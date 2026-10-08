import { EventEmitter } from 'node:events';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { of } from 'rxjs';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { OpenApiController } from './open-api.controller';
import { OpenApiGuard } from './open-api.guard';
import { ChatService } from '../chat/chat.service';
import { PermissionService } from '../permission/permission.service';
import { BrainCompilerService } from '../brain-compiler/brain-compiler.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { KnowledgeOperationsService } from '../ingestion/knowledge-operations.service';
import { extractArchiveDocuments } from '../ingestion/archive-extractor';
import { withStrictOutputPermit, withStrictResourceOutput } from '../permission/strict-output-permit';

const kb = '11111111-1111-4111-8111-111111111111';
const otherKb = '22222222-2222-4222-8222-222222222222';
const conversationId = '33333333-3333-4333-8333-333333333333';
const docId = '44444444-4444-4444-8444-444444444444';
const mockPrisma: any = {
  knowledgeBase: { findUnique: jest.fn(), findMany: jest.fn() },
  document: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
  conversation: { create: jest.fn(), findFirst: jest.fn() },
  message: { create: jest.fn() },
  $transaction: jest.fn(async (work: (db: any) => Promise<any>): Promise<any> => work(mockPrisma)),
};
const mockReadable = jest.fn();
jest.mock('../prisma', () => ({ getPrismaClient: () => mockPrisma }));
jest.mock('../chat/chat.service', () => ({ ChatService: class ChatService {} }));
jest.mock('../db/tenant-context.service', () => ({ withServiceContext: async (db: any, work: (db: any) => Promise<any>) => work(db) }));
jest.mock('../permission/authorization-revision', () => ({
  authorizationEnforced: () => process.env.CORE_AUTH_ENFORCE === '1',
  withAuthorizedRequest: async (_user: string, work: (snapshot: any) => Promise<any>) => work({ revision: '1', policyVersion: 'p', expiresAt: Infinity }),
  assertRequestAuthorization: async () => undefined,
}));
jest.mock('../permission/strict-output-permit', () => ({
  withStrictOutputPermit: jest.fn(async (_user, _snapshot, emit) => emit()),
  withStrictResourceOutput: jest.fn(async (_user, _snapshot, read, emit) => emit(await read(mockPrisma))),
}));
jest.mock('../permission/document-acl.service', () => ({ DocumentAclService: class {
  filterReadableDocuments(...args: any[]) { return mockReadable(...args); }
} }));
jest.mock('../ingestion/archive-extractor', () => ({ extractArchiveDocuments: jest.fn(async () => [{ filename: 'child.txt', buffer: Buffer.from('text') }]) }));
jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), promises: {
  ...jest.requireActual('node:fs').promises, mkdir: jest.fn(), writeFile: jest.fn(),
} }));

function response() {
  const res: any = new EventEmitter();
  res.setHeader = jest.fn();
  res.status = jest.fn(() => res);
  res.json = jest.fn(body => { res.body = body; res.writableEnded = true; res.emit('finish'); return res; });
  res.write = jest.fn(() => { res.headersSent = true; return true; });
  res.end = jest.fn(body => { res.body = body; res.writableEnded = true; res.emit('finish'); });
  return res;
}

