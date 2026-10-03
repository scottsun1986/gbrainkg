import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { PermissionService } from '../permission/permission.service';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';

@UseGuards(AuthGuard)
@Controller('api/v1/session')
export class SessionController {
  private readonly prisma = getPrismaClient();

  constructor(
    private readonly authService: AuthService,
    private readonly permissionService: PermissionService,
  ) {}

  @Get('bootstrap')
  async bootstrap(@Req() req: any) {
    const userId = await this.authService.userIdFromRequest(req);
    const visibleIds = await this.permissionService.getVisibleKnowledgeBases(userId);
    const [user, kbs, capabilities, managedOrgIds, systemAdmin] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, displayName: true, email: true, mustChangePassword: true, roles: { include: { role: true } }, orgs: { include: { orgNode: true } } } }),
      this.prisma.knowledgeBase.findMany({ where: { id: { in: visibleIds }, status: 'active' }, select: { id: true, name: true, type: true, description: true, ownerUserId: true, createdAt: true, updatedAt: true }, orderBy: { createdAt: 'desc' } }),
      this.permissionService.getCapabilities(userId),
      this.permissionService.getManagedOrgIds(userId),
      this.permissionService.isSystemAdmin(userId),
    ]);
    const writePermissions = await this.permissionService.canManageKnowledgeBases(userId, kbs.map((kb) => kb.id));
    // documentCount 不再在 bootstrap 中聚合（原先 N+1 COUNT 导致 54 个 KB 耗时 5s）。
    // 文档数量延迟到知识库详情页按需加载。
    const mappedKbs = kbs.map((kb) => ({ ...kb, documentCount: 0, canWrite: writePermissions.get(kb.id) || false, canDelete: systemAdmin || (kb.type === 'personal' && kb.ownerUserId === userId) }));
    // B-3: knowledgeBases 重复字段已删除（web 仅消费 kbs）；载荷减半。
    return { user, kbs: mappedKbs, capabilities, managedOrgIds: [...managedOrgIds] };
  }
}
