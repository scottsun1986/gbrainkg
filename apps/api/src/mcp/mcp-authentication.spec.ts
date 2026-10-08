import { UnauthorizedException } from '@nestjs/common';
import { McpAuthenticationService, McpUploadGuard } from './mcp-authentication';

describe('MCP upload authentication guard', () => {
  it('authenticates and limits before file parsing, then reuses only that request identity', async () => {
    const credentials = { verifyCredential: jest.fn().mockResolvedValue({ user: { id: 'user' }, credential: { id: 'credential', appId: 'app' } }) };
    const rate = { check: jest.fn().mockReturnValue({ allowed: true }), limitPerMinute: 60 };
    const authentication = new McpAuthenticationService(credentials as any, rate as any, {} as any);
    const guard = new McpUploadGuard(authentication);
    const req: any = { headers: { 'x-app-id': 'app', 'x-app-secret': 'secret' } };
    const context: any = { switchToHttp: () => ({ getRequest: () => req }) };
    expect(await guard.canActivate(context)).toBe(true);
    expect(req.file).toBeUndefined();
    await authentication.authenticate(req);
    expect(credentials.verifyCredential).toHaveBeenCalledTimes(1);
    expect(rate.check).toHaveBeenCalledTimes(1);
    credentials.verifyCredential.mockResolvedValueOnce(null);
    await expect(authentication.authenticate({ headers: { ...req.headers } } as any)).rejects.toThrow(UnauthorizedException);
  });
});
