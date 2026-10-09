import { createHash } from 'node:crypto';
import { Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { getPrismaClient } from '../prisma';
import { PermissionService } from '../permission/permission.service';
import { readableDocumentWhere } from '../retrieval/readable-document-scope';
import { validateEvidenceDependenciesInClient } from '../permission/evidence-dependencies';
import { authorizationEnforced } from '../permission/authorization-revision';
import { DocumentLifecycleService } from './document-lifecycle.service';
import { uploadRoot } from '../storage/upload-paths';

export type KnowledgeResource = { kind: 'knowledge_bases' | 'document_status' | 'documents' | 'document' | 'versions' | 'conversations' | 'conversation' | 'user_info' | 'upload_guide' | 'mutation_receipt' | 'retrieval_empty'; args: Record<string, any> };
const documentFields = { id: true, kbId: true, title: true, status: true, sourceType: true,
  version: true, activeVersionId: true, contentHash: true, indexReadiness: true,
  parserEngine: true, qualityIssues: true, qualityStatus: true, qualityScore: true, createdAt: true, updatedAt: true };

@Injectable()
export class KnowledgeOperationsService {
  constructor(private readonly permission: PermissionService,
    @Optional() readonly lifecycle?: DocumentLifecycleService) {}

  async readResource(userId: string, resource: KnowledgeResource, db: any = getPrismaClient()): Promise<any> {
    const { kind, args } = resource;
    if (kind === 'user_info') {
      const user = await db.user.findFirst({ where: { id: userId, status: 'active' },
        select: { id: true, username: true, displayName: true, email: true,
          roles: { select: { role: { select: { name: true } } } }, orgs: { select: { orgNode: { select: { name: true } } } } } });
      if (!user) throw new NotFoundException('User unavailable');
      return { ...user, roles: user.roles.map((r: any) => r.role.name), orgs: user.orgs.map((o: any) => o.orgNode.name) };
    }
    if (kind === 'conversations' || kind === 'conversation') return this.readConversation(userId, resource, db);
    const visible = await this.permission.getVisibleKnowledgeBases(userId, db);
    if (kind === 'documents' && !visible.includes(args.kb_id)) throw new NotFoundException('Knowledge base unavailable');
    const readable = await readableDocumentWhere(db, userId, visible);
    if (kind === 'knowledge_bases' || kind === 'upload_guide') {
      const limit = args.limit ?? 50; const offset = args.offset ?? 0;
      const where = { id: { in: visible }, status: 'active', ...(args.type && args.type !== 'all' ? { type: args.type } : {}) };
      const rows = await db.knowledgeBase.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: offset, take: limit, select: { id: true, name: true, type: true, description: true, createdAt: true, updatedAt: true,
          _count: { select: { documents: { where: { status: 'published', ...readable } } } } } });
      const total = await db.knowledgeBase.count({ where });
      return { total, offset, limit, knowledge_bases: rows.map((kb: any) => ({ id: kb.id, name: kb.name, type: kb.type,
        description: kb.description, document_count: kb._count.documents, created_at: kb.createdAt, updated_at: kb.updatedAt })) };
    }
    if (kind === 'retrieval_empty') {
      if (args.kb_ids.some((id: string) => !visible.includes(id))) throw new NotFoundException('Knowledge scope unavailable');
      return { success: true, query: args.query, total: 0, results: [], exhaustive: false };
    }
    if (kind === 'mutation_receipt') {
      if (Array.isArray(args.doc_ids)) {
        const documents = [];
        for (const docId of args.doc_ids) documents.push(await this.readResource(userId, { kind, args: { ...args, doc_ids: undefined, doc_id: docId } }, db));
        return { documents, total: documents.length, status: 'accepted' };
      }
      if (!await this.permission.canManageKnowledgeBase(userId, args.kb_id, db)) throw new NotFoundException('Knowledge base unavailable');
      if (args.action === 'delete_document') {
        if (await db.document.findFirst({ where: { id: args.doc_id, kbId: args.kb_id }, select: { id: true } })) throw new BadRequestException('Deletion is not complete');
        return { ok: true, documentId: args.doc_id };
      }
      const document = await db.document.findFirst({ where: { id: args.doc_id, kbId: args.kb_id }, select: { id: true, kbId: true } });
      if (!document) throw new NotFoundException('Document unavailable');
      return { document_id: document.id, kb_id: document.kbId, status: 'accepted' };
    }
    if (kind === 'documents') {
      if (!visible.includes(args.kb_id)) throw new NotFoundException('Knowledge base unavailable');
      const where = { AND: [{ kbId: args.kb_id, ...(args.status ? { status: args.status } : { status: 'published' }),
        ...(args.search ? { title: { contains: args.search, mode: 'insensitive' } } : {}) }, readable] };
      const limit = args.limit ?? 50; const offset = args.offset ?? 0;
      const [items, total] = await Promise.all([db.document.findMany({ where, select: documentFields,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: limit, skip: offset }), db.document.count({ where })]);
      return { items, total, limit, offset };
    }
    const doc = await db.document.findFirst({ where: { AND: [{ id: args.doc_id, kbId: { in: visible } }, readable] },
      select: { ...documentFields, mdPath: true } });
    if (!doc) throw new NotFoundException('Document unavailable');
    if (kind === 'document_status') {
      const chunkCount = await db.chunk.count({ where: { documentId: doc.id } });
      const { mdPath, ...metadata } = doc;
      const kb = await db.knowledgeBase.findFirst({ where: { id: doc.kbId, status: 'active' }, select: { id: true, name: true, type: true } });
      return { ...metadata, chunk_count: chunkCount, source_type: doc.sourceType, parser_engine: doc.parserEngine,
        index_readiness: doc.indexReadiness, quality_status: doc.qualityStatus, quality_score: doc.qualityScore,
        quality_issues: doc.qualityIssues, kb, knowledge_base: kb, active_version_id: doc.activeVersionId,
        created_at: doc.createdAt, updated_at: doc.updatedAt };
    }
    if (kind === 'versions') {
      const limit = args.limit ?? 50; const offset = args.offset ?? 0;
      const where = { documentId: doc.id, state: 'published' };
      const [items, total] = await Promise.all([db.documentVersion.findMany({ where, take: limit, skip: offset,
        orderBy: { number: 'desc' }, select: { id: true, number: true, state: true, title: true, sourceHash: true, createdAt: true, publishedAt: true } }), db.documentVersion.count({ where })]);
      return { document_id: doc.id, active_version_id: doc.activeVersionId, legacy_version: doc.version, items, total, limit, offset };
    }
    if (kind !== 'document' || doc.status !== 'published') throw new NotFoundException('Published document unavailable');
    if (args.version_id && args.version_id !== doc.activeVersionId) throw new BadRequestException('Only the active published version is readable through this endpoint');
    const offset = args.offset ?? 0; const limit = args.limit ?? 64000;
    const { mdPath, ...metadata } = doc;
    if (doc.activeVersionId) {
      const version = await db.documentVersion.findFirst({ where: { id: doc.activeVersionId, documentId: doc.id, state: 'published' },
        select: { sourceHash: true, number: true, manifestHash: true } });
      if (!version) throw new NotFoundException('Published version unavailable');
      const rows: any[] = await db.$queryRaw`
        WITH pieces AS (
          SELECT id, ord, "charStart", "charEnd", COALESCE("rawContent", content) || E'\n\n' AS piece
          FROM "BlockArtifact" WHERE "versionId"=${doc.activeVersionId}::uuid
        ), positions AS (
          SELECT *, SUM(char_length(piece)) OVER (ORDER BY ord ROWS UNBOUNDED PRECEDING)-char_length(piece) AS start
          FROM pieces
        ), totals AS (SELECT COALESCE(SUM(char_length(piece)),0) AS total FROM pieces)
        SELECT p.id, p.ord, p."charStart", p."charEnd", totals.total,
          SUBSTRING(p.piece FROM GREATEST(1,${offset}::bigint-p.start+1)::integer
            FOR GREATEST(0,LEAST(char_length(p.piece),${offset + limit}::bigint-p.start)-GREATEST(0,${offset}::bigint-p.start))::integer) AS fragment
        FROM totals LEFT JOIN positions p ON p.start < ${offset + limit} AND p.start + char_length(p.piece) > ${offset}
        ORDER BY p.ord ASC
      `;
      const total = Number(rows[0]?.total ?? 0);
      const sources = rows.filter(row => row.id);
      const current = await db.document.findFirst({ where: { id: doc.id, activeVersionId: doc.activeVersionId, status: 'published' }, select: { id: true } });
      if (!current) throw new BadRequestException('Published version changed; retry');
      return { document: metadata, active_version_id: doc.activeVersionId, source_hash: version.sourceHash,
        manifest_hash: version.manifestHash, content_format: 'published_raw_blocks', offset_unit: 'unicode_character',
        markdown_content: sources.map(row => row.fragment || '').join(''),
        source_refs: sources.map(row => ({ block_id: row.id, ord: row.ord, char_start: row.charStart, char_end: row.charEnd })),
        offset, limit, total_chars: total, next_offset: offset + limit < total ? offset + limit : null };
    }
    const root = uploadRoot(); const source = resolve(root, doc.mdPath);
    if (!source.startsWith(root + sep)) throw new BadRequestException('Invalid document artifact');
    if ((await stat(source)).size > 8 * 1024 * 1024) throw new BadRequestException('Legacy document exceeds read budget');
    const markdown = await readFile(source, 'utf8');
    const actualHash = createHash('sha256').update(markdown).digest('hex');
    const current = await db.document.findFirst({ where: { id: doc.id, version: doc.version, contentHash: doc.contentHash,
      activeVersionId: null, status: 'published' }, select: { id: true } });
    if (!current || !doc.contentHash || actualHash !== doc.contentHash) throw new BadRequestException('Document source changed; retry');
    let total = 0; let page = '';
    for (const character of markdown) { if (total >= offset && total < offset + limit) page += character; total++; }
    return { document: metadata, active_version_id: null, source_hash: actualHash, content_format: 'legacy_markdown', offset_unit: 'unicode_character',
      markdown_content: page, offset, limit, total_chars: total, next_offset: offset + limit < total ? offset + limit : null };

  }

  private async readConversation(userId: string, resource: KnowledgeResource, db: any) {
    const { kind, args } = resource; const limit = args.limit ?? 50;
    if (kind === 'conversations') {
      const where: any = { userId };
      if (args.before) {
        const anchor = await db.conversation.findFirst({ where: { id: args.before, userId }, select: { id: true, createdAt: true } });
        if (!anchor) throw new NotFoundException('Conversation cursor unavailable');
        where.OR = [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }];
      }
      const rows = await db.conversation.findMany({ where, select: { id: true, title: true, createdAt: true },
        take: limit + 1, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      return { items: rows.slice(0, limit), has_more: rows.length > limit, next_cursor: rows.length > limit ? rows[limit - 1].id : null };
    }
    const conversation = await db.conversation.findFirst({ where: { id: args.conversation_id, userId }, select: { id: true, title: true, createdAt: true } });
    if (!conversation) throw new NotFoundException('Conversation unavailable');
    const where: any = { conversationId: conversation.id };
    if (args.before) {
      const anchor = await db.message.findFirst({ where: { id: args.before, conversationId: conversation.id }, select: { id: true, createdAt: true } });
      if (!anchor) throw new NotFoundException('Message cursor unavailable');
      where.OR = [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }];
    }
    const messages = await db.message.findMany({ where, take: limit + 1, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, role: true, content: true, createdAt: true, citationsSummary: true, dependencyManifest: true } });
    // Manifest re-validation is an authorization control: it only runs while
    // core authorization is enforced, matching every other history reader
    // (chat/conversation.controller.ts). Running it unconditionally hid every
    // assistant turn whose manifest was absent in non-enforced/dev deployments,
    // where no manifests are ever persisted.
    const enforced = authorizationEnforced();
    const items = [];
    for (const message of messages.slice(0, limit)) {
      const allowed = !enforced || message.role !== 'assistant' || await validateEvidenceDependenciesInClient(userId, message.dependencyManifest, db);
      const { dependencyManifest, ...item } = message;
      items.push(allowed ? item : { ...item, content: '该回答的来源已失效或您已无权访问。', citationsSummary: null });
    }
    return { conversation, messages: items.reverse(), has_more: messages.length > limit,
      next_cursor: messages.length > limit ? messages[limit - 1].id : null };
  }
}
