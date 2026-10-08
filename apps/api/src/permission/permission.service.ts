import { runAsService } from '../db/service-principal';
import { Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { getPrismaClient } from "../prisma";
import { withServiceContext, withPermissionRead } from "../db/tenant-context.service";
import { RedisService } from "../redis/redis.service";
import {
  BASE_USER_PERMISSIONS,
  DEFAULT_ROLES,
  PERMISSIONS,
} from "./permissions";

@Injectable()
export class PermissionService implements OnModuleInit {
  private readonly logger = new Logger(PermissionService.name);
  private prisma = getPrismaClient();
  /**
   * 单个请求（guard + handler）会把 isSystemAdmin / getRolePermissions /
   * getManagedOrgIds 各算 3~6 次，RLS 模式下每条查询又是独立事务（4~5 次往返），
   * bootstrap / admin/data 因此各多花 30~80 次 DB 往返。用与用户状态缓存一致的
   * 短 TTL 进程内缓存收敛；角色、组织、授权变更入口调用 invalidatePermissionCaches
   * 主动失效，TTL 只兜底。
   */
  private static readonly PERM_TTL_MS = Math.max(
    0,
    Number(process.env.PERMISSION_CACHE_TTL_MS ?? 5_000),
  );
  private readonly systemAdminCache = new Map<string, { expiresAt: number; value: boolean }>();
  private readonly rolePermissionsCache = new Map<string, { expiresAt: number; value: Set<string> }>();
  private readonly managedOrgIdsCache = new Map<string, { expiresAt: number; value: Set<string> }>();
  private readonly visibleKbsCache = new Map<string, { expiresAt: number; value: string[] }>();
  private orgNodeListCache: { expiresAt: number; nodes: { id: string; parentId: string | null }[] } | null = null;
  private cacheRevision = 0;

  /** Cross-replica cache-invalidation channel (Redis pub/sub). */
  private static readonly INVALIDATION_CHANNEL = 'permission-cache-invalidation';

  constructor(@Optional() private readonly redis?: RedisService) {}

  invalidatePermissionCaches(userId?: string): void {
    this.invalidateLocalPermissionCaches(userId);
    // Broadcast so other replicas drop their copies immediately instead of
    // waiting out PERMISSION_CACHE_TTL_MS. Fire-and-forget: without Redis this
    // is a no-op and the short TTL stays the single-instance fallback.
    const instanceId = this.redis?.getInstanceId();
    void this.redis?.publish(PermissionService.INVALIDATION_CHANNEL, {
      instanceId,
      userId: userId ?? null,
    });
  }

  private invalidateLocalPermissionCaches(userId?: string): void {
    // An invalidation must also retire computations started before the change;
    // otherwise an in-flight read can repopulate the just-cleared cache.
    this.cacheRevision += 1;
    if (userId) {
      this.systemAdminCache.delete(userId);
      this.rolePermissionsCache.delete(userId);
      this.managedOrgIdsCache.delete(userId);
      this.visibleKbsCache.delete(userId);
      return;
    }
    this.systemAdminCache.clear();
    this.rolePermissionsCache.clear();
    this.managedOrgIdsCache.clear();
    this.visibleKbsCache.clear();
    this.orgNodeListCache = null;
  }

  private async cachedOrgNodeList(): Promise<{ id: string; parentId: string | null }[]> {
    const ttl = PermissionService.PERM_TTL_MS;
    if (this.orgNodeListCache && this.orgNodeListCache.expiresAt > Date.now()) {
      return this.orgNodeListCache.nodes;
    }
    // 授权计算（管辖子树 BFS / 组织可见性向上继承）必须基于全量 active 组织图。
    // 该查询若走请求用户的 RLS 上下文，组织管理员只能看到自己挂载链向上的
    // 节点，子树 BFS 永远无法向下展开（2026-10-06 E2E BUG-2 复测发现的
    // 第二层根因）；因此这里用 service 范围读取，结果仅用于 id 集合计算。
    const revision = this.cacheRevision;
    const nodes = (await withPermissionRead(this.prisma, (db: any) =>
      db.orgNode.findMany({
        where: { status: 'active' },
        select: { id: true, parentId: true },
      }),
    )) as { id: string; parentId: string | null }[];
    if (revision !== this.cacheRevision) return this.cachedOrgNodeList();
    if (ttl > 0) this.orgNodeListCache = { expiresAt: Date.now() + ttl, nodes };
    return nodes;
  }

  async onModuleInit() {
    await runAsService('permission-initialize', () => this.initializeInternal());
    // Cross-replica cache invalidation: another instance's permission change
    // drops this instance's caches immediately rather than after the TTL.
    await this.redis?.subscribe(
      PermissionService.INVALIDATION_CHANNEL,
      (message: string) => this.handleInvalidationMessage(message),
      () => this.invalidateLocalPermissionCaches(),
    );
  }

  /** Apply a peer's invalidation broadcast to this instance's local caches. */
  private handleInvalidationMessage(message: string): void {
    try {
      const payload = JSON.parse(message);
      if (payload?.instanceId && payload.instanceId === this.redis?.getInstanceId()) return;
      this.invalidateLocalPermissionCaches(
        typeof payload?.userId === 'string' ? payload.userId : undefined,
      );
    } catch {
      // Malformed message: ignore rather than crash the subscriber.
    }
  }

  private async initializeInternal() {
    await this.ensureDefaultRoles();
    this.logger.log("Permission service initialized.");
  }

  private async ensureDefaultRoles() {
    for (const role of DEFAULT_ROLES) {
      const where = 'code' in role ? { code: role.code as string } : { name: role.name };
      const existing = await this.prisma.role.findUnique({ where });
      // Statement-level authorization triggers also fire for identical updates.
      // A second instance starting must not invalidate every in-flight answer.
      if (existing && existing.description === role.description &&
          existing.builtin === role.builtin &&
          (!('code' in role) || existing.code === role.code) &&
          Array.isArray(existing.permissions) &&
          existing.permissions.length === role.permissions.length &&
          existing.permissions.every((permission: string, index: number) => permission === role.permissions[index])) {
        continue;
      }
      await this.prisma.role.upsert({
        where,
        create: {
          name: role.name,
          code: 'code' in role ? role.code as string : null,
          description: role.description,
          builtin: role.builtin,
          permissions: role.permissions,
        },
        update: {
          description: role.description,
          ...('code' in role ? { code: role.code as string } : {}),
          builtin: role.builtin,
          permissions: role.permissions,
        },
      });
    }

    // A non-builtin role must never carry a wildcard or an unknown permission.
    // The role API forbids "*" for unprotected roles, so its presence — or a
    // stale permission string from an older release — marks legacy/escalated
    // data. Converge any such role to the base user permissions, keyed on the
    // permission set, never on a specific role name.
    const knownPermissions = new Set<string>(Object.values(PERMISSIONS));
    const nonBuiltinRoles = await this.prisma.role.findMany({
      where: { builtin: false },
      select: { id: true, name: true, permissions: true },
    });
    for (const role of nonBuiltinRoles) {
      const permissions: string[] = Array.isArray(role.permissions) ? (role.permissions as string[]) : [];
      const hasInvalid = permissions.some((permission) => permission === '*' || !knownPermissions.has(permission));
      if (!hasInvalid) continue;
      await this.prisma.role.update({
        where: { id: role.id },
        data: { permissions: [...BASE_USER_PERMISSIONS] },
      });
      this.logger.warn(`Converged legacy/over-privileged role "${role.name}" to the base user permissions.`);
    }
    const usersWithoutRole = await this.prisma.user.findMany({
      where: { status: "active", roles: { none: {} } },
      select: { id: true },
    });
    const basicRole = await this.prisma.role.findUnique({
      where: { name: "普通用户" },
      select: { id: true },
    });
    if (basicRole && usersWithoutRole.length) {
      await this.prisma.userRole.createMany({
        data: usersWithoutRole.map((user) => ({
          userId: user.id,
          roleId: basicRole.id,
        })),
        skipDuplicates: true,
      });
    }

    // 旧数据没有记录行业库创建者时，统一归属给系统管理员，避免把删除权误授给普通库管理员。
    const systemOwner = await this.prisma.user.findFirst({
      where: { status: "active", roles: { some: { role: { code: { in: ['system_admin', 'super_admin'] } } } } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    const ownerlessIndustryKb = systemOwner && await this.prisma.knowledgeBase.findFirst({
      where: { type: "industry", ownerUserId: null }, select: { id: true },
    });
    if (systemOwner && ownerlessIndustryKb) {
      await this.prisma.knowledgeBase.updateMany({
        where: { type: "industry", ownerUserId: null },
        data: { ownerUserId: systemOwner.id },
      });
    }
  }

  async isSystemAdmin(userId: string, prisma: any = this.prisma): Promise<boolean> {
    // A transaction client is an explicit fresh-read boundary (strict output).
    if (prisma !== this.prisma) {
      return Boolean(await prisma.userRole.findFirst({
        where: { userId, role: { code: { in: ['system_admin', 'super_admin'] } } },
        select: { userId: true },
      }));
    }
    const ttl = PermissionService.PERM_TTL_MS;
    const cached = this.systemAdminCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    // Only the dedicated system-admin role names grant system administration.
    // Matching on `builtin: true` alone would promote any future built-in
    // role (e.g. an internal service role) to system admin.
    const revision = this.cacheRevision;
    const value = Boolean(
      await prisma.userRole.findFirst({
        where: {
          userId,
          role: {
            code: { in: ['system_admin', 'super_admin'] },
          },
        },
        select: { userId: true },
      }),
    );
    if (revision !== this.cacheRevision) return this.isSystemAdmin(userId, prisma);
    if (ttl > 0) this.systemAdminCache.set(userId, { expiresAt: Date.now() + ttl, value });
    return value;
  }

  /**
   * 超级管理员是最高的受保护身份，仅用于少数只能由它完成的动作（如授予“行业库创建者”
   * 角色）。系统管理员（`system_admin`）虽有 `*`，但不是超级管理员，二者不可混同。
   */
  async isSuperAdmin(userId: string): Promise<boolean> {
    return Boolean(
      await this.prisma.userRole.findFirst({
        where: { userId, role: { code: 'super_admin' } },
        select: { userId: true },
      }),
    );
  }

  async getRolePermissions(userId: string): Promise<Set<string>> {
    const ttl = PermissionService.PERM_TTL_MS;
    const cached = this.rolePermissionsCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return new Set(cached.value);
    const revision = this.cacheRevision;
    const roles = await this.prisma.userRole.findMany({
      where: { userId },
      select: { role: { select: { permissions: true } } },
    });
    const permissions = new Set<string>(BASE_USER_PERMISSIONS);
    for (const item of roles) {
      if (Array.isArray(item.role.permissions))
        item.role.permissions
          .filter(
            (permission): permission is string =>
              typeof permission === "string",
          )
          .forEach((permission) => permissions.add(permission));
    }
    if (revision !== this.cacheRevision) return this.getRolePermissions(userId);
    if (ttl > 0) this.rolePermissionsCache.set(userId, { expiresAt: Date.now() + ttl, value: permissions });
    return new Set(permissions);
  }

  async hasPermission(userId: string, permission: string): Promise<boolean> {
    if (await this.isSystemAdmin(userId)) return true;
    const permissions = await this.getRolePermissions(userId);
    return permissions.has("*") || permissions.has(permission);
  }

  async getManagedOrgIds(userId: string): Promise<Set<string>> {
    const ttl = PermissionService.PERM_TTL_MS;
    const cached = this.managedOrgIdsCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return new Set(cached.value);
    const revision = this.cacheRevision;
    const value = await this.computeManagedOrgIds(userId);
    if (revision !== this.cacheRevision) return this.getManagedOrgIds(userId);
    if (ttl > 0) this.managedOrgIdsCache.set(userId, { expiresAt: Date.now() + ttl, value });
    return new Set(value);
  }

  private async computeManagedOrgIds(userId: string): Promise<Set<string>> {
    if (await this.isSystemAdmin(userId)) {
      const nodes = await this.cachedOrgNodeList();
      return new Set(nodes.map((node) => node.id));
    }
    const rolePermissions = await this.getRolePermissions(userId);
    // OrgAdmin 是资源范围记录，不是独立的授权入口；没有组织管理角色时
    // 即使残留历史 OrgAdmin 关系，也不能据此管理人员或组织。
    const canManageOrg =
      rolePermissions.has(PERMISSIONS.ORG_USER_MANAGE) ||
      rolePermissions.has(PERMISSIONS.ORG_NODE_CREATE);
    const managedRoots = canManageOrg
      ? await this.prisma.orgAdmin.findMany({
          where: { userId },
          select: { orgNodeId: true },
        })
      : [];
    const memberships = rolePermissions.has(PERMISSIONS.ORG_USER_MANAGE)
      ? await this.prisma.userOrg.findMany({
          where: { userId },
          select: { orgNodeId: true },
        })
      : [];
    const nodes = await this.cachedOrgNodeList();
    // 组织管理员角色以当前组织为管理根范围；OrgAdmin 关系作为历史数据和显式授权继续兼容。
    const managed = new Set([
      ...managedRoots.map((item) => item.orgNodeId),
      ...memberships.map((item) => item.orgNodeId),
    ]);
    // Index children by parent first: the previous BFS used queue.shift()
    // (O(n) per dequeue) with a full scan per node — O(n²) overall.
    const childrenByParent = new Map<string, string[]>();
    for (const node of nodes) {
      if (!node.parentId) continue;
      const list = childrenByParent.get(node.parentId) ?? [];
      list.push(node.id);
      childrenByParent.set(node.parentId, list);
    }
    const queue = [...managed];
    while (queue.length) {
      const parentId = queue.pop()!;
      for (const childId of childrenByParent.get(parentId) ?? []) {
        if (!managed.has(childId)) {
          managed.add(childId);
          queue.push(childId);
        }
      }
    }
    return managed;
  }

  async canManageOrganization(userId: string, orgId: string): Promise<boolean> {
    return (await this.getManagedOrgIds(userId)).has(orgId);
  }

  async canManageUser(userId: string, targetUserId: string): Promise<boolean> {
    if (await this.isSystemAdmin(userId)) return true;
    const managedOrgIds = await this.getManagedOrgIds(userId);
    // 目标用户的挂载关系必须以 service 范围读取：请求用户上下文下 UserOrg 的
    // RLS 策略只放行本人行，组织管理员在此查任何下属成员都会得到空集，
    // 导致"可管理"判定恒为 false（2026-10-06 E2E BUG-2 关联缺陷）。
    const targetOrgs = (await withPermissionRead(this.prisma, (db: any) =>
      db.userOrg.findMany({
        where: { userId: targetUserId },
        select: { orgNodeId: true },
      }),
    )) as Array<{ orgNodeId: string }>;
    return (
      targetOrgs.length > 0 &&
      targetOrgs.some((item) => managedOrgIds.has(item.orgNodeId))
    );
  }

  async canManageIndustryKb(userId: string, kbId: string): Promise<boolean> {
    if (await this.isSystemAdmin(userId)) return true;
    return Boolean(
      await this.prisma.knowledgeBase.findFirst({
        where: {
          id: kbId,
          type: "industry",
          status: "active",
          OR: [{ ownerUserId: userId }, { admins: { some: { userId } } }],
        },
        select: { id: true },
      }),
    );
  }

  async canGrantIndustryKb(userId: string, kbId: string): Promise<boolean> {
    if (await this.isSystemAdmin(userId)) return true;
    return Boolean(
      await this.prisma.knowledgeBase.findFirst({
        // 阅读授权属于日常内容治理，只交给当前指定的行业库管理员。
        // 创建者即使保留设置管理员和删除权，也不能绕过已转交的管理关系。
        where: {
          id: kbId,
          type: "industry",
          status: "active",
          admins: { some: { userId } },
        },
        select: { id: true },
      }),
    );
  }

  /**
   * Knowledge-base write permission is deliberately stricter than read
   * visibility. Organization libraries are managed by organization admins in
   * their managed subtree; a stale/direct KbAdmin row must not bypass that
   * organization boundary. Personal and industry libraries retain their
   * owner/resource-admin semantics.
   */
  async canManageKnowledgeBase(userId: string, kbId: string, client?: any): Promise<boolean> {
    if (client && client !== this.prisma) {
      const scoped = new PermissionService();
      scoped.prisma = client;
      return scoped.canManageKnowledgeBase(userId, kbId);
    }
    if (await this.isSystemAdmin(userId)) return true;
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { type: true, ownerUserId: true, orgNodeId: true, status: true },
    });
    if (!kb || kb.status !== "active") return false;
    if (kb.type === "org" && kb.orgNodeId) {
      // 组织库维护规则：本级（及上级）组织管理员始终可维护——即使库另指派
      // 了知识库管理员也不被剥夺；被指派的知识库管理员同样获得维护权
      //（否则指派无意义）。未指派时则仅组织管理员可维护。
      if (await this.canManageOrganization(userId, kb.orgNodeId)) return true;
      return Boolean(
        await this.prisma.kbAdmin.findFirst({
          where: { kbId, userId },
          select: { kbId: true },
        }),
      );
    }
    // An industry-library creator retains resource-level administration
    // (administrator assignment and archive/delete), but knowledge writes
    // belong to the currently assigned library administrators. This keeps
    // ownership and day-to-day content maintenance intentionally separate.
    if (kb.type === "industry") {
      return Boolean(
        await this.prisma.kbAdmin.findFirst({
          where: { kbId, userId },
          select: { kbId: true },
        }),
      );
    }
    if (kb.ownerUserId === userId) return true;
    return Boolean(
      await this.prisma.kbAdmin.findFirst({
        where: { kbId, userId },
        select: { kbId: true },
      }),
    );
  }

  /**
   * 批量版 canManageKnowledgeBase：一次加载用户的管理面数据
   * （系统管理员判定、组织管理子树、KbAdmin 关系），避免列表页对每个
   * 知识库重复发起 3~6 次查询造成的 N+1。
   */
  async canManageKnowledgeBases(
    userId: string,
    kbIds: string[],
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    const uniqueIds = [...new Set(kbIds)];
    if (!uniqueIds.length) return result;
    if (await this.isSystemAdmin(userId)) {
      for (const id of uniqueIds) result.set(id, true);
      return result;
    }
    const [kbs, kbAdminRows, managedOrgIds] = await Promise.all([
      this.prisma.knowledgeBase.findMany({
        where: { id: { in: uniqueIds } },
        select: {
          id: true,
          type: true,
          ownerUserId: true,
          orgNodeId: true,
          status: true,
        },
      }),
      this.prisma.kbAdmin.findMany({
        where: { userId, kbId: { in: uniqueIds } },
        select: { kbId: true },
      }),
      this.getManagedOrgIds(userId),
    ]);
    const kbById = new Map(kbs.map((kb) => [kb.id, kb]));
    const adminKbIds = new Set(kbAdminRows.map((row) => row.kbId));
    for (const id of uniqueIds) {
      const kb = kbById.get(id);
      if (!kb || kb.status !== "active") {
        result.set(id, false);
        continue;
      }
      if (adminKbIds.has(id)) {
        result.set(id, true);
        continue;
      }
      if (kb.type === "org") {
        // 组织库维护规则与单个版本保持一致：本级（及上级）组织管理员始终
        // 可维护；无挂靠组织或不在管理子树时回退到 owner 判定
        //（KbAdmin 已在上方统一覆盖）。
        if (kb.orgNodeId && managedOrgIds.has(kb.orgNodeId)) {
          result.set(id, true);
        } else {
          result.set(id, kb.ownerUserId === userId);
        }
        continue;
      }
      if (kb.type === "industry") {
        // 行业库的写入权只属于当前在任的库管理员，创建者不自动保留。
        result.set(id, false);
        continue;
      }
      result.set(id, kb.ownerUserId === userId);
    }
    return result;
  }

  async getCapabilities(userId: string): Promise<string[]> {
    const permissions = await this.getRolePermissions(userId);
    if (await this.isSystemAdmin(userId)) return ["*"];
    const capabilities = new Set(permissions);
    // 行业库模块入口来自“行业库管理员”角色；具体资源的维护/授权仍由
    // canManageIndustryKb/canGrantIndustryKb 按 owner/kbAdmin 关系校验。
    const managedOrgIds = await this.getManagedOrgIds(userId);
    if (managedOrgIds.size) {
      capabilities.add(PERMISSIONS.ORG_READ);
      capabilities.add(PERMISSIONS.ORG_USER_READ);
      capabilities.add(PERMISSIONS.ORG_USER_MANAGE);
      capabilities.add(PERMISSIONS.ORG_NODE_CREATE);
    } else {
      // 组织管理员角色只是权限模板，必须同时存在 OrgAdmin 节点范围才生效。
      [
        PERMISSIONS.ORG_READ,
        PERMISSIONS.ORG_USER_READ,
        PERMISSIONS.ORG_USER_MANAGE,
        PERMISSIONS.ORG_NODE_CREATE,
      ].forEach((permission) => capabilities.delete(permission));
    }
    return [...capabilities];
  }

  private async getUserOrgIds(userId: string, prisma: any = this.prisma): Promise<Set<string>> {
    const memberships = await prisma.userOrg.findMany({
      where: { userId },
      select: { orgNodeId: true },
    });
    const nodes = prisma.orgNode
      ? prisma !== this.prisma
        ? await prisma.orgNode.findMany({ where: { status: 'active' }, select: { id: true, parentId: true } })
        : await this.cachedOrgNodeList()
      : [];
    const byId = new Map<string, any>(nodes.map((node: any) => [node.id, node]));
    const visibleOrgIds = new Set<string>();
    for (const membership of memberships) {
      let nodeId: string | null = membership.orgNodeId;
      // 组织可见范围只向上继承：本人节点 + 全部祖先节点，不能向下扩散。
      while (nodeId) {
        visibleOrgIds.add(nodeId);
        nodeId = byId.get(nodeId)?.parentId ?? null;
      }
    }
    return visibleOrgIds;
  }

  async resolveUserId(requestedUserId?: string): Promise<string | null> {
    if (!requestedUserId) return null;
    const user = await this.prisma.user.findFirst({
      where: { id: requestedUserId, status: "active" },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  /**
   * 核心算法：计算用户的可见知识库集合
   * visible_kbs = 个人库 ∪ 组织库继承 ∪ 行业库ACL
   */
  async getVisibleKnowledgeBases(userId: string, prisma?: any): Promise<string[]> {
    if (prisma) return this.computeVisibleKnowledgeBases(prisma, userId);
    // One question triggers this 5+ times: the answer path itself, the
    // rerank-hop authorization, the citation ACL check and the search filter
    // each recompute it, and every call runs getUserOrgIds plus four KB
    // queries inside its own RLS transaction. The result only changes when a
    // role/org/grant changes, and every such entry point already calls
    // invalidatePermissionCaches, so the same short TTL the other caches use
    // is enough to collapse a request's repeats to a single computation.
    const cached = this.visibleKbsCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    // Visibility computation must see KnowledgeBase rows; under RLS a pooled
    // connection without GUC context fail-closes and returns [] -> 404 on
    // document lists. Run the ACL computation under the service context and
    // keep the application-level filters below as the authorization source.
    const revision = this.cacheRevision;
    const value = await withServiceContext(this.prisma, (db) =>
      this.computeVisibleKnowledgeBases(db as any, userId),
    );
    if (revision !== this.cacheRevision) return this.getVisibleKnowledgeBases(userId);
    if (PermissionService.PERM_TTL_MS > 0) {
      this.visibleKbsCache.set(userId, {
        expiresAt: Date.now() + PermissionService.PERM_TTL_MS,
        value,
      });
      // Bound the map: an idle deployment must not accumulate one entry per
      // user seen since boot.
      while (this.visibleKbsCache.size > 5000) {
        this.visibleKbsCache.delete(this.visibleKbsCache.keys().next().value!);
      }
    }
    return value;
  }

  private async computeVisibleKnowledgeBases(prisma: any, userId: string): Promise<string[]> {
    const visibleKbIds = new Set<string>();
    const _prisma = prisma || this.prisma;

    const orgIds = await this.getUserOrgIds(userId, _prisma);
    const [systemAdmin, directManagedKbs] = await Promise.all([
      this.isSystemAdmin(userId, _prisma),
      _prisma.knowledgeBase.findMany({
        where: {
          type: { not: "personal" },
          status: "active",
          OR: [{ ownerUserId: userId }, { admins: { some: { userId } } }],
        },
        select: { id: true },
      }),
    ]);
    // kbAdmin 只额外授予对应知识库本身的可见性，绝不把权限扩展到同组织或下级组织的其它库。
    directManagedKbs.forEach((kb: any) => visibleKbIds.add(kb.id));

    // 1. 个人库：系统级规则，只允许 owner 看到。
    const personalKbs = await _prisma.knowledgeBase.findMany({
      where: { type: "personal", ownerUserId: userId, status: "active" },
      select: { id: true },
    });
    personalKbs.forEach((kb: any) => visibleKbIds.add(kb.id));

    // 2. 组织库：成员可看到自己的组织及所有祖先组织的库。
    if (orgIds.size > 0) {
      const orgKbs = await _prisma.knowledgeBase.findMany({
        where: {
          type: "org",
          status: "active",
          orgNodeId: { in: [...orgIds] },
        },
        select: { id: true },
      });
      orgKbs.forEach((kb: any) => visibleKbIds.add(kb.id));
    }

    // 系统管理员可查看全部组织库与行业库。
    if (systemAdmin) {
      const managedKbs = await _prisma.knowledgeBase.findMany({
        where: { type: { in: ["org", "industry"] }, status: "active" },
        select: { id: true },
      });
      managedKbs.forEach((kb: any) => visibleKbIds.add(kb.id));
    }

    // 3. 行业库：支持人员、角色、组织三种主体，过期授权自动失效。
    const userRoles = _prisma.userRole
      ? await _prisma.userRole.findMany({
          where: { userId },
          select: { roleId: true },
        })
      : [];
    const subjects = [
      { subjectType: "user", subjectId: userId },
      ...userRoles.map((role: any) => ({
        subjectType: "role",
        subjectId: role.roleId,
      })),
      ...[...orgIds].map((orgId: any) => ({ subjectType: "org", subjectId: orgId })),
    ];
    const industryGrants =
      subjects.length === 0
        ? []
        : await _prisma.industryGrant.findMany({
            where: {
              kb: { type: "industry", status: "active" },
              AND: [
                { OR: subjects },
                {
                  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                },
              ],
            },
            select: { kbId: true },
          });
    industryGrants.forEach((grant: any) => visibleKbIds.add(grant.kbId));

    return Array.from(visibleKbIds);
  }

  async getUsersVisibleToKnowledgeBase(kbId: string): Promise<string[]> {
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { type: true, ownerUserId: true, orgNodeId: true },
    });
    if (!kb) return [];
    if (kb.type === "personal") return kb.ownerUserId ? [kb.ownerUserId] : [];

    const visibleUserIds = new Set<string>();

    const systemAdmins = await this.prisma.user.findMany({
      where: {
        status: "active",
        roles: {
          some: {
            role: {
              code: { in: ['system_admin', 'super_admin'] },
            },
          },
        },
      },
      select: { id: true },
    });
    for (const admin of systemAdmins) visibleUserIds.add(admin.id);

    if (kb.type === "org" && kb.orgNodeId) {
      const nodes = await this.prisma.orgNode.findMany({
        where: { status: "active" },
        select: { id: true, parentId: true },
      });
      const descendantIds = new Set<string>([kb.orgNodeId]);
      const queue = [kb.orgNodeId];
      while (queue.length) {
        const current = queue.shift()!;
        for (const node of nodes) {
          if (node.parentId === current && !descendantIds.has(node.id)) {
            descendantIds.add(node.id);
            queue.push(node.id);
          }
        }
      }
      const users = await this.prisma.user.findMany({
        where: {
          status: "active",
          orgs: { some: { orgNodeId: { in: [...descendantIds] } } },
        },
        select: { id: true },
      });
      for (const user of users) visibleUserIds.add(user.id);
    } else if (kb.type === "industry") {
      const kbWithAdmins = await this.prisma.knowledgeBase.findUnique({
        where: { id: kbId },
        select: { ownerUserId: true, admins: { select: { userId: true } } },
      });
      const directUserIds = [];
      if (kbWithAdmins?.ownerUserId)
        directUserIds.push(kbWithAdmins.ownerUserId);
      if (kbWithAdmins?.admins) {
        for (const admin of kbWithAdmins.admins)
          directUserIds.push(admin.userId);
      }
      if (directUserIds.length) {
        const activeDirectUsers = await this.prisma.user.findMany({
          where: { id: { in: directUserIds }, status: "active" },
          select: { id: true },
        });
        for (const user of activeDirectUsers) visibleUserIds.add(user.id);
      }

      const grants = await this.prisma.industryGrant.findMany({
        where: {
          kbId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { subjectType: true, subjectId: true },
      });

      const userGrants = grants
        .filter((g) => g.subjectType === "user")
        .map((g) => g.subjectId);
      const roleGrants = grants
        .filter((g) => g.subjectType === "role")
        .map((g) => g.subjectId);
      const orgGrants = grants
        .filter((g) => g.subjectType === "org")
        .map((g) => g.subjectId);

      const conditions: any[] = [];
      if (userGrants.length) conditions.push({ id: { in: userGrants } });
      if (roleGrants.length)
        conditions.push({ roles: { some: { roleId: { in: roleGrants } } } });

      if (orgGrants.length) {
        const nodes = await this.prisma.orgNode.findMany({
          where: { status: "active" },
          select: { id: true, parentId: true },
        });
        const descendantIds = new Set<string>(orgGrants);
        const queue = [...orgGrants];
        while (queue.length) {
          const current = queue.shift()!;
          for (const node of nodes) {
            if (node.parentId === current && !descendantIds.has(node.id)) {
              descendantIds.add(node.id);
              queue.push(node.id);
            }
          }
        }
        conditions.push({
          orgs: { some: { orgNodeId: { in: [...descendantIds] } } },
        });
      }

      if (conditions.length) {
        const users = await this.prisma.user.findMany({
          where: { status: "active", OR: conditions },
          select: { id: true },
        });
        for (const user of users) visibleUserIds.add(user.id);
      }
    }

    return Array.from(visibleUserIds);
  }

  /**
   * 触发权限变更事件 (撤销权限)
   * 将会通过事件总线通知 BrainCompiler 进行 CRITICAL 优先级的重编译
   */
  async revokeAccess(userId: string, kbId: string) {
    // 1. 数据库更新，删除 grant
    await this.prisma.industryGrant.deleteMany({
      where: { subjectType: 'user', subjectId: userId, kbId },
    });

    this.logger.log(
      `Revoked access for ${userId} to ${kbId}; visibility will be recomputed on the next request.`,
    );
  }
}
