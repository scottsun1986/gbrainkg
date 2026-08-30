import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PermissionService } from '../permission/permission.service';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';

@UseGuards(AuthGuard)
@Controller('api/v1/session')
export class SessionController {
  private readonly prisma = new PrismaClient();

  constructor(
    private readonly authService: AuthService,
    private readonly permissionService: PermissionService,
  ) {}

  @Get('bootstrap')
  async bootstrap(@Req() req: any) {
    const userId = await this.authService.userIdFromRequest(req);
    const visibleIds = await this.permissionService.getVisibleKnowledgeBases(userId);
    const [user, kbs, capabilities, managedOrgIds, systemAdmin] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, displayName: true, email: true, roles: { include: { role: true } }, orgs: { include: { orgNode: true } } } }),
      this.prisma.knowledgeBase.findMany({ where: { id: { in: visibleIds }, status: 'active' }, include: { _count: { select: { documents: true } } }, orderBy: { createdAt: 'desc' } }),
      this.permissionService.getCapabilities(userId),
      this.permissionService.getManagedOrgIds(userId),
      this.permissionService.isSystemAdmin(userId),
    ]);
    const writePermissions = await Promise.all(kbs.map((kb) => this.permissionService.canManageKnowledgeBase(userId, kb.id)));
    return { user, kbs: kbs.map(({ _count, ...kb }, index) => ({ ...kb, documentCount: _count.documents, canWrite: writePermissions[index], canDelete: systemAdmin || (kb.type === 'personal' && kb.ownerUserId === userId) })), capabilities, managedOrgIds: [...managedOrgIds] };
  }
}
