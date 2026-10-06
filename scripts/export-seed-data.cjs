#!/usr/bin/env node
/**
 * 导出本机环境的「组织 / 用户 / 知识库」为可移植 SQL 初始化脚本。
 *
 * 用法（在 apps/api 工作目录下执行，保证 @prisma/client 可解析）：
 *   DATABASE_URL='postgresql://llmwiki:***@host:5433/llmwiki?schema=public' \
 *     node scripts/export-seed-data.cjs [输出路径]
 *
 * 默认输出 deploy/seed/test-env-seed.sql。生成结果幂等：全部使用
 * ON CONFLICT DO NOTHING，可安全重复导入全新或半初始化环境。
 *
 * 安全：脚本包含 User.passwordHash（scrypt 哈希）以便目标环境沿用同一批登录口令；
 * 默认重置 MFA（mfaEnabled=false / mfaSecret=NULL），如需保留 MFA 设置 EXPORT_MFA=1。
 * 该产物含凭据材料，禁止提交到公开仓库。
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
// 以当前工作目录（apps/api）为基准解析依赖，避免脚本目录找不到 @prisma/client。
const { PrismaClient } = createRequire(path.join(process.cwd(), 'package.json'))('@prisma/client');

const OUT = process.argv[2] || path.resolve(process.cwd(), 'deploy/seed/test-env-seed.sql');
const KEEP_MFA = process.env.EXPORT_MFA === '1';
// 默认只导出未停用用户，避免把历史测试账号（disabled）带进新环境；EXPORT_INCLUDE_DISABLED=1 可全量。
const INCLUDE_DISABLED = process.env.EXPORT_INCLUDE_DISABLED === '1';
// 默认只导出 active 组织节点，剔除历史 E2E 归档组织；EXPORT_INCLUDE_ARCHIVED_ORGS=1 可全量。
const INCLUDE_ARCHIVED_ORGS = process.env.EXPORT_INCLUDE_ARCHIVED_ORGS === '1';
// 默认只导出 active 知识库（剔除归档的历史测试库）；EXPORT_INCLUDE_ARCHIVED_KBS=1 可全量。
const INCLUDE_ARCHIVED_KBS = process.env.EXPORT_INCLUDE_ARCHIVED_KBS === '1';
// 可选：按名称正则剔除测试遗留实体（同时作用于组织与知识库），例如 '^E2E'。
const EXCLUDE_REGEX = process.env.EXPORT_EXCLUDE_REGEX ? new RegExp(process.env.EXPORT_EXCLUDE_REGEX) : null;
const keepName = (name) => !EXCLUDE_REGEX || !EXCLUDE_REGEX.test(String(name || ''));

const prisma = new PrismaClient();
const pad = (n, w = 2) => String(n).padStart(w, '0');

function fmtTs(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

function lit(value, type) {
  if (value === null || value === undefined) return 'NULL';
  switch (type) {
    case 'bool': return value ? 'true' : 'false';
    case 'int': return String(value);
    case 'json': return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
    case 'ts': return `'${fmtTs(value)}'::timestamp`;
    case 'uuid': return `'${String(value)}'::uuid`;
    default: return `'${String(value).replace(/'/g, "''")}'`;
  }
}

function insertBlock(table, columns, rows) {
  if (!rows.length) return `-- ${table}: 0 rows\n`;
  const colSql = columns.map((c) => `"${c.name}"`).join(', ');
  const lines = rows.map((row) => `  (${columns.map((c) => lit(row[c.name], c.type)).join(', ')})`);
  return `INSERT INTO "${table}" (${colSql}) VALUES\n${lines.join(',\n')}\nON CONFLICT DO NOTHING;\n`;
}

async function main() {
  const [roles, orgsAll, allUsers, allUserOrgs, allUserRoles, allOrgAdmins, allKbs, allKbAdmins, allGrants] = await Promise.all([
    prisma.role.findMany({ orderBy: { name: 'asc' } }),
    prisma.orgNode.findMany({}),
    prisma.user.findMany({}),
    prisma.userOrg.findMany({}),
    prisma.userRole.findMany({}),
    prisma.orgAdmin.findMany({}),
    prisma.knowledgeBase.findMany({}),
    prisma.kbAdmin.findMany({}),
    prisma.industryGrant.findMany({}),
  ]);

  // 只导出未停用用户 / active 组织（默认）及其关联；关联表按保留集合过滤，避免外键悬空。
  const users = INCLUDE_DISABLED ? allUsers : allUsers.filter((u) => u.status === 'active');
  const userIds = new Set(users.map((u) => u.id));
  const orgs = (INCLUDE_ARCHIVED_ORGS ? orgsAll : orgsAll.filter((o) => o.status === 'active'))
    .filter((o) => keepName(o.name));
  const orgIds = new Set(orgs.map((o) => o.id));
  const userOrgs = allUserOrgs.filter((row) => userIds.has(row.userId) && orgIds.has(row.orgNodeId));
  const userRoles = allUserRoles.filter((row) => userIds.has(row.userId));
  const orgAdmins = allOrgAdmins.filter((row) => userIds.has(row.userId) && orgIds.has(row.orgNodeId));
  const kbs = allKbs.filter((kb) =>
    (INCLUDE_ARCHIVED_KBS || kb.status === 'active')
    && keepName(kb.name)
    && (!kb.ownerUserId || userIds.has(kb.ownerUserId))
    && (!kb.orgNodeId || orgIds.has(kb.orgNodeId)));
  const kbIds = new Set(kbs.map((kb) => kb.id));
  const kbAdmins = allKbAdmins.filter((row) => kbIds.has(row.kbId) && userIds.has(row.userId));
  const grants = allGrants.filter((row) => kbIds.has(row.kbId));

  // 组织：父节点先于子节点写入，满足自引用外键。
  const orgOrdered = [...orgs].sort((a, b) => (a.path.split('/').length - b.path.split('/').length) || a.path.localeCompare(b.path));

  const userRows = users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    passwordHash: u.passwordHash,
    mustChangePassword: u.mustChangePassword,
    status: u.status,
    source: u.source,
    mfaSecret: KEEP_MFA ? u.mfaSecret : null,
    mfaEnabled: KEEP_MFA ? u.mfaEnabled : false,
    mfaLastCounter: KEEP_MFA ? u.mfaLastCounter : null,
    mfaEnabledAt: KEEP_MFA ? u.mfaEnabledAt : null,
    oidcSub: u.oidcSub,
    createdAt: u.createdAt,
  }));

  const generatedAt = `${fmtTs(new Date())}Z`;
  const header = [
    '-- ============================================================================',
    '-- 测试环境初始化种子数据（组织 / 用户 / 知识库）',
    `-- 由 scripts/export-seed-data.cjs 自动生成于 ${generatedAt}`,
    '-- 来源：本机测试环境数据库',
    '--',
    '-- 覆盖对象：',
    '--   Role(角色) / OrgNode(组织) / User(用户) / UserOrg(用户-组织)',
    '--   UserRole(用户-角色) / OrgAdmin(组织管理员)',
    '--   KnowledgeBase(知识库) / KbAdmin(库管理员) / IndustryGrant(行业库授权)',
    '--',
    '-- 使用前提：',
    '--   1) 目标环境已执行 prisma migrate deploy（表结构就绪）；',
    '--   2) 建议以具备 BYPASSRLS 的迁移角色导入（llmwiki），而非运行时角色；',
    '--   3) 默认角色由应用启动时 ensureDefaultRoles 播种；本脚本以显式 id 写入角色，',
    '--      全新库可直接导入；若目标库已存在同名但 id 不同的角色，请改为按 name 映射。',
    '--',
    '-- 幂等：全部 ON CONFLICT DO NOTHING，可重复执行。',
    `-- 范围：${INCLUDE_DISABLED ? '用户全量（含停用）' : '仅未停用用户'}；${INCLUDE_ARCHIVED_ORGS ? '组织全量' : '仅 active 组织'}；${INCLUDE_ARCHIVED_KBS ? '知识库全量' : '仅 active 知识库'}；关联表按保留集合过滤。`,
    `-- 可选剔除：EXPORT_EXCLUDE_REGEX（按名称正则，同时作用于组织与知识库）${EXCLUDE_REGEX ? `当前=${EXCLUDE_REGEX}` : '（未启用）'}。`,
    `-- 安全：包含 User.passwordHash（scrypt 哈希，可沿用同一口令）。${KEEP_MFA ? '已保留 MFA 配置。' : '已重置 MFA（mfaEnabled=false / mfaSecret=NULL）。'}`,
    '--       禁止提交到公开仓库。',
    '-- ============================================================================',
    '',
    'BEGIN;',
    '',
    '-- 角色（含内置）；UserRole 以显式 roleId 关联。',
    insertBlock('Role', [
      { name: 'id', type: 'uuid' },
      { name: 'code', type: 'text' },
      { name: 'name', type: 'text' },
      { name: 'description', type: 'text' },
      { name: 'builtin', type: 'bool' },
      { name: 'permissions', type: 'json' },
    ], roles),
    '-- 组织（父节点在前）',
    insertBlock('OrgNode', [
      { name: 'id', type: 'uuid' },
      { name: 'parentId', type: 'uuid' },
      { name: 'name', type: 'text' },
      { name: 'path', type: 'text' },
      { name: 'sort', type: 'int' },
      { name: 'status', type: 'text' },
    ], orgOrdered),
    '-- 用户',
    insertBlock('User', [
      { name: 'id', type: 'uuid' },
      { name: 'username', type: 'text' },
      { name: 'displayName', type: 'text' },
      { name: 'email', type: 'text' },
      { name: 'passwordHash', type: 'text' },
      { name: 'mustChangePassword', type: 'bool' },
      { name: 'status', type: 'text' },
      { name: 'source', type: 'text' },
      { name: 'mfaSecret', type: 'text' },
      { name: 'mfaEnabled', type: 'bool' },
      { name: 'mfaLastCounter', type: 'int' },
      { name: 'mfaEnabledAt', type: 'ts' },
      { name: 'oidcSub', type: 'text' },
      { name: 'createdAt', type: 'ts' },
    ], userRows),
    '-- 用户-组织',
    insertBlock('UserOrg', [
      { name: 'userId', type: 'uuid' },
      { name: 'orgNodeId', type: 'uuid' },
    ], userOrgs),
    '-- 用户-角色',
    insertBlock('UserRole', [
      { name: 'userId', type: 'uuid' },
      { name: 'roleId', type: 'uuid' },
    ], userRoles),
    '-- 组织管理员',
    insertBlock('OrgAdmin', [
      { name: 'orgNodeId', type: 'uuid' },
      { name: 'userId', type: 'uuid' },
    ], orgAdmins),
    '-- 知识库',
    insertBlock('KnowledgeBase', [
      { name: 'id', type: 'uuid' },
      { name: 'type', type: 'text' },
      { name: 'name', type: 'text' },
      { name: 'description', type: 'text' },
      { name: 'ownerUserId', type: 'uuid' },
      { name: 'orgNodeId', type: 'uuid' },
      { name: 'gitRepoUrl', type: 'text' },
      { name: 'embeddingModelId', type: 'uuid' },
      { name: 'status', type: 'text' },
      { name: 'domainTerms', type: 'json' },
      { name: 'createdAt', type: 'ts' },
      { name: 'updatedAt', type: 'ts' },
    ], kbs),
    '-- 库管理员',
    insertBlock('KbAdmin', [
      { name: 'kbId', type: 'uuid' },
      { name: 'userId', type: 'uuid' },
    ], kbAdmins),
    '-- 行业库授权（subjectType=role 的 subjectId 仍为角色 id）',
    insertBlock('IndustryGrant', [
      { name: 'id', type: 'uuid' },
      { name: 'kbId', type: 'uuid' },
      { name: 'subjectType', type: 'text' },
      { name: 'subjectId', type: 'uuid' },
      { name: 'grantedById', type: 'uuid' },
      { name: 'expiresAt', type: 'ts' },
      { name: 'createdAt', type: 'ts' },
    ], grants),
    'COMMIT;',
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, header, 'utf8');
  const counts = { roles: roles.length, orgs: orgs.length, users: users.length, userOrgs: userOrgs.length, userRoles: userRoles.length, orgAdmins: orgAdmins.length, kbs: kbs.length, kbAdmins: kbAdmins.length, grants: grants.length };
  console.log(JSON.stringify({ ok: true, out: OUT, counts }, null, 2));
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
