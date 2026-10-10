import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { getPrismaClient } from '../prisma';
import { PermissionService } from './permission.service';
import {
  AclEntryInput,
  AclMode,
  DocumentAclService,
  normalizeAclEntry,
} from './document-acl.service';

@UseGuards(AuthGuard)
@Controller('api/v1/documents')
export class DocumentAclController {
  private readonly prisma = getPrismaClient();

  constructor(
    private readonly documentAcl: DocumentAclService,
    private readonly permissionService: PermissionService,
  ) {}

  private async loadDocumentOrThrow(documentId: string) {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, kbId: true, aclMode: true },
    });
    if (!doc) throw new NotFoundException('document not found');
    return doc;
  }

  /**
   * Documents the caller cannot see must be indistinguishable from documents
   * that do not exist: the rest of the surface already answers 404 for a
   * knowledge base that is not visible, so a 403 here would confirm that the
   * id exists and belongs to somebody else.
   */
  private async loadVisibleDocumentOrThrow(documentId: string, userId: string) {
    const doc = await this.loadDocumentOrThrow(documentId);
    if (!(await this.permissionService.getVisibleKnowledgeBases(userId)).includes(doc.kbId)) {
      throw new NotFoundException('document not found');
    }
    return doc;
  }

  private parseEntries(entries: unknown): AclEntryInput[] {
    if (!Array.isArray(entries)) {
      throw new BadRequestException('entries must be an array');
    }
    try {
      return entries.map((entry) => normalizeAclEntry(entry));
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'invalid acl entry',
      );
    }
  }

  @Get(':id/acl-subjects')
  async subjects(@Param('id') id: string, @Req() req: any, @Query('type') type: string, @Query('q') search: string) {
    await this.loadVisibleDocumentOrThrow(id, (req.user?.id as string));
    if (!await this.documentAcl.canManageAcl(req.user?.id, id)) throw new ForbiddenException('Document ACL management required');
    const q = String(search || '').trim().slice(0, 80);
    if (q.length < 2) return [];
    // Managers may resolve a name to a grant target; never return credentials or personal contact details.
    if (type === 'user') return (await this.prisma.user.findMany({ where: { status: 'active', OR: [{ displayName: { contains: q, mode: 'insensitive' } }, { username: { contains: q, mode: 'insensitive' } }] }, select: { id: true, displayName: true, username: true }, take: 30, orderBy: { displayName: 'asc' } })).map(u => ({ id: u.id, name: u.displayName || u.username }));
    if (type === 'role') return this.prisma.role.findMany({ where: { name: { contains: q, mode: 'insensitive' } }, select: { id: true, name: true }, take: 30, orderBy: { name: 'asc' } });
    if (type === 'org') return this.prisma.orgNode.findMany({ where: { name: { contains: q, mode: 'insensitive' } }, select: { id: true, name: true }, take: 30, orderBy: { name: 'asc' } });
    throw new BadRequestException('Unknown subject type');
  }

  @Get(':id/acl')
  async list(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id as string;
    const doc = await this.loadVisibleDocumentOrThrow(id, (req.user?.id as string));
    const readable = await this.documentAcl.isDocumentReadable(userId, id);
    const canManage = await this.documentAcl.canManageAcl(userId, id);
    if (!readable && !canManage) {
      throw new ForbiddenException('document is not readable');
    }
    return { aclMode: doc.aclMode, entries: await this.documentAcl.list(id) };
  }

  /** 全量替换 ACL（kb 管理员 / 系统管理员）。 */
  @Put(':id/acl')
  async replace(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { entries?: unknown; aclMode?: AclMode },
  ) {
    const userId = req.user?.id as string;
    await this.loadVisibleDocumentOrThrow(id, (req.user?.id as string));
    if (!(await this.documentAcl.canManageAcl(userId, id))) {
      throw new ForbiddenException('kb admin or system admin required');
    }
    const entries = this.parseEntries(body?.entries ?? []);
    const mode = body?.aclMode ?? 'restricted';
    if (!['inherit', 'restricted'].includes(mode) || (mode === 'inherit' && entries.length)) {
      throw new BadRequestException('aclMode must be inherit with no entries, or restricted');
    }
    return { aclMode: mode, entries: await this.documentAcl.replaceAll(id, entries, mode) };
  }

  /** 增量添加一条 ACL。 */
  @Post(':id/acl')
  async add(@Param('id') id: string, @Req() req: any, @Body() body: unknown) {
    const userId = req.user?.id as string;
    await this.loadVisibleDocumentOrThrow(id, (req.user?.id as string));
    if (!(await this.documentAcl.canManageAcl(userId, id))) {
      throw new ForbiddenException('kb admin or system admin required');
    }
    let entry: AclEntryInput;
    try {
      entry = normalizeAclEntry(body);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'invalid acl entry',
      );
    }
    const created = await this.documentAcl.add(id, entry);
    return { entry: created };
  }

  @Delete(':id/acl/:aclId')
  async remove(
    @Param('id') id: string,
    @Param('aclId') aclId: string,
    @Req() req: any,
  ) {
    const userId = req.user?.id as string;
    await this.loadVisibleDocumentOrThrow(id, (req.user?.id as string));
    if (!(await this.documentAcl.canManageAcl(userId, id))) {
      throw new ForbiddenException('kb admin or system admin required');
    }
    return this.documentAcl.remove(id, aclId);
  }
}
