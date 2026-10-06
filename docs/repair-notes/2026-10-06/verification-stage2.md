# Stage 2 verification (2026-10-06)

本轮（接续）实际执行的验证与结果。所有命令在本机 `/home/scottsun/gbrainkg` 执行，未部署生产。

## 代码级验证（全部通过）

| 检查 | 命令 | 结果 |
|---|---|---|
| API 构建 | `pnpm --filter api build` | 退出码 0 |
| API 单测（默认库） | `pnpm --filter api test` | 1280 passed / 2 failed（仅 `auth/user-credential.spec.ts`，见下“环境”） |
| API 单测（凭据用例指向隔离库） | `USER_CREDENTIAL_TEST_DATABASE_URL=…/llmwiki_inst99998 pnpm --filter api test` | **146 suites passed，1 skipped；1282 passed，5 skipped，0 failed，退出码 0** |
| Web 类型检查 | `pnpm --filter web exec tsc --noEmit` | 退出码 0（Stage 1 记录的 10 个类型错误已消除） |
| Web lint | `pnpm --filter web lint` | 退出码 0，0 errors / 128 warnings |
| Web 单测 | `pnpm --filter web test` | 66 / 66 通过 |
| Parser 单测 | `pnpm test:parser` | 54 passed，4 subtests passed，0 failed（Stage 1 的 `test_execute.py:48` 失败已消除） |
| Parser Ruff | `python3 -m ruff check .`（apps/parser-worker） | All checks passed |
| Parser mypy | `python3 -m mypy --explicit-package-bases main.py quality.py extractors` | Success，5 source files |
| GBrain adapter | `pnpm test:adapter` | 构建通过，契约测试 17 / 17 |
| 门禁自测 | `pnpm benchmark:selftest` | 退出码 0（全部分项 selftest 通过） |
| 空白/尾随空格 | `git diff --check` | 无输出 |

## 数据库验证（隔离库）

隔离库：本机容器 `llmwiki-postgres` 内的 `llmwiki_inst99998`，配套 NOBYPASSRLS 运行时角色 `llmwiki_app_inst99998`。

| 检查 | 结果 |
|---|---|
| 全新库全量迁移链 | 76 个迁移全部成功应用，含本次新增 `20261006160000_security_and_authority_repairs` 与修复迁移 `20261006170000_visibility_cache_fail_closed` |
| 新安全 fixture | `packages/database/prisma/migrations/20261006160000_security_and_authority_repairs/security-test.sql` → 退出码 0 |
| 历史安全 fixture（包装） | `20260927100000_kb_write_rls_guard/security-test.sql`（角色名映射为 `llmwiki_app_inst99998`）→ 退出码 0 |
| 运行时 RLS 只读校验 | `scripts/verify-runtime-rls.sh` → `PASS: structural RLS, runtime non-bypass and scoped read checks`，退出码 0（附带空语料 NOTICE） |

## 本轮修复的失败项

失败均来自“修改后的代码 vs 未同步的测试替身”，以及一个真实迁移缺口。

| 位置 | 原因 | 处置 |
|---|---|---|
| `tests/evaluation/quality-gate-judge.selftest.ts` | fixture 未复制 `gate-thresholds.{ts,json}`；mock `python3` 同时打掉了阈值加载器 | 复制真源文件；mock 仅拦截 `ann_recall_eval.py`，其余委派真实解释器 |
| `apps/api/src/knowledge-graph-cache.spec.ts` | 缓存键新增 `userId/revision/expiresAt`，payload 需含 `nodes`，且命中路径新增 ACL 复校验 | 按新实现更新 fixture，注入 `documentAclService` 与鉴权快照 mock |
| `apps/api/src/chat/chat.service.spec.ts` | 命中主题由逐条 `findUnique` 改为一次 `findMany` | 补 `brainTopic.findMany`，懒编译断言加第三参数，mock 改用 `mockResolvedValueOnce` 避免跨用例泄漏 |
| `apps/api/src/mcp/mcp-strict-output.spec.ts` | 严格输出许可按 `params.name` 区分知识工具 | 用例补 `params:{name:'search_knowledge'}` |
| `apps/api/src/permission/permission.service.spec.ts` | 撤销授权按 `subjectType` 收窄（M-19 修复） | 期望值补 `subjectType:'user'`（代码正确） |
| `apps/api/src/ingestion/ingestion-version.spec.ts` | 新增 `document.findFirst`（H-17 修复）等委托 | 补 `findFirst` / `findMany` |
| `apps/api/src/ingestion/version-chain.service.spec.ts` | 失败清理路径对 `rm()` 结果调用 `.catch` | `rm` mock 返回 Promise |
| `apps/api/src/ingestion/knowledge-base.controller.spec.ts` | `resolveDocumentSize` 需要 `version`/`updatedAt` | fixture 补齐字段 |
| `apps/api/src/embedding/chunk-embedding.service.spec.ts` | 混合索引改为游标分页循环（H-27 修复） | fixture 第二页返回空，终止循环 |
| `apps/api/src/chat/chat.controller.spec.ts` | runId 路径仍会写 `done` 事件，响应替身缺 `write` | 补 `write` mock，避免 finalize 抛错级联 |
| `apps/api/src/auth/user-credential.spec.ts` | 真实库集成用例，默认库未应用新迁移 | 支持 `USER_CREDENTIAL_TEST_DATABASE_URL` 重定向并自种子用户 |

## 本轮发现并修复的真实缺陷

两项均由本次新增的验证资产暴露，已通过新增修复迁移 `20261006170000_visibility_cache_fail_closed` 处理（不修改任何已应用迁移）：

1. `public.app_document_readable()` 在可见库缓存无法确认属于当前用户时 fail-open。`app_visible_kb_ids()` 对未激活用户提前返回且不写缓存，同一事务内切换用户时上一次的缓存值仍被用于本次判定；对无 `DocumentAcl` 行的文档即报可读。规范路径（每事务单用户）不可达，但边界必须 fail-closed，现已改为无法确认即拒绝。
2. `GraphCommunity` 含 `kbId` 租户数据且有 6 条策略，但 RLS 只 ENABLE 未 FORCE，表属主仍绕过策略。现已 `FORCE ROW LEVEL SECURITY`。

修复后 `security-test.sql` 与 `verify-runtime-rls.sh` 双双通过。

## 未执行

- 未执行付费在线质量评测与真实检索概率校准（用户决定）。
- 未部署任何环境；生产库、生产服务、生产域名均未改动。
- 未在本地开发库 `llmwiki` 执行迁移（见下）。
