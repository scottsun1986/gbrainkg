import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Prisma } from '@prisma/client';
import { getPrismaClient } from '../prisma';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { PermissionService } from '../permission/permission.service';
import { DocumentAclService } from '../permission/document-acl.service';
import { IngestionService } from './ingestion.service';
import { immutableVersionsEnabled } from './document-version-store';
import { uploadRoot, resolveUploadPath } from '../storage/upload-paths';
import { instanceIdentity } from '../observability/instance-identity';
import { withSystemWrite } from '../db/tenant-context.service';
import { previewQaRows, previewQaText, QaMapping, validateQa, qaConflictKey } from './qa-import';

@UseGuards(AuthGuard)
@Controller('api/v1/kbs/:kbId/qa')
export class QaController {
  private readonly db = getPrismaClient();
  constructor(private readonly auth: AuthService, private readonly permission: PermissionService, private readonly ingestion: IngestionService) {}
  private async manage(req: any, kbId: string) {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(kbId);
    // Without this the Prisma client raises its own validation error, which the
    // exception filter does not map, so every malformed id becomes a 500.
    if (!uuid) throw new NotFoundException('Knowledge base not found');
    const userId = await this.auth.userIdFromRequest(req);
    const kb = await this.db.knowledgeBase.findFirst({ where: { id: kbId, status: 'active' } });
    if (!kb) throw new NotFoundException('Knowledge base not found');
    if (!(await this.permission.getVisibleKnowledgeBases(userId)).includes(kbId) || !await this.permission.canManageKnowledgeBase(userId, kbId)) throw new ForbiddenException('Knowledge base management required');
    return userId;
  }
  @Post('preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async preview(@Param('kbId') kbId: string, @Req() req: any, @UploadedFile() file: any, @Body() body: { mapping?: string }) {
    const userId = await this.manage(req, kbId);
    if (!file?.buffer?.length) throw new BadRequestException('QA file required');
    let mapping: QaMapping;
    try { mapping = JSON.parse(body.mapping || '{}'); } catch { throw new BadRequestException('Invalid field mapping'); }
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new BadRequestException('Invalid field mapping');
    const extension = extname(file.originalname).toLowerCase(); let preview: ReturnType<typeof previewQaRows>;
    if (['.csv', '.jsonl'].includes(extension)) preview = previewQaText(file.buffer, extension, mapping);
    else if (['.xlsx', '.xls'].includes(extension)) {
      const form = new FormData(); form.append('file', new Blob([file.buffer]), file.originalname); form.append('instance_id', instanceIdentity()); form.append('small_table_rows', '501');
      const token = process.env.PARSER_AUTH_TOKEN || process.env.AUTH_TOKEN;
      const response = await fetch(`${(process.env.PARSER_WORKER_URL || 'http://127.0.0.1:8100').replace(/\/$/, '')}/parse-execute?parser_type=auto`, { method: 'POST', body: form, headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new BadRequestException('QA workbook parsing failed');
      const parsed: any = await response.json(); const tables = parsed.structured_tables || [];
      if (tables.length !== 1) throw new BadRequestException('QA 导入请选择仅含一个表的工作表，避免字段跨表错配');
      const table = tables[0];
      if (!table.complete || table.artifact_id || table.row_count > 501) throw new BadRequestException('QA 表格超过预览预算，请分批导入');
      preview = previewQaRows(table.headers, table.rows.filter((row: any) => !row.is_header).map((row: any) => ({ line: row.row, data: table.headers.map((_v: any, index: number) => {
        const cell = row.cells.find((cell: any) => Number(cell.column) === (table.header_columns?.[index] ?? index + 1));
        return cell?.value ?? cell?.display ?? '';
      }) })), mapping);
    } else throw new BadRequestException('QA supports CSV/XLS/XLSX/JSONL');
    // Conflict detection only needs the conflict key and ID, so bound the query
    // instead of materialising every question and answer in the knowledge base.
    const existing = await this.db.document.findMany({ where: { kbId, sourceType: 'qa' }, orderBy: { updatedAt: 'desc' }, take: 1000, select: { id: true, sourceExternalId: true, title: true, parserMetadata: true } });
    for (const row of preview.rows) {
      const match = existing.find(doc => (doc.parserMetadata as any)?.qa && qaConflictKey((doc.parserMetadata as any).qa) === qaConflictKey(row));
      if (match && (match.parserMetadata as any)?.qa?.answer !== row.answer && (match.sourceExternalId !== row.id || !row.idProvided) && await new DocumentAclService(this.permission).isDocumentReadable(userId, match.id)) {
        row.errors.push('已存在同题不同答案，请映射原 QA ID 后明确更新'); (row as any).conflict = true;
      }
    }
    return { ...preview, errors: preview.rows.flatMap(row => row.errors.map(error => ({ line: row.line, error }))), validCount: preview.rows.filter(row => !row.errors.length).length };
  }

  @Get()
  async list(@Param('kbId') kbId: string, @Req() req: any) {
    const userId = await this.manage(req, kbId);
    // ACL must narrow before truncation; KB managers do not automatically
    // receive restricted document content.
    // The list is a management view, so bound the inventory rather than loading
    // every QA document in the knowledge base into memory.
    const inventory = await this.db.document.findMany({ where: { kbId, sourceType: 'qa' }, orderBy: { updatedAt: 'desc' }, take: 500 });
    // Probe: an expired candidate must stay visible so a maintainer can update or retire it.
    const allowed = await new DocumentAclService(this.permission).filterReadableDocuments(userId, inventory.map(d => d.id), { docs: inventory, probe: true });
    const docs = inventory.filter(doc => allowed.has(doc.id)).slice(0, 500);
    const items = [];
    for (const doc of docs) {
      const inputQa = await readFile(resolveUploadPath(doc.pendingRawFileOid || doc.rawFileOid || ''), 'utf8').then(JSON.parse).catch(() => (doc.parserMetadata as any)?.qa);
      const activeQa = doc.status === 'published' ? (doc.parserMetadata as any)?.qa || null : null;
      const hasPending = !!doc.pendingRawFileOid || !activeQa;
      const pendingQa = hasPending ? inputQa : null;
      const qa = pendingQa || activeQa;
      const qaState = pendingQa ? pendingQa.reviewStatus !== 'approved' ? 'needs_review' : (doc.parserMetadata as any)?.pendingError ? 'failed' : 'indexing' : doc.status;
      items.push({ ...doc, qa, activeQa, pendingQa, qaState, displayVersion:hasPending ? doc.ingestVersion || doc.version : doc.version,
        displayEffectiveFrom:qa?.effectiveFrom || null, displayEffectiveTo:qa?.effectiveTo || null,
        rawFileOid:undefined,pendingRawFileOid:undefined });
    }
    return { items };
  }

  @Post('import')
  async import(@Param('kbId') kbId: string, @Req() req: any, @Body() body: { rows: any[]; reviewed?: boolean; expectedVersion?: number; expectedHash?: string }) {
    const userId = await this.manage(req, kbId);
    if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 500) throw new BadRequestException('QA rows must contain 1–500 items');
    const records = body.rows.map(validateQa);
    const ids = records.map(row => row.record.id);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('重复 QA ID，需先解决冲突');
    const conflictGroups = new Map<string, Set<string>>();
    for (const row of records) { const key = qaConflictKey(row.record); const answers = conflictGroups.get(key) || new Set<string>(); answers.add(row.record.answer); conflictGroups.set(key, answers); }
    if ([...conflictGroups.values()].some(answers => answers.size > 1)) throw new BadRequestException('同一问题与适用范围存在多个答案，需先解决冲突');
    if (records.some(row => row.errors.length)) throw new BadRequestException({ message: 'QA validation failed', errors: records.map((r, i) => ({ line: i + 1, errors: r.errors })) });
    const documents = [];
    for (const [index,{ record, idProvided }] of records.entries()) {
      record.reviewStatus = body.reviewed === true ? 'approved' : 'pending';record.maintainerId=userId;
      // Explicit maintainer review is required for generated/feedback candidates too.
      if (record.sourceDocumentId) {
        if (!record.sourceVersionId || !await new DocumentAclService(this.permission).isDocumentReadable(userId, record.sourceDocumentId)) throw new ForbiddenException('Readable source version required');
        const source = await this.db.document.findFirst({ where: { id: record.sourceDocumentId, activeVersionId: record.sourceVersionId, status: 'published' } });
        if (!source || source.kbId !== kbId || source.sourceType === 'qa') throw new BadRequestException('QA source must be a current non-QA document in the same knowledge base');
      }
      const document = await withSystemWrite(this.db, async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`SELECT id FROM "KnowledgeBase" WHERE id=${kbId}::uuid FOR UPDATE`;
        const existing = await tx.document.findFirst({ where: { kbId, sourceType: 'qa', sourceExternalId: record.id } });
        if (body.expectedVersion !== undefined && (!existing || (immutableVersionsEnabled() ? existing.ingestVersion || existing.version : existing.version) !== body.expectedVersion || (body.expectedHash && (existing.pendingContentHash || existing.contentHash) !== body.expectedHash))) throw new BadRequestException('QA candidate changed; reload before review');
        if (record.sourceDocumentId) {
          const source = await tx.document.findFirst({ where:{id:record.sourceDocumentId,kbId,activeVersionId:record.sourceVersionId,status:'published',sourceType:{not:'qa'}} });
          if (!source) throw new BadRequestException('QA source changed before import');
        }
        // Probe: repairing or retiring the caller's own expired candidate must
        // stay possible, otherwise it is stuck in needs_review forever.
        if (existing && !await new DocumentAclService(this.permission).isDocumentReadable(userId, existing.id, { probe: true })) throw new NotFoundException('QA not found');
        const conflicts = await tx.document.findMany({ where: { kbId, sourceType: 'qa', title: record.question, ...(existing ? { id: { not: existing.id } } : {}) }, select: { id: true, parserMetadata: true } });
        if (conflicts.some(doc => (doc.parserMetadata as any)?.qa && qaConflictKey((doc.parserMetadata as any).qa) === qaConflictKey(record) && (doc.parserMetadata as any)?.qa?.answer !== record.answer) || (existing && !idProvided && (existing.parserMetadata as any)?.qa?.answer !== record.answer)) throw new BadRequestException('同一问题存在不同答案，请用原 QA ID 明确更新');
        const id = existing?.id || randomUUID(); const version = existing ? (immutableVersionsEnabled() ? existing.ingestVersion || existing.version : existing.version) + 1 : 1;
        const text = JSON.stringify(record); const hash = createHash('sha256').update(text).digest('hex');
        const qaMetadata: Prisma.InputJsonObject = { ...record, aliases: [...record.aliases] };
        if(existing&&(existing.pendingContentHash||existing.contentHash)===hash)return {...existing,unchanged:true};
        const path = join(uploadRoot(), id, `qa.input.v${version}.json`);
        await mkdir(join(uploadRoot(), id), { recursive: true }); await writeFile(path, text);
        const common = { effectiveFrom: record.effectiveFrom ? new Date(record.effectiveFrom) : null, effectiveTo: record.effectiveTo ? new Date(record.effectiveTo) : null };
        if (existing) return tx.document.update({ where: { id }, data: {
          ...(immutableVersionsEnabled() ? { ingestVersion: version, pendingRawFileOid: path, pendingTitle: record.question, pendingContentHash: hash } : { version, rawFileOid: path, title: record.question, contentHash: hash, status: 'parsing' }) } });
        return tx.document.create({ data: { id, kbId, title: record.question, sourceType: 'qa', sourceExternalId: record.id, rawFileOid: path,
          mdPath: `${id}/content.md`, contentHash: hash, uploadedById: userId, status: 'parsing', parserMetadata: { qa: qaMetadata }, ...common } });
      });
      if(!(document as any).unchanged)await this.ingestion.enqueue(document.id, 'qa-import', immutableVersionsEnabled() ? document.ingestVersion || document.version : document.version, 1);
      documents.push(document);
    }
    return { documents, total: documents.length, status: 'accepted' };
  }

