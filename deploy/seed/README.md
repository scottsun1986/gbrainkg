# 环境初始化种子数据（组织 / 用户 / 知识库）

`test-env-seed.sql` 由 `scripts/export-seed-data.cjs` 从**本机测试环境**数据库导出，
用于在其它环境快速初始化组织架构、用户与知识库。

> ⚠️ 该 SQL 含 `User.passwordHash`（scrypt 哈希，可沿用同一批登录口令），
> 属于**凭据材料**，已通过 `.gitignore`（`deploy/seed/*.sql`）阻止提交，请勿公开。

## 重新生成

```bash
cd apps/api
DATABASE_URL='postgresql://llmwiki:<pass>@<host>:5433/llmwiki?schema=public' \
  node ../../scripts/export-seed-data.cjs ../../deploy/seed/test-env-seed.sql
```

可选开关：

- `EXPORT_INCLUDE_DISABLED=1`：导出全部用户（默认仅未停用用户）。
- `EXPORT_INCLUDE_ARCHIVED_ORGS=1`：导出全部组织（默认仅 active 组织）。
- `EXPORT_INCLUDE_ARCHIVED_KBS=1`：导出全部知识库（默认仅 active）。
- `EXPORT_EXCLUDE_REGEX='^E2E'`：按名称正则剔除测试遗留实体（同时作用于组织与知识库）。
- `EXPORT_MFA=1`：保留 MFA 配置（默认重置：`mfaEnabled=false`、`mfaSecret=NULL`）。

> 本仓库当前交付的 `test-env-seed.sql` 使用 `EXPORT_EXCLUDE_REGEX='^E2E'` 生成，
> 仅保留 `演示公司` 组织树、7 个未停用用户与 6 个 active 知识库。

## 导入到目标环境

```bash
# 1) 目标库先完成表结构迁移
pnpm --filter database exec prisma migrate deploy

# 2) 以迁移角色（具 BYPASSRLS，如 llmwiki）导入
#    无 psql 客户端时可用任意 PG 客户端执行该文件
psql "$DATABASE_URL" -f deploy/seed/test-env-seed.sql
```

## 说明

- **幂等**：所有写入均为 `ON CONFLICT DO NOTHING`，可重复导入。
- **覆盖对象**：`Role` / `OrgNode` / `User` / `UserOrg` / `UserRole` / `OrgAdmin` /
  `KnowledgeBase` / `KbAdmin` / `IndustryGrant`。
- **不含文档内容与向量**：仅元数据；文档需另行重传或从源环境迁移。
- **角色 id 一致**：脚本以显式 id 写入角色；目标库为全新库时可直接导入。
  若目标库已存在同名但 id 不同的角色，请改为按 `name` 映射 `UserRole`。
