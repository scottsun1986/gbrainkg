import {
  BadRequestException,
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
import { PermissionService } from '../permission/permission.service';
import { getPrismaClient } from '../prisma';
import { VersionChainService } from './version-chain.service';
import { DocumentAclService } from '../permission/document-acl.service';

@UseGuards(AuthGuard)
@Controller('api/v1/documents')
export class DocumentVersionController {
  private prisma = getPrismaClient();

  constructor(
    private readonly versionChain: VersionChainService,
    private readonly permissionService: PermissionService,
  ) {}

  private async assertCanRead(userId: string, documentId: string) {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, kbId: true },
    });
    if (!doc) throw new NotFoundException('document not found');
    const visibleKbs = await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visibleKbs.includes(doc.kbId) || !await new DocumentAclService(this.permissionService).isDocumentReadable(userId, documentId)) {
      throw new ForbiddenException('无权访问该文档');
    }
  }

  private async assertCanWrite(userId: string, documentId: string) {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, kbId: true, kb: { select: { ownerUserId: true, type: true } } },
    });
    if (!doc) throw new NotFoundException('document not found');
    const isAdmin = await this.prisma.userRole.findFirst({
      where: {
        userId,
        role: { code: { in: ['system_admin', 'super_admin'] } },
      },
    });
    const isKbAdmin = await this.prisma.kbAdmin.findUnique({
      where: { kbId_userId: { kbId: doc.kbId, userId } },
    });
    const isOwner = doc.kb?.ownerUserId === userId;
    if ((doc.kb?.type === 'personal' && !isOwner) || (!isAdmin && !isKbAdmin && !isOwner)) {
      throw new ForbiddenException('kb admin or owner required');
    }
    return doc;
  }

  @Post(':id/replay-failed-artifacts')
  async replayFailed(@Param('id') id: string, @Req() req: any) {
    await this.assertCanWrite(req.user.id, id);
    const doc = await this.prisma.document.findUniqueOrThrow({ where: { id } });
    const events = await this.prisma.brainChangeEvent.findMany({ where: { resourceId: id, status: 'failed', eventType: { in: ['enrichment_request','aux_enrichment_request'] } }, take: 100 });
    const replayed = [];
    for (const event of events) {
      const payload = event.payload as any;
      const validVersion = payload?.versionId ? [doc.activeVersionId,doc.buildingVersionId].includes(payload.versionId) : payload?.version === doc.version;
      if (!validVersion) continue;
      replayed.push(await this.prisma.brainChangeEvent.create({ data: { eventType: event.eventType, resourceType: event.resourceType, resourceId: id, status: 'pending', payload: { ...payload, replayOf: event.id } } }));
    }
    return { queued: replayed.length, eventIds: replayed.map(e => e.id) };
  }

  @Get(':id/index-generations')
  async generations(@Param('id') id: string, @Req() req: any) {
    await this.assertCanWrite(req.user.id, id);
    const doc = await this.prisma.document.findUniqueOrThrow({ where: { id } });
    return doc.activeVersionId ? this.prisma.indexGeneration.findMany({ where: { versionId: doc.activeVersionId, channel: 'dense' } }) : [];
  }

  @Post(':id/index-generations')
  async generationRequest(@Param('id') id: string, @Req() req: any, @Body() body: any) {
    await this.assertCanWrite(req.user.id, id);
    if (!['build','activate'].includes(body?.action)) throw new BadRequestException('action must be build or activate');
    const doc = await this.prisma.document.findUniqueOrThrow({ where: { id } });
    if (!doc.activeVersionId) throw new BadRequestException('Published immutable version required');
    if (body.action === 'activate') {
      if (typeof body.generationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.generationId)) throw new BadRequestException('generationId required');
      const generation = await this.prisma.indexGeneration.findUnique({ where: { id: body.generationId } });
      if (!generation || generation.versionId !== doc.activeVersionId || generation.channel !== 'dense' || generation.state !== 'ready') throw new BadRequestException('Complete matching dense generation required');
    }
    return this.prisma.brainChangeEvent.create({ data: { eventType: 'enrichment_request', resourceType: 'document', resourceId: id, status: 'pending',
      payload: { kbId: doc.kbId, version: doc.version, versionId: doc.activeVersionId, generationAction: body.action, ...(body.generationId ? { generationId: body.generationId } : {}) } } });
  }

  @Get(':id/chain')
  async chain(@Param('id') id: string, @Req() req: any) {
    const userId = req.user.id as string;
    await this.assertCanRead(userId, id);
    return this.versionChain.listChain(id);
  }

  /** 既有文档升版：创建新 version 并 supersedes 旧版。 */
  @Post(':id/versions')
  async publishVersion(@Param('id') id: string, @Req() req: any, @Body() body: any) {
    const userId = req.user.id as string;
    await this.assertCanWrite(userId, id);
    const doc = await this.prisma.document.findUniqueOrThrow({ where: { id } });
    if ((body.mdPath && body.mdPath !== doc.mdPath) || (body.objectKey && body.objectKey !== doc.objectKey && body.objectKey !== doc.rawFileOid)) {
      throw new BadRequestException('Upload the replacement through the document ingestion API; source paths cannot be reassigned');
    }
    const parseDate = (value: unknown): Date | undefined => {
      if (value === undefined || value === null || value === '') return undefined;
      const date = new Date(String(value));
      if (!Number.isFinite(date.getTime())) throw new BadRequestException('Invalid effective date');
      return date;
    };
    const effectiveFrom = parseDate(body.effectiveFrom);
    const effectiveTo = parseDate(body.effectiveTo);
    if (effectiveFrom && effectiveTo && effectiveFrom >= effectiveTo) throw new BadRequestException('effectiveTo must follow effectiveFrom');
    return this.versionChain.createVersion({
      kbId: doc.kbId,
      documentId: id,
      title: body.title || doc.title,
      mdPath: body.mdPath || doc.mdPath,
      sourceType: body.sourceType || doc.sourceType,
      uploadedById: userId,
      objectKey: doc.rawFileOid || undefined,
      storageProvider: "local",
      contentHash: doc.contentHash || undefined,
      sourceExternalId: body.sourceExternalId ?? doc.sourceExternalId,
      sensitivity: body.sensitivity ?? doc.sensitivity,
      language: body.language ?? doc.language,
      effectiveFrom,
      effectiveTo,
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
