import { of } from 'rxjs';
import AdmZip = require('adm-zip');
import { McpService } from './mcp.service';

// saveUploadAndEnqueue 依赖共享 Prisma 客户端与文件系统，这里整体打桩；
// 通过 global 槽位在用例间注入 mock（jest.mock 工厂会被提升到文件顶部）。
jest.mock('../prisma', () => ({
  ...jest.requireActual('../prisma'),
  getPrismaClient: () => (global as any).__mcpServicePrismaMock,
}));
jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

describe('McpService', () => {
  let mcpService: McpService;
  let mockChatService: any;
  let mockPermissionService: any;
  let mockPrisma: any;

  const mockUser = {
    id: 'user-123',
    username: 'testuser',
    displayName: '测试用户',
    email: 'test@example.com',
    roles: [{ role: { name: '管理员' } }],
    orgs: [{ orgNode: { name: '研发部' } }],
  };

  beforeEach(() => {
    mockChatService = {
      searchKnowledgeForAgent: jest.fn().mockResolvedValue({
        total: 1,
        results: [
          {
            title: '测试文档',
            snippet: '这是测试片段',
            score: 0.95,
            documentId: '44444444-4444-4444-8444-444444444444',
            kbId: '11111111-1111-4111-8111-111111111111',
          },
        ],
      }),
      handleChatStream: jest.fn().mockResolvedValue(
        of(
          { data: { type: 'token', content: '测试回答' } },
          { data: { type: 'citation', timeline_entry: { title: '测试引用' } } },
          { data: { type: 'done', dependency_manifest: { fixture: 'source-version' } } },
        ),
      ),
    };

    mockPermissionService = {
      getVisibleKnowledgeBases: jest.fn().mockResolvedValue(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']),
      canManageKnowledgeBase: jest.fn().mockResolvedValue(true),
    };

    mockPrisma = {
      user: { findFirst: jest.fn().mockResolvedValue(mockUser) },
      knowledgeBase: {
        findUnique: jest.fn().mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111', name: '测试库', type: 'personal', ownerUserId: 'user-123', status: 'active',
        }),
      },
      document: {
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: data.id, title: data.title, version: data.version, status: data.status })),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: '33333333-3333-4333-8333-333333333333', ...data })),
      },
      message: {
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'msg-123', ...data })),
      },
    };
    (global as any).__mcpServicePrismaMock = mockPrisma;

    mcpService = new McpService(mockChatService, mockPermissionService);
  });

  it('should list all available tools', () => {
    const tools = mcpService.getTools();
    expect(tools.length).toBe(15);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('search_knowledge');
    expect(names).toContain('chat_knowledge');
    expect(names).toContain('aggregate_knowledge_table');
    expect(names).toContain('list_knowledge_bases');
    expect(names).toContain('get_document_status');
    expect(names).toContain('get_user_info');
    expect(names).toContain('get_file_upload_guide');
  });

  describe('handleJsonRpc', () => {
    it('should handle initialize request', async () => {
      const res = await mcpService.handleJsonRpc(mockUser, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      });

      expect(res.jsonrpc).toBe('2.0');
      expect(res.id).toBe(1);
      expect(res.result.serverInfo.name).toBe('gbrainkg-mcp');
      expect(res.result.protocolVersion).toBe('2024-11-05');
      expect(res.result.capabilities.tools).toBeDefined();
    });

    it('should handle ping request', async () => {
      const res = await mcpService.handleJsonRpc(mockUser, {
        jsonrpc: '2.0',
        id: 2,
        method: 'ping',
      });

      expect(res.jsonrpc).toBe('2.0');
      expect(res.id).toBe(2);
      expect(res.result).toEqual({});
    });

    it('should handle tools/list request', async () => {
      const res = await mcpService.handleJsonRpc(mockUser, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
      });

      expect(res.jsonrpc).toBe('2.0');
      expect(res.id).toBe(3);
      expect(Array.isArray(res.result.tools)).toBe(true);
      expect(res.result.tools.length).toBe(15);
    });

    it('should forward legacy tools/call search_knowledge to chat_knowledge', async () => {
      const res = await mcpService.handleJsonRpc(mockUser, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'search_knowledge',
          arguments: { query: '测试' },
        },
      });

      expect(res.jsonrpc).toBe('2.0');
      expect(res.id).toBe(4);
      expect(res.result.isError).toBe(false);
      // Legacy search_knowledge calls are forwarded to chat_knowledge
      expect(mockChatService.handleChatStream).toHaveBeenCalledWith(
        'user-123',
        '测试',
        ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
        '33333333-3333-4333-8333-333333333333',
      );
    });

    it('should handle tools/call chat_knowledge defaulting to all visible KBs and persisting assistant reply', async () => {
      const res = await mcpService.handleJsonRpc(mockUser, {
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
          name: 'chat_knowledge',
          arguments: { prompt: '什么是绩效？' },
        },
      });

      expect(res.jsonrpc).toBe('2.0');
      expect(res.id).toBe(42);
      expect(res.result.isError).toBe(false);
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.conversation_id).toBe('33333333-3333-4333-8333-333333333333');
      expect(parsed.answer).toBe('测试回答');
      // Transport keeps the bare timeline entry; only persistence is enveloped.
      expect(parsed.citations).toEqual([{ title: '测试引用' }]);

      // Conversation created with all visible KBs scope
      expect(mockPrisma.conversation.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-123',
          title: '什么是绩效？',
          kbScope: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
        },
      });

      // User prompt message created
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: {
          conversationId: '33333333-3333-4333-8333-333333333333',
          role: 'user',
          content: '什么是绩效？',
        },
      });

      // Stream called with all visible KBs
      expect(mockChatService.handleChatStream).toHaveBeenCalledWith(
        'user-123',
        '什么是绩效？',
        ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
        '33333333-3333-4333-8333-333333333333',
      );

      // Assistant reply persisted to database
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: {
          conversationId: '33333333-3333-4333-8333-333333333333',
          role: 'assistant',
          content: '测试回答',
          citationsSummary: [{ type: 'citation', index: undefined, topic_slug: undefined, timeline_entry: { title: '测试引用' } }],
          processingTrace: [],
          dependencyManifest: { fixture: 'source-version' },
          latencyMs: expect.any(Number),
        },
      });
    });

    it('should handle tools/call chat_knowledge with specific kb_ids', async () => {
      await mcpService.handleJsonRpc(mockUser, {
        jsonrpc: '2.0',
        id: 43,
        method: 'tools/call',
        params: {
          name: 'chat_knowledge',
          arguments: { prompt: '考勤时间', kb_ids: ['11111111-1111-4111-8111-111111111111'] },
        },
      });

      expect(mockChatService.handleChatStream).toHaveBeenCalledWith(
        'user-123',
        '考勤时间',
        ['11111111-1111-4111-8111-111111111111'],
        '33333333-3333-4333-8333-333333333333',
      );
    });

    it('should handle tools/call get_user_info', async () => {
      const res = await mcpService.handleJsonRpc(mockUser, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'get_user_info',
          arguments: {},
        },
      });

      expect(res.jsonrpc).toBe('2.0');
      expect(res.id).toBe(5);
      expect(res.result.isError).toBe(false);
      const user = JSON.parse(res.result.content[0].text);
      expect(user.id).toBe('user-123');
      expect(user.displayName).toBe('测试用户');
      expect(user.roles).toContain('管理员');
      expect(user.orgs).toContain('研发部');
    });

    it('should handle tools/call get_file_upload_guide', async () => {
      mockPrisma.knowledgeBase.findMany = jest.fn().mockResolvedValue([
        { id: '11111111-1111-4111-8111-111111111111', name: '测试库', type: 'personal', description: '描述', _count: { documents: 1 } },
      ]);
      (mockUser as any).mcpAuth = { method: 'app_credentials', appId: 'app_test_123', instanceUrl: 'http://localhost:3001' };
      mockPrisma.knowledgeBase.count = jest.fn().mockResolvedValue(1);
      mockPrisma.userCredential = {
        findFirst: jest.fn().mockResolvedValue({ appId: 'app_test_123' }),
      };

      const res = await mcpService.handleJsonRpc(mockUser, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'get_file_upload_guide',
          arguments: { kb_id: '11111111-1111-4111-8111-111111111111' },
        },
      });

      expect(res.jsonrpc).toBe('2.0');
      expect(res.id).toBe(6);
      expect(res.result.isError).toBe(false);
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.auth.app_id).toBe('app_test_123');
      expect(parsed.target_kb.id).toBe('11111111-1111-4111-8111-111111111111');
      expect(parsed.upload_endpoint).toContain('/mcp/upload');
      expect(parsed.upload_method).toContain('multipart/form-data');
      expect(parsed.auth.headers).toContain('X-App-Id');
      expect(mockPrisma.userCredential.findFirst).not.toHaveBeenCalled();
    });

    it('should return -32601 on unknown method', async () => {
      const res = await mcpService.handleJsonRpc(mockUser, {
        jsonrpc: '2.0',
        id: 99,
        method: 'unknown/method',
      });

      expect(res.jsonrpc).toBe('2.0');
      expect(res.id).toBe(99);
      expect(res.error.code).toBe(-32601);
    });
  });

  describe('core tool safety', () => {
    const call = (name: string, args: any) => mcpService.handleJsonRpc(mockUser, { jsonrpc: '2.0', id: 1,
      method: 'tools/call', params: { name, arguments: args } });
    it.each([{}, { prompt: 'q', kb_ids: [] }, { prompt: 'q', kb_ids: ['invalid'] }, { prompt: 'q', extra: true }])
    ('rejects malformed chat arguments without any backend work', async args => {
      const result = await call('chat_knowledge', args);
      expect(result.error.code).toBe(-32602);
      expect(mockPermissionService.getVisibleKnowledgeBases).not.toHaveBeenCalled();
      expect(mockChatService.handleChatStream).not.toHaveBeenCalled(); expect(mockPrisma.message.create).not.toHaveBeenCalled();
    });
    it('rejects a valid but unauthorized explicit scope without widening', async () => {
      const result = await call('chat_knowledge', { prompt: 'q', kb_ids: ['99999999-9999-4999-8999-999999999999'] });
      expect(result.result.isError).toBe(true); expect(mockChatService.handleChatStream).not.toHaveBeenCalled();
      expect(mockPrisma.conversation.create).not.toHaveBeenCalled();
    });
    it('stops a saved conversation whose entire scope was revoked', async () => {
      mockPrisma.conversation.findFirst.mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333', kbScope: ['revoked'] });
      const result = await call('chat_knowledge', { prompt: 'q', conversation_id: '33333333-3333-4333-8333-333333333333' });
      expect(result.result.isError).toBe(true); expect(mockPrisma.message.create).not.toHaveBeenCalled();
      expect(mockChatService.handleChatStream).not.toHaveBeenCalled();
    });
    it('retrieves evidence without generating an answer or creating a conversation', async () => {
      mockChatService.searchKnowledgeForAgent.mockResolvedValue({ success: true, results: [{ documentId: 'source' }], dependencyManifest: { sources: ['source'] } });
      const result = await call('retrieve', { query: 'q', kb_ids: ['11111111-1111-4111-8111-111111111111'], top_k: 2 });
      expect(result.result.isError).toBe(false);
      expect(JSON.parse(result.result.content[0].text).dependency_manifest).toEqual({ sources: ['source'] });
      expect(mockChatService.handleChatStream).not.toHaveBeenCalled(); expect(mockPrisma.conversation.create).not.toHaveBeenCalled();
    });
    it('uses replacement as the final reply and persists done dependencies', async () => {
      mockChatService.handleChatStream.mockResolvedValue(of({ data: { type: 'delta', content: 'draft' } },
        { data: { type: 'replace', content: 'final' } }, { data: { type: 'done', dependency_manifest: { source: 'v2' } } }));
      const result = await call('chat_knowledge', { prompt: 'q' });
      expect(JSON.parse(result.result.content[0].text).answer).toBe('final');
      expect(mockPrisma.message.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ role: 'assistant', content: 'final', dependencyManifest: { source: 'v2' } }) });
    });
    it.each([
      [{ data: { type: 'delta', content: 'partial' } }, { data: { type: 'error', message: 'internal secret' } }],
      [{ data: { type: 'delta', content: 'partial' } }],
    ])('does not persist a partial answer on failure or missing done', async (...events: any[]) => {
      mockChatService.handleChatStream.mockResolvedValue(of(...events));
      const result = await call('chat_knowledge', { prompt: 'q' });
      expect(result.result.isError).toBe(true);
      expect(mockPrisma.message.create.mock.calls.every((args: any[]) => args[0].data.role === 'user')).toBe(true);
      expect(JSON.stringify(result)).not.toContain('partial'); expect(JSON.stringify(result)).not.toContain('internal secret');
    });
    it('binds a citation-free refusal to a typed non-evidence result', async () => {
      mockChatService.handleChatStream.mockResolvedValue(of({ data: { type: 'replace', content: 'insufficient evidence' } }, { data: { type: 'done', answer_kind: 'refusal' } }));
      const result = await call('chat_knowledge', { prompt: 'q' });
      expect(result.result.isError).toBe(false);
      expect(JSON.parse(result.result.content[0].text).dependency_manifest).toEqual(expect.objectContaining({ kind: 'non_evidence' }));
    });
    it('does not claim success if assistant persistence fails', async () => {
      mockPrisma.message.create.mockImplementation(({ data }: any) => data.role === 'assistant' ? Promise.reject(new Error('database secret')) : Promise.resolve({ id: 'msg' }));
      const result = await call('chat_knowledge', { prompt: 'q' });
      expect(result.result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain('database secret');
    });
  });

  describe('saveUploadAndEnqueue (共享上传管线)', () => {
    it('should validate, persist file, create document and enqueue', async () => {
      const ingestion = { enqueue: jest.fn().mockResolvedValue(undefined) };
      const svc = new McpService(mockChatService, mockPermissionService, ingestion as any);

      const result = await svc.saveUploadAndEnqueue('user-123', {
        kbId: '11111111-1111-4111-8111-111111111111',
        filename: 'report.pdf',
        fileBuffer: Buffer.from('%PDF-1.4 fake'),
        title: '季度报告',
      });

      expect(mockPermissionService.canManageKnowledgeBase).toHaveBeenCalledWith('user-123', '11111111-1111-4111-8111-111111111111');
      expect(mockPrisma.document.create).toHaveBeenCalledTimes(1);
      expect(ingestion.enqueue).toHaveBeenCalledWith(expect.any(String), 'upload', 1);
      expect(result.document_id).toBeDefined();
      expect(result.kb_name).toBe('测试库');
      expect(result.size_bytes).toBe(Buffer.from('%PDF-1.4 fake').length);
      expect(result.status).toBe('parsing');
    });

    it('keeps the original file extension when a title without one is supplied', async () => {
      const svc = new McpService(mockChatService, mockPermissionService, { enqueue: jest.fn() } as any);
      const result = await svc.saveUploadAndEnqueue('user-123', {
        kbId: '11111111-1111-4111-8111-111111111111', filename: 'report.pdf',
        fileBuffer: Buffer.from('%PDF-1.4 fake'), title: '季度报告',
      });
      expect(result.title).toBe('季度报告.pdf');
    });

    it('falls back to the original filename when no title is supplied', async () => {
      const svc = new McpService(mockChatService, mockPermissionService, { enqueue: jest.fn() } as any);
      const result = await svc.saveUploadAndEnqueue('user-123', {
        kbId: '11111111-1111-4111-8111-111111111111', filename: '员工手册.docx', fileBuffer: Buffer.from('docx'),
      });
      expect(result.title).toBe('员工手册.docx');
    });

    it('should reject when user lacks permission on the kb', async () => {
      mockPermissionService.canManageKnowledgeBase = jest.fn().mockResolvedValue(false);
      const svc = new McpService(mockChatService, mockPermissionService);
      await expect(
        svc.saveUploadAndEnqueue('user-123', {
          kbId: '11111111-1111-4111-8111-111111111111', filename: 'a.pdf', fileBuffer: Buffer.from('x'),
        }),
      ).rejects.toThrow('Knowledge base unavailable');
    });

    it('should reject when kb does not exist', async () => {
      mockPrisma.knowledgeBase.findUnique = jest.fn().mockResolvedValue(null);
      const svc = new McpService(mockChatService, mockPermissionService);
      await expect(
        svc.saveUploadAndEnqueue('user-123', {
          kbId: '99999999-9999-4999-8999-999999999999', filename: 'a.pdf', fileBuffer: Buffer.from('x'),
        }),
      ).rejects.toThrow('不存在');
    });

    it('should reject empty buffer and missing extension', async () => {
      const svc = new McpService(mockChatService, mockPermissionService);
      await expect(
        svc.saveUploadAndEnqueue('user-123', { kbId: '11111111-1111-4111-8111-111111111111', filename: 'a.pdf', fileBuffer: Buffer.alloc(0) }),
      ).rejects.toThrow('内容为空');
      await expect(
        svc.saveUploadAndEnqueue('user-123', { kbId: '11111111-1111-4111-8111-111111111111', filename: 'noext', fileBuffer: Buffer.from('x') }),
      ).rejects.toThrow('扩展名');
    });

    it('should extract archive, create multiple documents and enqueue each', async () => {
      const zip = new AdmZip();
      zip.addFile('docA.md', Buffer.from('# Document A'));
      zip.addFile('docB.txt', Buffer.from('Document B content'));
      const zipBuffer = zip.toBuffer();

      const ingestion = { enqueue: jest.fn().mockResolvedValue(undefined) };
      const svc = new McpService(mockChatService, mockPermissionService, ingestion as any);

      const result = await svc.saveUploadAndEnqueue('user-123', {
        kbId: '11111111-1111-4111-8111-111111111111',
        filename: 'bundle.zip',
        fileBuffer: zipBuffer,
      });

      expect(result.is_archive).toBe(true);
      expect(result.total).toBe(2);
      expect(mockPrisma.document.create).toHaveBeenCalledTimes(2);
      expect(ingestion.enqueue).toHaveBeenCalledTimes(2);
    });
  });
});
