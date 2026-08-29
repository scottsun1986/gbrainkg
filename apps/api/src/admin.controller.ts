import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Req } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PermissionService } from './permission/permission.service';
import { AuthService } from './auth/auth.service';
import { BrainCompilerService } from './brain-compiler/brain-compiler.service';
import { ModelConfigService } from './model-config.service';

const prisma = new PrismaClient();

@Controller('api/v1/admin')
export class AdminController {
  constructor(private readonly permissionService: PermissionService, private readonly authService: AuthService, private readonly brainCompilerService: BrainCompilerService, private readonly modelConfigService: ModelConfigService) {}

  @Get('data')
  async getAllData(@Req() req: any) {
    const adminId = await this.authService.userIdFromRequest(req);
    const capabilities = await this.permissionService.getCapabilities(adminId);
    const isSystemAdmin = capabilities.includes('*');
    const managedOrgIds = await this.permissionService.getManagedOrgIds(adminId);
    const directIndustryScopeCount = await prisma.knowledgeBase.count({ where: { type: 'industry', status: 'active', OR: [{ ownerUserId: adminId }, { admins: { some: { userId: adminId } } }] } });
    const canReadOrg = isSystemAdmin || capabilities.includes('org.read') || capabilities.includes('org.user.read');
    // 行业库管理菜单是角色能力，不是某个具体行业库的管理员关系。
    // 具体行业库的列表仍在 industryScopeKbs 中按资源范围收敛。
    const canReadIndustry = isSystemAdmin || capabilities.includes('kb.industry.read');
    const canReadRoles = isSystemAdmin || capabilities.includes('role.read');
    const canReadAudit = isSystemAdmin || capabilities.includes('audit.read');
    // 某个行业库管理员即使没有“行业库管理员”角色，也需要能通过知识库
    // 页面维护自己负责的库；但这不应让他看到行业库管理菜单。
    if (!canReadOrg && !canReadIndustry && !canReadRoles && !canReadAudit && directIndustryScopeCount === 0) throw new ForbiddenException('No administration permission.');

    const users = await prisma.user.findMany({
      include: { roles: { include: { role: true } }, orgs: { include: { orgNode: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const allOrgs = await prisma.orgNode.findMany({ where: { status: 'active' }, include: { admins: { include: { user: { select: { id: true, displayName: true, username: true } } } }, kbs: { where: { status: 'active' }, select: { id: true, name: true, status: true, description: true, orgNodeId: true, admins: { include: { user: { select: { displayName: true, username: true } } } } } } }, orderBy: [{ path: 'asc' }, { sort: 'asc' }] });
    const orgs = (canReadOrg || canReadIndustry) ? allOrgs.filter((org) => isSystemAdmin || canReadIndustry || managedOrgIds.has(org.id)).map((org) => ({
      ...org,
      canManage: isSystemAdmin || managedOrgIds.has(org.id),
      canCreateChild: isSystemAdmin || managedOrgIds.has(org.id),
      canSetAdmin: isSystemAdmin,
    })) : [];
    const kbs = await prisma.knowledgeBase.findMany({
      where: { status: 'active' },
      include: { admins: { include: { user: true } }, _count: { select: { documents: true } } },
    });
    const [roles, grants, providers, configs, compileJobs, documents] = await Promise.all([
      prisma.role.findMany({ include: { _count: { select: { users: true } } }, orderBy: { name: 'asc' } }),
      prisma.industryGrant.findMany({ include: { kb: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } }),
      prisma.modelProvider.findMany({ orderBy: { name: 'asc' } }),
      prisma.modelConfig.findMany({ include: { provider: true }, orderBy: { createdAt: 'asc' } }),
      prisma.compileJob.findMany({ include: { user: { select: { displayName: true, username: true } }, brainTopic: { select: { topicSlug: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.document.findMany({ include: { kb: { select: { name: true } } }, orderBy: { updatedAt: 'desc' }, take: 100 }),
    ]);
    const safeProviders = (isSystemAdmin ? providers : []).map(({ apiKeyEncrypted, ...provider }) => ({
      ...provider,
      keyMask: apiKeyEncrypted ? `已配置 · ${Buffer.from(apiKeyEncrypted).toString('utf8').slice(-4).padStart(4, '*')}` : '(无密钥)',
      hasApiKey: Boolean(apiKeyEncrypted),
    }));
    const industryScopeKbs = kbs.filter((kb) => kb.type === 'industry' && (isSystemAdmin || kb.ownerUserId === adminId || kb.admins.some((admin) => admin.userId === adminId)));
    // 管理后台的管理范围和用户实际阅读范围不同：普通成员不能管理组织库，
    // 但仍应在对话/知识库页面看到自己按组织继承规则可读的组织库。
    const readableKbIds = new Set(await this.permissionService.getVisibleKnowledgeBases(adminId));
    const readableKbs = kbs.filter((kb) => readableKbIds.has(kb.id));
    const visibleKbs = isSystemAdmin ? kbs : [...new Map([...readableKbs, ...industryScopeKbs].map((kb) => [kb.id, kb])).values()];
    const safeUsers = users
      .filter((user) => isSystemAdmin || canReadIndustry || user.orgs.some((org) => managedOrgIds.has(org.orgNodeId)) || user.id === adminId)
      .map(({ passwordHash, ...user }) => ({ ...user, canManage: isSystemAdmin || user.orgs.some((org) => managedOrgIds.has(org.orgNodeId)) }));
    const safeGrants = grants.filter((grant) => isSystemAdmin || industryScopeKbs.some((kb) => kb.id === grant.kbId));
    const safeDocuments = documents.filter((doc) => isSystemAdmin || visibleKbs.some((kb) => kb.id === doc.kbId));
    const userById = new Map(users.map((user) => [user.id, user]));
    const safeCompileJobs = isSystemAdmin ? compileJobs : compileJobs.filter((job) => job.userId === adminId);
    const audit = [
      ...(canReadAudit ? safeDocuments.map((doc) => ({ id: `doc-${doc.id}`, when: doc.updatedAt, action: `文档「${doc.title}」状态变更为 ${doc.status}`, actor: doc.uploadedById ? (userById.get(doc.uploadedById)?.displayName || userById.get(doc.uploadedById)?.username || doc.uploadedById) : '系统', source: doc.kb.name })) : []),
      ...(canReadAudit ? safeCompileJobs.map((job) => ({ id: `job-${job.id}`, when: job.createdAt, action: `主题「${job.brainTopic.topicSlug}」编译任务 ${job.status}`, actor: job.user.displayName || job.user.username, source: job.trigger })) : []),
      ...(canReadAudit ? safeGrants.map((grant) => ({ id: `grant-${grant.id}`, when: grant.createdAt, action: `为「${grant.kb.name}」新增 ${grant.subjectType} 授权`, actor: grant.grantedById, source: grant.kb.name })) : []),
    ].sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime()).slice(0, 100);
    const writePermissions = await Promise.all(visibleKbs.map((kb) => this.permissionService.canManageKnowledgeBase(adminId, kb.id)));
    const managedIndustryWritePermissions = await Promise.all(industryScopeKbs.map((kb) => this.permissionService.canManageKnowledgeBase(adminId, kb.id)));
    return {
      user: (() => {
        const current = safeUsers.find((item) => item.id === adminId);
        if (!current) return null;
        return current;
      })(),
      users: safeUsers,
      orgs,
      roles: canReadRoles ? roles.map(({ _count, ...role }) => ({ ...role, users: _count.users, perms: Array.isArray(role.permissions) ? role.permissions : [] })) : [],
      kbs: visibleKbs.map(({ _count, ...kb }, index) => ({ ...kb, documentCount: _count.documents, canWrite: writePermissions[index], canManage: isSystemAdmin || (kb.type === 'industry' && (kb.ownerUserId === adminId || kb.admins.some((admin) => admin.userId === adminId))), canGrant: isSystemAdmin || (kb.type === 'industry' && (kb.ownerUserId === adminId || kb.admins.some((admin) => admin.userId === adminId))), canDelete: isSystemAdmin || (kb.type === 'personal' && kb.ownerUserId === adminId) || (kb.type === 'industry' && kb.ownerUserId === adminId) })),
      // 管理后台的行业库页只消费这一组，避免“可阅读但不可管理”的行业库
      // 因阅读权限混入行业库管理列表。
      managedIndustryKbs: industryScopeKbs.map(({ _count, ...kb }, index) => ({ ...kb, documentCount: _count.documents, canWrite: managedIndustryWritePermissions[index], canManage: isSystemAdmin || kb.ownerUserId === adminId || kb.admins.some((admin) => admin.userId === adminId), canGrant: isSystemAdmin || kb.ownerUserId === adminId || kb.admins.some((admin) => admin.userId === adminId), canDelete: isSystemAdmin || kb.ownerUserId === adminId })),
      grants: safeGrants,
      providers: safeProviders,
      models: isSystemAdmin ? configs.map(({ provider, ...config }) => ({ ...config, provider })) : [],
      audit,
      capabilities,
      managedOrgIds: [...managedOrgIds],
    };
  }

  @Post('orgs')
  async createOrg(@Req() req: any, @Body() body: any) {
    const userId = await this.authService.userIdFromRequest(req);
    const name = String(body?.name || '').trim();
    const parentId = body?.parentId ? String(body.parentId) : null;
    if (!name) throw new BadRequestException('Organization name is required.');
    if (name.length > 120) throw new BadRequestException('Organization name is too long.');
    if (/[\\/]/.test(name)) throw new BadRequestException('Organization name cannot contain slash characters.');
    if (parentId && !/^[0-9a-f-]{36}$/i.test(parentId)) throw new BadRequestException('Invalid parent organization.');

    const parent = parentId
      ? await prisma.orgNode.findFirst({ where: { id: parentId, status: 'active' } })
      : null;
    if (parentId && !parent) throw new NotFoundException('Parent organization not found.');
    if (!parentId && !(await this.permissionService.isSystemAdmin(userId))) throw new ForbiddenException('Only a system administrator can create a root organization.');
    if (parentId && !(await this.permissionService.canManageOrganization(userId, parentId))) throw new ForbiddenException('You can only create child organizations within your managed scope.');

    const siblingCount = await prisma.orgNode.count({
      where: { parentId, status: 'active' },
    });
    const basePath = parent ? `${parent.path}/${name}` : `/${name}`;
    const duplicate = await prisma.orgNode.findFirst({ where: { path: basePath, status: 'active' } });
    if (duplicate) throw new BadRequestException('An organization with the same path already exists.');

    const org = await prisma.orgNode.create({
      data: { name, parentId, path: basePath, sort: siblingCount },
    });
    return { organization: org };
  }

  @Post('orgs/:id/admins')
  async updateOrgAdmins(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const operatorId = await this.authService.userIdFromRequest(req);
    if (!(await this.permissionService.canManageOrganization(operatorId, id))) throw new ForbiddenException('You can only manage administrators within your organization scope.');
    const org = await prisma.orgNode.findFirst({ where: { id, status: 'active' }, include: { kbs: { select: { id: true } } } });
    if (!org) throw new NotFoundException('Organization not found.');
    const userIds = Array.isArray(body?.userIds) ? body.userIds : [];
    const activeUsers = await prisma.user.findMany({ where: { id: { in: userIds }, status: 'active' }, select: { id: true } });
    if (activeUsers.length !== new Set(userIds).size) throw new BadRequestException('Organization administrators must be active users.');
    await prisma.$transaction(async (tx) => {
      await tx.orgAdmin.deleteMany({ where: { orgNodeId: id } });
      if (userIds.length) await tx.orgAdmin.createMany({ data: userIds.map((userId: string) => ({ orgNodeId: id, userId })) });
      for (const kb of org.kbs) {
        await tx.kbAdmin.deleteMany({ where: { kbId: kb.id } });
        if (userIds.length) await tx.kbAdmin.createMany({ data: userIds.map((userId: string) => ({ kbId: kb.id, userId })) });
      }
    });
    return { ok: true };
  }

  @Delete('orgs/:id')
  async archiveOrg(@Req() req: any, @Param('id') id: string) {
    const operatorId = await this.authService.userIdFromRequest(req);
    if (!(await this.permissionService.canManageOrganization(operatorId, id))) throw new ForbiddenException('You can only archive organizations within your organization scope.');
    const childCount = await prisma.orgNode.count({ where: { parentId: id, status: 'active' } });
    if (childCount) throw new BadRequestException('Move or archive child organizations first.');
    const org = await prisma.orgNode.update({ where: { id }, data: { status: 'archived' } });
    return { organization: org };
  }

  private async canManageOrganization(userId: string, orgId: string): Promise<boolean> {
    return this.permissionService.canManageOrganization(userId, orgId);
  }

  @Post('orgs/:id/knowledge-base/activate')
  async activateOrganizationKnowledgeBase(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const userId = await this.authService.userIdFromRequest(req);
    if (!(await this.canManageOrganization(userId, id))) throw new BadRequestException('Only a system administrator or an administrator of this organization or its parent can activate the organization knowledge base.');
    const org = await prisma.orgNode.findFirst({ where: { id, status: 'active' }, include: { admins: { select: { userId: true } } } });
    if (!org) throw new NotFoundException('Organization not found.');
    const name = String(body?.name || `${org.name}知识库`).trim();
    const existing = await prisma.knowledgeBase.findFirst({ where: { type: 'org', orgNodeId: id }, include: { admins: true, _count: { select: { documents: true } } } });
    const adminIds = [...new Set([userId, ...org.admins.map((item) => item.userId), ...(existing?.admins || []).map((item) => item.userId)])];
    const kb = existing
      ? await prisma.knowledgeBase.update({ where: { id: existing.id }, data: { status: 'active', name, description: body?.description !== undefined ? String(body.description) : existing.description } })
      : await prisma.knowledgeBase.create({ data: { type: 'org', orgNodeId: id, name, description: String(body?.description || `${org.name}组织成员共享的知识库`), gitRepoUrl: `db://org/${id}` } });
    await prisma.kbAdmin.createMany({ data: adminIds.map((adminId) => ({ kbId: kb.id, userId: adminId })), skipDuplicates: true });
    return { knowledgeBase: { ...kb, status: 'active' } };
  }

  @Post('orgs/:id/knowledge-base/deactivate')
  async deactivateOrganizationKnowledgeBase(@Req() req: any, @Param('id') id: string) {
    const userId = await this.authService.userIdFromRequest(req);
    if (!(await this.canManageOrganization(userId, id))) throw new BadRequestException('Only a system administrator or an administrator of this organization or its parent can deactivate the organization knowledge base.');
    const kb = await prisma.knowledgeBase.findFirst({ where: { type: 'org', orgNodeId: id, status: 'active' } });
    if (!kb) throw new NotFoundException('Organization knowledge base is not active.');
    return { knowledgeBase: await prisma.knowledgeBase.update({ where: { id: kb.id }, data: { status: 'archived' } }) };
  }

  @Post('users')
  async createUser(@Req() req: any, @Body() body: any) {
    const operatorId = await this.authService.userIdFromRequest(req);
    const username = String(body?.username || '').trim();
    const displayName = String(body?.displayName || '').trim();
    const email = String(body?.email || `${username}@local.invalid`).trim();
    if (!username || !displayName) throw new BadRequestException('Username and display name are required.');
    const orgIds: string[] = Array.isArray(body?.orgIds) ? Array.from(new Set<string>(body.orgIds.map((id: string) => String(id)))) : [];
    if (!orgIds.length) throw new BadRequestException('At least one organization is required.');
    const orgs = await prisma.orgNode.findMany({ where: { id: { in: orgIds }, status: 'active' }, select: { id: true } });
    if (orgs.length !== orgIds.length) throw new BadRequestException('One or more organizations are invalid.');
    if (!(await this.permissionService.isSystemAdmin(operatorId))) {
      const managedOrgIds = await this.permissionService.getManagedOrgIds(operatorId);
      if (orgIds.some((orgId) => !managedOrgIds.has(orgId))) throw new ForbiddenException('You can only assign users to your organization or its descendants.');
    }
    const roleIds: string[] = Array.isArray(body?.roleIds) ? Array.from(new Set<string>(body.roleIds.map((id: string) => String(id)))) : [];
    await this.validateAssignableRoles(operatorId, roleIds);
    const basicRole = await prisma.role.findUnique({ where: { name: '普通用户' }, select: { id: true } });
    const finalRoleIds = roleIds.length ? roleIds : (basicRole ? [basicRole.id] : []);
    const password = String(body?.password || 'LLMwiki@2026');
    const user = await prisma.user.create({ data: {
      username, displayName, email, passwordHash: this.authService.hashPassword(password), status: body?.status === 'disabled' ? 'disabled' : 'active',
      orgs: { create: orgIds.map((orgNodeId: string) => ({ orgNodeId })) },
      roles: { create: finalRoleIds.map((roleId: string) => ({ roleId })) },
    }, include: { roles: { include: { role: true } }, orgs: { include: { orgNode: true } } } });
    await this.brainCompilerService.ensureUserBrainRepo(user.id);
    return { user };
  }

  @Patch('users/:id')
  async updateUser(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const operatorId = await this.authService.userIdFromRequest(req);
    const exists = await prisma.user.findUnique({ where: { id }, include: { orgs: true } });
    if (!exists) throw new NotFoundException('User not found.');
    if (!(await this.permissionService.canManageUser(operatorId, id))) throw new ForbiddenException('You can only manage users in your organization or its descendants.');
    const data: any = {};
    if (body?.username !== undefined) data.username = String(body.username).trim();
    if (body?.displayName !== undefined) data.displayName = String(body.displayName).trim();
    if (body?.email !== undefined) data.email = String(body.email).trim();
    if (body?.status !== undefined) data.status = body.status === 'disabled' ? 'disabled' : 'active';
    if (body?.password) data.passwordHash = this.authService.hashPassword(String(body.password));
    const isSystemAdmin = await this.permissionService.isSystemAdmin(operatorId);
    const roleIds: string[] | null = Array.isArray(body?.roleIds) ? Array.from(new Set<string>(body.roleIds.map((roleId: string) => String(roleId)))) : null;
    if (roleIds) await this.validateAssignableRoles(operatorId, roleIds);
    const orgIds: string[] | null = Array.isArray(body?.orgIds) ? Array.from(new Set<string>(body.orgIds.map((orgNodeId: string) => String(orgNodeId)))) : null;
    if (orgIds) {
      if (!orgIds.length) throw new BadRequestException('At least one organization is required.');
      const validOrgs = await prisma.orgNode.findMany({ where: { id: { in: orgIds }, status: 'active' }, select: { id: true } });
      if (validOrgs.length !== orgIds.length) throw new BadRequestException('One or more organizations are invalid.');
      if (!isSystemAdmin) {
        const managedOrgIds = await this.permissionService.getManagedOrgIds(operatorId);
        if (orgIds.some((orgId) => !managedOrgIds.has(orgId))) throw new ForbiddenException('You can only assign users to your organization or its descendants.');
      }
    }
    const user = await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data });
      if (orgIds) {
        await tx.userOrg.deleteMany({ where: { userId: id } });
        await tx.userOrg.createMany({ data: orgIds.map((orgNodeId: string) => ({ userId: id, orgNodeId })) });
      }
      if (roleIds) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        if (roleIds.length) await tx.userRole.createMany({ data: roleIds.map((roleId: string) => ({ userId: id, roleId })) });
      }
      return tx.user.findUnique({ where: { id }, include: { roles: { include: { role: true } }, orgs: { include: { orgNode: true } } } });
    });
    return { user };
  }

  @Delete('users/:id')
  async disableUser(@Req() req: any, @Param('id') id: string) {
    const operatorId = await this.authService.userIdFromRequest(req);
    if (!(await this.permissionService.canManageUser(operatorId, id))) throw new ForbiddenException('You can only manage users in your organization or its descendants.');
    return { user: await prisma.user.update({ where: { id }, data: { status: 'disabled' } }) };
  }

  private async validateAssignableRoles(operatorId: string, roleIds: string[]) {
    if (await this.permissionService.isSystemAdmin(operatorId)) return;
    const roles = await prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, builtin: true, permissions: true } });
    if (roles.length !== roleIds.length || roles.some((role) => role.builtin || (Array.isArray(role.permissions) && role.permissions.some((permission) => permission !== 'chat.use' && permission !== 'kb.read')))) {
      throw new ForbiddenException('Organization administrators cannot assign privileged roles.');
    }
  }

  @Post('roles')
  async createRole(@Req() req: any, @Body() body: any) {
    await this.authService.adminUserIdFromRequest(req);
    const name = String(body?.name || '').trim();
    if (!name) throw new BadRequestException('Role name is required.');
    return { role: await prisma.role.create({ data: { name, description: String(body?.description || ''), builtin: false, permissions: Array.isArray(body?.permissions) ? body.permissions : [] } }) };
  }

  @Patch('roles/:id')
  async updateRole(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    await this.authService.adminUserIdFromRequest(req);
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Role not found.');
    return { role: await prisma.role.update({ where: { id }, data: { name: role.builtin ? role.name : String(body?.name ?? role.name), description: String(body?.description ?? (role.description || '')), permissions: Array.isArray(body?.permissions) ? body.permissions : role.permissions } }) };
  }

  @Delete('roles/:id')
  async deleteRole(@Req() req: any, @Param('id') id: string) {
    await this.authService.adminUserIdFromRequest(req);
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Role not found.');
    if (role.builtin) throw new BadRequestException('Built-in roles cannot be deleted.');
    await prisma.role.delete({ where: { id } });
    return { ok: true };
  }

  @Post('kbs')
  async createKnowledgeBase(@Req() req: any, @Body() body: any) {
    const adminId = await this.authService.userIdFromRequest(req);
    const name = String(body?.name || '').trim();
    const type = ['industry', 'org', 'personal'].includes(body?.type) ? body.type : 'industry';
    if (!name) throw new BadRequestException('Knowledge base name is required.');
    const isSystemAdmin = await this.permissionService.isSystemAdmin(adminId);
    if (type === 'personal') {
      if (body?.ownerUserId && body.ownerUserId !== adminId && !isSystemAdmin) throw new ForbiddenException('A personal knowledge base can only belong to its owner.');
    } else if (type === 'industry') {
      if (!isSystemAdmin && !(await this.permissionService.hasPermission(adminId, 'kb.industry.create'))) throw new ForbiddenException('Industry knowledge base creation permission required.');
    } else {
      if (!body?.orgNodeId || !(await this.permissionService.canManageOrganization(adminId, String(body.orgNodeId)))) throw new ForbiddenException('You can only create organization knowledge bases within your managed scope.');
    }
    const kb = await prisma.knowledgeBase.create({ data: { name, type, description: String(body?.description || ''), gitRepoUrl: String(body?.gitRepoUrl || `db://${name}`), orgNodeId: type === 'org' ? String(body.orgNodeId) : undefined, ownerUserId: type === 'personal' || type === 'industry' ? adminId : undefined, admins: type === 'personal' ? undefined : { create: [{ userId: adminId }] } }, include: { admins: { include: { user: true } }, _count: { select: { documents: true } } } });
    return { knowledgeBase: { ...kb, documentCount: kb._count.documents } };
  }

  @Delete('kbs/:id')
  async archiveKnowledgeBase(@Req() req: any, @Param('id') id: string) {
    const userId = await this.authService.userIdFromRequest(req);
    const kb = await prisma.knowledgeBase.findUnique({ where: { id }, select: { id: true, type: true, ownerUserId: true } });
    if (!kb) throw new NotFoundException('Knowledge base not found.');
    const allowed = kb.type === 'personal' || kb.type === 'industry' ? kb.ownerUserId === userId : false;
    if (!(await this.permissionService.isSystemAdmin(userId)) && !allowed) throw new ForbiddenException('Knowledge base management permission required.');
    return { knowledgeBase: await prisma.knowledgeBase.update({ where: { id }, data: { status: 'archived' } }) };
  }

  @Post('kbs/:id/admins')
  async updateKbAdmins(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const userId = await this.authService.userIdFromRequest(req);
    const kb = await prisma.knowledgeBase.findUnique({ where: { id }, select: { id: true, type: true, ownerUserId: true, status: true } });
    if (!kb) throw new NotFoundException('Knowledge base not found.');
    if (kb.type === 'personal') throw new ForbiddenException('Personal knowledge bases cannot be shared or assigned administrators.');
    if (!(await this.permissionService.canManageIndustryKb(userId, id)) && !(await this.permissionService.isSystemAdmin(userId))) throw new ForbiddenException('Knowledge base administrator permission required.');
    const userIds = Array.isArray(body?.userIds) ? body.userIds : [];
    if (!userIds.length) throw new BadRequestException('At least one administrator is required.');
    const activeUsers = await prisma.user.findMany({ where: { id: { in: userIds }, status: 'active' }, select: { id: true } });
    if (activeUsers.length !== new Set(userIds).size) throw new BadRequestException('Knowledge base administrators must be active users.');
    await prisma.$transaction(async (tx) => {
      await tx.kbAdmin.deleteMany({ where: { kbId: id } });
      await tx.kbAdmin.createMany({ data: userIds.map((userId: string) => ({ kbId: id, userId })) });
    });
    return { ok: true };
  }

  @Post('grants')
  async createGrant(@Req() req: any, @Body() body: any) {
    const grantedById = await this.authService.userIdFromRequest(req);
    const subjectType = String(body?.subjectType || 'user');
    const subjectId = String(body?.subjectId || '');
    const kbId = String(body?.kbId || '');
    if (!['user', 'role', 'org'].includes(subjectType) || !subjectId || !kbId) throw new BadRequestException('Invalid grant.');
    const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId }, select: { id: true, type: true, status: true } });
    if (!kb || kb.type !== 'industry' || kb.status !== 'active') throw new NotFoundException('Industry knowledge base not found.');
    if (!(await this.permissionService.canGrantIndustryKb(grantedById, kbId))) throw new ForbiddenException('Industry knowledge base authorization permission required.');
    if (subjectType === 'user' && !(await prisma.user.findFirst({ where: { id: subjectId, status: 'active' }, select: { id: true } }))) throw new BadRequestException('Authorized user is invalid.');
    if (subjectType === 'role' && !(await prisma.role.findUnique({ where: { id: subjectId }, select: { id: true } }))) throw new BadRequestException('Authorized role is invalid.');
    if (subjectType === 'org' && !(await prisma.orgNode.findFirst({ where: { id: subjectId, status: 'active' }, select: { id: true } }))) throw new BadRequestException('Authorized organization is invalid.');
    const duplicate = await prisma.industryGrant.findFirst({ where: { kbId, subjectType, subjectId } });
    if (duplicate) throw new BadRequestException('This authorization already exists.');
    return { grant: await prisma.industryGrant.create({ data: { kbId, subjectType, subjectId, grantedById, expiresAt: body?.expiresAt ? new Date(body.expiresAt) : null } }) };
  }

  @Delete('grants/:id')
  async deleteGrant(@Req() req: any, @Param('id') id: string) {
    const userId = await this.authService.userIdFromRequest(req);
    const grant = await prisma.industryGrant.findUnique({ where: { id }, select: { id: true, kbId: true } });
    if (!grant) throw new NotFoundException('Authorization not found.');
    if (!(await this.permissionService.canGrantIndustryKb(userId, grant.kbId))) throw new ForbiddenException('Industry knowledge base authorization permission required.');
    await prisma.industryGrant.delete({ where: { id } });
    return { ok: true };
  }

  @Post('providers')
  async createProvider(@Req() req: any, @Body() body: any) {
    await this.authService.adminUserIdFromRequest(req);
    const name = String(body?.name || '').trim();
    const baseUrl = String(body?.baseUrl || '').trim();
    if (!name || !baseUrl) throw new BadRequestException('Provider name and base URL are required.');
    const provider = await prisma.modelProvider.create({ data: { name, kind: String(body?.kind || 'external'), baseUrl, apiKeyEncrypted: body?.apiKey ? Buffer.from(String(body.apiKey)) : undefined, defaultParams: body?.defaultParams || undefined } });
    await this.modelConfigService.applyRuntimeConfig();
    return { provider };
  }

  @Delete('providers/:id')
  async deleteProvider(@Req() req: any, @Param('id') id: string) {
    await this.authService.adminUserIdFromRequest(req);
    await prisma.modelProvider.delete({ where: { id } });
    return { ok: true };
  }

  @Patch('providers/:id')
  async updateProvider(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    await this.authService.adminUserIdFromRequest(req);
    const provider = await prisma.modelProvider.findUnique({ where: { id } });
    if (!provider) throw new NotFoundException('Provider not found.');
    const updated = await prisma.modelProvider.update({ where: { id }, data: {
      name: body?.name !== undefined ? String(body.name).trim() : provider.name,
      kind: body?.kind !== undefined ? String(body.kind) : provider.kind,
      baseUrl: body?.baseUrl !== undefined ? String(body.baseUrl).trim() : provider.baseUrl,
      apiKeyEncrypted: body?.apiKey ? Buffer.from(String(body.apiKey)) : undefined,
      defaultParams: body?.defaultParams !== undefined ? body.defaultParams : provider.defaultParams,
    } });
    await this.modelConfigService.applyRuntimeConfig();
    return { provider: updated };
  }

  @Post('models')
  async createModel(@Req() req: any, @Body() body: any) {
    await this.authService.adminUserIdFromRequest(req);
    const providerId = String(body?.providerId || '');
    const modelName = String(body?.modelName || '').trim();
    if (!providerId || !modelName) throw new BadRequestException('Provider and model name are required.');
    const provider = await prisma.modelProvider.findUnique({ where: { id: providerId } });
    if (!provider) throw new NotFoundException('Provider not found.');
    const kind = ['llm', 'embedding', 'rerank'].includes(body?.kind) ? body.kind : 'llm';
    if (body?.isDefault) await prisma.modelConfig.updateMany({ where: { kind }, data: { isDefault: false } });
    const model = await prisma.modelConfig.create({ data: { providerId, kind, modelName, contextLen: Number(body?.contextLen || 8192), dimensions: body?.dimensions ? Number(body.dimensions) : undefined, isDefault: Boolean(body?.isDefault) } });
    await this.modelConfigService.applyRuntimeConfig();
    return { model };
  }

  @Patch('models/:id')
  async updateModel(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    await this.authService.adminUserIdFromRequest(req);
    const existing = await prisma.modelConfig.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Model not found.');
    const kind = body?.kind !== undefined ? String(body.kind) : existing.kind;
    if (!['llm', 'embedding', 'rerank'].includes(kind)) throw new BadRequestException('Invalid model kind.');
    if (body?.isDefault) await prisma.modelConfig.updateMany({ where: { kind }, data: { isDefault: false } });
    const model = await prisma.modelConfig.update({ where: { id }, data: {
      providerId: body?.providerId ? String(body.providerId) : existing.providerId,
      kind,
      modelName: body?.modelName !== undefined ? String(body.modelName).trim() : existing.modelName,
      contextLen: body?.contextLen !== undefined ? Number(body.contextLen) : existing.contextLen,
      dimensions: body?.dimensions !== undefined && body.dimensions !== '' ? Number(body.dimensions) : existing.dimensions,
      isDefault: body?.isDefault !== undefined ? Boolean(body.isDefault) : existing.isDefault,
    } });
    await this.modelConfigService.applyRuntimeConfig();
    return { model };
  }

  @Delete('models/:id')
  async deleteModel(@Req() req: any, @Param('id') id: string) {
    await this.authService.adminUserIdFromRequest(req);
    await prisma.modelConfig.delete({ where: { id } });
    await this.modelConfigService.applyRuntimeConfig();
    return { ok: true };
  }

  @Post('models/:id/test')
  async testModel(@Req() req: any, @Param('id') id: string) {
    await this.authService.adminUserIdFromRequest(req);
    const config = await prisma.modelConfig.findUnique({ where: { id }, include: { provider: true } });
    if (!config) throw new NotFoundException('Model not found.');
    let status = 'failed';
    try {
      const key = config.provider.apiKeyEncrypted ? Buffer.from(config.provider.apiKeyEncrypted).toString('utf8') : '';
      const response = await fetch(`${config.provider.baseUrl.replace(/\/$/, '')}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
      status = response.ok ? 'passed' : 'failed';
    } catch { status = 'failed'; }
    const model = await prisma.modelConfig.update({ where: { id }, data: { testStatus: status } });
    return { ok: status === 'passed', status, model };
  }
}
