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
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { getPrismaClient } from '../prisma';
import {
  AclEntryInput,
  DocumentAclService,
  normalizeAclEntry,
} from './document-acl.service';

@UseGuards(AuthGuard)
@Controller('api/v1/documents')
export class DocumentAclController {
  private readonly prisma = getPrismaClient();

  constructor(private readonly documentAcl: DocumentAclService) {}

  private async loadDocumentOrThrow(documentId: string) {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, kbId: true },
    });
    if (!doc) throw new NotFoundException('document not found');
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

  @Get(':id/acl')
  async list(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id as string;
    await this.loadDocumentOrThrow(id);
    const readable = await this.documentAcl.isDocumentReadable(userId, id);
    const canManage = await this.documentAcl.canManageAcl(userId, id);
    if (!readable && !canManage) {
      throw new ForbiddenException('document is not readable');
    }
    return { entries: await this.documentAcl.list(id) };
  }

  /** 全量替换 ACL（kb 管理员 / 系统管理员）。 */
  @Put(':id/acl')
  async replace(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { entries?: unknown },
  ) {
    const userId = req.user?.id as string;
    await this.loadDocumentOrThrow(id);
    if (!(await this.documentAcl.canManageAcl(userId, id))) {
      throw new ForbiddenException('kb admin or system admin required');
    }
    const entries = this.parseEntries(body?.entries ?? []);
    return { entries: await this.documentAcl.replaceAll(id, entries) };
  }

  /** 增量添加一条 ACL。 */
  @Post(':id/acl')
  async add(@Param('id') id: string, @Req() req: any, @Body() body: unknown) {
    const userId = req.user?.id as string;
    await this.loadDocumentOrThrow(id);
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
    await this.loadDocumentOrThrow(id);
    if (!(await this.documentAcl.canManageAcl(userId, id))) {
      throw new ForbiddenException('kb admin or system admin required');
    }
    return this.documentAcl.remove(aclId);
  }
}
