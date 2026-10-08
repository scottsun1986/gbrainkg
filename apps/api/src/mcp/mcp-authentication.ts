import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Request } from 'express';
import { UserCredentialService } from '../auth/user-credential.service';
import { OpenApiRateLimitService } from '../open-api/open-api-rate-limit.service';
import { AuthService } from '../auth/auth.service';
import { setRequestContextUser } from '../observability/request-context';
import { runAsAuth } from '../db/tenant-context.service';
import { trustedMcpInstanceUrl, validateMcpOrigin } from './mcp-protocol';
export const MCP_AUTHENTICATION = Symbol('mcp-authentication');
export type McpIdentity = { user: any; credential?: any; binding: string };
@Injectable()
export class McpAuthenticationService {
  constructor(private readonly userCredentialService: UserCredentialService, private readonly rateLimitService: OpenApiRateLimitService, private readonly authService: AuthService) {}
  async authenticate(req: Request): Promise<McpIdentity> {
    const existing = (req as any)[MCP_AUTHENTICATION];
    if (existing) return existing;
    validateMcpOrigin(req);
    const headers = req.headers || {};

    const appId =
      headers['x-app-id'] ||
      headers['app-id'] ||
      headers['x-appid'];

    const appSecret =
      headers['x-app-secret'] ||
      headers['app-secret'] ||
      headers['x-appsecret'];

    if ((appId || appSecret) && (typeof appId !== 'string' || typeof appSecret !== 'string')) throw new UnauthorizedException('Invalid MCP credential headers');
    if (appId && appSecret) {
      const verified = await this.userCredentialService.verifyCredential(
        String(appId).trim(),
        String(appSecret).trim(),
      );
      if (!verified) {
        throw new UnauthorizedException({
          code: 401,
          message: 'MCP 鉴权失败：X-App-Id 或 X-App-Secret 不正确或已被禁用',
        });
      }

      // 凭证鉴权不经过 AuthService.userIdFromRequest，必须显式把用户写入请求
      // 上下文，供应用层授权与审计关联请求用户。
      setRequestContextUser(verified.user.id);

      const rate = this.rateLimitService.check(String(appId).trim());
      if (!rate.allowed) {
        throw new HttpException(
          {
            code: 429,
            message: `请求过于频繁：该 AppId 每分钟最多 ${this.rateLimitService.limitPerMinute} 次请求，请在 ${rate.retryAfterSec} 秒后重试`,
          },
          429,
        );
      }

      const identity = { user: { ...verified.user, mcpAuth: { method: 'app_credentials', appId: String(appId).trim(), instanceUrl: trustedMcpInstanceUrl() } }, credential: verified.credential, binding: createHash('sha256').update(JSON.stringify([verified.user.id, verified.credential.id, String(appId).trim(), String(appSecret).trim()])).digest('hex') };
      (req as any)[MCP_AUTHENTICATION] = identity;
      return identity;
    }

    // Fallback: Bearer JWT
    if (headers.authorization !== undefined && typeof headers.authorization !== 'string') throw new UnauthorizedException('Invalid Authorization header');
    const authHeader = String(headers.authorization || '');
    if (authHeader.startsWith('Bearer ')) {
      try {
        const userId = await this.authService.userIdFromRequest(req);
        const rate = this.rateLimitService.check(userId);
        if (!rate.allowed) {
          throw new HttpException(
            {
              code: 429,
              message: `请求过于频繁：每分钟最多 ${this.rateLimitService.limitPerMinute} 次请求，请在 ${rate.retryAfterSec} 秒后重试`,
            },
            429,
          );
        }
        const user = await runAsAuth((tx) => tx.user.findUnique({
          where: { id: userId, status: 'active' },
          include: {
            roles: { include: { role: true } },
            orgs: { include: { orgNode: true } },
          },
        }));
        if (user) {
          const identity = {
            user: {
              id: user.id,
              username: user.username,
              displayName: user.displayName,
              email: user.email,
              roles: user.roles,
              orgs: user.orgs,
              mcpAuth: { method: 'bearer', instanceUrl: trustedMcpInstanceUrl() },
            },
            binding: createHash('sha256').update(JSON.stringify([user.id, authHeader])).digest('hex'),
          };
          (req as any)[MCP_AUTHENTICATION] = identity;
          return identity;
        }
      } catch (error) {
        if (error instanceof HttpException && error.getStatus() === 429) throw error;
      }
    }

    throw new UnauthorizedException({
      code: 401,
      message: 'MCP 鉴权失败：缺少有效的 X-App-Id 和 X-App-Secret 凭证',
    });
  }

}

@Injectable()
export class McpUploadGuard implements CanActivate {
  constructor(private readonly authentication: McpAuthenticationService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> { await this.authentication.authenticate(context.switchToHttp().getRequest()); return true; }
}

@Injectable()
export class McpOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean { validateMcpOrigin(context.switchToHttp().getRequest()); return true; }
}
