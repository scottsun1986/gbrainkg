import { McpService } from './mcp.service';

describe('McpService', () => {
  let mcpService: McpService;
  let mockChatService: any;
  let mockPermissionService: any;

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
      handleChatStream: jest.fn(),
    };

    mockPermissionService = {
      getVisibleKnowledgeBases: jest.fn().mockResolvedValue(['kb-1']),
    };

    mcpService = new McpService(mockChatService, mockPermissionService);
  });

  it('should list all available tools', () => {
    const tools = mcpService.getTools();
    expect(tools.length).toBe(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain('upload_document');
    expect(names).toContain('search_knowledge');
    expect(names).toContain('chat_knowledge');
    expect(names).toContain('list_knowledge_bases');
    expect(names).toContain('get_document_status');
    expect(names).toContain('get_user_info');
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

    it('should handle tools/call search_knowledge', async () => {
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
});
