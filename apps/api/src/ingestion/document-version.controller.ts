import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { getPrismaClient } from '../prisma';
import { VersionChainService } from './version-chain.service';

@UseGuards(AuthGuard)
@Controller('api/v1/documents')
export class DocumentVersionController {
  private prisma = getPrismaClient();

  constructor(private readonly versionChain: VersionChainService) {}

  private async assertCanWrite(userId: string, documentId: string) {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, kbId: true, kb: { select: { ownerUserId: true, type: true } } },
    });
    if (!doc) throw new NotFoundException('document not found');
    const isAdmin = await this.prisma.userRole.findFirst({
      where: {
        userId,
        role: { name: { in: ['系统管理员', '超级管理员'] } },
      },
    });
    const isKbAdmin = await this.prisma.kbAdmin.findUnique({
      where: { kbId_userId: { kbId: doc.kbId, userId } },
    });
    const isOwner = doc.kb?.ownerUserId === userId;
    if (!isAdmin && !isKbAdmin && !isOwner) {
      throw new ForbiddenException('kb admin or owner required');
    }
    return doc;
  }

  @Get(':id/chain')
  async chain(@Param('id') id: string) {
    return this.versionChain.listChain(id);
  }

  /** 既有文档升版：创建新 version 并 supersedes 旧版。 */
  @Post(':id/versions')
  async publishVersion(@Param('id') id: string, @Req() req: any, @Body() body: any) {
    const userId = req.user.id as string;
    await this.assertCanWrite(userId, id);
    const doc = await this.prisma.document.findUniqueOrThrow({ where: { id } });
    return this.versionChain.createVersion({
      kbId: doc.kbId,
      documentId: id,
      title: body.title || doc.title,
      mdPath: body.mdPath || doc.mdPath,
      sourceType: body.sourceType || doc.sourceType,
      uploadedById: userId,
      objectKey: body.objectKey,
      storageProvider: body.storageProvider,
      contentHash: body.contentHash,
      sourceExternalId: body.sourceExternalId ?? doc.sourceExternalId,
      sensitivity: body.sensitivity ?? doc.sensitivity,
      language: body.language ?? doc.language,
      effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : undefined,
      effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : undefined,
      relation: body.relation,
    });
  }

  @Patch(':id/sensitivity')
  async setSensitivity(@Param('id') id: string, @Req() req: any, @Body() body: any) {
    const userId = req.user.id as string;
    await this.assertCanWrite(userId, id);
    const allowed = ['public', 'internal', 'secret'];
    const sensitivity = String(body?.sensitivity || '');
    if (!allowed.includes(sensitivity)) {
      throw new ForbiddenException(`sensitivity must be one of ${allowed.join('/')}`);
    }
    const doc = await this.prisma.document.update({
      where: { id },
      data: { sensitivity },
      select: { id: true, sensitivity: true },
    });
    return doc;
  }
}