describe('OpenAPI scope, events and output contracts', () => {
  const chat = { handleChatStream: jest.fn(), searchKnowledgeForAgent: jest.fn() };
  const permission = { getVisibleKnowledgeBases: jest.fn(), canManageKnowledgeBase: jest.fn() };
  const ingestion = { enqueue: jest.fn() };
  const operations = { readResource: jest.fn(), lifecycle: { addTextDocument: jest.fn(), retryDocument: jest.fn(), deleteDocument: jest.fn() } };
  const req = { user: { id: 'user' }, headers: {} };
  let controller: OpenApiController;
  const originalStrict = process.env.KNOWLEDGE_STRICT_OUTPUT;
  const originalAuth = process.env.CORE_AUTH_ENFORCE;
  beforeEach(() => {
    jest.clearAllMocks();
    (withStrictOutputPermit as jest.Mock).mockReset().mockImplementation(async (_user: string, _snapshot: any, emit: () => Promise<void>) => emit());
    (withStrictResourceOutput as jest.Mock).mockReset().mockImplementation(async (_user: string, _snapshot: any, read: (tx: any) => Promise<any>, emit: (result: any) => Promise<void>) => emit(await read(mockPrisma)));
    process.env.KNOWLEDGE_STRICT_OUTPUT = '0';
    process.env.CORE_AUTH_ENFORCE = '0';
    permission.getVisibleKnowledgeBases.mockResolvedValue([kb]);
    permission.canManageKnowledgeBase.mockResolvedValue(true);
    mockPrisma.conversation.create.mockResolvedValue({ id: conversationId });
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    mockPrisma.message.create.mockResolvedValue({ id: 'message' });
    mockReadable.mockImplementation(async (_user, ids) => new Set(ids));
    operations.readResource.mockResolvedValue({ knowledge_bases: [], total: 0 });
    operations.lifecycle.addTextDocument.mockResolvedValue({ documents: [{ id: docId }], status: 'accepted' });
    controller = new OpenApiController(chat as any, permission as any, {} as any, ingestion as any, operations as any);
  });
  afterAll(() => {
    if (originalStrict === undefined) delete process.env.KNOWLEDGE_STRICT_OUTPUT; else process.env.KNOWLEDGE_STRICT_OUTPUT = originalStrict;
    if (originalAuth === undefined) delete process.env.CORE_AUTH_ENFORCE; else process.env.CORE_AUTH_ENFORCE = originalAuth;
  });

  it.each([[[]], [['']], [[otherKb]]])('rejects explicit empty or unauthorized scope before writes/model (%j)', async scope => {
    await expect(controller.chatCompletions(req, response(), { prompt: 'Question', kb_ids: scope })).rejects.toThrow();
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
    expect(chat.handleChatStream).not.toHaveBeenCalled();
  });
  it('does not expand a fully revoked conversation scope to another visible KB', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue({ id: conversationId, kbScope: [otherKb] });
    await expect(controller.chatCompletions(req, response(), { prompt: 'Question', conversation_id: conversationId })).rejects.toThrow();
    expect(chat.handleChatStream).not.toHaveBeenCalled();
  });
  it.each([false, true])('uses authoritative replace and persists exact dependencies (stream=%s)', async stream => {
    const manifest = [{ documentId: docId, number: 1, versionId: 'v1', sourceHash: 'h' }];
    chat.handleChatStream.mockResolvedValue(of(...[
      { type: 'delta', content: 'draft' }, { type: 'replace', content: 'verified' },
      { type: 'citation', timeline_entry: { document_id: docId, doc_title: 'Title' } },
      { type: 'trace', node: { id: 'retrieval', status: 'running' } },
      { type: 'trace', node: { id: 'retrieval', status: 'success' } },
      { type: 'done', dependency_manifest: manifest },
    ].map(data => ({ data }))));
    const res = response();
    await controller.chatCompletions(req, res, { prompt: 'Question', stream });
    const saved = mockPrisma.message.create.mock.calls[1][0].data;
    expect(saved.content).toBe('verified');
    expect(saved.dependencyManifest).toBe(manifest);
    expect(saved.citationsSummary[0].timeline_entry.document_id).toBe(docId);
    expect(saved.processingTrace).toEqual([{ id: 'retrieval', status: 'success' }]);
    if (stream) {
      expect(res.write.mock.calls.some(([frame]: [string]) => frame.includes('replace'))).toBe(true);
      expect(res.body).toContain('verified');
      expect(res.body).not.toContain('dependency_manifest');
    } else expect(res.body.data.answer).toBe('verified');
  });
  it.each([false, true])('never returns/persists partial source text as success after a data error (stream=%s)', async stream => {
    chat.handleChatStream.mockResolvedValue(of({ data: { type: 'delta', content: 'private draft' } },
      { data: { type: 'error', content: 'raw secret-bearing provider error' } }));
    const res = response();
    await controller.chatCompletions(req, res, { prompt: 'Question', stream });
    const saved = mockPrisma.message.create.mock.calls[1][0].data;
    expect(saved.content).not.toContain('private');
    expect(saved.citationsSummary).toEqual([]);
    expect(saved.dependencyManifest).toEqual({ kind: 'non_evidence', version: 1, outcome: 'failure' });
    if (stream) { expect(res.body).toContain('error'); expect(res.body).not.toContain('done'); }
    else { expect(res.status).toHaveBeenCalledWith(503); expect(res.body.data).toBeNull(); }
  });
  it('allows an explicit source-free refusal through strict output and saves the marker', async () => {
    process.env.KNOWLEDGE_STRICT_OUTPUT = '1'; process.env.CORE_AUTH_ENFORCE = '1';
    chat.handleChatStream.mockResolvedValue(of({ data: { type: 'delta', content: 'No evidence.' } }, { data: { type: 'done', answer_kind: 'refusal' } }));
    const res = response();
    await controller.chatCompletions(req, res, { prompt: 'Question' });
    expect((withStrictOutputPermit as jest.Mock).mock.calls[0][3]).toEqual({ kind: 'non_evidence', version: 1, outcome: 'refusal' });
    expect(res.body.data.answer).toBe('No evidence.');
  });
  it('discards strict buffered output when the authorization permit rejects before persistence', async () => {
    process.env.KNOWLEDGE_STRICT_OUTPUT = '1'; process.env.CORE_AUTH_ENFORCE = '1';
    chat.handleChatStream.mockResolvedValue(of({ data: { type: 'delta', content: 'source-backed text' } },
      { data: { type: 'done', dependency_manifest: [{ documentId: docId, number: 1 }] } }));
    (withStrictOutputPermit as jest.Mock).mockRejectedValueOnce(new ForbiddenException('Authorization changed'));
    const res = response();
    await expect(controller.chatCompletions(req, res, { prompt: 'Question' })).rejects.toThrow('Authorization changed');
    expect(mockPrisma.message.create).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
  });
  it('delegates inventory to the shared permission-scoped operations instead of raw counts', async () => {
    operations.readResource.mockResolvedValue({ knowledge_bases: [{ id: kb, document_count: 1 }], total: 1 });
    const res = response();
    await controller.listKnowledgeBases(req, res);
    expect(res.body.data[0].document_count).toBe(1);
    expect(operations.readResource).toHaveBeenCalledWith('user', { kind: 'knowledge_bases', args: {} }, mockPrisma);
    expect(mockPrisma.knowledgeBase.findMany).not.toHaveBeenCalled();
  });
  it('uses resource permits for strict inventory/status and forwards exact search manifest', async () => {
    process.env.KNOWLEDGE_STRICT_OUTPUT = '1'; process.env.CORE_AUTH_ENFORCE = '1';
    mockPrisma.knowledgeBase.findMany.mockResolvedValue([]); mockPrisma.document.findMany.mockResolvedValue([]);
    await controller.listKnowledgeBases(req, response());
    expect(withStrictResourceOutput).toHaveBeenCalled();
    mockPrisma.document.findFirst.mockResolvedValue({ id: docId, kbId: kb, kb: { id: kb } });
    await controller.getDocumentStatus(req, docId, response());
    expect((withStrictResourceOutput as jest.Mock).mock.calls).toHaveLength(2);
    const manifest = [{ documentId: docId, number: 1 }];
    chat.searchKnowledgeForAgent.mockResolvedValue({ total: 1, results: [{ documentId: docId }], dependencyManifest: manifest });
    await controller.searchKnowledge(req, { query: 'Question' }, response());
    expect((withStrictOutputPermit as jest.Mock).mock.calls[0][3]).toBe(manifest);
  });
  it('represents empty retrieval as non-exhaustive resource output, without pretending refusal evidence', async () => {
    process.env.KNOWLEDGE_STRICT_OUTPUT = '1'; process.env.CORE_AUTH_ENFORCE = '1';
    chat.searchKnowledgeForAgent.mockResolvedValue({ total: 0, results: [], dependencyManifest: null });
    const res = response();
    await controller.searchKnowledge(req, { query: 'Question', kb_ids: [kb] }, res);
    expect(withStrictOutputPermit).not.toHaveBeenCalled();
    expect(withStrictResourceOutput).toHaveBeenCalled();
    expect(res.body.data).toEqual({ query: 'Question', total: 0, results: [], exhaustive: false });
  });
  it('documents path, multipart, bearer, SSE and bounded runtime inputs', () => {
    const spec = controller.getOpenApiSpec({ get: () => 'localhost', protocol: 'http' });
    expect(spec.paths['/open-api/v1/documents/status/{docId}'].get.parameters).toEqual([expect.objectContaining({ in: 'path', required: true, name: 'docId' })]);
    expect(spec.paths['/open-api/v1/documents/upload'].post.requestBody.content['multipart/form-data'].schema.required).toEqual(['file', 'kb_id']);
    expect(spec.paths['/open-api/v1/chat/completions'].post.responses['200'].content).toHaveProperty('text/event-stream');
    expect(spec.security).toContainEqual({ BearerAuth: [] });
    expect(spec.components.schemas.SearchRequest.properties.top_k.maximum).toBe(50);
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const operation of Object.values<any>(item)) {
        for (const match of path.matchAll(/\{([^}]+)\}/g)) {
          expect(operation.parameters).toContainEqual(expect.objectContaining({ name: match[1], in: 'path', required: true }));
        }
      }
    }
    expect(spec.paths['/open-api/v1/documents/text'].post.requestBody.content['application/json'].schema.required).toEqual(['kb_id', 'content']);
  });

  it('delegates core reads through validated paging and the strict resource lock', async () => {
    process.env.KNOWLEDGE_STRICT_OUTPUT = '1'; process.env.CORE_AUTH_ENFORCE = '1';
    await controller.listDocuments(req, response(), { kb_id: kb, limit: '10', offset: '20' });
    expect(operations.readResource).toHaveBeenCalledWith('user', { kind: 'documents', args: { kb_id: kb, limit: 10, offset: 20 } }, mockPrisma);
    await controller.readDocument(req, response(), docId, { limit: '1000' });
    await controller.listDocumentVersions(req, response(), docId, {});
    await controller.listConversations(req, response(), {});
    await controller.getConversation(req, response(), conversationId, {});
    expect((withStrictResourceOutput as jest.Mock).mock.calls).toHaveLength(5);
    expect(() => controller.listDocuments(req, response(), { kb_id: kb, limit: '100000' })).toThrow();
    expect(operations.readResource).toHaveBeenCalledTimes(5);
  });
  it('routes text/retry/delete through the existing management lifecycle with the caller identity', async () => {
    await controller.ingestDocumentText(req, { kb_id: kb, title: 'Title', content: 'Native text' }, response());
    expect(operations.lifecycle.addTextDocument).toHaveBeenCalledWith('user', kb, { title: 'Title', content: 'Native text', duplicateMode: undefined });
    await controller.retryDocument(req, docId, { kb_id: kb }, response());
    expect(operations.lifecycle.retryDocument).toHaveBeenCalledWith('user', kb, docId);
    await controller.deleteDocument(req, docId, { kb_id: kb }, response());
    expect(operations.lifecycle.deleteDocument).toHaveBeenCalledWith('user', kb, docId);
    await expect(controller.ingestDocumentText(req, { kb_id: kb, content: {} }, response())).rejects.toThrow();
    expect(operations.lifecycle.addTextDocument).toHaveBeenCalledTimes(1);
  });

  describe('real Nest HTTP upload response', () => {
    let app: any;
    beforeEach(async () => {
      mockPrisma.knowledgeBase.findUnique.mockResolvedValue({ id: kb, status: 'active' });
      mockPrisma.document.create.mockImplementation(async ({ data }: { data: any }) => data);
      const module = await Test.createTestingModule({ controllers: [OpenApiController], providers: [
        { provide: ChatService, useValue: chat }, { provide: PermissionService, useValue: permission },
        { provide: BrainCompilerService, useValue: {} }, { provide: IngestionService, useValue: ingestion },
        { provide: KnowledgeOperationsService, useValue: operations },
      ] }).overrideGuard(OpenApiGuard).useValue({ canActivate: (context: ExecutionContext) => { context.switchToHttp().getRequest().user = req.user; return true; } }).compile();
      app = module.createNestApplication(); await app.init();
    });
    afterEach(async () => { await app.close(); });
    it.each(['file.txt', 'archive.zip'])('finishes successful upload and enqueues exactly once (%s)', async name => {
      const result = await request(app.getHttpServer()).post('/open-api/v1/documents/upload')
        .field('kb_id', kb).attach('file', Buffer.from('data'), name).timeout({ response: 1000, deadline: 2000 }).expect(200);
      expect(result.body.code).toBe(200);
      expect(mockPrisma.document.create).toHaveBeenCalledTimes(1);
      expect(ingestion.enqueue).toHaveBeenCalledTimes(1);
    });
    it.each(['file.txt', 'archive.zip'])('strict upload emits only fresh mutation receipts (%s)', async name => {
      process.env.KNOWLEDGE_STRICT_OUTPUT = '1'; process.env.CORE_AUTH_ENFORCE = '1';
      if (name.endsWith('.zip')) (extractArchiveDocuments as jest.Mock).mockResolvedValueOnce([
        { filename: 'secret title one.txt', buffer: Buffer.from('one') },
        { filename: 'secret title two.txt', buffer: Buffer.from('two') },
      ]);
      operations.readResource.mockImplementation(async (_user: string, resource: any, db: any) => {
        expect(db).toBe(mockPrisma);
        expect(resource.kind).toBe('mutation_receipt');
        expect(resource.args.action).toBe('upload_document');
        expect(resource.args.kb_id).toBe(kb);
        const receipt = (id: string) => ({ document_id: id, kb_id: kb, status: 'accepted' });
        return resource.args.doc_ids ? { documents: resource.args.doc_ids.map(receipt), total: resource.args.doc_ids.length, status: 'accepted' }
          : receipt(resource.args.doc_id);
      });
      const result = await request(app.getHttpServer()).post('/open-api/v1/documents/upload')
        .field('kb_id', kb).attach('file', Buffer.from('data'), name).timeout({ response: 1000, deadline: 2000 }).expect(200);
      expect(result.body.data.status).toBe('accepted');
      expect(JSON.stringify(result.body)).not.toContain('title');
      expect(JSON.stringify(result.body)).not.toContain('parsing');
      expect(withStrictResourceOutput).toHaveBeenCalledTimes(1);
      const createdIds = mockPrisma.document.create.mock.calls.map(([input]: [any]) => input.data.id);
      const descriptor = operations.readResource.mock.calls[0][1];
      if (name.endsWith('.zip')) {
        expect(descriptor.args.doc_ids).toEqual(createdIds);
        expect(result.body.data.total).toBe(2);
      } else expect(descriptor.args.doc_id).toBe(createdIds[0]);
    });
    it('returns HTTP 200 for search as the published specification declares', async () => {
      chat.searchKnowledgeForAgent.mockResolvedValue({ total: 0, results: [] });
      await request(app.getHttpServer()).post('/open-api/v1/search').send({ query: 'Question' }).expect(200);
    });
  });
});
