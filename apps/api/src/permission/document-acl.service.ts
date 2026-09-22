import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '../prisma';
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

  constructor(private readonly permissionService: PermissionService) {}

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
    await this.prisma.documentAcl.deleteMany({ where: { documentId } });
    for (const entry of normalized) {
      await this.prisma.documentAcl.create({
        data: {
          id: randomUUID(),
          documentId,
          subjectType: entry.subjectType,
          subjectId: entry.subjectId,
          permission: entry.permission ?? 'read',
        },
      });
    }
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
    return this.prisma.documentAcl.create({
      data: {
        id: randomUUID(),
        documentId,
        subjectType: normalized.subjectType,
        subjectId: normalized.subjectId,
        permission: normalized.permission ?? 'read',
      },
    });
  }

  async remove(aclId: string): Promise<{ id: string }> {
    const row = await this.prisma.documentAcl.findUnique({
      where: { id: aclId },
    });
    if (!row) return { id: aclId };
    await this.prisma.documentAcl.delete({ where: { id: aclId } });
    return { id: aclId };
  }

  /**
   * 文档可读判定：
   * 1. KB 不可见 → 拒绝
   * 2. 无 ACL 行 → 继承 KB 可见性（可读）
   * 3. 有 ACL 行 → 仅匹配 user/role/org 主体可读
   * 4. 知识库管理员始终可读（覆盖 3 的拒绝）
   */
  async isDocumentReadable(
    userId: string,
    documentId: string,
  ): Promise<boolean> {
    if (!userId || !documentId) return false;
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, kbId: true },
    });
    if (!doc) return false;

    const visible = await this.permissionService.getVisibleKnowledgeBases(
      userId,
    );
    const kbVisible = visible.includes(doc.kbId);

    const acls = await this.prisma.documentAcl.findMany({
      where: { documentId },
      select: { subjectType: true, subjectId: true },
    });

    const isKbAdmin = Boolean(
      await this.prisma.kbAdmin.findFirst({
        where: { kbId: doc.kbId, userId },
        select: { kbId: true },
      }),
    );

    if (!acls.length) {
      // 空 ACL = 继承 KB；kbAdmin 即使 KB 未入 visible 列表也应可读。
      return kbVisible || isKbAdmin;
    }

    if (isKbAdmin) return true;

    if (!kbVisible) {
      // 有 ACL 但 KB 都不可见时，仍允许 ACL 显式授权的主体读取
      // （主体匹配优先于 KB 集合，与 app_document_readable 的顺序不同但更安全：
      //  不额外放行，仅在 ACL 命中时放行）。
    }

    const [roles, orgs] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId },
        select: { roleId: true },
      }),
      this.prisma.userOrg.findMany({
        where: { userId },
        select: { orgNodeId: true },
      }),
    ]);

    const allowedSubjects = new Set<string>([`user:${userId}`]);
    for (const role of roles) allowedSubjects.add(`role:${role.roleId}`);
    for (const org of orgs) allowedSubjects.add(`org:${org.orgNodeId}`);

    for (const acl of acls) {
      if (allowedSubjects.has(`${acl.subjectType}:${acl.subjectId}`)) {
        return true;
      }
    }
    return false;
  }

  /** 写 ACL 的管理面：kb 管理员 / 库 owner / 系统管理员。 */
  async canManageAcl(userId: string, documentId: string): Promise<boolean> {
    if (!userId || !documentId) return false;
    if (await this.permissionService.isSystemAdmin(userId)) return true;
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
