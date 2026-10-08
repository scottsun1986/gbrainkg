import { McpController } from './mcp.controller';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';

jest.mock('../observability/request-context', () => ({
  ...jest.requireActual('../observability/request-context'),
  setRequestContextUser: jest.fn(),
}));

import { setRequestContextUser } from '../observability/request-context';

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

  afterEach(() => controller.onModuleDestroy());

  it('returns the configured instance URL and only supported credential locations', () => {
    const previousOrigin = process.env.WEB_ORIGIN;
    process.env.WEB_ORIGIN = 'https://instance.example:20480';
    const mockReq = {
      get: jest.fn().mockImplementation((header: string) => {
        if (header === 'host') return 'knowledge.5gsailor.com';
        return undefined;
      }),
      protocol: 'https',
    } as any;

    const spec = controller.getMcpSpec(mockReq);
    expect(spec.name).toBe('gbrainkg-mcp');
    expect(spec.endpoints.streamable_http).toBe('https://instance.example:20480/mcp');
    expect(spec.endpoints.sse).toBe('https://instance.example:20480/mcp/sse');
    expect(spec.endpoints.upload_file).toBe('https://instance.example:20480/mcp/upload');
    expect(spec.transports).toContain('streamable-http');
    expect(spec.clientConfigurations.streamable_http).toBeDefined();
    expect(spec.clientConfigurations.cursor_and_windsurf_sse).toBeDefined();
    expect(spec.clientConfigurations.claude_desktop).toBeDefined();
    expect(spec.clientConfigurations.dify_and_orchestrators).toBeDefined();
    expect(spec.tools).toBeDefined();
    expect(spec.auth).not.toHaveProperty('query');
    expect(spec.auth.bearer).toContain('Authorization');
    if (previousOrigin === undefined) delete process.env.WEB_ORIGIN; else process.env.WEB_ORIGIN = previousOrigin;
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

  it('skips the wire write when the client transport is already gone', async () => {
    // A client timeout must not cancel the run: the answer is still persisted
    // (like the web chat path), and only the socket write is dropped here.
    const res: any = {
      destroyed: true, writableEnded: true,
      status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn(), write: jest.fn(), end: jest.fn(),
    };
    const req: any = { headers: { 'x-app-id': 'app_valid', 'x-app-secret': 'sec_valid' }, query: {} };
    await controller.handleDirectRpc(req, res, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chat_knowledge', arguments: { prompt: 'q' } },
    });
    expect(mockMcpService.handleJsonRpc).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('should bind the credential user into the request context for RLS', async () => {
    const mockReq = {
      headers: {
        'x-app-id': 'app_valid',
        'x-app-secret': 'sec_valid',
      },
      query: {},
    } as any;

    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
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

    expect(setRequestContextUser).toHaveBeenCalledWith('user-1');
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
      params: { name: 'chat_knowledge', arguments: { prompt: '测试问题', kb_ids: ['11111111-1111-4111-8111-111111111111'] }, _meta: { progressToken: 'request-progress' } },
    });

    expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
    expect(mockRes.end).toHaveBeenCalled();
    expect(writes.length).toBeGreaterThan(0);
    const hasProgress = writes.some((w) => w.includes('notifications/progress'));
    expect(hasProgress).toBe(true);
  });
  it('revalidates credentials and applies rate limits for every legacy session message', async () => {
    const makeRequest = (secret = 'sec_valid') => ({ headers: { 'x-app-id': 'app_valid', 'x-app-secret': secret }, query: {}, on: jest.fn() } as any);
    const stream = { setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn(), writableEnded: false } as any;
    await controller.connectSse(makeRequest(), stream);
    const endpoint = stream.write.mock.calls[0][0] as string;
    const sessionId = /sessionId=([^\n]+)/.exec(endpoint)![1];
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() } as any;
    await controller.postMessage(makeRequest(), res, sessionId, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(mockUserCredentialService.verifyCredential).toHaveBeenCalledTimes(2);
    expect(mockRateLimitService.check).toHaveBeenCalledTimes(2);
    mockUserCredentialService.verifyCredential.mockResolvedValueOnce(null);
    await expect(controller.postMessage(makeRequest(), res, sessionId, { jsonrpc: '2.0', id: 2, method: 'ping' })).rejects.toThrow(UnauthorizedException);
    expect(mockMcpService.handleJsonRpc).toHaveBeenCalledTimes(1);
    mockUserCredentialService.verifyCredential.mockResolvedValueOnce({ user: { id: 'user-1' }, credential: { id: 'cred-1', appId: 'app_valid' } });
    await expect(controller.postMessage(makeRequest('rotated-secret'), res, sessionId, { jsonrpc: '2.0', id: 3, method: 'ping' })).rejects.toThrow(UnauthorizedException);
    expect(mockMcpService.handleJsonRpc).toHaveBeenCalledTimes(1);
  });
  it('returns 405 for modern GET and rejects an invalid protocol before dispatch', async () => {
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn(), setHeader: jest.fn() } as any;
    controller.rejectModernGet({ headers: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', 'POST');
    await expect(controller.handleDirectRpc({ headers: { 'mcp-protocol-version': 'invalid' } } as any, res, {})).rejects.toThrow(BadRequestException);
    expect(mockMcpService.handleJsonRpc).not.toHaveBeenCalled();
  });

  it('does not send custom delta notifications merely because Accept includes SSE', async () => {
    const req: any = { headers: { 'x-app-id': 'app_valid', 'x-app-secret': 'sec_valid', accept: 'application/json, text/event-stream' }, query: {} };
    const res: any = { setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn(), writableEnded: false };
    await controller.handleStreamEndpoint(req, res, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'retrieve', arguments: { query: 'q' } } });
    expect(mockMcpService.handleJsonRpc.mock.calls[0][2]).toBeUndefined();
    expect(JSON.stringify(res.write.mock.calls)).not.toContain('notifications/message');
  });
  it('emits standard progress only for the supplied token with increasing numeric progress', async () => {
    mockMcpService.handleJsonRpc.mockImplementation(async (_user: any, _body: any, progress: any) => {
      progress({ type: 'token', delta: 'draft' });
      progress({ type: 'progress', message: 'retrieval' }); progress({ type: 'progress', message: 'verification' });
      return { jsonrpc: '2.0', id: 1, result: { content: [] } };
    });
    const req: any = { headers: { 'x-app-id': 'app_valid', 'x-app-secret': 'sec_valid' }, query: {} };
    const res: any = { setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn(), writableEnded: false };
    await controller.handleStreamEndpoint(req, res, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chat_knowledge', _meta: { progressToken: 'token' } } });
    const messages = res.write.mock.calls.map((row: any[]) => JSON.parse(row[0].split('data: ')[1]));
    expect(messages.slice(0, 2)).toEqual([
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'token', progress: 1, message: 'retrieval' } },
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'token', progress: 2, message: 'verification' } },
    ]);
    expect(JSON.stringify(messages)).not.toContain('draft');
  });
  it('namespaces explicitly opted-in custom frames and keeps authoritative replacement', async () => {
    mockMcpService.handleJsonRpc.mockImplementation(async (_user: any, _body: any, progress: any) => {
      progress({ type: 'replace', content: 'final' }); return { jsonrpc: '2.0', id: 1, result: { content: [] } };
    });
    const req: any = { headers: { 'x-app-id': 'app_valid', 'x-app-secret': 'sec_valid' }, query: {} };
    const res: any = { setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn(), writableEnded: false };
    await controller.handleStreamEndpoint(req, res, { jsonrpc: '2.0', id: 1, method: 'tools/call', stream: true });
    expect(res.write.mock.calls[0][0]).toContain('notifications/gbrain/chat');
    expect(res.write.mock.calls[0][0]).toContain('final');
  });

});
