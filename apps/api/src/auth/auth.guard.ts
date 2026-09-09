import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PermissionService } from '../permission/permission.service';

const ADMIN_CAPABILITIES = [
  'org.read', 'org.user.read', 'org.user.manage', 'org.node.create',
  'role.read', 'role.manage',
  'kb.industry.read', 'kb.industry.create', 'kb.industry.manage', 'kb.industry.grant',
  'system.settings.read', 'system.settings.manage', 'audit.read',
];

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    // Missing/invalid credentials must surface as 401 (RFC 6750) so clients
    // can distinguish "re-authenticate" from "authenticated but forbidden".
    let userId: string;
    try {
      userId = await this.authService.userIdFromRequest(request);
    } catch {
      throw new UnauthorizedException("Invalid or missing credentials.");
    }
    if (!userId) throw new UnauthorizedException("Invalid or missing credentials.");
    if (
      !String(request.path || '').endsWith('/auth/change-password') &&
      !String(request.path || '').endsWith('/auth/me') &&
      (await this.authService.isPasswordChangeRequired(userId))
    ) {
      return false;
    }
    request.user = { id: userId };
    return true;
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private authService: AuthService, private permissionService: PermissionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    try {
      const userId = await this.authService.userIdFromRequest(request);
      if (await this.authService.isPasswordChangeRequired(userId)) return false;
      const capabilities = await this.permissionService.getCapabilities(userId);
      // Allow regular users to create personal knowledge bases
      const isPersonalKbCreation =
        request.method === 'POST' &&
        (request.path === '/api/v1/admin/kbs' || request.url?.includes('/admin/kbs')) &&
        request.body?.type === 'personal';
      if (!isPersonalKbCreation && !capabilities.includes('*') && !ADMIN_CAPABILITIES.some((permission) => capabilities.includes(permission))) return false;
      request.user = { id: userId, isAdmin: capabilities.includes('*') };
      return true;
    } catch {
      return false;
    }
  }
}
