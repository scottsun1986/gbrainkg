import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { BASE_USER_PERMISSIONS, DEFAULT_ROLES, PERMISSIONS } from './permissions';

@Injectable()
export class PermissionService implements OnModuleInit {
  private readonly logger = new Logger(PermissionService.name);
  private prisma = new PrismaClient();

  async onModuleInit() {
    await this.ensureDefaultRoles();
    this.logger.log('Permission service initialized.');
  }

  private async ensureDefaultRoles() {
    for (const role of DEFAULT_ROLES) {
      await this.prisma.role.upsert({
        where: { name: role.name },
        create: { name: role.name, description: role.description, builtin: role.builtin, permissions: role.permissions },
        update: { description: role.description, builtin: role.builtin, permissions: role.permissions },
      });
    }

    // 旧版验收数据中的员工角色曾携带过量管理权限，统一收敛为普通阅读权限。
    const legacyEmployeeRole = await this.prisma.role.findUnique({ where: { name: '研发中心员工' } });
    if (legacyEmployeeRole && !legacyEmployeeRole.builtin) {
      await this.prisma.role.update({ where: { id: legacyEmployeeRole.id }, data: { permissions: BASE_USER_PERMISSIONS } });
    }
    const usersWithoutRole = await this.prisma.user.findMany({ where: { status: 'active', roles: { none: {} } }, select: { id: true } });
    const basicRole = await this.prisma.role.findUnique({ where: { name: '普通用户' }, select: { id: true } });
    if (basicRole && usersWithoutRole.length) {
      await this.prisma.userRole.createMany({ data: usersWithoutRole.map((user) => ({ userId: user.id, roleId: basicRole.id })), skipDuplicates: true });
    }

    // 旧数据没有记录行业库创建者时，统一归属给系统管理员，避免把删除权误授给普通库管理员。
    const systemOwner = await this.prisma.user.findFirst({
      where: { status: 'active', roles: { some: { role: { builtin: true } } } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (systemOwner) {
      await this.prisma.knowledgeBase.updateMany({ where: { type: 'industry', ownerUserId: null }, data: { ownerUserId: systemOwner.id } });
    }
  }

  async isSystemAdmin(userId: string): Promise<boolean> {
    return Boolean(await this.prisma.userRole.findFirst({
      where: { userId, role: { OR: [{ builtin: true }, { name: '超级管理员' }, { name: '系统管理员' }] } },
      select: { userId: true },
    }));
  }

  async getRolePermissions(userId: string): Promise<Set<string>> {
    const roles = await this.prisma.userRole.findMany({ where: { userId }, select: { role: { select: { permissions: true } } } });
    const permissions = new Set<string>(BASE_USER_PERMISSIONS);
    for (const item of roles) {
      if (Array.isArray(item.role.permissions)) item.role.permissions.filter((permission): permission is string => typeof permission === 'string').forEach((permission) => permissions.add(permission));
    }
    return permissions;
  }

  async hasPermission(userId: string, permission: string): Promise<boolean> {
    if (await this.isSystemAdmin(userId)) return true;
    const permissions = await this.getRolePermissions(userId);
    return permissions.has('*') || permissions.has(permission);
  }

  async getManagedOrgIds(userId: string): Promise<Set<string>> {
    if (await this.isSystemAdmin(userId)) {
      const nodes = await this.prisma.orgNode.findMany({ where: { status: 'active' }, select: { id: true } });
      return new Set(nodes.map((node) => node.id));
    }
    const rolePermissions = await this.getRolePermissions(userId);
    // OrgAdmin 是资源范围记录，不是独立的授权入口；没有组织管理角色时
    // 即使残留历史 OrgAdmin 关系，也不能据此管理人员或组织。
    const canManageOrg = rolePermissions.has(PERMISSIONS.ORG_USER_MANAGE) || rolePermissions.has(PERMISSIONS.ORG_NODE_CREATE);
    const managedRoots = canManageOrg
      ? await this.prisma.orgAdmin.findMany({ where: { userId }, select: { orgNodeId: true } })
      : [];
    const memberships = rolePermissions.has(PERMISSIONS.ORG_USER_MANAGE)
      ? await this.prisma.userOrg.findMany({ where: { userId }, select: { orgNodeId: true } })
      : [];
    const nodes = await this.prisma.orgNode.findMany({ where: { status: 'active' }, select: { id: true, parentId: true } });
    // 组织管理员角色以当前组织为管理根范围；OrgAdmin 关系作为历史数据和显式授权继续兼容。
    const managed = new Set([...managedRoots.map((item) => item.orgNodeId), ...memberships.map((item) => item.orgNodeId)]);
    const queue = [...managed];
    while (queue.length) {
      const parentId = queue.shift()!;
      for (const node of nodes) {
        if (node.parentId === parentId && !managed.has(node.id)) {
          managed.add(node.id);
          queue.push(node.id);
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
    const targetOrgs = await this.prisma.userOrg.findMany({ where: { userId: targetUserId }, select: { orgNodeId: true } });
    return targetOrgs.length > 0 && targetOrgs.some((item) => managedOrgIds.has(item.orgNodeId));
  }

  async canManageIndustryKb(userId: string, kbId: string): Promise<boolean> {
    if (await this.isSystemAdmin(userId)) return true;
    return Boolean(await this.prisma.knowledgeBase.findFirst({
      where: { id: kbId, type: 'industry', status: 'active', OR: [{ ownerUserId: userId }, { admins: { some: { userId } } }] },
      select: { id: true },
    }));
  }

  async canGrantIndustryKb(userId: string, kbId: string): Promise<boolean> {
    if (await this.isSystemAdmin(userId)) return true;
    return Boolean(await this.prisma.knowledgeBase.findFirst({
      where: { id: kbId, type: 'industry', status: 'active', OR: [{ ownerUserId: userId }, { admins: { some: { userId } } }] },
      select: { id: true },
    }));
  }

  /**
   * Knowledge-base write permission is deliberately stricter than read
   * visibility. Organization libraries are managed by organization admins in
   * their managed subtree; a stale/direct KbAdmin row must not bypass that
   * organization boundary. Personal and industry libraries retain their
   * owner/resource-admin semantics.
   */
  async canManageKnowledgeBase(userId: string, kbId: string): Promise<boolean> {
    if (await this.isSystemAdmin(userId)) return true;
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { type: true, ownerUserId: true, orgNodeId: true, status: true },
    });
    if (!kb || kb.status !== 'active') return false;
    if (kb.type === 'org' && kb.orgNodeId) return this.canManageOrganization(userId, kb.orgNodeId);
    if (kb.ownerUserId === userId) return true;
    return Boolean(await this.prisma.kbAdmin.findFirst({ where: { kbId, userId }, select: { kbId: true } }));
  }

  async getCapabilities(userId: string): Promise<string[]> {
    const permissions = await this.getRolePermissions(userId);
    if (await this.isSystemAdmin(userId)) return ['*'];
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
      [PERMISSIONS.ORG_READ, PERMISSIONS.ORG_USER_READ, PERMISSIONS.ORG_USER_MANAGE, PERMISSIONS.ORG_NODE_CREATE].forEach((permission) => capabilities.delete(permission));
    }
    return [...capabilities];
  }

  private async getUserOrgIds(userId: string): Promise<Set<string>> {
    const memberships = await this.prisma.userOrg.findMany({
      where: { userId },
      select: { orgNodeId: true },
    });
    const nodes = this.prisma.orgNode ? await this.prisma.orgNode.findMany({
      where: { status: 'active' },
      select: { id: true, parentId: true },
    }) : [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
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
    if (requestedUserId) {
      const user = await this.prisma.user.findFirst({
        where: { id: requestedUserId, status: 'active' },
        select: { id: true },
      });
      return user?.id ?? null;
    }
    if (process.env.NODE_ENV === 'production') return null;
    const firstUser = await this.prisma.user.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return firstUser?.id ?? null;
  }

  /**
   * 核心算法：计算用户的可见知识库集合
   * visible_kbs = 个人库 ∪ 组织库继承 ∪ 行业库ACL
   */
  async getVisibleKnowledgeBases(userId: string): Promise<string[]> {
    const visibleKbIds = new Set<string>();

    const orgIds = await this.getUserOrgIds(userId);
    const [systemAdmin, directManagedKbs] = await Promise.all([
      this.isSystemAdmin(userId),
      this.prisma.knowledgeBase.findMany({ where: { type: { not: 'personal' }, status: 'active', OR: [{ ownerUserId: userId }, { admins: { some: { userId } } }] }, select: { id: true } }),
    ]);
    // kbAdmin 只额外授予对应知识库本身的可见性，绝不把权限扩展到同组织或下级组织的其它库。
    directManagedKbs.forEach((kb) => visibleKbIds.add(kb.id));

    // 1. 个人库：系统级规则，只允许 owner 看到。
    const personalKbs = await this.prisma.knowledgeBase.findMany({
      where: { type: 'personal', ownerUserId: userId, status: 'active' },
      select: { id: true }
    });
    personalKbs.forEach(kb => visibleKbIds.add(kb.id));

    // 2. 组织库：成员可看到自己的组织及所有祖先组织的库。
    if (orgIds.size > 0) {
      const orgKbs = await this.prisma.knowledgeBase.findMany({
        where: { type: 'org', status: 'active', orgNodeId: { in: [...orgIds] } },
        select: { id: true }
      });
      orgKbs.forEach(kb => visibleKbIds.add(kb.id));
    }

    // 系统管理员可查看全部组织库。组织管理员的下级管理权只用于管理接口，
    // 不改变普通知识库阅读视图；阅读仍严格遵循本人组织节点及祖先节点规则。
    if (systemAdmin) {
      const managedKbs = await this.prisma.knowledgeBase.findMany({
        where: { type: 'org', status: 'active' },
        select: { id: true },
      });
      managedKbs.forEach((kb) => visibleKbIds.add(kb.id));
    }

    // 3. 行业库：支持人员、角色、组织三种主体，过期授权自动失效。
    const userRoles = this.prisma.userRole ? await this.prisma.userRole.findMany({
      where: { userId },
      select: { roleId: true },
    }) : [];
    const subjects = [
      { subjectType: 'user', subjectId: userId },
      ...userRoles.map((role) => ({ subjectType: 'role', subjectId: role.roleId })),
      ...[...orgIds].map((orgId) => ({ subjectType: 'org', subjectId: orgId })),
    ];
    const industryGrants = subjects.length === 0 ? [] : await this.prisma.industryGrant.findMany({
      where: {
        kb: { type: 'industry', status: 'active' },
        AND: [
          { OR: subjects },
          { OR: [
            { expiresAt: null },
            { expiresAt: { gt: new Date() } },
          ] },
        ],
      },
      select: { kbId: true }
    });
    industryGrants.forEach(grant => visibleKbIds.add(grant.kbId));

    return Array.from(visibleKbIds);
  }

  async getUsersVisibleToKnowledgeBase(kbId: string): Promise<string[]> {
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { type: true, ownerUserId: true, orgNodeId: true },
    });
    if (!kb) return [];
    if (kb.type === 'personal') return kb.ownerUserId ? [kb.ownerUserId] : [];

    const users = await this.prisma.user.findMany({
      where: { status: 'active' },
      select: { id: true },
    });
    const visible: string[] = [];
    for (const user of users) {
      if ((await this.getVisibleKnowledgeBases(user.id)).includes(kbId)) visible.push(user.id);
    }
    return visible;
  }

  /**
   * 触发权限变更事件 (撤销权限)
   * 将会通过事件总线通知 BrainCompiler 进行 CRITICAL 优先级的重编译
   */
  async revokeAccess(userId: string, kbId: string) {
    // 1. 数据库更新，删除 grant
    await this.prisma.industryGrant.deleteMany({
      where: { subjectId: userId, kbId: kbId }
    });

    this.logger.log(`Revoked access for ${userId} to ${kbId}; visibility will be recomputed on the next request.`);
  }
}