  @Post(':docId/review')
  async review(@Param('kbId') kbId: string, @Param('docId') docId: string, @Req() req: any, @Body() body: { approved?: boolean; expectedVersion?: number }) {
    const userId = await this.manage(req, kbId);
    if (!await new DocumentAclService(this.permission).isDocumentReadable(userId, docId, { probe: true })) throw new NotFoundException('QA not found');
    const doc = await this.db.document.findFirst({ where: { id: docId, kbId, sourceType: 'qa' } });
    if (!doc?.rawFileOid) throw new NotFoundException('QA not found');
    if (body.approved !== true) throw new BadRequestException('Explicit approved=true required');
    if (body.expectedVersion !== undefined && body.expectedVersion !== (immutableVersionsEnabled() ? doc.ingestVersion || doc.version : doc.version)) throw new BadRequestException('QA candidate changed since it was displayed; reload before review');
    let source: string;
    try {
      source = await readFile(resolveUploadPath(doc.pendingRawFileOid || doc.rawFileOid), 'utf8');
    } catch {
      // A deleted or corrupted candidate snapshot must not leak a filesystem
      // path through a raw 500.
      throw new NotFoundException('QA candidate content is unavailable');
    }
    let qa: any;
    try { qa = JSON.parse(source); } catch { throw new BadRequestException('QA candidate content is not valid JSON'); }
    if (!qa || typeof qa !== 'object' || Array.isArray(qa)) throw new BadRequestException('QA candidate content is not an object');
    qa.sourceCategory = qa.sourceCategory || 'manual';
    return this.import(kbId, req, { rows:[qa],reviewed:true,expectedVersion:immutableVersionsEnabled() ? doc.ingestVersion || doc.version : doc.version,expectedHash:createHash('sha256').update(source).digest('hex') });
  }
}
