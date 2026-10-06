# GBrainKG 全量代码走查报告（待修复清单）

- **走查日期**：2026-10-06
- **代码基线**：`27cd327 feat(retrieval): 优化候选饱和下的低分排除机制与重排上下文增强`
- **走查范围**：`apps/api`（NestJS，337 TS 文件）、`apps/web`（Next.js 16，~13.6k 行）、`apps/parser-worker`（Python，~2.8k 行）、`packages/database`（76 个 SQL 迁移）、`packages/gbrain-adapter`、`packages/shared-types`、`scripts/`、`tests/`、`.github/workflows/`
- **走查方法**：按子系统分片并行静态走查 + 逐条人工复核（CRITICAL/HIGH 级结论均已用 `sed`/`grep` 定位到实际代码并二次确认）
- **缺陷统计**：**133 项**（CRITICAL 5 / HIGH 27 / MEDIUM 84 / LOW 17）

> 说明：本报告只收录**已定位到具体行并确认成立**的缺陷，不含风格、重构建议、测试覆盖率意见。所有 `file:line` 均基于上述 commit。

---

## 目录

- [P0 CRITICAL（5 项）](#p0-critical5-项)
- [P1 HIGH（27 项）](#p1-high27-项)
- [P2 MEDIUM（84 项）](#p2-medium84-项)
- [P3 LOW（17 项）](#p3-low17-项)
- [缺陷分布统计](#缺陷分布统计)
- [修复优先级建议](#修复优先级建议)

---

## P0 CRITICAL（5 项）

### C-01 普通用户可越权触发全租户重建任务（鉴权绕过）

**位置**：`apps/api/src/auth/auth.guard.ts:52-57`（触发点）→ `apps/api/src/admin.controller.ts:369-370, 401-404`（受害处理器）

```ts
      const isPersonalKbCreation =
        request.method === 'POST' &&
        (request.path === '/api/v1/admin/kbs' || request.url?.includes('/admin/kbs')) &&
        request.body?.type === 'personal';
```

`request.path` 只有 pathname，而 `request.url` 是**完整的 path + query string**。因此只要在 query 里塞 `/admin/kbs`，任意 `POST /api/v1/admin/*` 路由都会让 `isPersonalKbCreation === true`，直接跳过 `capabilities` 校验。已确认无 `setGlobalPrefix`、无 URL 重写中间件，`req.url` 就是客户端发的原文。

`AdminController` 是类级 `@UseGuards(AdminGuard)`，其中这两个 POST 处理器**没有任何内部鉴权**（无 `@Req`、无 capability 判断）：

```ts
  @Post("enrichment/backfill")
  async backfillEnrichment(@Body("limit") limit?: number) {
    ...
    const docs = await this.prisma.document.findMany({
      where: { status: "published", indexReadiness: { not: "ready" } },   // 无租户过滤
```

**复现**（仅持有 `BASE_USER_PERMISSIONS` 的普通用户）：
```
POST /api/v1/admin/enrichment/backfill?x=/admin/kbs
{"type":"personal","limit":500}
```
→ 最多 500 篇跨租户文档被置为 `indexReadiness='pending'` 并入队 enrichment（触发 LLM 费用）。返回值 `{enqueued, remaining}` 同时**泄露全系统未完成索引的文档总数**。`embeddings/backfill` 同理，`limit` 上限 5000。

**修复**：删除 `request.url?.includes(...)` 分支（改用精确 `request.path` 匹配）；同时在这两个处理器内部补 `system.settings.manage` capability 校验，不依赖类守卫。

---

### C-02 `/parse-execute` 位置参数错位一个，OCR 全链路失效 + 跨租户缓存串号

**位置**：`apps/parser-worker/src/main.py:1903-1912`（签名）vs `main.py:1996-2000`（调用）

```python
async def parse_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    parser_type: str = "docling",
    instance_id: str | None = Form(None),      # ← 第 4 个位置参数
    ocr_provider: str | None = Form(None),
    ...
```
```python
    accepted = await parse_document(
        background, file, parser_type, ocr_provider, ocr_endpoint,
        ocr_api_key, ocr_secret_key, _auth,
    )
```

`execute_document`（`main.py:1981`）**没有 `instance_id` 形参**，而调用按位置传了 8 个实参。映射结果整体右移一位：

| 形参 | 实际收到 |
|---|---|
| `instance_id` | `ocr_provider` |
| `ocr_provider` | `ocr_endpoint` |
| `ocr_endpoint` | `ocr_api_key`（**百度 API Key 被当主机名拼进 URL**，`main.py:1014,1121`）|
| `ocr_api_key` | `ocr_secret_key` |
| `ocr_secret_key` | `_auth` |
| `_auth` | 回落为未求值的 `Depends(verify_auth)` 哨兵 |

**三重生产事故：**

1. **OCR 完全失效**：`ocr_config["provider"] = ocr_endpoint.lower()` 恒不等于 `"baidu"`，`main.py:1253, 1479, 1621, 1821` 的四处 OCR 分支全部跳过。扫描版 PDF 全部落到 docling / pypdf 兜底，纯扫描件在 `main.py:1671` 直接失败。
2. **租户真实身份被丢弃**：`main.py:1936-1939` 拿 `ocrConfig.provider` 当 instance id 校验，任何不在 `[A-Za-z0-9_.-]{1,80}` 的 provider 串都会返回**永久 HTTP 400 "Invalid instance identity"**，ingestion 直接失败。
3. **跨租户 artifact cache 串号**：`main.py:1680` 把 `instanceIdentity` 设成 `"baidu"`/`"legacy"`（对所有租户相同），`artifact_cache.py:15-17` 又用它参与 key → 一旦设置 `OCR_DEPLOYMENT_REVISION`（`main.py:1086`），**租户 B 会拿到租户 A 的百度 OCR 结果**（相同图片字节）。

附带：所有调用方共用同一 identity，`PARSER_PER_INSTANCE_CONCURRENCY=2` 会把所有租户一起限流到 2 并发，`/resource-metrics` 的 `runningByInstance` 报告的是 `"baidu"` 而非租户 ID。

**修复**：`execute_document` 增加 `instance_id: str | None = Form(None)`，调用改为全关键字 `parse_document(background_tasks=..., file=..., parser_type=..., instance_id=..., ocr_provider=..., ...)`。

---

### C-03 GBrain 推送无条件关闭 TLS 证书校验，与同文件的环境开关自相矛盾

**位置**：`packages/gbrain-adapter/src/index.ts:885-888`

同文件 `:443-449` 有明确的安全门：

```ts
      // SECURITY: GBRAIN_ALLOW_UNVERIFIED_REMOTE=1 disables TLS certificate
      // verification … It is a blanket MITM exposure … never by default.
      ...(process.env.GBRAIN_ALLOW_UNVERIFIED_REMOTE === '1'
        ? { GBRAIN_ALLOW_UNVERIFIED_REMOTE: '1' }
        : {}),
```

但 push 路径把开关写死：
```ts
  private async pushSourceIfConfigured(sourceId: string): Promise<void> {
    if (!this.configuredRemote(sourceId)) return;
    await this.run(['sources', 'push', sourceId, '--allow-unverified-remote', '--json']);
  }
```

**触发条件**：只要设置了 `GBRAIN_SOURCE_REMOTE_URL_TEMPLATE`（唯一前置条件），`ingest`/`rebuild`/`deleteMany`/`maintain`（`:1050, 1102, 1158, 1176`）**每一次**都会把租户知识以关闭证书校验的方式推送到远端。环境变量保护的是一个没人设置的值，真正的绕过是硬编码的。

**修复**：`...(process.env.GBRAIN_ALLOW_UNVERIFIED_REMOTE === '1' ? ['--allow-unverified-remote'] : [])`。

---

### C-04 RLS 在约 20 张含租户数据的表上被显式关闭，同时对 runtime 角色全量 GRANT

**位置**：`packages/database/prisma/migrations/20260926160000_rls_disable_no_policy_tables/migration.sql:9-16, 78` + `scripts/reconcile-runtime-db-role.sh:47, 49`

```sql
    'AuditLog', 'BrainChangeEvent', 'BrainDerivedPage', 'BrainMaintenanceRun',
    'BrainOperationLog', 'BrainRepo', 'BrainScope', 'BrainScopeMember',
    'BrainSource', 'BrainSourceDocument', 'BrainSourceMember', 'BrainTopic',
    ...
    'ModelConfig', 'ModelProvider', ...
    'User', 'UserCredential', 'UserOrg', 'UserRole', '_prisma_migrations',
```
```sql
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
```
```sql
SELECT format('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_role') \gexec
```
`line 49` 还追加了 `ALTER DEFAULT PRIVILEGES`，**新建表自动继承这份授权**。

按该迁移自己的头注释，`llmwiki_app` 正是每个请求使用的 NOBYPASSRLS 角色。RLS 关闭 + 全量授权 ⇒ 以下查询在 API 进程内任意位置均可直接执行：
- `SELECT "appSecretEnc" FROM "UserCredential"` — 用户 AppSecret 密文
- `SELECT "secretKeyEncrypted" FROM "ModelProvider"` — LLM/OCR 供应商密钥
- `SELECT * FROM "SemanticCache"` — 跨租户问答缓存
- `SELECT content, "derivedFrom", "sourceKeys" FROM "BrainDerivedPage"` — **最严重**：跨 source 合成的知识 + 原文片段，唯一隔离靠应用层，`app_document_readable()` 完全不覆盖该表

任何一处 `findMany` 漏写 `where`、或任何 SQL 注入，都是全租户数据泄露。

**修复**：把 `UserCredential`、`ModelProvider`、`SemanticCache`、`BrainDerivedPage`、`BrainScopeMember`、`BrainSourceMember`、`BrainSourceDocument`、`FeedbackCase` 移出白名单，各自补真实策略 + FORCE；用逐表授权替换 `GRANT … ON ALL TABLES`。

---

### C-05 生产发布默认门禁不跑类型检查、不跑 lint、不跑 API 单测、不跑质量门禁

**位置**：`scripts/deploy-prod.sh:70` → `scripts/release-quality-first-gate.sh` → `scripts/release-functional-gate.sh:37-45`

```bash
GATE_PROFILE=quality-first          # deploy-prod.sh:70，默认值
```
`quality-first` 只 `exec release-functional-gate.sh`，后者全部检查项为：
```bash
python3 tests/integration/run-core-checks.py --unit
pnpm run test:parser
pnpm run test:adapter
pnpm run benchmark:selftest
(cd apps/web && npx --yes tsx@4.23.13 __tests__/answer-layout.fixture.tsx …)
python3 tests/e2e/chat_answer_layout.py
python3 -u tests/e2e/sota_knowledge_base_suite.py
git diff --check
python3 scripts/release-gate-fingerprint.py save
```
**缺失**：`tsc --noEmit`、`pnpm --filter api lint`、`pnpm run test:api`、`pnpm --filter web test`、`tests/evaluation/ci-gate.sh`、`scripts/ab-gate.sh`、`scripts/feedback-gate.sh`。仅 `--gate=full` 才会走 `scripts/ci.sh`。

而 `scripts/ci.sh:53-58` 的注释断言的恰好相反：
```bash
# Typecheck and lint before the unit layers. This script is the only gate
# deploy-prod.sh runs, and it previously executed neither …
```
（注释已过时，`deploy-prod.sh` 现在有 3 个 profile。）

**叠加影响**：`release-functional-gate.sh:33-36` 的指纹短路会把整个门禁降级为一次 `curl /ready`：
```bash
if python3 scripts/release-gate-fingerprint.py check; then
  curl --fail --silent "${API_BASE:-http://127.0.0.1:3202}/ready" >/dev/null
  exit 0
fi
```

**修复**：默认 `GATE_PROFILE=full`；或让 `release-functional-gate.sh` 补跑 `test:api` + `tsc --noEmit` + `lint`；并把至少 `test:parser`/`test:adapter`/`benchmark:selftest` 移出指纹短路。

---

## P1 HIGH（27 项）

### 鉴权与密钥

| ID | 位置 | 缺陷 |
|---|---|---|
| **H-01** | `apps/api/src/open-api/open-api.guard.ts:37-42` | App Secret 允许从 **query string** 读取（`query.app_secret`）。`deploy/native/nginx.llmwiki.conf:49` 代理 `/open-api/` 未覆盖 `access_log`，nginx 默认 `combined` 格式会把 `?app_secret=…` 完整落盘。而 `open-api.controller.ts:70-81` 发布的 spec 只声明 `in: 'header'`。**修复**：删除 query 回退。 |
| **H-02** | `apps/api/src/main.ts`（全文件无 `trust proxy`）+ `app.module.ts:33-36,70-72` + `auth.controller.ts:17-22` | 未设 `app.set('trust proxy', …)`，而 `@nestjs/throttler` 按 `req.ip` 计键。nginx 后置下所有请求 `req.ip` 都是代理地址 ⇒ **登录限流 10 次/分钟对整个部署生效**（自伤式全站锁死，且对分布式攻击无效）。**修复**：`app.set('trust proxy', 1)`。 |
| **H-03** | `apps/api/src/open-api/open-api.guard.ts:83-109` | Bearer 回退路径**不检查 `mustChangePassword`**，而 `auth.guard.ts:27-33` 会检查。被强制改密的账号仍可通过 `Authorization: Bearer` 完整使用 `/open-api`（KB 列表/检索/对话/上传/状态）。**修复**：补 `isPasswordChangeRequired`。 |
| **H-04** | `apps/api/src/auth/user-credential.service.ts:239-248` | App Secret 用 `!==` 比较（非时序安全），且**第二处比较的是解密后的明文**（攻击者正在猜的值）。对比 `auth.service.ts:74` 正确使用 `timingSafeEqual`。**修复**：等长缓冲 + `timingSafeEqual`。 |
| **H-05** | `apps/api/src/auth/mfa.service.ts:123, 177` + `totp.ts:94-104` | TOTP **无重放防护**：`verifyTotp` 只返回 bool，不返回匹配的 counter，也没有任何地方记录 `lastUsedCounter`（schema 只有 `mfaSecret/mfaEnabled/mfaEnabledAt`）。一个 90 秒窗口内的验证码可被重复兑换二次登录。**修复**：持久化 `mfaLastCounter`，`<=` 即拒绝。 |
| **H-06** | `apps/api/src/main.ts:103-115` | CORS 白名单被 `isLocalhost` 无条件 OR 绕过：配置了 `WEB_ORIGIN`/`CORS_ORIGINS` 也无法关闭。任何 `localhost`/`127.0.0.1` 任意端口的 origin 都拿到 `Access-Control-Allow-Credentials: true`。**修复**：仅在未配置白名单时启用 localhost 默认值，并固定端口。 |

### 跨租户数据泄露

| ID | 位置 | 缺陷 |
|---|---|---|
| **H-07** | `apps/api/src/knowledge-graph.controller.ts:184, 222, 379` | 知识图谱接口**完全没有 ACL 过滤**（已确认全文无 `DocumentAcl`/`filterReadable*` 引用），直接 `document.findMany({ kbId: { in: visibleKbIds }, status:'published' })` 并把 chunk `content` 与派生 `terms` 作为 `concept:` 节点标签返回。而 `document-acl.service.ts:188` 的契约是「有 ACL 则 deny-by-default」。**任意 KB 读者都能看到受限文档的标题、片段与派生词。** |
| **H-08** | `apps/api/src/ingestion/knowledge-base.controller.ts:419-463` | 文档列表绕过 per-document ACL，并**把绝对服务器路径 `rawFileOid` 返回给客户端**。`currentUser`（`:213`）只在 `req.params.docId` 存在时才做 `isDocumentReadable`，本路由没有该参数。`getDocument`（`:536`）却是正确的，证明是遗漏。 |
| **H-09** | `apps/api/src/retrieval/table-evidence.service.ts:31` vs `:18` | MCP 表格聚合缺 `activeVersionId: versionId` 过滤（同文件 `:18` 的兄弟方法是正确的）。`document-version-store.ts:141` 只把新版本置为 `published`，旧版本仍是 `published` ⇒ **可对已非当前版本的内容做 count/sum/min/max**。 |

### 数据完整性 / 生命周期

| ID | 位置 | 缺陷 |
|---|---|---|
| **H-10** | `apps/api/src/ingestion/ingestion.controller.ts:458-465` + `graph-rag.service.ts:1132` | 删除文档后清理图谱时，`removeDocumentFromGraph` 默认**吞掉所有异常**（只有 `{strict:true}` 才抛）。一次瞬时 DB 故障就让 `GraphEntity.properties->docIds`、`GraphRelation.provenance` 永久指向已删文档，**继续在 GraphRAG 回答中返回陈旧内容**。`archived-personal-cleanup.service.ts:232` 证明正确用法是 `{strict:true}`。同样问题见 `:456`（lexical）与 `:229`。 |
| **H-11** | `apps/api/src/mcp/mcp.service.ts:30-31` vs `ingestion.controller.ts:83-84`、`connector.service.ts:41`、`object-storage.service.ts:42`、`admin.controller.ts:1116` | **5 处 `UPLOAD_ROOT` 默认值互不相同**。未设环境变量时 MCP 写到 `<cwd>/runtime/uploads/<docId>/`，删除时 `ingestion.controller.ts:484` 用的是**另一个根目录** ⇒ `rawFileOid` 原始文件被删，但 `content.v*.md`、`converted_preview_v*.pdf` 及整个文档目录**永久残留**，反复上传/删除会填满磁盘。 |
| **H-12** | `apps/api/src/brain-compiler/brain-compiler.processor.ts:154-164` | Outbox 事件认领是 check-then-act TOCTOU。更糟：worker 若在置 `processing` 之后崩溃，该行**永久停留 `processing` 且 `retryCount: 0`** —— 后续运行全部走 `skipped` 分支并**成功返回**，`retryCount` 永不增长，`deadLetterExhausted()`（`brain-outbox.service.ts:80`，过滤 `pending/failed`）永远不会认领，dispatcher 在 `job.retry('completed')` 上空转。**`perm_revoke`/`doc_delete` 事件被静默丢弃，权限撤销与文档删除永久不生效。** **修复**：`updateMany({ where: { id, status: { in: ['pending','failed'] } } })` + `processing` 超时回收器。 |
| **H-13** | `apps/api/src/ingestion/version-chain.service.ts:57-88` + `document-version.controller.ts:117-131` | `publishVersion` ①`previous` 无 `FOR UPDATE` 锁 → 并发调用都算出 `nextVersion = previous.version + 1`，产生**两个「当前」v-N 行**（`(kbId, sourceExternalId)` 无唯一索引）→ 搜索结果重复；②新行 `mdPath` 继承 `previous.mdPath`（`<oldDocId>/content.v2.*.md`），**旧文档被删时会连带删掉当前文档指向的 markdown**；③`rawFileOid` 为空 ⇒ 新行永远无法被 `ingestion.service.ts:274` 摄取，永久停留 `status:'parsing'`。 |
| **H-14** | `apps/api/src/connector/connector.service.ts:339-357` | 连接器重新同步时，`writeFile(existingRawPath, content)` 覆盖原始文件、`prisma.document.update`、入队三步**无事务**。中间崩溃 ⇒ 磁盘上是 v(N+1) 的字节而 DB 仍记 v(N) 的 `contentHash`，**上一版本被不可恢复地破坏且无不可变副本**。也违背了 `immutableVersionsEnabled()` 的设计初衷。 |
| **H-15** | `apps/api/src/admin.controller.ts:2425-2444` + `schema.prisma:140-153` | `IndustryGrant` **无唯一约束**（仅 `@@index`），且 `findFirst` 重复检查在 `$transaction` **之外**。并发授权请求双双通过检查并插入；`deleteGrant`（`:2482`）只按 id 删一行 ⇒ **撤销后残留行仍然授予 KB 访问权**，且 `app_visible_kb_ids()` 无 `DISTINCT`。**修复**：加 `@@unique([kbId, subjectType, subjectId])`。 |
| **H-16** | `apps/api/src/admin.controller.ts:2201-2210` | `updateRole` 只对 `builtin` 角色的 `name` 加固，`permissions` **可写**。`PATCH /admin/roles/<basic_user_id> {"permissions":["*"]}` ⇒ 所有基础用户被静默提升为系统管理员（`auth.guard.ts:57` 视 `capabilities.includes('*')` 为全权）。**修复**：builtin 角色禁止改 `permissions`。 |
| **H-17** | `apps/api/src/ingestion/ingestion.service.ts:666-684, 784` | 解析失败/被取代时 `catch` 里 `unlink(pendingContentPath)` —— 但该文件在 `:678` 已 `rename` 走，**清理是空操作**。每次事务失败（含正常的 `SupersededVersionError`）都留下一份完整 markdown 副本，全代码库无人删除。 |
| **H-18** | `apps/api/src/permission/document-acl.service.ts:125-133` + `schema.prisma:331-343` | `DocumentAcl` 无 `(documentId, subjectType, subjectId)` 唯一约束，`findFirst`→`create` 跨事务。两个并发 `POST /documents/:id/acl` 产生重复行；`replaceAll` 的 `createMany({ skipDuplicates: true })`（`:111-112`）无索引时是 no-op；撤销时删一行，**另一行继续生效**。 |

### 检索 / 答案正确性

| ID | 位置 | 缺陷 |
|---|---|---|
| **H-19** | `apps/api/src/chat/bridge-rescue.ts:676-678` | **索引空间混淆**：`byScore` 是按分数排序的数组，`item.index` 是池下标。代码用池下标去索引排序数组：<br>`if (input.isRelevant && !input.isRelevant(byScore[index].citation)) continue;`<br>即 `isRelevant` 被施加在一个**无关文档**上。调用方 `chat.service.ts:4019-4029` 专门为此提供了词覆盖率闸门（用来阻止《公车管理办法》混入考勤答案），在 50 条候选池下它实际检验的是随机文档 ⇒ 要么静默丢弃本应恢复的桥接文档（召回损失 → 错误拒答），要么让无关文档借他人覆盖率蒙混过关。**且 `plan.docs.push(key)` 记录的是「意图文档」，trace 撒谎。** **修复**：`const found = byScore.find(…); if (found.isRelevant…) … plan.indices.push(found.index)`。 |
| **H-20** | `apps/api/src/chat/chat.service.ts:4179, 4189-4199` | 命中 topic 列表是**按引用逐条产生**的（`citation-assembly.ts:317, 848`），即 8–30+ 条。循环内串行 `brainTopic.findUnique` + 任意次无上限的 `triggerLazyCompileAndWait`，**既无条数上限也不检查 deadline**（`getRequestContext()?.execution?.deadline` 未被查询），而 `searchChunksFallback` 早已消耗完检索预算。⇒ 跨 30 个 dirty topic 的问题会在 LLM 预算花完后超时。**修复**：`Set` 去重 + `slice(0,8)` + 单次 `findMany` + 每次请求最多 1 次编译并受 deadline 约束。 |
| **H-21** | `apps/api/src/chat/agentic-rag.service.ts:351, 367-370, 377, 452` | `planCache` **无容量上限、无淘汰**（过期项只有同 key 再次命中才被覆盖）。key 是 `${complexity}:${query.trim().toLowerCase()}`，**纯用户输入**。任何已认证用户发 N 条不同 multi-hop 问题即可无界增长堆内存直至 OOM ⇒ 全服务 DoS。同文件 `:338-341` 的兄弟缓存 `expansionCache` 有 500 条上限，唯独这里没有。 |
| **H-22** | `apps/api/src/chat/retrieval-arms.ts:601-604, 630, 654-658` | `scopeDomainTermsCache` 无界，key 是**调用方请求的 KB scope 子集**（`chat.controller.ts:118` 只限 100 项）。拥有 K 个 KB 的用户可用轮换子集构造约 2^K 个 key（K=30 → 10.7 亿），每个保留完整 `terms`+`mappings` 数组 120 秒 ⇒ 廉价内存放大原语。 |
| **H-23** | `apps/api/src/chat/chat.service.ts:5686-5694` | 该 `try` 覆盖了 `await assertRequestAuthorization()`（`:5622`）。流式生成中途的授权撤销抛出的 `ForbiddenException` 被上报为 **`LLM Connection Failed: {error.message}`**；更严重的是 `emitCitationsAndComplete`（第三层文档 ACL 复查）被**跳过**。开启 `KNOWLEDGE_INCREMENTAL_STREAM=1` 时，`IncrementalAnswerStreamer`（`answer-stream.ts:262-267`）已推送的 delta 帧来自**现已撤销的文档**，且无 `replace` 事件撤回 ⇒ **用户继续看到被撤权文档的完整答案**。**修复**：`rethrowAuthorizationFailure(error)`（本文件其它处理器均如此）。 |
| **H-24** | `apps/api/src/chat/chat.controller.ts:197-206, 225, 240, 368, 373` | 严格输出缓冲溢出时 `writeEvent` **抛异常**，但它的三个调用点不在 `try` 内：`upsertPersistenceTrace`（`:225`）经 `finalize()`（`:240`）在 `try`（`:242`）**之前**执行；`next:`/`error:`（`:339`/`:366`）同样在外。且调用点是 `void finalize();`（`:368, :373`）**无 `.catch`**。⇒ 拒绝逃逸出 `finalizePromise`，Node 默认 `--unhandled-rejections=throw` **终止 API 进程**，带走所有在途请求。触发条件与提问形态相关（长答案 + 多 trace 节点）。**修复**：不要从 sink 抛异常，改置标志位并显式失败该轮；所有 `void` 调用点补 `.catch(() => {})`。 |

### DoS / 资源

| ID | 位置 | 缺陷 |
|---|---|---|
| **H-25** | `apps/api/src/brain-compiler/brain-compiler.service.ts:68-81` | `:68-76` 的注释明确写着「无界 `Promise.all` 曾耗尽 Prisma 连接池并让 HTTP 监听器无法绑定」，但 `:77-79` 的 `GBRAIN_MIGRATE_ON_STARTUP === '1'` 分支**又对所有活跃用户做了同样的无界 fan-out**，且 `syncUserBrainRepo` 每次会 spawn GBrain 子进程 + git 操作（`gbrain-adapter/index.ts:495, 759, 829`）。**修好的模式没有应用到第二个调用点。** |
| **H-26** | `apps/parser-worker/src/quality.py:45`（调用点 `main.py:1877`） | `re.findall` 为**每个匹配字符创建一个 list 元素**。实测 8.4 MiB CJK markdown → **195 MiB** 瞬时占用。200 MiB `.txt` 上传（~1 亿 CJK 字符）→ 数 GB 分配，systemd `MemoryMax=4G` ⇒ **worker 在 ingestion 中途被 OOM kill**。且这是同步 CPU 调用、未包 `to_thread`，会把事件循环卡住数十秒（`quality.py:48` 随后再逐字符走一遍）。**修复**：`sum(1 for _ in re.finditer(...))` + `asyncio.to_thread`。 |
| **H-27** | `apps/api/src/embedding/chunk-embedding.service.ts:126-133` | 混合索引一次查询取出文档**全部** chunk 的完整 `content`，**无 `LIMIT`**（对比同文件 `:62-78` 的密集路径有游标分页）。500 页 PDF → 数万 chunk 全量物化。叠加 `enrichment.processor.ts:38` 的 4 并发 worker ⇒ 堆峰值可避免地暴涨。 |

---

## P2 MEDIUM（84 项）

### 逻辑正确性

| ID | 位置 | 缺陷 |
|---|---|---|
| M-01 | `apps/api/src/chat/fusion-rerank.ts:337-340` | 一个空 `buildContextualizedRerankText` 导致**整个探测组被静默丢弃重排**（`documents.length !== pool.length` 即 return，无 `recordFailopen`、无 trace）。`citations` 含 `retrieval-arms.ts:2132-2152` 推入的 raptor/isSummary 命中（不设 context）⇒ 主查询组一个摘要即让全部主查询候选失去重排，池内混用跨编码器分与 min-max 合成分。 |
| M-02 | `apps/api/src/chat/chat.service.ts:1654-1656` | 搜索路径排序比较器 `?? 0` **不拦截非数值 score**。原始引擎引用在 `:2859` 未加工拼入，`retrieval-arms.ts:2145` 也有。字符串型/非有限 score ⇒ 比较器返回 `NaN` ⇒ V8 TimSort 视所有对为无序 ⇒ **排序结果由输入顺序决定（非确定性）**；且无 tie-break（同分很常见：`retrieval-arms.ts:1899-1901` 已有正确的确定性 tie-break 可参考）。 |
| M-03 | `apps/api/src/chat/chat.service.ts:1040-1044, 1111-1113` | `cancelFromTransport` **从未被注册**：全文件无 `inheritedCancellation.addEventListener('abort', cancelFromTransport)`。teardown 移除一个从未挂载的监听器，函数体（含唯一的 `subscriber.error`）不可达。任何预置 `ctx.cancellation` 的调用方（`mcp/mcp.controller.ts:48-50` 正是此模式）**得不到取消传播**，管线空跑到 120 秒 deadline。 |
| M-04 | `apps/api/src/chat/retrieval-arms.ts:1308-1316` vs `:1712-1723` | `subQueryChunkCache` 命中路径在**权限过滤之前**就 return。缓存 key（`:1309`）含 user/authRevision/kbScope/asOf，但**不含 `aclEpoch`/`knowledgeEpoch`** ⇒ 120 秒 TTL 内撤销授权后仍返回已被过滤掉的 chunk。当前靠每个调用方兜底重跑过滤掩盖，是活的 ACL 绕过地雷。 |
| M-05 | `apps/api/src/ingestion/contextual-retrieval.ts:145, 251`（数据源 `ingestion.service.ts:608`） | `options?.concurrency ?? 4` **不替换 `NaN`**；`concurrency: Number(process.env.CONTEXTUAL_RETRIEVAL_CONCURRENCY || 5)`。拼错的值（`=8x`）⇒ `offset += NaN` ⇒ 循环条件恒假 ⇒ **零个 chunk 被富集，无错误无日志**，文档以降级上下文发布。同类问题：`contextual-retrieval.ts:73` 的 `MAX_ENRICH_CHUNKS`。 |
| M-06 | `apps/api/src/ingestion/markdown-chunker.ts:33-36, 284-287, 412-414` | `CHUNK_MAX_CHARS=0`（字符串 `'0'` 是 `\|\|` 的假值陷阱）⇒ `end === start`、不产出任何 chunk、`nextStart = start + 1` ⇒ 循环**逐字符**走完整个多 MB 文档。`CHUNK_MAX_CHARS=abc` ⇒ 立即退出，表现为 `"Parser returned no indexable content."`。 |
| M-07 | `packages/gbrain-adapter/src/index.ts:518-525, 790, 827` | `Math.max(30_000, Number(env))` 在 `NaN` 时结果是 `NaN`，`setTimeout(fn, NaN)` 下一 tick 即触发 ⇒ **一个拼错的时间戳环境变量让所有子进程 1ms 超时死亡**，表现为 "GBrain timed out" 而非配置错误。同文件 `:498-499` 已对 `GBRAIN_MAX_OUTPUT_BYTES` 做了 `Number.isFinite` 守卫，此处没有。 |
| M-08 | `packages/gbrain-adapter/src/index.ts:814-820` | `GIT_STALE_LOCK_MS=10m`（注释里「10 minutes」的顺手写法）⇒ `staleMs = NaN` ⇒ `ageMs < NaN` 恒 false ⇒ `rm(lockPath)` **无条件执行**，删除**正在运行**的 `git add` 的 index.lock ⇒ 第二个 git 进程继续并损坏/丢失源码库暂存状态。 |
| M-09 | `packages/gbrain-adapter/src/index.ts:1542-1550, 1517, 1391-1392, 1506` | 4 处 `Math.max(N, Number(env))`：`slice(0, NaN)` → **零条引用、无报错**；`GBRAIN_RRF_K` 为 NaN ⇒ 每个 `rrfScore` 变 NaN，污染 `:1546-1549` 的比较器；`GBRAIN_CONTEXT_MAX_*` ⇒ `remaining = NaN` ⇒ 任何页面都无法 hydrate。 |
| M-10 | `packages/gbrain-adapter/src/index.ts:791-807` | ①`:792` 对 `commit` 提前 `return`，使 `:798` 的 `'commit'` 判断**不可达**（注释描述的 commit 恢复从未生效）；②所有 `git commit` 失败被 `return`/吞掉 ⇒ `ingest`（`:1049`）带着未提交的工作继续 `syncSource`；③超时消息是 `timed out after …ms`，不含 `'failed'`，故超时也永不触发恢复。 |
| M-11 | `packages/gbrain-adapter/src/index.ts:638-647, 741-747` | `sources status --json` 有 3.5 秒缓存，`sourcePageCount` 不强制刷新，而 `ensureSource`/`registeredSource` 都会读它 ⇒ **同步后 3.5 秒窗口内的校验必然比对同步前的计数并抛错**，`ingest`（`:1051`）失败且到不了 `verifyPages`。间歇性、负载相关的 ingestion 失败。`rebuild:1109` 正确传了 `force = true`。 |
| M-12 | `packages/gbrain-adapter/src/index.ts:1479` vs `:152-159` | `getPage` 仍在用**未锚定**的 `/^---[\s\S]*?---\s*/`，而 `FRONTMATTER_PATTERN`（`:159`）正是为修这个而写的（注释说明旧的多行模式会把 PDF 分页符 `---` 之间的正文整段删掉）。标题含 `---` 时（`canonicalPage:136` 经 `JSON.stringify` 原样输出）惰性匹配停在标题内 ⇒ **YAML frontmatter 片段被注入 `citation.context`**。 |
| M-13 | `packages/gbrain-adapter/src/index.ts:183-193, 236, 246` | `structuralPassages` 的 `insideArticle` 只在遇到 Markdown 标题时清除，**离开条款时不清** ⇒ 首个 `第N条` 之后所有 `一、`/`1.` 都被并入该条款并无界增长；`localizePassage`（`:246`）再 `slice(0, 18_000)` **静默截断**超长部分。`:236` 按内容相等找邻居，撞车时取第一个。 |
| M-14 | `apps/api/src/ingestion/ingestion.controller.ts:166-171` vs `:226-231` | 压缩包上传路径**缺少单文件路径已修复的 `FOR UPDATE` 幂等锁**（`:226-231` 有明确注释说明这是为了修 check-then-act 竞争）。两个并发 ZIP（或 ZIP + 单文件）`duplicateMode:'skip'` ⇒ 重复文档、重复 chunk、重复 embedding/LLM 计费。且两条路径默认值不一致（`:154` 为 `'copy'`，`:312` 为 `'skip'`）。 |
| M-15 | `apps/api/src/ingestion/ingestion.controller.ts:315-321` | 文本文档端点同一竞争未修：无 `FOR UPDATE`、无事务。且与上传路径**默认值也不一致**。 |
| M-16 | `apps/api/src/connector/feishu-connector.ts:190-207` | 下载失败时 `continue` **不推进 `nextCursor`**，但循环继续，后续成功会覆盖 `nextCursor` ⇒ 文件 `[A,B,C]` 中 B 失败 ⇒ `nextCursor` 最终为 C ⇒ 下轮 `filter(f.token > 'C')` ⇒ **B 永不重试，内容永久静默缺失**。 |
| M-17 | `apps/api/src/connector/webhook-connector.ts:71-84, 89` | 队列在 `connector.service.ts` 持久化**之前**就被清空；若全部入库失败，`connector.service.ts:221` 正确地拒绝推进 DB 游标，但**载荷已永久丢失**（docstring 却声称「至少一次投递」）。`export const webhookConnector = new WebhookConnector()`（`:89`）是**进程内单例**，在 AGENTS.md 的多实例拓扑（独立主机、`REDIS_DB=N-1`）下，实例 2 收到的 webhook 对实例 1 的同步不可见。 |
| M-18 | `apps/api/src/brain-compiler/brain-outbox.service.ts:139-162, 173-175, 194` | dispatcher 游标会**越过被 `continue` 跳过（队列满）或 `enqueueEvent` 抛错的事件**。畸形富化载荷导致的 `Invalid enrichment outbox event` 发生在 dispatcher 里，`retryCount` 永不增长、`deadLetterExhausted()`（`:80`）永不认领 ⇒ **毒丸事件被无限重试**。队列满还会顺延 priority-1 的 revoke 事件一整轮。 |
| M-19 | `apps/api/src/permission/permission.service.ts:719-728` | `revokeAccess` 的 `deleteMany` **忽略 `subjectType`**：`{ subjectId: userId, kbId }` 会连带删除 `role`/`org` 主题中 `subjectId` 恰好等于该用户 UUID 的授权。 |
| M-20 | `apps/api/src/model-credential.ts:11-21` | 用**精确字符串** `process.env.NODE_ENV === "production"` 判定生产；`NODE_ENV=prod`、首尾空格或未设置都会落到**仓库内硬编码常量** `sha256("llmwiki-local-model-config-key")`。这正是 `auth-secret.ts:6-19`（用 `DEV_ENVIRONMENTS` Set + 显式开关）要关闭的同一个洞，但此处保护的是 LLM 供应商 API Key 与全部 `UserCredential.appSecretEnc`。 |
| M-21 | `apps/api/src/model-credential.ts:59-61` | GCM 认证标签校验失败被静默吞成 `""`。`MODEL_CONFIG_KEY` 轮换或密文被篡改都不报错；`maskModelCredential` 报 `(无密钥)`，`user-credential.service.ts:242-244` 随后拿 `"" !== appSecret` 比较 ⇒ 表现为「密码错」而非「密钥配置错误」。 |
| M-22 | `apps/api/src/ingestion/ingestion.service.ts:99-102` | `ModelQuotaBucket` / `ModelArtifactCache` 的 GC 被包在 `if (process.env.CORE_VERSIONING_ENABLED === '1')` 里。前者是 `app_admit_model_call` 在**每次模型调用**上写入的限流状态（`20261001001000_model_quota/migration.sql:11-14`），且无其它清理路径。`CORE_VERSIONING_ENABLED` 未设置（即默认）⇒ **最热的写路径上分钟桶无界增长**。 |

### 工程质量（违反仓库自身声明的守则）

| ID | 位置 | 缺陷 |
|---|---|---|
| M-23 | `packages/database/prisma/migrations/20261003000000_force_rls_core_tenant_tables/verify.sql:36-45`（唯一断言） | 全仓 grep：`verify.sql` / `security-test.sql` / `rollback.sql` **只出现在 `docs/plans/*.md` 和 git index 里，没有任何脚本或 workflow 执行它们**。`scripts/deploy-prod.sh:609` 只有 `npx prisma migrate deploy`，无后置校验；`scripts/rls-inspect.sh`（它确实会打印 `enabled_not_forced`）同样无人调用。⇒ **FORCE RLS 不变量在生产完全无人守护。** |
| M-24 | 同上 + `20261004120000_chat_run/migration.sql:30` | `ChatRun` 只 `ENABLE` 未 `FORCE`，且**不在** `20261003000000` 的表清单里（该迁移时间更早 `20261003 < 20261004`，顺序上无法补救）。`chatrun_rw` 策略是 chat run 的**唯一**租户隔离（注释：*"Tenant isolation follows Message"*）⇒ 任何以属主角色（`llmwiki`）连接的会话可读写所有用户的 `ChatRun`（含 `errorMessage`）。**更糟：配套 `verify.sql:30-33, 42-50` 检测不出来** —— 只 `RAISE NOTICE 'PASS: ChatRun RLS enabled (forced=%)'` 不做断言，且只检查 `current_user`（而非 `pg_class.relowner`）。 |
| M-25 | `20261001001000_model_quota/migration.sql:1-5`、`20261001002000_authority_state_guard/migration.sql:2-3` | 另有两张表同样 enabled-but-not-forced（`ModelQuotaBucket`、`AuthorizationState`），而同系列的 `20261001000000:4`、`20261001005000:8`、`20261001014000:23`、`20260930210000:12,14`、`20260930220000:11` **都有 FORCE**。 |
| M-26 | `packages/database/prisma/schema.prisma:331-343` | `DocumentAcl` 无唯一约束（与 H-18 同源，但这里是 schema 层的根因）。 |
| M-27 | `packages/database/prisma/schema.prisma:476-489` | `Citation` 的 `chunkId` / `documentId` / `kbId` **外键无索引**（历史里只有 `Citation_messageId_idx`）。这三个字段都是 `ON DELETE SET NULL` ⇒ 文档/块清理会 seq-scan 引用表；`kbId` 缺索引还阻塞按 KB 作用域的引用清理。 |
| M-28 | `packages/gbrain-adapter/src/index.ts:380-388, 934-942, 578-586` | `sourceId` 直接拼文件系统路径（`getSourcePath` / `initializeSource` / `resolveChildCwd`）**零校验**。`getSourcePath`、`initializeSource`、`extract(sourceId,…)` 均为 public。`gbrain://source/../../../srv/x` 会让 adapter `mkdir -p`、`git init`、写 `.gbrain-source` 并注册一个根在 `<basePath>/gbrain-sources` **之外**的 GBrain source。当前调用方恰好都传 sha256-hex（`brain-source.ts:8-11`），属纵深防御缺口而非活的利用路径。 |
| M-29 | `packages/gbrain-adapter/src/index.ts:1085-1098` vs `brain-scope.service.ts:382` | `rebuild()` 的孤儿清理只遍历 `docs/`，但应用确实会写到 `docs/` 之外（`slug: 'derived/scope-summary'`）⇒ `rebuild()` 后 `<source>/derived/*.md` 孤儿永不清除，继续被 `syncSource(sourceId, 0, true)` 索引并**作为可检索证据返回**。 |
| M-30 | `apps/parser-worker/src/main.py:655-660, 1618-1628` + `quality.py:22-31` | `classify_pdf` 返回 `"mixed"` 的条件正是「`page_ratio > 0.20` 且 quality 不是 good」，而 `native_page_indexes` **只在 `native_quality == "good"` 时才填充** ⇒ 对 mixed 类它恒为 `[]` ⇒ `scan_page_indexes` 覆盖全文 ⇒ 子集守卫为假 ⇒ **整份 PDF 全部重跑云 OCR 并丢弃完好的原生页文本**，每页重复计费。 |
| M-31 | `apps/parser-worker/src/main.py:763, 813-819, 820-825` | `list(sheet.iter_rows(values_only=True))` 无维度上限。已实测：单元格设在 `XFD1048576` 的工作簿会得到 `max_row=1048576, max_column=16384` ⇒ **171 亿个单元格**。约 10 KB 的构造 `.xlsx` 即可 OOM worker。合并单元格前向填充（`:752-761`）同样无范围上限，且单个 range 失败会 `logger.debug` 掉并中止该 sheet 的**全部**剩余 range（静默错误输出）。 |
| M-32 | `apps/parser-worker/src/main.py:2008-2054 → 1347 → 1273` | `/ocr-embedded-images` **绕过所有并发控制**：既不进 `_parse_limiter.slot()` 也不进 `_docling_semaphore`。它按嵌入图片数量**串行**发百度请求，每次 `OCR_TIMEOUT_SECONDS=900`。无限并发请求 ⇒ 无限出站调用，击穿 OCR 配额/限流，同时每张图在内存持有 50 MB。 |
| M-33 | `apps/parser-worker/src/main.py:2034-2052` | 自身的 413/400 护栏被 `except Exception` 捕获后重抛为 **500 并回显 `str(exc)`**（文件路径、供应商 URL）。调用方对永久超限的上传看到可重试的 500 ⇒ **无限重试**。 |
| M-34 | `apps/parser-worker/src/main.py:1064-1065 → 1296-1300, 1650, 1801, 2003` | 百度 `access_token` 通过 `params={"access_token": token}`（`:1052`）传递 ⇒ 任何 `HTTPStatusError` 消息**内嵌完整含 token 的 URL**；该字符串被 (a) 拼进解析后的 Markdown（即被索引进租户知识库的内容），(b) 存入 `task["ocr_error"]` 并由 `/parse-execute`、`/parse/{task_id}` 返回。配合服务端全局 `BAIDU_OCR_API_KEY` 默认值 ⇒ **租户 A 拿到租户 B 的 OCR 凭证明文**。 |
| M-35 | `apps/parser-worker/src/extractors/vlm_extractor.py:60-71`（调用 `main.py:1827, 1842`） | 20 MB 限制在 `read_bytes()` **之后**才检查，且调用方传的是 200 MiB 原始上传，**未包 `to_thread`** ⇒ 事件循环里一次阻塞 200 MB 读 + 267 MB base64，冻结 `/health`、`/metrics` 与所有在途解析。 |
| M-36 | `apps/parser-worker/src/main.py:1957-1960`（清扫 `:149-185`） | `except Exception` 抓不到 `asyncio.CancelledError`（`BaseException`）⇒ 客户端在 `await file.read(...)` 期间断开时，**部分写入的 200 MiB 临时文件永久残留**，`tasks[task_id]` 永久停留 `"queued"`（`periodic_cleanup` 只改 `tasks`，**从不扫描 `UPLOAD_ROOT`**）。 |
| M-37 | `apps/api/src/mcp/mcp.controller.ts:162-197` | 裸 `catch {}` 把限流 `HttpException(429)` 一并吞掉 ⇒ 被限流的调用方收到**误导性的 401「缺少有效凭证」**而非 429 + `retryAfterSec` ⇒ 客户端退避策略错误。 |
| M-38 | `apps/api/src/ingestion/knowledge-base.controller.ts:810, 860, 945` | 预览/下载把**整个原文件读入内存 Buffer**（`readFile`）再 `res.send`。上传上限 200 MB ⇒ N 个并发预览需要 N×200 MB 堆。`ingestion.controller.ts:64-68` 已有正确注释说明「200MB 上传绝不能被物化为单个 JS 字符串」，此处未遵循。 |
| M-39 | `apps/api/src/ingestion/document-version.controller.ts:127-128` | `new Date(body.effectiveFrom)` 无效值产生 `Invalid Date`，Prisma 写入时抛错 ⇒ 500 而非 400。注意 `effectiveFrom/To` 驱动 as-of 检索过滤（`retrieval-arms.ts:366`）。 |

### 前端

| ID | 位置 | 缺陷 |
|---|---|---|
| M-40 | `apps/web/src/components/knowledge-graph/KnowledgeGraphScreen.tsx:481`（依赖 `:341`，`positions` `:343`） | `rerunLayout = () => setLayout(null)`，但 `layout` **不在** 布局 effect 的依赖数组里 ⇒ 置 null 不会触发重算 ⇒ `positions` 变空 ⇒ 画布**永久空白**，直到某个无关依赖（>20px 的 ResizeObserver、类型 chip 切换、`localRoot` 变化）碰巧触发重算。 |
| M-41 | `apps/web/src/components/chat/ChatScreen.tsx:875-876, 884, 966` vs `apps/api/src/chat/citation-assembly.ts:1282-1289, 1426` | **后端发的是稀疏下标**（`finalCitations` 是 `1..N` 的子序列，`:1426` 输出 `originalIndex`），前端却用数组位置 `idx+1` 编号。⇒ 答案正文写 `[2] [3]`，同一屏的引用面板徽章却是 `1` `2`，「来源」行（`:966` 用 `source.citationIndex`，正确）显示 `[2] [3]`。点击答案里的 `[2]` 会高亮**标着 2 的那张卡（即第 3 条）**。 |
| M-42 | `apps/web/src/components/common/ConfirmModal.tsx:17` | `onClick={() => { onConfirm(); onClose(); }}` —— `onConfirm` 是 async 且在 `UsersPanel.tsx:528`、`RolesPanel.tsx:147`、`IndustryKBPanel.tsx:186`、`ModelPanel.tsx:192-193`、`OrgPanel.tsx:518`、`LibrariesScreen.tsx:777` **全部会抛**。模态无条件关闭，rejection 未处理 ⇒ **所有失败的破坏性操作完全静默**（无 toast、无错误态），而列表仍保留该行。 |
| M-43 | `apps/web/src/components/chat/ChatScreen.tsx:803`（prepend `:579-582`，无 key 追加 `:450`） | key 回落为数组下标，而 `loadOlderMessages` 用 **prepend** ⇒ 所有下标位移 ⇒ React 复用错误的 `MessageItem`/`TraceDetails` 实例 ⇒ **已展开的调用链（含缓存的 trace）挂到错误消息上**，摘要计数对错误的 trace 数组渲染。 |
| M-44 | `apps/web/src/components/libraries/LibrariesScreen.tsx:73, 90`（调用方 `:286, :323, :332`） | `loadDocuments` **无 AbortController、无序列守卫**，而三个独立生产者并发调用它（2 秒轮询、debounce 分页 effect、`app-data-refresh` 监听）。慢的 page-1 响应覆盖快的 page-2 ⇒ **表格显示第 1 页而 `docPage` 读第 2 页**，KPI 计数也被另一页覆盖。 |
| M-45 | `apps/web/src/components/admin/UsersPanel.tsx:542, 545, 563, 568` | 编辑表单用单 `<select>` 取 `orgIds[0]`，而表格渲染**多个** org 徽章；API 是整体替换（`admin.controller.ts:2031-2036`）⇒ **保存会静默剥掉用户的其余组织归属**。另外 `username` 初值取 `target?.initials?.toLowerCase()`，而 `mapUsers` 写入的是未小写的原值（`useAdminBootstrap.ts:49`）⇒ 一次无关的编辑会把 `ZhangSan` 改写成 `zhangsan`。 |
| M-46 | `apps/web/src/components/admin/IndustryKBPanel.tsx:205, 208-209, 217` | 管理员字段标了必填星号但**从不校验**（按钮只 `disabled={saving}`），管理员分配 POST 的 `response.ok` **从不检查** ⇒ 网络失败也照样弹「行业知识库已创建」⇒ 产出一个**无人可维护的知识库**而 UI 宣称成功。 |
| M-47 | `apps/web/src/components/settings/PersonalSettingsScreen.tsx:218-221` + `UniversalDocumentViewer.tsx:443-449` | `navigator.clipboard.writeText` **既不 await 也不 .catch** ⇒ 非安全源/权限被拒时 unhandled rejection，而 UI 已弹「已复制」。这是**含 AppSecret 的 MCP 配置 JSON** 的复制路径（`PersonalSettingsScreen.tsx:584`）⇒ 用户会以为凭据已上剪贴板并粘到编辑器里。`handleCopyMarkdown` 的 2 秒 `setTimeout` 也从未在卸载时清除。 |
| M-48 | `apps/web/src/components/preview/PptDeckViewer.tsx:197-202, 294-295, 429-431` | `objectUrlsRef` 只在**下次**解析开始时 drain，cleanup（`:429-431`）只设 `cancelled = true` ⇒ **卸载时泄漏全部图片 blob URL**（blob 由 URL registry 持有，不被 GC）。反复预览/关闭会无界累积。 |
| M-49 | `apps/web/src/components/preview/PptDeckViewer.tsx:211-212` + `UniversalDocumentViewer.tsx:222-231, 430-441` | 允许 200 MB 的上传被整体 `arrayBuffer()` + `JSZip.loadAsync`（Blob + ArrayBuffer + 完整解压对象图三者同时在内存）；**切换 sheet 的处理器每次点击都重新解析整个工作簿**；`XLSX.utils.sheet_to_json` 无 `!ref` 上限且结果无界保存在 `sheetsData` state。 |
| M-50 | `apps/web/src/components/shell/AppShell.tsx:413-421` + `lib/app-events.ts:34, 38` | 命令面板的「新建个人库」发 `app-new-kb`、「上传文档到当前知识库」发 `app-focus-upload`，**全仓无任何监听者**（已 grep 确认只有发射点）⇒ 两条 ⌘K 操作只会切屏然后什么都不做。另外 `setAdminTab('newkb')` 不是合法 tab id（`AdminScreen.tsx:23` 从 `tabRules` keys 初始化）。 |
| M-51 | `apps/web/src/components/admin/AdminScreen.tsx:34, 37-52, 327` | audit / Dream 分页无请求序列守卫，且共享 `appStore` + `auditMeta`。快速切页（或 `:34` 的自动重载与 `:327` 的 1.5 秒延迟重载竞争）⇒ **表格显示第 3 页而分页条读第 4 页**，用户无法判断自己在哪页。 |
| M-52 | `apps/web/src/components/chat/ChatScreen.tsx:609-623` | 会话重命名只有 `if (res.ok)`，**无 else 分支**，`catch {}` 为空 ⇒ 4xx/5xx/网络错误都无 toast、无列表更新 ⇒ 输入的标题静默消失（服务端明确会用 `NotFoundException('Title cannot be empty.')` 拒绝空标题，`conversation.controller.ts:143`）。 |
| M-53 | `apps/web/src/components/chat/ChatScreen.tsx:158-173, 319-332` | 「加载更早的会话」① `if (!res.ok) return;` 静默失败，按钮可无限点击；② `app-admin-data-updated` 处理器用 `appStore.CONVERSATIONS_META`（仅由首次 30 条 bootstrap 填充，`useAdminBootstrap.ts:246-254`）覆盖 `convCursor` ⇒ **任何管理操作之后侧边栏永久卡在 30 条**（下一次重复拉取第 2 页，去重把行全丢掉）。 |
| M-55 | `.github/workflows/ci.yml:152-157` | 名为「Threshold source of truth is sourced by both gates」的检查**只断言非空**，且所在 job 并不携带 `quality-gate.yml` 的 env 块 ⇒ **阈值分歧持续存在时它依然通过**。检查名断言的属性它没有测。 |
| M-56 | `tests/evaluation/quality-gate.ts:65-71` | 第三份更弱的阈值副本硬编码在代码里（0.80/0.75/0.90），低于 `gate-thresholds.sh`（0.90/0.85/0.95）。`gate-thresholds.sh` 只被 `ci-gate.sh:21` source ⇒ 任何新入口静默降级，且 `THRESHOLDS` 被原样写进 JSON 报告（`:563`）**使降级不可见**。 |
| M-57 | `scripts/feedback-gate.sh:76-93`、`scripts/ab-gate.sh:35-52` | 两个侧门禁在默认模式下崩溃也 `exit 0`（`STRICT="${GATE_STRICT:-0}"`，而没有任何 workflow 设置它）⇒ 无 registry 访问时 `npx --yes tsx` 失败或 API 宕机，两者都只打印 WARNING 后返回 0，**按退出码无法与通过区分**。 |
| M-58 | `tests/evaluation/gate-thresholds.sh:26-30` | 两个已声明的发布阈值（`PROBE_TOLERANCE`、`GATE_NO_ANSWER_HALLUCINATION_MAX`）**只被 `sota-gate.sh` / `sota_gate_results.py` 消费**，而 `sota-gate.sh` **没有被任何脚本或 workflow 调用** ⇒ 「无答案幻觉率上限」（注释称该类问题曾两次静默复发）在 CI 与发布中完全未强制，可设为 `1.0` 而无任何可观测效果。 |
| M-59 | `tests/evaluation/intl-benchmark/../../20260922200000_rls_tenant_isolation/verify.sql:89-102` | 第 5 步用 `PERFORM count(*)` **丢弃结果** ⇒ 即便 `app.service=on` 被拒绝全部行（正是本仓库踩过的 deny-all 回归），仍打印 `PASS`；且文件头要求「以 superuser 或表属主运行」，该角色**永远** `rolbypassrls` ⇒ 按文档推荐的调用方式，第 4、5 步双双走 `SKIP` 分支，**两个 fail-closed 断言都被跳过且脚本退出 0**。 |
| M-60 | `20260927100000_kb_write_rls_guard/security-test.sql:3` | 全文**未设置 `\set ON_ERROR_STOP on`**（`:20260922200000/verify.sql:6`、`:20261003000000/verify.sql:10` 都设了）。psql 默认关闭 ⇒ 中途报错打到 stderr 而**退出 0**，其后所有断言（包括「Reader forged another personal owner」）全部空转。 |

### parser-worker 资源与异步

| ID | 位置 | 缺陷 |
|---|---|---|
| M-61 | `apps/parser-worker/src/main.py:75-77, 111, 1945-1956` | `MAX_INFLIGHT_TASKS` 默认等于 `MAX_TASKS`（=5000），且 `docker-compose.prod.yml` 与 `deploy/production.env.example` 都未设它。闸门是 `len(tasks) >= MAX_TASKS`（**条目计数而非字节**），且在 `path.open("wb")` **之前**检查。**无字节预算、无磁盘余量检查、传输期间不持限流器** ⇒ 5000 个并发 200 MiB 上传（≈1 TB）可同时在途。 |
| M-62 | `apps/parser-worker/src/main.py:1064-1066` | 供应商返回的 `markdown_url` **无任何校验**就被 `client.get` + `.text`（无大小上限、超时 900 秒）⇒ SSRF（可打 `http://` 内网 / `169.254.169.254`）与 OOM。 |
| M-63 | `apps/parser-worker/src/main.py:1048-1057` | OCR 轮询循环对 429/5xx **无重试退避** ⇒ 在 M-32 的无界并发导致的限流下，单次 429 即让已付费的 900 秒作业中断。 |
| M-64 | `apps/parser-worker/src/main.py:2039`、`1708-1709`、`1852-1855` | 事件循环内的阻塞文件 I/O 与 CPU：50 MB `fh.write(chunk)` 同步写、`extract_plaintext` 对 200 MiB 做 utf-8→gbk→gb18030 级联解码 + `re.sub`/`split` 全同步、`normalize_markdown` 再造多份全尺寸副本（约 5 份 ≈ 1 GB 瞬时）。全部阻塞其它租户的轮询、health、metrics 数秒到数分钟。 |
| M-65 | `apps/parser-worker/src/main.py:1248, 1251, 1283, 1289, 1296` | 嵌入图 OCR 是 O(N × len(markdown)) 的字符串重建（循环体内 5 处 `replace`，每次分配完整副本）⇒ 200 页 2000 图的 PPTX 要重写多 MB 字符串 2000 次，且全部在事件循环内。 |
| M-66 | `apps/parser-worker/src/extractors/vlm_extractor.py:166-171` | 200 dpi 硬编码渲染**无像素上限**，仅受 PDF `/MediaBox` 约束。A0 图纸（33×47 in）⇒ 6622×9330 px ≈ 62 M 像素 ≈ 185 MB pixmap + 磁盘 PNG，**每个图片占位符一次**（`:316-343`），全在事件循环内。 |
| M-67 | `apps/parser-worker/src/main.py:2001-2005` | `await background()` 未包 try（已核对 `starlette.background.BackgroundTasks.__call__` **不吞异常**）⇒ 任一 handler 失败（如 `:1687` 的 `path.unlink` 抛 `OSError`）⇒ 500，`finally` 仍 pop 掉任务，`ingestion.service.ts:444` 报 `Parser execution failed: 500` 且**无 markdown —— 尽管解析已成功**。 |
| M-68 | `apps/parser-worker/src/main.py:957-960` + `docling_job.py:19` | Docling 产物大小在**无上限写入之后**才检查。`run_process` 只限制墙钟时间，子进程可在 240 秒内写满卷。 |
| M-69 | `apps/parser-worker/src/main.py:1496-1500` + `quality.py:58-63` | PPTX 的 OCR 平均置信度用 `position`（**全部**幻灯片的**全部**图片数）做分母，但只有返回了置信度的图片进入分子 ⇒ 10 页幻灯片仅第 1 页有文字时，报告值被稀释 9/10，`quality_score` 随之被钳到错误值 ⇒ **污染发布闸门**。 |
| M-70 | `apps/parser-worker/src/main.py:128, 2060`、`artifact_cache.py:12-13` | `int(os.environ.get(...))` 无守卫（`MAX_TASKS` 至少用了 `max(1, int(...))`）⇒ 拼错或空值（`PARSER_CONCURRENCY=`、值带尾空格）在**模块导入期**抛 `ValueError`，worker 带 traceback 启动失败而非用默认值启动。`deploy/provision-instance.sh:81` 只校验 `PARSER_AUTH_TOKEN` 非空。 |
| M-71 | `apps/parser-worker/src/main.py:224, 235, 238-252` + `infra/nginx/nginx.conf:74-91` | `AUTH_TOKEN` 未设时回退信任 `_DOCKER_INTERNAL_NETWORK = ipaddress.ip_network("172.16.0.0/12")`（1048574 个地址），而 `/12` 恰好是**阿里云默认 VPC CIDR**（按 AGENTS.md 即生产主机 `meetings2`）⇒ **同 VPC 任何其他 VM 无需 token 即可访问全部端点**。`nginx.conf:74-91` 又把 `location = /parse` 与 `/parse/` 从公网 vhost 反代到 `127.0.0.1:8100` ⇒ `AUTH_TOKEN` 为空时「仅回环」的兜底**互联网可达**：任何人可经 nginx POST 200 MiB 文档烧掉 docling/OCR 配额。 |
| M-72 | `apps/parser-worker/src/main.py:285-286` | `/metrics` **无鉴权依赖**（其余端点都有 `_auth: None = Depends(verify_auth)`）⇒ 任何调用方可读取实时任务数、引擎名与每文件分类分布，是有用的 DoS 侦察素材。 |
| M-73 | `apps/parser-worker/src/artifact_cache.py:15-17` + `main.py:1088` | artifact cache key 的 `contract` 含 provider/endpoint/revision 但**不含 API Key** ⇒ 租户轮换百度凭据后仍持续返回用已退役密钥产出的结果（叠加 M-71 的身份塌缩，还会跨租户）。 |
| M-74 | `apps/parser-worker/src/maxsim_job.py:18-20` + `main.py:2068, 2071, 2080` | `np.asarray(row['vectors'], dtype=np.float32)` 在**形状校验之前**对任意形状的嵌套 list 做完整转换 + `isfinite` 遍历（20 MiB 载荷）。父进程还把同一份 20 MiB JSON 解析两次并同时持有 `bytearray` 与 `bytes` 副本。 |
| M-75 | `apps/parser-worker/src/controlled_jobs.py:57` | `FairLimiter.running` 归零时**不删除 key**；该 dict 被 `/resource-metrics`（`main.py:2106`）原样输出 ⇒ 随见过的每个租户身份无界增长。 |
| M-76 | `apps/parser-worker/src/controlled_jobs.py:69-82` | 取消场景下 `finally` 里 `await asyncio.wait_for(process.wait(), 2)` 可被立即重新取消 ⇒ `:79` 的 `SIGKILL` 升级**永不执行**，无响应的 docling/numpy 子进程带着完整进程组存活。 |
| M-77 | `apps/parser-worker/src/main.py:469-475` | `subprocess.run(..., capture_output=True, timeout=120)` 输出**无上限**；且其超时只 `Popen.kill()` 直接子进程（无 `killpg`），与 `run_process` 的做法不一致。 |

### gbrain-adapter 其余

| ID | 位置 | 缺陷 |
|---|---|---|
| M-78 | `packages/gbrain-adapter/src/index.ts:843-844` | `runGitOutput` **无输出上限**（`executeProcess` 在 `:498-541` 限 8 MB）⇒ 恶意 git hook 或超大输出可在 API 进程内无界累积。 |
| M-79 | `packages/gbrain-adapter/src/index.ts:686-687` | `assertEmbeddingPlane` 只校验 `content_chunks.embedding` 一列（匹配 `Column:\s+content_chunks\.embedding`），而迁移 `20260910100000_add_raptor_nodes`、`20260912120000_add_summary_node_embeddings` 还有更多向量列 ⇒ 只重迁移 `content_chunks` 的模型/维度变更能通过检查，**图谱/摘要向量留在旧平面**，产出静默错误的检索而非报错。 |
| M-80 | `packages/gbrain-adapter/src/index.ts:1555` vs `:1560, 1564` | `reranked: results.every(r => r.reranked)` 在零 source 时为 `true`（`[].every()` 恒真），而相邻的 metrics 指标都正确地加了 `results.length > 0 &&` ⇒ 摘要自相矛盾。 |
| M-81 | `packages/gbrain-adapter/src/index.ts:1266-1271, 1464-1467` | `queryCache` ①返回**浅拷贝**，命中时 `citations` 是**共享数组**；②淘汰是 FIFO 且每次只删一个，重复 `set` 同一 key **不会**把它移到 Map 尾部 ⇒ **热 key 反而最先被淘汰**，冷 key 存活。 |

### 数据库迁移

| ID | 位置 | 缺陷 |
|---|---|---|
| M-82 | `packages/database/prisma/migrations/20260926140000_document_upload_dedupe_index/migration.sql:1` | 全文件只有一行裸 `CREATE INDEX "Document_kbId_contentHash_idx" …`，**无 `IF NOT EXISTS`**，与本仓库自身约定不符（`20260922200000/migration.sql:13-14` 用了 `IF NOT EXISTS`）⇒ 重跑即 abort（`scripts/heal-rls-no-policy-tables.sh:27` 就会为其兄弟迁移这么干）。 |
| M-83 | `packages/database/prisma/migrations/20260926160000_rls_global_identity_runtime_access/` 与 `20260926160000_rls_disable_no_policy_tables/` | **两个迁移共用同一个 14 位版本前缀**。Prisma 按字典序恰好确定，但任何以 14 位前缀为键的工具（`prisma migrate status`、`migrate resolve`、`scripts/release-gate-fingerprint.py`、临时运维 SQL）都无法区分二者。 |
| M-84 | `20261003000000_force_rls_core_tenant_tables/verify.sql:59` | 存在性探测**未过滤 schema**（缺 `pg_namespace` 条件），而 8 行之前的同类检查（`:64-65`）是正确过滤的 ⇒ 任何其它 schema 里的同名表都能满足存在性测试，让「该表确实缺失」的情况被报成 `SKIP`，检查静默失效。 |
| M-87 | `apps/api/src/admin.controller.ts:2362-2377` | `updateKbAdmins` 未过滤 UUID 元素（兄弟处理器 `:1671-1680` 有明确注释说明为什么必须过滤）⇒ `["not-a-uuid"]` 让 Prisma 抛错 → 500。重复 id 能通过 `new Set(userIds).size` 比较，随后撞 `@@id([kbId,userId])` 复合主键（`createMany` 无 `skipDuplicates`）→ 500（事务已回滚故无数据损失，但应是 400）。 |

---

## P3 LOW（17 项）

| ID | 位置 | 缺陷 |
|---|---|---|
| L-01 | `apps/api/src/open-api/open-api.controller.ts:538-578` | 压缩包上传路径**跳过了扩展名白名单**（该门禁只在非压缩分支 `:582`）⇒ 上传 `.zip` 会为**每个条目**写入 `raw<任意扩展名>` 文件且无类型过滤。（已确认 `path.extname` 不返回路径分隔符，故**非**路径穿越。） |
| L-02 | `apps/api/src/open-api/open-api.controller.ts:623-627` | 文档存在性预言机：`findUnique` 在可见性检查**之前**执行，`404 文档不存在` vs `403 无权访问该文档状态` 可区分存在的外部文档 ID。 |
| L-03 | `apps/api/src/open-api/open-api.controller.ts:359-374, 421-428` | `conversation.create` → `message.create` → （完成时）第二次 `message.create` 各自独立隐式事务 ⇒ 中途崩溃留下空会话或孤立助手回复。 |
| L-04 | `apps/api/src/auth/mfa.controller.ts:25` | `mfaToken` 允许从 **query string** 读取（`req.query?.mfaToken`）⇒ 5 分钟有效的二因子票据进入 URL 与访问日志。 |
| L-05 | `apps/api/src/main.ts:86-87` + `open-api.controller.ts:507` | `express.json({ limit: '250mb' })` 与 `urlencoded({ limit: '250mb' })`，叠加 200 MB 文件上限 ⇒ 少量并发 250 MB JSON body 即可耗尽堆。文件上传路径另有独立限额。 |
| L-06 | `apps/api/src/auth/oidc.service.ts:272-278` | 上游 IdP 的错误体被**原样记入日志**（某些 IdP 会返回 `access_token`/`id_token`）并把 `error_description` 返回给调用者；部分 IdP 会在错误描述里回显提交的 `code`/`client_id`。 |
| L-07 | `apps/api/src/open-api/open-api.controller.ts:409-414` | 流式路径把 `err.message` 原样下发给 OpenAPI 客户端（可能含上游 provider 文本、连接串、内部 KB/表标识），而非流式之外的 `:468`（正确返回固定文案）。 |
| L-08 | `apps/api/src/chat/retrieval-arms.ts`（缓存命中路径） | 见 M-04 的次生问题：缓存 key 缺 epoch。当前每个调用方都重跑过滤，故暂未暴露。 |
| L-09 | `apps/api/src/ingestion/ingestion.controller.ts:84` + `mcp.service.ts:31` + `connector.service.ts:41` + `object-storage.service.ts:42` + `admin.controller.ts:1116` | 5 处 `UPLOAD_ROOT` 回退路径各不相同（详见 H-11，这是根因）。 |
| L-10 | `apps/web/src/components/preview/PptDeckViewer.tsx:479, 486-489` | 全局键盘处理只排除 `INPUT`/`TEXTAREA`/`SELECT` ⇒ 焦点在工具栏按钮上时按 Space **既翻页又 `preventDefault()` 掉按钮激活**，该控件无法用键盘操作；方向键同理。 |
| L-11 | `apps/web/src/components/common/Modal.tsx:12-17` | `useEffect(..., [])` 把首个 `onClose` 永久冻结。多数调用点传裸 state setter 恰好能用，但 `UniversalDocumentViewer` 的用法及任何闭包型 handler 会调用陈旧回调。 |
| L-12 | `apps/web/src/components/chat/ChatScreen.tsx:599-607` | 会话「隐藏」的 undo 闭包捕获了 dispatch 时的 `hiddenConvs` ⇒ 5 秒内隐藏两个会话再撤销第一个，会把第二次隐藏也一并回滚。 |
| L-13 | `apps/web/src/proxy.ts:14-18` | 鉴权分支是**空块**（`if (!token && !isLoginPage) { /* soft guard */ }`）。**不是鉴权绕过**（真正的门禁在 Nest `AuthGuard` 与 `AppShell.tsx:159-194`），但它读起来像一个守卫却什么都不做，且引用了并不存在的 `/login` 路由；未来有人「修好」这个空块反而会弄坏以 URL fragment 到达的 SSO。 |
| L-14 | `apps/web/src/lib/api.ts:5-8` + `AppShell.tsx:68, 361` | Bearer token 存 `localStorage`。**目前无可达 XSS sink**（`lib/markdown.ts:33-60` 双重 DOMPurify 且只改写文本节点；`AnswerMarkdown` 全程走 React + `safeLink` 白名单 + `rel="noopener noreferrer"`），属潜在风险；同一 token 也被 `proxy.ts:5` 从 cookie 接受，改用 httpOnly cookie 可零成本获得纵深防御。 |
| L-15 | `packages/gbrain-adapter/src/index.ts:1049, 1097` | 同 M-10/M-29 族的低危分支。 |
| L-16 | `apps/api/src/chat/agentic-rag.service.ts:338-341, 272, 377` | Redis 命中路径（`:272`）与 `planCache.set`（`:377`）**绕过** `:338-341` 的 500 条淘汰上限（该上限只在非 Redis 路径）。 |
| L-17 | `apps/api/src/retrieval/table-aggregation.ts` / `open-api.controller.ts` 归档上传 | `SUPPORTED_UPLOAD_EXTENSIONS` 在 MCP 路径（`mcp.service.ts:296-299, 359`）**只检查扩展名存在、不检查白名单**（Web 上传路径 `ingestion.controller.ts:219` 有白名单）⇒ `POST /mcp/upload` 可持久化 `payload.sh` 并交给按扩展名分派的 parser worker。 |

---

## 缺陷分布统计

### 按子系统

| 子系统 | CRITICAL | HIGH | MEDIUM | LOW | 小计 |
|---|---|---|---|---|---|
| `apps/api` — 鉴权 / 密钥 / RLS | 1 | 8 | 4 | 4 | 17 |
| `apps/api` — 会话 / 摄取 / 连接器 / 生命周期 | 0 | 11 | 11 | 5 | 27 |
| `apps/api` — 检索 / 答案管线 | 0 | 7 | 4 | 2 | 13 |
| `apps/web` | 0 | 0 | 14 | 5 | 19 |
| `apps/parser-worker` | 1 | 1 | 24 | 0 | 26 |
| `packages/gbrain-adapter` | 1 | 0 | 13 | 1 | 15 |
| `packages/database`（schema + 迁移） | 1 | 0 | 10 | 0 | 11 |
| `scripts/` + `.github/`（发布门禁） | 1 | 0 | 4 | 0 | 5 |
| **合计** | **5** | **27** | **84** | **17** | **133** |

### 按缺陷类别

| 类别 | 数量（可重叠） | 代表 ID |
|---|---|---|
| 鉴权绕过 / 越权 | 5 | C-01, H-03, H-16, M-37, L-04 |
| 跨租户数据泄露 | 4 | C-02, C-04, H-07, H-08 |
| 跨租户授权不可撤销 | 3 | H-12, H-15, H-18 |
| 静默错误答案 / 引用错乱 | 4 | H-19, M-01, M-02, M-41 |
| 授权撤销后仍可见内容 | 2 | H-10, H-23 |
| DoS / 资源耗尽 | 7 | H-21, H-22, H-25, H-26, H-27, M-61, M-32 |
| 进程崩溃 / 未处理 rejection | 3 | H-24, M-03, M-67 |
| 发布门禁失效（假绿） | 7 | C-05, M-23, M-55, M-56, M-57, M-58 |
| `NaN` 静默降级 | 5 | M-05, M-07, M-08, M-09, M-06 |
| 环境变量未守卫 | 4 | H-20（同族）, M-07, M-09, M-70 |
| 缺少唯一约束 | 3 | H-15, H-18, M-26 |
| RLS 缺口 | 3 | C-04, M-24, M-25 |
| TOCTOU / 缺事务 | 5 | H-12, H-14, M-14, M-15, M-18 |
| 前端竞态 / 静默失败 | 9 | M-40…M-47, M-51…M-53 |
| 测试脚本自身失效 | 3 | M-59, M-60, M-58 |

### 按「违反仓库自身声明的守则」

| 守则（AGENTS.md） | 违反情况 | ID |
|---|---|---|
| §1 发布管控（严禁直接发生产、必须有明确指令） | 默认门禁本身失效，使「已充分测试」这一前提不成立 | **C-05**, M-55…M-58, M-23 |
| §2 拒绝业务硬编码 | 本次走查未发现检索/语义对齐层的业务专用同义词表或正则加权分支；`corpus-agnostic-config.ts` 是正确的 env 化做法。**该项无违规。** | — |
| §3 多实例隔离 | 5 处 `UPLOAD_ROOT` 默认值不一致（MCP 与删除路径错配）；webhook 连接器是进程内单例，多实例下跨实例不可见 | H-11, M-17, L-09 |

---

## 修复优先级建议

### 第 1 批（建议立即，阻断性安全/正确性问题）

| ID | 一句话理由 |
|---|---|
| **C-01** | 一行删除即可关闭的越权；当前任何登录用户可跨租户触发 LLM 费用消耗。 |
| **C-02** | 一行改动（改关键字传参）修复 OCR 全链路 + 跨租户缓存串号 + 跨租户限流塌缩三重生产事故。 |
| **C-04** | 需要一次 schema/策略设计与迁移，但影响面最大（密钥 + 跨租户合成知识）。 |
| **H-07 / H-08** | 纯数据泄露，修复方式是接上已有的 `filterReadableDocuments`（同文件 `getDocument` 就是范例）。 |
| **H-15 / H-18** | 加 `@@unique` + 把预检查移进事务；`revokeAccess` 的 `subjectType` 过滤（M-19）一并修。 |
| **H-12** | outbox 事件永久静默丢弃 ⇒ 权限撤销与文档删除永不生效，属于合规风险。 |
| **C-03** | 改一个 spread 表达式。 |
| **C-05** | 改默认 `GATE_PROFILE`；这是**所有其它修复能否真正上线的保障**。 |

### 第 2 批（正确性与稳定性）

- **答案正确性**：H-19（索引空间混淆）、H-23（撤权后仍可见）、M-01、M-02、M-41。
- **进程稳定性**：H-24（严格输出溢出崩溃）、M-03（取消传播失效）、M-67（解析成功却报 500）。
- **生命周期完整性**：H-10（陈旧图谱实体）、H-13、H-14、H-17。
- **资源**：H-21、H-22、H-25、H-26、H-27、M-61。

### 第 3 批（工程健壮性与门禁守护）

- `NaN` 静默降级一族：M-05…M-09、M-70（建议统一引入 `_env_int`/`Number.isFinite` 辅助函数）。
- RLS 守护：M-23…M-25（把 `verify.sql` 接进 `deploy-prod.sh`，并让 `rls-inspect.sh` 在 `enabled_not_forced > 0` 时非零退出）。
- 测试脚本自失效：M-58…M-60。
- 前端竞态与静默失败：M-40…M-53（尤其 M-42 静默失败的破坏性操作、M-43 串消息状态）。
- 其余 LOW。

### 建议补充的回归测试

以下缺陷目前**没有任何测试能捕获**，修复时应同步补测试：

| 缺陷 | 需要的测试层次 |
|---|---|
| C-01 | 集成：`POST /admin/enrichment/backfill?x=/admin/kbs` 对普通用户必须 403 |
| C-02 | 集成：`/parse-execute` 必须把 6 个 OCR/instance 字段原样送达（当前被 mock 掩盖） |
| H-19 | 单元：bridge-rescue 在分数序≠池序时 `isRelevant` 必须作用于目标引用 |
| H-21/H-22 | 单元：缓存超过上限后必须淘汰（现有测试只测缓存命中，不测容量） |
| H-24 | 单元：严格输出超 8 MB 时必须走显式失败路径而非抛出未处理 rejection |
| H-12 | 集成：`processing` 状态崩溃后必须被回收 |
| M-02 | 属性测试：任意（含 NaN/字符串）score 输入下排序必须确定性 |
| M-05…M-09, M-70 | 单元：所有 env 数值读取必须对非法值回落默认值（建议参数化测试覆盖每个开关） |
| M-23 | 门禁：`deploy-prod.sh` 必须在 `migrate deploy` 后执行 `verify.sql` |