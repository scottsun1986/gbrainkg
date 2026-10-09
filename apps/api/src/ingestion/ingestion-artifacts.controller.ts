import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { resolve, sep } from 'node:path';
import { getPrismaClient } from '../prisma';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { PermissionService } from '../permission/permission.service';
import { DocumentAclService } from '../permission/document-acl.service';
import { withAuthorizedRequest, assertAuthorizationSnapshot } from '../permission/authorization-revision';
import { INGESTION_CAPABILITIES } from './parser-capabilities';
import { IngestionService } from './ingestion.service';
import { DocumentLifecycleService } from './document-lifecycle.service';
import { immutableVersionsEnabled } from './document-version-store';
import { uploadRoot } from '../storage/upload-paths';

@UseGuards(AuthGuard)
@Controller('api/v1/kbs')
export class IngestionArtifactsController {
  private readonly db = getPrismaClient();
  constructor(private readonly auth: AuthService, private readonly permission: PermissionService,
    private readonly ingestion: IngestionService, private readonly lifecycle: DocumentLifecycleService) {}
  @Get('ingestion-capabilities')
  capabilities() { return INGESTION_CAPABILITIES; }

  private requireUuid(value:string) { if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw new BadRequestException('Valid resource UUID required'); }
  @Get('imports/:batchId')
  async batch(@Param('batchId') batchId: string, @Req() req: any) {
    this.requireUuid(batchId);const userId = await this.auth.userIdFromRequest(req);
    const batch = await (this.db as any).importBatch.findUnique({ where: { id: batchId } });
    if (!batch || !(await this.permission.getVisibleKnowledgeBases(userId)).includes(batch.kbId) || !await this.permission.canManageKnowledgeBase(userId, batch.kbId)) throw new NotFoundException('Import batch not found');
    const ids = batch.items.flatMap((item: any) => item.documentId ? [item.documentId] : []);
    const allowed = await new DocumentAclService(this.permission).filterReadableDocuments(userId, ids);
    const docs = await this.db.document.findMany({ where: { id: { in: [...allowed] }, kbId: batch.kbId }, select: { id: true, status: true, parserMetadata: true, qualityIssues: true } });
    return { ...batch, items: batch.items.map((item: any) => {
      if (!item.documentId) return item;
      const doc = docs.find(doc => doc.id === item.documentId);
      return doc ? { ...item, status: doc.status, coverage: (doc.parserMetadata as any)?.coverage, qualityIssues: doc.qualityIssues } : { path: item.path, status: 'skipped', reason: '文档已删除或无访问权限' };
    }) };
  }
  @Post('imports/:batchId/retry')
  async retryBatch(@Param('batchId') batchId: string, @Req() req: any, @Body() body: { paths: string[] }) {
    const batch = await this.batch(batchId, req);
    const userId = await this.auth.userIdFromRequest(req);
    if (!Array.isArray(body.paths) || body.paths.length > 500) throw new BadRequestException('paths required');
    const results = [];
    for (const path of [...new Set(body.paths)]) {
      const item = batch.items.find((item: any) => item.path === path);
      if (!item?.documentId) { results.push({ path, status: 'skipped', reason: '子文件无保留原件，请重新上传该子文件' }); continue; }
      try { const result = await this.lifecycle.retryDocument(userId, batch.kbId, item.documentId); results.push({ path, ...result }); }
      catch (error) { results.push({ path, status: 'failed', reason: error instanceof Error ? error.message : String(error) }); }
    }
    return { results };
  }

  @Post(':kbId/documents/:docId/retry-units')
  async retryUnits(@Param('kbId') kbId: string, @Param('docId') docId: string, @Req() req: any, @Body() body: { unitIds: string[] }) {
    this.requireUuid(kbId);this.requireUuid(docId);const userId = await this.auth.userIdFromRequest(req);
    if (!await this.permission.canManageKnowledgeBase(userId, kbId) || !await new DocumentAclService(this.permission).isDocumentReadable(userId, docId)) throw new ForbiddenException('Document management required');
    const doc = await this.db.document.findFirst({ where: { id: docId, kbId, kb: { status: 'active' } } });
    if (!doc?.rawFileOid) throw new NotFoundException('Document not found');
    const units = (doc.parserMetadata as any)?.source_units || [];
    if (!Array.isArray(body.unitIds) || !body.unitIds.length || body.unitIds.some(id => !units.some((unit: any) => unit.id === id))) throw new BadRequestException('Known source unit IDs required');
    const updated = await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${docId}::uuid FOR UPDATE`;
      const current = await tx.document.findUnique({ where: { id:docId } });
      if (!current || current.version !== doc.version || current.contentHash !== doc.contentHash || current.pendingRawFileOid || current.buildingVersionId) throw new BadRequestException('Document input changed or a build is pending; retry after it settles');
      return tx.document.update({ where: { id: docId }, data: {
      ...(immutableVersionsEnabled() ? { ingestVersion: { increment: 1 }, ...(!doc.activeVersionId ? { status: 'parsing' } : {}) } : { version: { increment: 1 }, status: 'parsing' }),
      parserMetadata: { ...(doc.parserMetadata as any), retry_units: body.unitIds, retry_base: { version:doc.version, contentHash:doc.contentHash, mdPath:doc.mdPath } },
    } });
    });
    await this.ingestion.enqueue(docId, 'unit-retry', immutableVersionsEnabled() ? updated.ingestVersion || updated.version : updated.version);
    return { status: 'accepted', document: updated };
  }

  @Get(':kbId/documents/:docId/assets/:assetId')
  async asset(@Param('kbId') kbId: string, @Param('docId') docId: string, @Param('assetId') assetId: string,
    @Query('version') versionNumber: string, @Req() req: any, @Res() res: any) {
    this.requireUuid(docId);if(kbId!=='_')this.requireUuid(kbId);if(versionNumber&&!/^[1-9]\d*$/.test(versionNumber))throw new BadRequestException('Valid asset version required');
    const userId = await this.auth.userIdFromRequest(req);
    return withAuthorizedRequest(userId, async snapshot => {
      if (!await new DocumentAclService(this.permission).isDocumentReadable(userId, docId)) throw new NotFoundException('Asset not found');
      const doc = await this.db.document.findFirst({ where: { id: docId, ...(kbId !== '_' ? { kbId } : {}), kb: { status: 'active' } } });
      if (!doc) throw new NotFoundException('Asset not found');
      let metadata: any = doc.parserMetadata;
      if (versionNumber && Number(versionNumber) !== doc.version) {
        const version = await this.db.documentVersion.findFirst({ where: { documentId: docId, number: Number(versionNumber), state: 'published' } });
        if (!version) throw new NotFoundException('Published asset version not found');
        metadata = (version.publicationData as any)?.parserMetadata;
      }
      const asset = [...(metadata?.assets || []), ...(metadata?.package_assets || [])].find(asset => asset.id === assetId);
      if (!asset?.path || !/^image\/(?:png|jpeg|webp|tiff|bmp|gif)$/.test(asset.mime)) throw new NotFoundException('Asset not found');
      const root = resolve(uploadRoot(), docId); const path = resolve(uploadRoot(), asset.path);
      if (!path.startsWith(root + sep)) throw new BadRequestException('Invalid asset path');
      await assertAuthorizationSnapshot(userId, snapshot);
      res.setHeader('Content-Type', asset.mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, no-store');
      const stream = createReadStream(path); stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); }); stream.pipe(res);
    });
  }
}
