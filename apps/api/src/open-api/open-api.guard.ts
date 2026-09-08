import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UserCredentialService } from '../auth/user-credential.service';
import { AuthService } from '../auth/auth.service';
import { getPrismaClient } from '../prisma';

@Injectable()
export class OpenApiGuard implements CanActivate {
  private readonly prisma = getPrismaClient();

  constructor(
    private readonly userCredentialService: UserCredentialService,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const headers = request.headers || {};
    const query = request.query || {};

    // 1. Primary auth route: X-App-Id & X-App-Secret headers
    const appId =
      headers['x-app-id'] ||
      headers['app-id'] ||
      headers['x-appid'] ||
      query.app_id ||
      query.appId;

    const appSecret =
      headers['x-app-secret'] ||
      headers['app-secret'] ||
      headers['x-appsecret'] ||
      query.app_secret ||
      query.appSecret;

    if (appId && appSecret) {
      const verified = await this.userCredentialService.verifyCredential(
        String(appId).trim(),
        String(appSecret).trim(),
      );
      if (!verified) {
        throw new UnauthorizedException({
          code: 401,
          msg: '鉴权失败：X-App-Id 或 X-App-Secret 不正确或已被禁用',
          data: null,
        });
      }
      request.user = verified.user;
      request.credential = verified.credential;
      return true;
    }

    // 2. Secondary fallback: Session/Bearer JWT authentication
    const authHeader = String(headers.authorization || '');
    if (authHeader.startsWith('Bearer ')) {
      try {
        const userId = await this.authService.userIdFromRequest(request);
        const user = await this.prisma.user.findUnique({
          where: { id: userId, status: 'active' },
          include: {
            roles: { include: { role: true } },
            orgs: { include: { orgNode: true } },
          },
        });
        if (user) {
          request.user = {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            email: user.email,
            roles: user.roles,
            orgs: user.orgs,
          };
          return true;
        }
      } catch {
        // Fall through to 401
      }
    }

    throw new UnauthorizedException({
      code: 401,
      msg: '鉴权失败：缺少 X-App-Id 或 X-App-Secret 请求头',
      data: null,
    });
  }
}
