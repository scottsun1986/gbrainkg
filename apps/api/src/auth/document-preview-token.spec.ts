import 'reflect-metadata';
import { AuthGuard } from './auth.guard';
import { DOCUMENT_PREVIEW_TRANSPORT, signPreviewPayload, verifyPreviewPayload } from './document-preview-token';

describe('document preview transport', () => {
  beforeAll(() => { process.env.PREVIEW_TOKEN_SECRET = 'preview-test-secret-at-least-32-characters'; });
  afterAll(() => { delete process.env.PREVIEW_TOKEN_SECRET; });
  const payload = () => ({ userId: 'user', kbId: 'kb', docId: 'doc', version: 2, exp: Math.floor(Date.now() / 1000) + 60 });
  it('accepts OnlyOffice token without a login credential only on the marked method', async () => {
    const handler = () => undefined;
    Reflect.defineMetadata(DOCUMENT_PREVIEW_TRANSPORT, true, handler);
    const request = { query: { token: signPreviewPayload(payload()) }, params: { kbId: 'kb', docId: 'doc' } };
    const auth = { userIdFromRequest: jest.fn().mockRejectedValue(new Error('missing')) };
    const guard = new AuthGuard(auth as any);
    const context = { getHandler: () => handler, switchToHttp: () => ({ getRequest: () => request }) };
    await expect(guard.canActivate(context as any)).resolves.toBe(true);
    expect(auth.userIdFromRequest).not.toHaveBeenCalled();
    await expect(guard.canActivate({ ...context, getHandler: () => () => undefined } as any)).rejects.toThrow();
  });
  it('rejects expired, extended and altered tokens', () => {
    const token = signPreviewPayload(payload());
    expect(verifyPreviewPayload(token)).toMatchObject({ version: 2 });
    expect(verifyPreviewPayload(`${token}.extra`)).toBeNull();
    expect(verifyPreviewPayload(token.replace(/^./, 'x'))).toBeNull();
    expect(verifyPreviewPayload(signPreviewPayload({ ...payload(), exp: 1 }))).toBeNull();
  });
  it('rejects another document token at the guard', async () => {
    const handler = () => undefined;
    Reflect.defineMetadata(DOCUMENT_PREVIEW_TRANSPORT, true, handler);
    const request = { query: { token: signPreviewPayload(payload()) }, params: { kbId: 'kb', docId: 'other' } };
    await expect(new AuthGuard({} as any).canActivate({ getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => request }) } as any)).rejects.toThrow('Invalid preview credentials');
  });
});
