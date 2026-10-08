import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { trustedMcpInstanceUrl, validateMcpOrigin, validateMcpProtocol } from './mcp-protocol';

describe('MCP HTTP boundary', () => {
  const original = { publicUrl: process.env.PUBLIC_API_URL, web: process.env.WEB_ORIGIN, cors: process.env.CORS_ORIGINS };
  afterEach(() => {
    for (const [key, value] of Object.entries({ PUBLIC_API_URL: original.publicUrl, WEB_ORIGIN: original.web, CORS_ORIGINS: original.cors })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  it('allows server clients without Origin and actively rejects untrusted browser Origins', () => {
    process.env.WEB_ORIGIN = 'https://trusted.example'; delete process.env.CORS_ORIGINS;
    expect(() => validateMcpOrigin({ headers: {} } as any)).not.toThrow();
    expect(() => validateMcpOrigin({ headers: { origin: 'https://trusted.example' } } as any)).not.toThrow();
    expect(() => validateMcpOrigin({ headers: { origin: 'https://evil.example' } } as any)).toThrow(ForbiddenException);
    expect(() => validateMcpOrigin({ headers: { origin: ['https://trusted.example'] } } as any)).toThrow(ForbiddenException);
  });
  it('validates supported protocol headers without treating missing legacy headers as invalid', () => {
    for (const version of ['2024-11-05', '2025-11-25']) expect(() => validateMcpProtocol({ headers: { 'mcp-protocol-version': version } } as any)).not.toThrow();
    expect(() => validateMcpProtocol({ headers: {} } as any)).not.toThrow();
    for (const version of ['invalid', ['2025-11-25']]) expect(() => validateMcpProtocol({ headers: { 'mcp-protocol-version': version } } as any)).toThrow(BadRequestException);
  });
  it('uses trusted deployment configuration for the instance address', () => {
    process.env.PUBLIC_API_URL = 'https://instance.example:20580';
    expect(trustedMcpInstanceUrl()).toBe('https://instance.example:20580');
    process.env.PUBLIC_API_URL = 'https://secret@instance.example';
    expect(() => trustedMcpInstanceUrl()).toThrow('Invalid public instance URL');
  });
});
