import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '../prisma';
import { withServiceContext } from '../db/tenant-context.service';
import { PermissionService } from './permission.service';

export type AclSubjectType = 'user' | 'role' | 'org';

export interface AclEntryInput {
  subjectType: AclSubjectType;
  subjectId: string;
  permission?: string;
}

export interface AclEntry {
  id: string;
  documentId: string;
  subjectType: string;
  subjectId: string;
  permission: string;
  createdAt: Date;
}

const SUBJECT_TYPES: AclSubjectType[] = ['user', 'role', 'org'];

export interface FilterReadableDocsOpts {
  /** 调用方已知的可见 KB 集合（缺省时按 userId 现算）。 */
  visibleKbIds?: string[];
  /** 调用方已取到的文档行（id + kbId），避免重复查 Document。 */
  docs?: Array<{ id: string; kbId?: string | null }>;
}

/** 解析当前请求用户：显式参数 > 请求上下文（AsyncLocalStorage）。 */
export function resolveRequestUserId(explicit?: string): string | undefined {
  if (explicit && typeof explicit === "string") return explicit;
  try {
    // 延迟 require，避免 observability 与本模块的循环依赖风险。
    const { getRequestContext } = require("../observability/request-context") as {
      getRequestContext: () => { userId?: string } | undefined;
    };
    return getRequestContext()?.userId;
  } catch {
    return undefined;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function normalizeAclEntry(raw: unknown): AclEntryInput {
  const body = (raw || {}) as Record<string, unknown>;
  const subjectType = String(body.subjectType || '') as AclSubjectType;
  if (!SUBJECT_TYPES.includes(subjectType)) {
    throw new Error(`subjectType must be one of ${SUBJECT_TYPES.join('/')}`);
  }
  const subjectId = String(body.subjectId || '');
  if (!isUuid(subjectId)) {
    throw new Error('subjectId must be a uuid');
  }
  const permission = String(body.permission || 'read');
  if (permission !== 'read') {
    throw new Error("permission must be 'read'");
  }
  return { subjectType, subjectId, permission };
}

/**
 * 文档级 ACL：空 ACL 继承 KB 可见性；一旦写入任何 ACL 行，则 deny-by-default，
 * 仅授权主体（user/role/org）与知识库管理员可读。与 RLS 侧
 * app_document_readable 语义对齐。
 */
@Injectable()
export class DocumentAclService {
  private readonly logger = new Logger(DocumentAclService.name);
  private readonly prisma = getPrismaClient();

  constructor(private readonly permissionService?: PermissionService) {}

  async list(documentId: string): Promise<AclEntry[]> {
    return this.prisma.documentAcl.findMany({
      where: { documentId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** 全量替换：清空既有行后写入新集合。 */
  async replaceAll(
    documentId: string,
    entries: AclEntryInput[],
  ): Promise<AclEntry[]> {
    const normalized = entries.map(normalizeAclEntry);
    await withServiceContext(this.prisma, async (tx) => {
      await tx.documentAcl.deleteMany({ where: { documentId } });
      for (const entry of normalized) {
        await tx.documentAcl.create({
          data: {
            id: randomUUID(),
            documentId,
            subjectType: entry.subjectType,
            subjectId: entry.subjectId,
            permission: entry.permission ?? 'read',
          },
        });
      }
    });
    this.logger.log(
      `document ${documentId} ACL replaced with ${normalized.length} entr(ies)`,
    );
    return this.list(documentId);
  }

  /** 增量添加：同 (subjectType, subjectId) 已存在则跳过。 */
  async add(documentId: string, entry: unknown): Promise<AclEntry> {
    const normalized = normalizeAclEntry(entry);
    const existing = await this.prisma.documentAcl.findFirst({
      where: {
        documentId,
        subjectType: normalized.subjectType,
        subjectId: normalized.subjectId,
      },
    });
    if (existing) return existing;
    return withServiceContext(this.prisma, (tx) => tx.documentAcl.create({
      data: {
        id: randomUUID(),
        documentId,
        subjectType: normalized.subjectType,
        subjectId: normalized.subjectId,
        permission: normalized.permission ?? 'read',
      },
    }));
  }

  async remove(aclId: string): Promise<{ id: string }> {
    const row = await this.prisma.documentAcl.findUnique({
      where: { id: aclId },
    });
    if (!row) return { id: aclId };
    await withServiceContext(this.prisma, (tx) => tx.documentAcl.delete({ where: { id: aclId } }));
    return { id: aclId };
  }

  /**
   * 文档可读判定（与 RLS app_document_readable 语义一致）：
   * 1. kbAdmin / KB owner 恒可读
   * 2. KB 不可见 → 拒绝
   * 3. 无 ACL 行 → 继承 KB 可见性（可读）
   * 4. 有 ACL 行 → deny-by-default，仅匹配 user/role/org 主体可读
   */
  async isDocumentReadable(
    userId: string,
    documentId: string,
  ): Promise<boolean> {
    if (!userId || !documentId) return false;
    const readable = await this.filterReadableDocuments(userId, [documentId]);
    return readable.has(documentId);
  }

  /**
   * 批量文档可读判定（常数次查询，禁止 N+1）。
   * 返回可读 documentId 集合，语义与 isDocumentReadable / app_document_readable 对齐：
   * kbAdmin/owner 恒可读；空 ACL 继承 KB 可见性；有 ACL 则 deny-by-default。
   */
  async filterReadableDocuments(
    userId: string,
    docIds: string[],
    opts: FilterReadableDocsOpts = {},
  ): Promise<Set<string>> {
    const readable = new Set<string>();
    if (!userId) return readable;
    const ids = [
      ...new Set(
        (docIds || []).filter((id) => typeof id === "string" && id.length > 0),
      ),
    ];
    if (!ids.length) return readable;
    const p = this.prisma as any;

    // 1) 文档 → kbId 映射。opts.docs 为权威集合（调用方刚查过 Document，
    //    未在其中的 id 直接视为不可读，不再回表，避免打乱调用方的查询序列）；
    //    未提供时批量查一次 Document。
    const docById = new Map<string, { id: string; kbId: string | null }>();
    if (opts.docs) {
      for (const d of opts.docs) {
        if (d?.id) {
          docById.set(String(d.id), { id: String(d.id), kbId: d.kbId ? String(d.kbId) : null });
        }
      }
    } else {
      if (!p?.document?.findMany) return readable;
      const rows = await p.document.findMany({
        where: { id: { in: ids } },
        select: { id: true, kbId: true },
      });
      for (const row of rows || []) {
        docById.set(String(row.id), { id: String(row.id), kbId: String(row.kbId) });
      }
    }
    const targets = ids
      .map((id) => docById.get(id))
      .filter((d): d is { id: string; kbId: string | null } => Boolean(d));
    if (!targets.length) return readable;
    const targetIds = targets.map((d) => d.id);
    const kbIds = [...new Set(targets.map((d) => d.kbId).filter((v): v is string => Boolean(v)))];

    // 2) 一次取齐 ACL 行 / 角色 / 组织 / 管理员 / 库 owner（全部批量，无 N+1）。
    const [aclRows, roleRows, orgRows, adminRows, kbRows] = await Promise.all([
      p?.documentAcl?.findMany
        ? withServiceContext(p, (tx) => tx.documentAcl.findMany({
            where: { documentId: { in: targetIds } },
            select: { documentId: true, subjectType: true, subjectId: true },
          }))
        : [],
      p?.userRole?.findMany
        ? p.userRole.findMany({ where: { userId }, select: { roleId: true } })
        : [],
      p?.userOrg?.findMany
        ? p.userOrg.findMany({ where: { userId }, select: { orgNodeId: true } })
        : [],
      p?.kbAdmin?.findMany
        ? p.kbAdmin.findMany({
            where: { kbId: { in: kbIds }, userId },
            select: { kbId: true },
          })
        : [],
      p?.knowledgeBase?.findMany
        ? p.knowledgeBase.findMany({
            where: { id: { in: kbIds } },
            select: { id: true, ownerUserId: true },
          })
        : [],
    ]);

    const visibleKbIds = new Set<string>(
      opts.visibleKbIds ??
        (this.permissionService
          ? await this.permissionService.getVisibleKnowledgeBases(userId)
          : []),
    );
    const adminKbIds = new Set<string>(
      (adminRows || []).map((r: any) => String(r.kbId)),
    );
    const ownerKbIds = new Set<string>(
      (kbRows || [])
        .filter((r: any) => r.ownerUserId === userId)
        .map((r: any) => String(r.id)),
    );
    const subjects = new Set<string>([`user:${userId}`]);
    for (const r of roleRows || []) subjects.add(`role:${r.roleId}`);
    for (const r of orgRows || []) subjects.add(`org:${r.orgNodeId}`);
    const aclsByDoc = new Map<
      string,
      Array<{ subjectType: string; subjectId: string }>
    >();
    for (const row of aclRows || []) {
      const key = String((row as any).documentId);
      const list = aclsByDoc.get(key) || [];
      list.push(row as any);
      aclsByDoc.set(key, list);
    }

    for (const doc of targets) {
      // kbAdmin / KB owner 恒可读（覆盖 ACL 拒绝与 KB 可见性）。
      if (doc.kbId && (adminKbIds.has(doc.kbId) || ownerKbIds.has(doc.kbId))) {
        readable.add(doc.id);
        continue;
      }
      // KB 不可见 → 拒绝（与 app_document_readable 的前置门一致）。
      // opts.docs 场景下 kbId 可能缺失：调用方已按可见 KB 过滤过，跳过此门。
      if (doc.kbId && !visibleKbIds.has(doc.kbId)) continue;
      const acls = aclsByDoc.get(doc.id) || [];
      // 空 ACL = 继承 KB 可见性。
      if (!acls.length) {
        readable.add(doc.id);
        continue;
      }
      // 有 ACL → deny-by-default，仅显式主体可读。
      for (const acl of acls) {
        if (subjects.has(`${acl.subjectType}:${acl.subjectId}`)) {
          readable.add(doc.id);
          break;
        }
      }
    }
    return readable;
  }

  /** 写 ACL 的管理面：kb 管理员 / 库 owner / 系统管理员。 */
  async canManageAcl(userId: string, documentId: string): Promise<boolean> {
    if (!userId || !documentId) return false;
    if (await this.permissionService?.isSystemAdmin(userId)) return true;
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        kbId: true,
        kb: { select: { ownerUserId: true, status: true } },
      },
    });
    if (!doc || doc.kb?.status !== 'active') return false;
    if (doc.kb?.ownerUserId === userId) return true;
    const admin = await this.prisma.kbAdmin.findFirst({
      where: { kbId: doc.kbId, userId },
      select: { kbId: true },
    });
    return Boolean(admin);
  }
}
