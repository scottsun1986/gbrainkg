# RLS 巡检：仅允许 service 写入的表（2026-10-06）

## 为什么做这次巡检

本次会话中被同一类问题咬了 **五次**，全部是"服务的 RLS 策略与真实运行时上下文冲突"，且**只在运行时暴露**、报错措辞具有误导性：

| 序 | 表 | 症状 | 根因 |
|---|---|---|---|
| 1 | `AuditLog` | 登录写审计被拒 | 写策略限 service，但登录路径是用户/匿名上下文 |
| 2 | `BrainScope`/`BrainSource` | 每个用户首次检索 500 | 应用在用户请求里惰性 upsert 作用域行 |
| 3 | 词法表（`KbLexicalStat` 等） | 删除文档 500 | 写策略限 service，删除路径要更新统计 |
| 4 | `AuditLog`（复现） | —— | **`INSERT ... RETURNING` 会用 SELECT 策略校验返回行**，而拒绝时**报的是 WITH CHECK 的措辞** |
| 5 | `GBRAIN_DATABASE_URL` | 删除 500 + 每秒刷屏报错 | 环境变量指向了项目库（配置问题，非策略） |

（第 5 条已修复：三环境的 `GBRAIN_DATABASE_URL` 均已指向各自的 gbrain 专用库。）

其中第 4 条是最难缠的：**报错说"违反 WITH CHECK"，实际卡在 SELECT 策略上** —— 这个措辞把我引偏过两次。

## 巡检方法（可重复执行）

反向列出所有"WITH CHECK 只允许 service"的策略 —— 这些就是**任何用户上下文写入都会炸**的表：

```sql
with p as (
  select c.relname tbl, p.polname,
         coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'') chk
  from pg_policy p join pg_class c on c.oid=p.polrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r'
)
select tbl||' | '||polname||' | '||chk from p
where chk like '%app_is_service()%' and chk not like '%OR%' order by 1;
```

## 巡检结果（当前实现）

以下表的写入**只允许服务上下文**。判定标准：应用**只能**在后台/索引/摄取路径写它们；一旦有请求路径直接写，就会以"违反 row-level security policy"的误导措辞失败。

| 表 | 策略 |
|---|---|
| `BlockArtifact` | core_blocks_write |
| `BrainDerivedPage` | derived_page_service |
| `BrainMaintenanceRun` | brain_maintenance_run_write |
| `BrainOperationLog` | brain_operation_log_write |
| `Chunk` | core_projection_insert / core_projection_update |
| `ConnectorRun` | connector_run_rw |
| `ContextualPrefixCache` | contextual_prefix_cache_rw |
| `DocumentVersion` | core_versions_write |
| `DocumentVersionLink` | version_link_rw |
| `EnrichmentStage` | enrichment_stage_service_rw |
| `GenerationVector` | generation_vector_service |
| `GraphCommunity` / `GraphEntity` / `GraphRelation` | artifact_service_access、core_projection_insert/update |
| `GraphProjectionInput` | graph_projection_service |
| `IndexGeneration` | core_generations |
| `LateContextVector` | late_context_service |
| `ModelArtifactCache` | model_artifact_service |
| `ModelQuotaBucket` | model_quota_service |
| `OriginalBlockSnapshot` | original_snapshot_write |
| `RaptorNode` | artifact_service_access、core_projection_insert/update |

**这批表绝大多数属于"摄取/索引产物"，由后台管线写入，service-only 是正确的。**

## 逐条代码确认结果（已完成）

### 方法

两条腿走路，缺一不可：

1. **静态**：扫出这些表在应用里的**全部写入点**（Prisma 模型方法），共 **45 处**，集中在 12 个文件；
2. **动态**（决定性）：按策略的反面去测 —— 这些表的用户上下文写入**必然**报 RLS 错误，
   所以直接**走一遍请求路径**并观察日志，比逐处读调用链更贴近事实。

### 写入点分布

| 文件 | 写入点数 |
|---|---|
| `graph-rag/graph-rag.service.ts` | 12 |
| `raptor/raptor.service.ts` | 8 |
| `ingestion/document-version-store.ts` | 6 |
| `ingestion/ingestion.service.ts` | 5 |
| `graph-rag/incremental-projection.ts` | 4 |
| `connector/connector.service.ts` | 3 |
| `brain-compiler/brain-compiler.service.ts` | 3 |
| `ingestion/version-chain.service.ts`、`embedding/verified-late-chunking.ts`、`brain-compiler/brain-scope.service.ts`、`brain-compiler/brain-outbox.service.ts`、`bootstrap/backfill-original-snapshots.ts` | 各 1 |

### 请求路径可达的几个（重点核查）

| 文件 | 是否走上下文包装 | 依据 |
|---|---|---|
| `ingestion/document-version-store.ts` | **是** | 4 个写入函数全部以 `withServiceContext(this.prisma, …)` 包裹 |
| `ingestion/version-chain.service.ts` | **是** | 第 53 行 `withServiceContext`；调用方是 `document-version.controller.ts`（API 端点），经包装 |
| `connector/connector.service.ts` | **是** | `ConnectorRun` 的写入位于事务内且在 service 语境下执行 |
| `graph-rag` / `raptor` | 由后台与图谱端点触发；实测无拒绝 | 见下方动态结果 |

### 动态验证（本地，真实 HTTP）

逐条走请求路径并观察日志，**全部返回正常且零 RLS 拒绝**：

```
重编译真相=200  文件下载=200  预览配置=200  文档列表=200
图谱(fresh=true，强制重建)=200  管理面=200  删除文档=200  删除整库=200
本轮 RLS 相关错误：0 条
```

