import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
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
    try {
      const userId = await this.authService.userIdFromRequest(request);
      request.user = { id: userId };
      return true;
    } catch {
      return false;
    }
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private authService: AuthService, private permissionService: PermissionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    try {
      const userId = await this.authService.userIdFromRequest(request);
      const capabilities = await this.permissionService.getCapabilities(userId);
      if (!capabilities.includes('*') && !ADMIN_CAPABILITIES.some((permission) => capabilities.includes(permission))) return false;
      request.user = { id: userId, isAdmin: capabilities.includes('*') };
      return true;
    } catch {
      return false;
    }
  }
}
