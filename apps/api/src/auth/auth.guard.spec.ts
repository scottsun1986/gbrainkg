import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard, AdminGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { PermissionService } from '../permission/permission.service';

describe('AuthGuards', () => {
  let authService: jest.Mocked<AuthService>;
  let permissionService: jest.Mocked<PermissionService>;
  let mockExecutionContext: ExecutionContext;

  beforeEach(() => {
    authService = {
      userIdFromRequest: jest.fn(),
      isPasswordChangeRequired: jest.fn().mockResolvedValue(false),
    } as any;

    permissionService = {
      getCapabilities: jest.fn(),
    } as any;

    mockExecutionContext = {
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: jest.fn().mockReturnValue({ path: '/api/test' }),
      }),
    } as any;
  });

  describe('AuthGuard tests', () => {
    let authGuard: AuthGuard;

    beforeEach(() => {
      authGuard = new AuthGuard(authService);
    });

    it('allows valid token', async () => {
      authService.userIdFromRequest.mockResolvedValue('user123');
      const result = await authGuard.canActivate(mockExecutionContext);
      expect(result).toBe(true);
      expect(mockExecutionContext.switchToHttp().getRequest().user.id).toBe('user123');
    });

    it('rejects missing token (401)', async () => {
      authService.userIdFromRequest.mockResolvedValue('');
      await expect(authGuard.canActivate(mockExecutionContext)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects expired token (401)', async () => {
      authService.userIdFromRequest.mockRejectedValue(new Error('Expired'));
      await expect(authGuard.canActivate(mockExecutionContext)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects tampered token (401)', async () => {
      authService.userIdFromRequest.mockRejectedValue(new Error('Invalid signature'));
      await expect(authGuard.canActivate(mockExecutionContext)).rejects.toThrow(UnauthorizedException);
    });

    it('handles force password change requirement', async () => {
      authService.userIdFromRequest.mockResolvedValue('user123');
      authService.isPasswordChangeRequired.mockResolvedValue(true);
      const result = await authGuard.canActivate(mockExecutionContext);
      expect(result).toBe(false);
    });
  });

  describe('AdminGuard privilege escalation tests (CRITICAL)', () => {
    let adminGuard: AdminGuard;

    beforeEach(() => {
      adminGuard = new AdminGuard(authService, permissionService);
      authService.userIdFromRequest.mockResolvedValue('user123');
    });

    it('User with ONLY audit.read should be allowed in AdminGuard but risks horizontal escalation', async () => {
      // NOTE: This test documents the horizontal escalation risk.
      // If AdminGuard allows any user with 'audit.read', they can potentially
      // access endpoints requiring other admin capabilities unless the controller
      // explicitly performs fine-grained checks.
      permissionService.getCapabilities.mockResolvedValue(['audit.read']);
      const result = await adminGuard.canActivate(mockExecutionContext);
      expect(result).toBe(true);
      expect(mockExecutionContext.switchToHttp().getRequest().user.isAdmin).toBe(false);
    });

    it('User with ONLY kb.industry.manage should be allowed (same escalation risk)', async () => {
      permissionService.getCapabilities.mockResolvedValue(['kb.industry.manage']);
      const result = await adminGuard.canActivate(mockExecutionContext);
      expect(result).toBe(true);
    });

    it('Test that each individual admin capability grants access to AdminGuard', async () => {
      const ADMIN_CAPABILITIES = [
        'org.read', 'org.user.read', 'org.user.manage', 'org.node.create',
        'role.read', 'role.manage',
        'kb.industry.read', 'kb.industry.create', 'kb.industry.manage', 'kb.industry.grant',
        'system.settings.read', 'system.settings.manage', 'audit.read',
      ];
      
      for (const cap of ADMIN_CAPABILITIES) {
        permissionService.getCapabilities.mockResolvedValue([cap]);
        const result = await adminGuard.canActivate(mockExecutionContext);
        expect(result).toBe(true);
      }
    });

    it('Test that wildcard * grants full admin access', async () => {
      permissionService.getCapabilities.mockResolvedValue(['*']);
      const result = await adminGuard.canActivate(mockExecutionContext);
      expect(result).toBe(true);
      expect(mockExecutionContext.switchToHttp().getRequest().user.isAdmin).toBe(true);
    });

    it('Test that a user with NO admin capabilities is blocked', async () => {
      permissionService.getCapabilities.mockResolvedValue(['user.basic']);
      const result = await adminGuard.canActivate(mockExecutionContext);
      expect(result).toBe(false);
    });
  });
});