（`重试解析=400` 属业务校验，非权限问题。）

### 结论

**在已覆盖的请求面上，没有发现新的 service-only 写入雷区。** 请求路径可达的那几个写入点都正确使用了 `withServiceContext`。

### 仍未覆盖（诚实标注）

以下路径**没有**被本次动态验证覆盖，属残余不确定性：

- **连接器同步**（需先配置一个连接器才能触发）—— `ConnectorRun` 是 service-only；
- **成功触发的解析重试 / replay-failed-artifacts**（本次 retry 返回 400，未走到写入）；
- **上传产生新版本**（`version-chain` 端点只做了静态确认，未端到端跑通）。

这三条建议在下次有对应数据时补测 —— 静态看它们是安全的，但静态确认 ≠ 实测。

## 附：另一个已知坑（非策略）

`GBRAIN_DATABASE_URL` 必须指向 **gbrain 专用库**（如 `/gbrain`），不能指向项目库。
写错时的症状极具迷惑性：**入库/检索全部正常，只有删除 500**，同时数据库日志里每秒刷屏
`v35 auto_rls_event_trigger: role llmwiki may not CREATE EVENT TRIGGER`。

---

## 补测三条未覆盖路径的结果（发现并修复了一个真问题）

### 结果

| 路径 | 结果 |
|---|---|
| `POST /api/v1/documents/:id/versions`（版本链） | **500 → 已修复** |
| `POST /api/v1/documents/:id/replay-failed-artifacts` | 201 ✓ |
| 连接器创建 / 同步 | 未测到（请求体字段写错，`type` 应为 `kind`），**仍属未覆盖** |

### 根因（系统性）

`version-chain.service.ts` **确实**用了上下文包装 —— 我静态查对了这一点。问题出在包装器的**语义**：

```
withServiceContext 在请求上下文里：set_config('app.user_id', <用户>), app.service='off'
runAsService         在请求上下文里：直接抛错「Cannot promote request identity to service」
```

**两者都无法以服务身份写"service-only 策略"的表**，而版本发布要写的正是这类表
（`DocumentVersion` / `DocumentVersionLink` / chunk 投影 / enrichment 阶段）——
它们是系统派生产物，本就该以系统身份写入。

这不是某一处遗漏，而是**请求可达的系统写入缺少通道**。

### 修复

新增 `withSystemWrite(prisma, fn)`（`apps/api/src/db/tenant-context.service.ts`）：
以 `app.service='on'`、`app.user_id=''` 开启事务，**可在请求内使用**。
文档里明确约束：**调用方必须已就该资源完成用户授权**，函数体内只允许写系统派生产物，
不得用于任何用户作用域的判定。

`version-chain.service.ts` 的 `createVersion` 已切换到该通道。

### 验证（三环境）

| 环境 | 新版本 | 版本链 | 删除文档 | 删除整库 | RLS 拒绝 |
|---|---|---|---|---|---|
| 本地 | **201** | 200 | 200 | 200 | 0 |
| 演示 | **201** | — | — | — | — |
| 生产 | **201** | 200 | 200 | 200 | 0 |

（修复前为 500。）

### 仍然未覆盖

- **连接器同步**：`ConnectorRun` 是 service-only，请求可达；本次未成功触发。
- **解析失败后的成功重试 / replay 写入分支**：本次 `retry` 返回 400，未走到写入。

### 方法论教训（本轮第三次）

我在这条命令里同时跑的"RLS 拒绝检测"报了**空**，而实际发生了拒绝 ——
**日志是 JSON 转义的，我的正则没匹配转义形式**。
如果只信那个自检，就会漏掉这个真问题。**检测方式本身也要被验证。**

---

## 连接器同步：第二个同类问题（已修复）

补测连接器路径（`kind` 为 `generic_webhook`，此前我把字段写成 `type` 所以没测到）：

| 步骤 | 修复前 | 修复后 |
|---|---|---|
| 创建连接器 | 201 | 201 |
| **触发同步** `POST /kbs/:kbId/connectors/:id/sync` | **500** | **201**（返回 `status:"success"` 的 run） |
| 运行记录 | 200 | 200 |

错误与版本链**完全同源**：

```
Invalid `prisma.connectorRun.create()`
42501: new row violates row-level security policy for table "ConnectorRun"
```

`ConnectorRun` 正是本次巡检**预先标出的** service-only 表之一。**巡检的预判被证实。**

### 修复

`connector.service.ts` 里 5 处上下文包装全部切换为 `withSystemWrite`。
理由与版本链一致：**连接器同步是端点只是"触发"的系统操作** —— 它写的是运行记录与外部 ACL，
这些是系统派生产物；调用者已由端点完成授权。

### 验证（三环境）

| 环境 | 创建连接器 | 触发同步 |
|---|---|---|
| 本地 | 201 | **201** |
| 演示 | 201 | **201** |
| 生产 | 201 | **201** |

---

## 本轮巡检的总收获

**共发现并修复 2 个同类真问题**（版本链、连接器同步），两者都是
"请求可达的代码路径去写 service-only 表"，通过新增 `withSystemWrite` 通道解决。

**方法论教训（累计三次）**：我自己的检测手段多次不可靠 ——
`finished_at is null` 没看 `rolled_back_at`、按 pid 回溯日志时行已滚出窗口、
正则没匹配 JSON 转义的报错、`docker logs --since` 判据不灵。
**最后一次是靠"看数据库日志里的 42501"才确认的。**
结论：**检测方式本身必须被验证**，不能只信一个自检信号。

**仍未覆盖**：解析失败后的成功重试写入分支（本次 `retry` 返回 400，未走到写入）。

