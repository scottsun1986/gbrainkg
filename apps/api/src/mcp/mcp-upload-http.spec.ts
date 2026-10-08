import { Test } from '@nestjs/testing';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { McpAuthenticationService, McpOriginGuard, McpUploadGuard } from './mcp-authentication';
import { UserCredentialService } from '../auth/user-credential.service';
import { OpenApiRateLimitService } from '../open-api/open-api-rate-limit.service';
import { AuthService } from '../auth/auth.service';
const request = require('supertest');

describe('MCP multipart authentication order', () => {
  it('rejects unauthorized malformed multipart before parsing and actively rejects hostile Origins', async () => {
    const service = { saveUploadAndEnqueue: jest.fn() };
    const credential = { verifyCredential: jest.fn().mockResolvedValue(null) };
    const module = await Test.createTestingModule({
      controllers: [McpController],
      providers: [McpAuthenticationService, McpOriginGuard, McpUploadGuard,
        { provide: McpService, useValue: service },
        { provide: UserCredentialService, useValue: credential },
        { provide: OpenApiRateLimitService, useValue: { check: jest.fn().mockReturnValue({ allowed: true }) } },
        { provide: AuthService, useValue: {} }],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer()).post('/mcp/upload').set('Content-Type', 'multipart/form-data; boundary=broken').send('invalid multipart').expect(401);
      await request(app.getHttpServer()).post('/mcp/upload').set('Origin', 'https://untrusted.invalid').set('Content-Type', 'multipart/form-data; boundary=broken').send('invalid multipart').expect(403);
      expect(service.saveUploadAndEnqueue).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
