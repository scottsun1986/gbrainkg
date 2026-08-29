import { BadRequestException, Controller, Delete, ForbiddenException, Headers, NotFoundException, OnModuleInit, Param, Post, Req, UnauthorizedException, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PermissionService } from '../permission/permission.service';
import { AuthService } from '../auth/auth.service';
import { BrainCompilerService } from '../brain-compiler/brain-compiler.service';
import { splitMarkdownIntoChunks } from './markdown-chunker';

function normalizeUploadFilename(value: unknown): string {
  const raw = String(value || 'upload.bin').replace(/[\\/]/g, '_');
  // Some multipart clients expose a UTF-8 filename as a Latin-1 string, e.g. "æµè¯.pdf".
  if (/[ÃÂà-ÿ]/.test(raw)) {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    if (!decoded.includes('�')) return decoded.replace(/[\\/]/g, '_');
  }
  try {
    if (/%[0-9a-f]{2}/i.test(raw)) return decodeURIComponent(raw).replace(/[\\/]/g, '_');
  } catch { /* keep the original filename when it is not valid URI encoding */ }
  return raw;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

@Controller('api/v1/kbs')
export class IngestionController implements OnModuleInit {
  private readonly prisma = new PrismaClient();
  private readonly uploadRoot = process.env.UPLOAD_ROOT || '/tmp/llmwiki/uploads';
  private readonly parserUrl = (process.env.PARSER_WORKER_URL || 'http://127.0.0.1:8100').replace(/\/$/, '');

  constructor(
    private readonly permissionService: PermissionService,
    private readonly authService: AuthService,
    private readonly compilerService: BrainCompilerService,
  ) {}

  async onModuleInit() {
    // A process restart cannot resume an in-memory parser task. Reclassify
    // old records so they are visible as retryable failures instead of
    // remaining in "解析中" forever. New uploads keep the full parser window.
    const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
    const stale = await this.prisma.document.updateMany({
      where: { status: { in: ['parsing', 'indexing'] }, updatedAt: { lt: staleBefore } },
      data: { status: 'failed' },
    });
    if (stale.count) console.warn(`[ingestion] marked ${stale.count} stale document(s) as failed; retry is available.`);
  }

  @Post(':kbId/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  async uploadDocument(
    @Param('kbId') kbId: string,
    @UploadedFile() file: any,
    @Req() req: any,
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    if (!file) throw new NotFoundException('A file is required.');

    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { id: true, type: true, ownerUserId: true, orgNodeId: true, status: true },
    });
    if (!kb || kb.status !== 'active') throw new NotFoundException('Knowledge base not found.');
    const visible = await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visible.includes(kbId)) throw new ForbiddenException('Knowledge base is not visible to this user.');
    const canWrite = await this.permissionService.canManageKnowledgeBase(userId, kbId);
    if (!canWrite) throw new ForbiddenException('Only the knowledge base owner or administrator can upload.');

    const documentId = randomUUID();
    const filename = normalizeUploadFilename(file.originalname);
    const rawPath = `${documentId}/${filename}`;
    await mkdir(join(this.uploadRoot, documentId), { recursive: true });
    await writeFile(join(this.uploadRoot, rawPath), file.buffer);
    const document = await this.prisma.document.create({
      data: {
        id: documentId,
        kbId,
        mdPath: `${documentId}/content.md`,
        title: filename,
        sourceType: 'upload',
        rawFileOid: join(this.uploadRoot, rawPath),
        uploadedById: userId,
        status: 'parsing',
      },
    });
    void this.parseAndPublish(document.id, kbId, filename, file.buffer);
    return { documents: [document], status: 'accepted' };
  }

  @Post(':kbId/documents/:docId/retry')
  async retryDocument(
    @Param('kbId') kbId: string,
    @Param('docId') docId: string,
    @Req() req: any,
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { id: true, type: true, ownerUserId: true, orgNodeId: true, status: true },
    });
    if (!kb || kb.status !== 'active') throw new NotFoundException('Knowledge base not found.');
    const visible = await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visible.includes(kbId)) throw new ForbiddenException('Knowledge base is not visible to this user.');
    const canWrite = await this.permissionService.canManageKnowledgeBase(userId, kbId);
    if (!canWrite) throw new ForbiddenException('Only the knowledge base owner or administrator can retry parsing.');

    const document = await this.prisma.document.findFirst({ where: { id: docId, kbId } });
    if (!document) throw new NotFoundException('Document not found.');
    if (document.status !== 'failed') throw new BadRequestException('Only failed documents can be retried.');
    if (!document.rawFileOid) throw new BadRequestException('Original upload is no longer available.');

    const content = await readFile(document.rawFileOid).catch(() => null);
    if (!content) throw new NotFoundException('Original upload is no longer available.');
    await this.prisma.document.update({ where: { id: docId }, data: { status: 'parsing' } });
    void this.parseAndPublish(docId, kbId, document.title, content);
    return { document: { ...document, status: 'parsing' }, status: 'accepted' };
  }

  @Delete(':kbId/documents/:docId')
  async deleteDocument(@Param('kbId') kbId: string, @Param('docId') docId: string, @Req() req: any) {
    const userId = await this.authService.userIdFromRequest(req);
    if (!isUuid(kbId) || !isUuid(docId)) throw new NotFoundException('Document not found.');
    const kb = await this.prisma.knowledgeBase.findUnique({ where: { id: kbId }, select: { id: true, type: true, ownerUserId: true, orgNodeId: true, status: true } });
    if (!kb || kb.status !== 'active') throw new NotFoundException('Knowledge base not found.');
    const visible = await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visible.includes(kbId)) throw new ForbiddenException('Knowledge base is not visible to this user.');
    if (!(await this.permissionService.canManageKnowledgeBase(userId, kbId))) throw new ForbiddenException('Only an organization administrator or knowledge base administrator can delete documents.');
    const document = await this.prisma.document.findFirst({ where: { id: docId, kbId }, select: { id: true, rawFileOid: true } });
    if (!document) throw new NotFoundException('Document not found.');
    await this.compilerService.onKnowledgeDeleted(kbId, docId);
    await this.prisma.document.delete({ where: { id: docId } });
    if (document.rawFileOid) await unlink(document.rawFileOid).catch(() => undefined);
    return { ok: true, documentId: docId };
  }

  private async parseAndPublish(documentId: string, kbId: string, filename: string, content: Buffer) {
    try {
      const form = new FormData();
      const fileBytes = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
      form.append('file', new Blob([fileBytes]), filename);
      const queued = await fetch(`${this.parserUrl}/parse?parser_type=plain`, { method: 'POST', body: form });
      if (!queued.ok) throw new Error(`Parser rejected upload: ${queued.status}`);
      const { task_id: taskId } = await queued.json() as { task_id: string };

      let parsed: any;
      // 首次加载 Docling 版面模型可能需要数分钟；30 秒会把仍在正常
      // 处理的 PDF 误判为失败。
      for (let attempt = 0; attempt < 600; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const response = await fetch(`${this.parserUrl}/parse/${taskId}`);
        if (!response.ok) throw new Error(`Parser status failed: ${response.status}`);
        parsed = await response.json();
        if (parsed.status === 'completed' || parsed.status === 'failed') break;
      }
      if (!parsed || parsed.status !== 'completed') throw new Error(parsed?.error || 'Parser timed out.');

      const markdown = String(parsed.markdown || '').trim();
      if (!markdown) throw new Error('Parser returned empty Markdown.');
      const chunks = splitMarkdownIntoChunks(markdown);
      if (!chunks.length) throw new Error('Parser returned no indexable content.');
      await this.prisma.$transaction([
        this.prisma.chunk.deleteMany({ where: { documentId } }),
        this.prisma.chunk.createMany({
          data: chunks.map((chunk) => ({
            documentId,
            kbId,
            ord: chunk.ord,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd,
            metadata: chunk.metadata as any,
          })),
        }),
        // 解析完成不等于已进入 GBrain；只有 source 同步成功后才标记 published。
        this.prisma.document.update({ where: { id: documentId }, data: { status: 'indexing' } }),
      ]);
      const topic = filename.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}\-_ ]/gu, '').trim() || documentId;
      const queuedJobs = await this.compilerService.onKnowledgePublished(kbId, documentId, [topic]);
      // 没有任何可见用户时没有需要执行的 source 同步任务，避免文档永久停留在 indexing。
      if (!queuedJobs) {
        await this.prisma.document.update({ where: { id: documentId }, data: { status: 'published' } });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.document.update({ where: { id: documentId }, data: { status: 'failed' } }).catch(() => undefined);
      console.error(`[ingestion] document ${documentId} failed: ${message}`);
    }
  }
}
