import { of } from 'rxjs';
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
            documentId: 'doc-1',
            kbId: 'kb-1',
          },
        ],
      }),
      handleChatStream: jest.fn().mockResolvedValue(
        of(
          { data: { type: 'token', content: '测试回答' } },
          { data: { type: 'citation', timeline_entry: { title: '测试引用' } } },
        ),
      ),
    };

    mockPermissionService = {
      getVisibleKnowledgeBases: jest.fn().mockResolvedValue(['kb-1', 'kb-2']),
      canManageKnowledgeBase: jest.fn().mockResolvedValue(true),
    };

    mockPrisma = {
      knowledgeBase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'kb-1', name: '测试库', type: 'personal', ownerUserId: 'user-123', status: 'active',
        }),
      },
      document: {
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: data.id, title: data.title, version: data.version, status: data.status })),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'conv-123', ...data })),
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
    expect(tools.length).toBe(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain('search_knowledge');
    expect(names).toContain('chat_knowledge');
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
      expect(res.result.tools.length).toBe(6);
    });

    it('should handle tools/call search_knowledge defaulting to all visible KBs', async () => {
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
      expect(res.result.content[0].type).toBe('text');
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.total).toBe(1);
      expect(parsed.results[0].title).toBe('测试文档');
      // When kb_ids is not passed, it defaults to all visible KBs
      expect(mockChatService.searchKnowledgeForAgent).toHaveBeenCalledWith(
        'user-123',
        '测试',
        ['kb-1', 'kb-2'],
        10,
      );
    });

    it('should handle tools/call search_knowledge with specific kb_ids', async () => {
      await mcpService.handleJsonRpc(mockUser, {
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: {
          name: 'search_knowledge',
          arguments: { query: '测试', kb_ids: ['kb-2', 'kb-unauthorized'] },
        },
      });

      expect(mockChatService.searchKnowledgeForAgent).toHaveBeenCalledWith(
        'user-123',
        '测试',
        ['kb-2'],
        10,
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
      expect(parsed.conversation_id).toBe('conv-123');
      expect(parsed.answer).toBe('测试回答');

      // Conversation created with all visible KBs scope
      expect(mockPrisma.conversation.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-123',
          title: '什么是绩效？',
          kbScope: ['kb-1', 'kb-2'],
        },
      });

      // User prompt message created
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: {
          conversationId: 'conv-123',
          role: 'user',
          content: '什么是绩效？',
        },
      });

      // Stream called with all visible KBs
      expect(mockChatService.handleChatStream).toHaveBeenCalledWith(
        'user-123',
        '什么是绩效？',
        ['kb-1', 'kb-2'],
        'conv-123',
      );

      // Assistant reply persisted to database
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: {
          conversationId: 'conv-123',
          role: 'assistant',
          content: '测试回答',
          citationsSummary: [{ title: '测试引用' }],
          processingTrace: undefined,
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
          arguments: { prompt: '考勤时间', kb_ids: ['kb-1'] },
        },
      });

      expect(mockChatService.handleChatStream).toHaveBeenCalledWith(
        'user-123',
        '考勤时间',
        ['kb-1'],
        'conv-123',
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
        { id: 'kb-1', name: '测试库', type: 'personal', description: '描述' },
      ]);
      mockPrisma.userCredential = {
        findFirst: jest.fn().mockResolvedValue({ appId: 'app_test_123' }),
      };

      const res = await mcpService.handleJsonRpc(mockUser, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'get_file_upload_guide',
          arguments: { kb_id: 'kb-1', file_path: '/Users/test/report.pdf' },
        },
      });

      expect(res.jsonrpc).toBe('2.0');
      expect(res.id).toBe(6);
      expect(res.result.isError).toBe(false);
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.auth.app_id).toBe('app_test_123');
      expect(parsed.target_kb.id).toBe('kb-1');
      expect(parsed.upload_endpoint).toContain('/mcp/upload');
      expect(parsed.guide).toContain('/mcp/upload');
      expect(parsed.guide).toContain('X-App-Id');
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

  describe('saveUploadAndEnqueue (共享上传管线)', () => {
    it('should validate, persist file, create document and enqueue', async () => {
      const ingestion = { enqueue: jest.fn().mockResolvedValue(undefined) };
      const svc = new McpService(mockChatService, mockPermissionService, ingestion as any);

      const result = await svc.saveUploadAndEnqueue('user-123', {
        kbId: 'kb-1',
        filename: 'report.pdf',
        fileBuffer: Buffer.from('%PDF-1.4 fake'),
        title: '季度报告',
      });

      expect(mockPermissionService.canManageKnowledgeBase).toHaveBeenCalledWith('user-123', 'kb-1');
      expect(mockPrisma.document.create).toHaveBeenCalledTimes(1);
      expect(ingestion.enqueue).toHaveBeenCalledWith(expect.any(String), 'upload', 1);
      expect(result.document_id).toBeDefined();
      expect(result.kb_name).toBe('测试库');
      expect(result.size_bytes).toBe(Buffer.from('%PDF-1.4 fake').length);
      expect(result.status).toBe('parsing');
    });

    it('should reject when user lacks permission on the kb', async () => {
      mockPermissionService.canManageKnowledgeBase = jest.fn().mockResolvedValue(false);
      const svc = new McpService(mockChatService, mockPermissionService);
      await expect(
        svc.saveUploadAndEnqueue('user-123', {
          kbId: 'kb-1', filename: 'a.pdf', fileBuffer: Buffer.from('x'),
        }),
      ).rejects.toThrow('无权');
    });

    it('should reject when kb does not exist', async () => {
      mockPrisma.knowledgeBase.findUnique = jest.fn().mockResolvedValue(null);
      const svc = new McpService(mockChatService, mockPermissionService);
      await expect(
        svc.saveUploadAndEnqueue('user-123', {
          kbId: 'kb-404', filename: 'a.pdf', fileBuffer: Buffer.from('x'),
        }),
      ).rejects.toThrow('不存在');
    });

    it('should reject empty buffer and missing extension', async () => {
      const svc = new McpService(mockChatService, mockPermissionService);
      await expect(
        svc.saveUploadAndEnqueue('user-123', { kbId: 'kb-1', filename: 'a.pdf', fileBuffer: Buffer.alloc(0) }),
      ).rejects.toThrow('内容为空');
      await expect(
        svc.saveUploadAndEnqueue('user-123', { kbId: 'kb-1', filename: 'noext', fileBuffer: Buffer.from('x') }),
      ).rejects.toThrow('扩展名');
    });
  });
});
