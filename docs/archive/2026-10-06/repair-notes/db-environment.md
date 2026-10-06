# 数据库环境差异与隔离验证（2026-10-06）

本轮数据库验证期间发现的两处环境问题。二者都不是本次代码改动引入的，但都会影响“在隔离库验证”的可执行性，需要单独处理。

## 1. 迁移按库名映射运行时角色，计划中的隔离库名无法跑迁移

`packages/database/prisma/migrations/20260927100000_kb_write_rls_guard/migration.sql` 末尾的授权块按 `current_database()` 推导运行时角色：

- `llmwiki` → `['llmwiki_app', 'llmwiki_app_inst1']`
- `^llmwiki_inst[0-9]+$` → `llmwiki_app_inst<N>`
- 其它库名 → `RAISE EXCEPTION 'Unknown runtime role mapping for database %'`
- 角色不存在时 → `RAISE EXCEPTION 'Expected runtime role is missing for database %'`

因此 FIX-TODO 中登记的隔离库名 `gbrain_core_opt_test_repair_20261006` **无法应用迁移链**：该库名前缀不匹配任何分支，迁移在 `20260927100000` 处整体失败（旧库中确实留下了这一条 `finished_at IS NULL` 的失败记录）。同样地，`gbrain_core_opt_test_migrations` 也停在同一处。

处置：不再修改已应用迁移（AGENTS.md 与既往复核结论均要求保留已部署历史）。改用符合约定的隔离库命名进行验证。

## 2. 本地开发库 `llmwiki` 不是本仓库迁移链建出来的

`prisma migrate status` 显示本地开发库已应用、但仓库中不存在的 4 条迁移：

| 开发库中已应用 | 仓库同时间戳下的名字 |
|---|---|
| `20260926170000_reassert_content_only_rls` | （仓库中无该时间戳） |
| `20260930100000_authorized_evidence` | `20260930100000_core_auth_contract` |
| `20260930110000_knowledge_governance` | `20260930110000_embedding_fingerprint` |
| `20260930120000_credential_scope` | `20260930120000_immutable_document_versions` |

进一步比对后，问题比“改名”严重得多：**该库的表结构与本仓库迁移链系统性不一致**，因此不是本仓库建出来的。

证据（`llmwiki` vs 全新按仓库链迁移的 `llmwiki_inst99998`）：

| 维度 | `llmwiki` | 仓库链产物 |
|---|---|---|
| 字符串列类型 | `character varying(N)` | `text` |
| 时间列类型 | `timestamp with time zone` | `timestamp without time zone` |
| 可空性 | 多列可空（如 `BrainDerivedPage.aclEpoch`） | NOT NULL |
| 额外表 | 有 `AuthorizationRevision` | 仓库 schema 中不存在 |
| 列数（public schema） | 1524 | 519 |

而 `git log --all -S'VarChar' -- '*.prisma'` 与 `git log --all -S'AuthorizationRevision'` 均为空——**本仓库任何分支的任何文件都从未出现过 `VarChar` 或 `AuthorizationRevision`**（该仓库只有一个 squash 提交 `9d55e23`）。仓库 schema 中 `VarChar` 出现 0 次，也没有任何迁移提到 `character varying`。

同时该库又带有大量本仓库特有的 RLS 工作（26 张表 FORCE RLS），且 8 张“近期新增”表中存在 7 张。综合判断：`llmwiki` 与 `llmwiki_inst99998` 是**同一谱系的两个分叉**，`llmwiki` 来自更早/另一份 schema 约定（varchar + timestamptz）的代码库。

后果：

- 该库**无法**用本仓库迁移链补齐：缺 `User.mfaLastCounter`、`BrainChangeEvent.claimToken/claimedAt`、`ChatRun.leaseExpiresAt`，缺 `IndustryGrant`/`DocumentAcl` 唯一索引，缺新迁移的 RLS/触发器。列类型与可空性也对不上，迁移只会产生混合结构。
- 因此 `apps/api/src/auth/user-credential.spec.ts` 在默认库上失败；且任何依赖新列/新索引的运行时行为（MFA 重放计数、Outbox 认领令牌、ChatRun 租约、去重唯一约束）在本地默认环境下都不成立。
- **且该库承载着可观的本地语料**：`User` 76、`KnowledgeBase` 227、`Document` 6597、`Chunk` 17148、`Conversation` 15766、`Message` 31832、`GraphEntity` 895，库大小 4.1 GB。它是本地/端到端语料的实际所在。

结论：**不能重建或清空该库**。本轮的处置是“保留 + 分流”：

- 保留 `llmwiki` 原样；
- 一切依赖最新 schema 的验证（迁移链、安全 fixture、RLS 校验、`user-credential` 集成用例）都在按仓库链全新构建的 `llmwiki_inst99998` 上进行，并通过 `USER_CREDENTIAL_TEST_DATABASE_URL` 分流；
- 若要让默认环境也具备最新 schema，需要“按仓库链新建库 + 重新灌入 4.1 GB 语料”的独立工程，且要先解决两套 schema 的列类型/可空性差异，不是一条迁移能覆盖的。

## 本轮建立的隔离验证环境

- 库：`llmwiki_inst99998`（`OWNER llmwiki`）
- 运行时角色：`llmwiki_app_inst99998`（`LOGIN NOSUPERUSER NOBYPASSRLS`），并按 `scripts/reconcile-runtime-db-role.sh` 的表/序列清单授予权限（该脚本用 `sudo -u postgres psql`，本机无 sudo 通道，故以容器内等价 SQL 复现）

在该库上完成：全量迁移（76 个，含两个新迁移）、新安全 fixture、历史安全 fixture、`verify-runtime-rls.sh`，全部通过。

复现命令（凭据取自 `apps/api/.env`，此处以变量代替）：

```bash
# 1. 建立库与角色
docker exec llmwiki-postgres psql -U llmwiki -d postgres -c "CREATE ROLE llmwiki_app_inst99998 LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '…';"
docker exec llmwiki-postgres psql -U llmwiki -d postgres -c "CREATE DATABASE llmwiki_inst99998 OWNER llmwiki;"

# 2. 全量迁移
cd packages/database
DATABASE_URL="postgresql://llmwiki:…@localhost:5433/llmwiki_inst99998?schema=public" ./node_modules/.bin/prisma migrate deploy

# 3. 安全 fixture
docker exec -i llmwiki-postgres psql -U llmwiki -d llmwiki_inst99998 -X \
  < packages/database/prisma/migrations/20261006160000_security_and_authority_repairs/security-test.sql

# 4. 运行时 RLS 只读校验（需 psql 可用；本机无 psql 时以容器内等价调用代替）
bash scripts/verify-runtime-rls.sh <instance-env-file>
```

## 待用户/后续决定

- 是否要把默认环境切到按仓库链构建的库：这需要“新建库 + 重新灌入 4.1 GB 语料 + 处理两套 schema 差异”，属独立工程，本轮未做，且**不会清空或改动原 `llmwiki`**。
- 若要在本地默认库上端到端跑新代码，需先解决 `llmwiki` 缺列/缺索引/类型不一致的问题——同上，不是一条迁移能覆盖。
- `20260927100000` 的库名映射是否放宽以支持任意测试库名——涉及已部署迁移，不建议在本轮改动。
