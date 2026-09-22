import { McpController } from './mcp.controller';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';

describe('McpController', () => {
  let controller: McpController;
  let mockMcpService: any;
  let mockUserCredentialService: any;
  let mockRateLimitService: any;
  let mockAuthService: any;

  beforeEach(() => {
    mockMcpService = {
      getTools: jest.fn().mockReturnValue([{ name: 'chat_knowledge' }]),
      handleJsonRpc: jest.fn().mockImplementation((user, body, onProgress) => {
        if (onProgress) {
          onProgress({ type: 'progress', phase: 'uploading', message: 'progress test' });
        }
        return Promise.resolve({
          jsonrpc: '2.0',
          id: body?.id ?? 1,
          result: { content: [{ type: 'text', text: 'ok' }] },
        });
      }),
    };

    mockUserCredentialService = {
      verifyCredential: jest.fn().mockImplementation((appId, appSecret) => {
        if (appId === 'app_valid' && appSecret === 'sec_valid') {
          return {
            user: { id: 'user-1', username: 'admin' },
            credential: { id: 'cred-1', appId },
          };
        }
        return null;
      }),
    };

    mockRateLimitService = {
      check: jest.fn().mockReturnValue({ allowed: true, retryAfterSec: 0 }),
      limitPerMinute: 60,
    };

    mockAuthService = {
      userIdFromRequest: jest.fn(),
    };

    controller = new McpController(
      mockMcpService,
      mockUserCredentialService,
      mockRateLimitService,
      mockAuthService,
    );
  });

  it('should return mcp spec with Streamable HTTP and port 20080 for production domain', () => {
    const mockReq = {
      get: jest.fn().mockImplementation((header: string) => {
        if (header === 'host') return 'knowledge.5gsailor.com';
        return undefined;
      }),
      protocol: 'https',
    } as any;

    const spec = controller.getMcpSpec(mockReq);
    expect(spec.name).toBe('gbrainkg-mcp');
    // 强制生产域名包含 20080 端口
    expect(spec.endpoints.streamable_http).toBe('https://knowledge.5gsailor.com:20080/mcp');
    expect(spec.endpoints.sse).toBe('https://knowledge.5gsailor.com:20080/mcp/sse');
    expect(spec.endpoints.upload_file).toBe('https://knowledge.5gsailor.com:20080/mcp/upload');
    expect(spec.transports).toContain('streamable-http');
    expect(spec.clientConfigurations.streamable_http).toBeDefined();
    expect(spec.clientConfigurations.cursor_and_windsurf_sse).toBeDefined();
    expect(spec.clientConfigurations.claude_desktop).toBeDefined();
    expect(spec.clientConfigurations.dify_and_orchestrators).toBeDefined();
    expect(spec.tools).toBeDefined();
  });

  describe('POST /mcp/upload 文件直传', () => {
    it('should pass utf8 filename, kb_id and buffer to shared upload pipeline', async () => {
      const saved = { document_id: 'doc-9', status: 'parsing' };
      mockMcpService.saveUploadAndEnqueue = jest.fn().mockResolvedValue(saved);
      const mockReq = {
        headers: { 'x-app-id': 'app_valid', 'x-app-secret': 'sec_valid' },
        query: {},
      } as any;
      // 模拟 Multer latin1 文件名：UTF-8 字节被逐字节保存
      const latin1Name = Buffer.from('测试文档.pdf', 'utf8').toString('latin1');
      const result = await controller.uploadFile(
        mockReq,
        undefined as any,
        'kb-1',
        undefined as any,
        { originalname: latin1Name, buffer: Buffer.from('binary-content') } as any,
      );
      expect(mockMcpService.saveUploadAndEnqueue).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ kbId: 'kb-1', filename: '测试文档.pdf' }),
      );
      expect(result).toEqual(saved);
    });

    it('should reject when file field is missing', async () => {
      const mockReq = {
        headers: { 'x-app-id': 'app_valid', 'x-app-secret': 'sec_valid' },
        query: {},
      } as any;
      await expect(controller.uploadFile(mockReq, undefined as any, 'kb-1', undefined as any, undefined as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject without credentials', async () => {
      const mockReq = { headers: {}, query: {} } as any;
      await expect(
        controller.uploadFile(mockReq, undefined as any, 'kb-1', undefined as any, { originalname: 'a.md', buffer: Buffer.from('x') } as any),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  it('should reject direct rpc without credentials', async () => {
    const mockReq = {
      headers: {},
      query: {},
    } as any;
    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    } as any;

    await expect(
      controller.handleDirectRpc(mockReq, mockRes, { jsonrpc: '2.0', id: 1, method: 'ping' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('should process direct rpc with valid X-App-Id / X-App-Secret', async () => {
    const mockReq = {
      headers: {
        'x-app-id': 'app_valid',
        'x-app-secret': 'sec_valid',
      },
      query: {},
    } as any;

    let jsonResult: any;
    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockImplementation((data) => {
        jsonResult = data;
        return data;
      }),
      setHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    } as any;

    await controller.handleDirectRpc(mockReq, mockRes, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'chat_knowledge', arguments: { prompt: 'test' } },
    });

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(jsonResult).toBeDefined();
    expect(jsonResult.jsonrpc).toBe('2.0');
    expect(mockMcpService.handleJsonRpc).toHaveBeenCalled();
  });

  it('should process Streamable HTTP when Accept: text/event-stream', async () => {
    const mockReq = {
      headers: {
        'x-app-id': 'app_valid',
        'x-app-secret': 'sec_valid',
        accept: 'text/event-stream',
      },
      query: {},
    } as any;

    const writes: string[] = [];
    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn().mockImplementation((str) => writes.push(str)),
      end: jest.fn(),
    } as any;

    await controller.handleDirectRpc(mockReq, mockRes, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'chat_knowledge', arguments: { query: '测试问题', kb_ids: ['kb-1'] } },
    });

    expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
    expect(mockRes.end).toHaveBeenCalled();
    expect(writes.length).toBeGreaterThan(0);
    const hasProgress = writes.some((w) => w.includes('notifications/progress'));
    expect(hasProgress).toBe(true);
  });
});
