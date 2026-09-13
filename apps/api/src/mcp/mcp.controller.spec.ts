import { McpController } from './mcp.controller';
import { UnauthorizedException } from '@nestjs/common';

describe('McpController', () => {
  let controller: McpController;
  let mockMcpService: any;
  let mockUserCredentialService: any;
  let mockRateLimitService: any;
  let mockAuthService: any;

  beforeEach(() => {
    mockMcpService = {
      getTools: jest.fn().mockReturnValue([{ name: 'search_knowledge' }]),
      handleJsonRpc: jest.fn().mockResolvedValue({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'ok' }] },
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

  it('should return mcp spec with tools and configurations', () => {
    const mockReq = {
      get: jest.fn().mockReturnValue('127.0.0.1:3202'),
      protocol: 'http',
    } as any;

    const spec = controller.getMcpSpec(mockReq);
    expect(spec.name).toBe('gbrainkg-mcp');
    expect(spec.endpoints.sse).toBe('http://127.0.0.1:3202/mcp/sse');
    expect(spec.clientConfigurations.cursor_and_windsurf).toBeDefined();
    expect(spec.clientConfigurations.claude_desktop).toBeDefined();
    expect(spec.tools).toBeDefined();
  });

  it('should reject direct rpc without credentials', async () => {
    const mockReq = {
      headers: {},
      query: {},
    } as any;

    await expect(
      controller.handleDirectRpc(mockReq, { jsonrpc: '2.0', id: 1, method: 'ping' }),
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

    const res = await controller.handleDirectRpc(mockReq, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_knowledge', arguments: { query: 'test' } },
    });

    expect(res).toBeDefined();
    expect(res.jsonrpc).toBe('2.0');
    expect(mockMcpService.handleJsonRpc).toHaveBeenCalled();
  });
});
