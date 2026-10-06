# C-04：全表 RLS 收口（2026-10-06）

C-04 的原始指控是「约 20 张含租户数据的表 RLS 被显式关闭，同时对 runtime 角色全量 GRANT」。本轮把它做完：`public` 下**已无任何表缺少 FORCE RLS**（`_prisma_migrations` 除外）。

## 三个迁移

| 迁移 | 内容 |
|---|---|
| `20261006160000_security_and_authority_repairs`（上一轮） | UserCredential / ModelProvider / FeedbackCase / BrainScopeMember / BrainSourceMember / BrainSourceDocument / SemanticCache / BrainDerivedPage 等 + FORCE ChatRun/AuthorizationState/ModelQuotaBucket |
| `20261006180000_identity_table_rls`（本轮） | 身份与权限：`User`、`Role`、`UserRole`、`UserOrg`、`OrgNode`、`OrgAdmin`、`KbAdmin`、`KbModelOverride`、`IndustryGrant`、`ModelConfig`、`SystemSetting`、`EmbeddingModelState`、`AuditLog` |
| `20261006190000_brain_lexical_rls`（本轮） | Brain / 词法 / 缓存：`BrainRepo`、`BrainScope`、`BrainSource`、`BrainTopic`、`CompileJob`、`BrainChangeEvent`、`BrainOperationLog`、`BrainMaintenanceRun`、`ChunkLexicalDoc`、`ChunkSparseEmbedding`、`KbLexicalStat`、`LexicalTermStat`、`ContextualPrefixCache` |

## 关键设计决定

**检索读取的表不能用 service-only。** `ChunkLexicalDoc` / `ChunkSparseEmbedding` / `KbLexicalStat` / `LexicalTermStat` 是在**用户请求上下文**里被检索路径读取的，因此按「文档/知识库可读性」收敛（`app_document_readable` / `app_visible_kb_ids` / `app_current_user_chunk_readable`），写入仍只有 service。若按 service-only 处理，检索会直接 500。

其余按归属推导：用户私有表用 `userId`；作用域表用成员关系；运维/遥测表 service 或系统管理员（管理面要读遥测）；内部缓存 service-only。

## 认证路径改造（身份表的前置条件）

身份表加 RLS 的前提是：认证前必须先能读到 `User`/`UserRole`/`Role`。新增 `runAsAuth()`（`db/tenant-context.service.ts`）——一个**认证专用**的事务上下文（`app.service=on`），包裹 9 处认证前读取：

- `auth.service`：登录按用户名/邮箱查找、`getUserStatus`
- `auth.mfa.service`：`getMfaStatus`
- `mcp.controller`：应用凭据鉴权后的用户读取
- `oidc.service`：`oidcSub`/`email`/用户名冲突查找、JIT 建号与绑定写入

`auth.controller.me` 与 `session.bootstrap` 在 `userIdFromRequest()` 之后执行（此时 `app.user_id` 已就位），由「自读」策略覆盖，无需包裹。

`runAsAuth` 刻意绕开 `forService` 的「不得把请求提升为 service」护栏：该护栏保护的是请求级业务逻辑，而这些调用点只读身份行来决定是否认证，不对结果执行调用方逻辑。**每新增一处使用都会扩大用户级隔离的缺口，必须限定在认证路径。**

## 踩到并修掉的两个陷阱

1. **策略助手只授给运行角色 → 嵌套求值失败。** 助手最初按 DB-03 的教训只 GRANT 给部署运行角色，结果安全 fixture 报 `permission denied for function app_current_user_scope_ids`：fixture 读 `BrainDerivedPage`，其策略里查 `BrainScope`，而 `BrainScope` 的新策略调用了该助手 —— **策略可被嵌套求值，任何能读到该表的角色都需要 EXECUTE**。这些助手无参、只返回调用者自己的成员关系，不构成越权探针，故按本仓库既有约定改为授给 PUBLIC（迁移内已写明原因）。
2. **`IndustryGrant.subjectId` 是 uuid**，策略里写成 `"subjectId"=app_current_user_id()::text` 会报 `operator does not exist: uuid = text`，需 `::text` 双侧转换。

## 验证

在按仓库链**从零重建**的隔离库 `llmwiki_inst99998` 上：

- 全量迁移链（78 个）全部成功应用。
- 新安全 fixture `exit=0`；历史安全 fixture `exit=0`；`scripts/verify-runtime-rls.sh` **PASS**。
- `public` 下未加 FORCE RLS 的表：**0**。
- 策略引用的函数，运行角色**全部可执行**（无 DB-03 类残留）。
- API 在 `RLS_ENFORCE=1` + NOBYPASSRLS 角色下启动正常、管理员登录 200、`admin/data` 200、`knowledge-graph` 200、**`/chat/search` 201 + `success:true`**（检索路径未被策略打断）。
- 本地回归：API 1291 passed / 0 failed，Web 66/66，Parser 54 passed，`git diff --check` 干净。

## 未做

- **未发布**：演示与生产仍是旧 release，上述代码与迁移只在本地与隔离库。
- 演示/生产的库是旧谱系，能否直接吃这三个迁移尚未验证（本地 `llmwiki` 就吃不下）——发布前必须先确认。
