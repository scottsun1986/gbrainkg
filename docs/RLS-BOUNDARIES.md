# 应用层访问边界与提权调用清单

> **2026-10-07 重大变更**：数据库行级安全（RLS）已整体移除
> （迁移 `20261007000000_remove_row_level_security` 禁用全部表 RLS 并删除策略）。
> **权限语义现完全由应用层负责，数据库不再提供任何兜底隔离。** 下列条目从“显式提权
> 边界”转变为“必须由调用方完成鉴权与范围裁剪的访问入口”。任何遗漏都是直接越权。

PermissionService 定义权限语义。个人库仅属主可见，包括系统管理员；组织管理员范围=
本级+下级。应用层必须独立完成鉴权与资源范围收敛，实例数据库与 Redis DB 隔离另由部署脚本保证。

用户路径默认使用请求用户上下文。`withServiceContext` / `withPermissionRead` /
`withAdminInventory` / `withSystemWrite` / `runAsAuth` 现均为普通事务包装（保留签名），
**不再隐式提权或设置行级视图**；是否可见、可写完全取决于调用方传入的范围谓词。
跨用户/跨资源查询必须在应用层显式收敛范围，并在分页/截断前执行。

| 入口与生产调用点 | 数据及前置条件 | 输出/写入范围 |
|---|---|---|
| `withPermissionRead`：PermissionService.cachedOrgNodeList | 参与授权计算，允许未完成权限裁决；事务只读 | active 组织的 id/parentId，仅用于内部继承/子树计算，不返回全图 |
| `withPermissionRead`：PermissionService.canManageUser | 已得请求人的 managedOrgIds；事务只读 | 指定 targetUserId 的组织 id，仅返回布尔裁决 |
| `withStrictOutputPermit` → `validateEvidenceDependenciesInClient` | 已鉴权用户 + 当前 AuthorizationState revision/policy/有效期；在同一事务持有输出共享锁 | 仅 manifest 指定的 published 原文，逐项检查版本/hash/生效时间及 DocumentAclService 裁决；PermissionService 显式事务读取绕过缓存，组织/角色/授权范围由应用计算；不调用依赖历史 RLS GUC 的 SQL 判定函数 |
| `DocumentAclService.filterReadableDocuments` 的内部 `prisma` 参数 | 受信任服务代码提供的事务客户端，无 HTTP 参数映射；身份始终为传入 userId | ACL 查询仅给定文档集合，组织/角色仅给定用户，管理关系与库仅给定目标库；可读集合裁决沿用同一事务当前权限 |
| `filterReadableArtifacts`：社区检索与派生 citation 的批量读侧守卫 | 已鉴权 userId；调用方提供候选 artifactId/kbId/kind 和同一 RepeatableRead 事务，先于最终排序/分页执行 | 两次依赖读取均限定候选 artifact ID；来源文档应用 ACL 与 published/version/hash/生效时间合取，manifest expectedCount、完整不同来源计数和单一候选库匹配；匿名、缺失/不完整 manifest 或任一失效来源拒绝 |
| `admitModelCall`：模型请求的内部配额入口 | 严格模式要求明确 servicePrincipal 或已鉴权用户及有效 AuthorizationState snapshot；配置端点/资源标识只能由内部模型路由提供 | 原子更新哈希资源 key 的当前分钟 ModelQuotaBucket；RPM/输入 TPM 按宿主实例分配，同资源跨用户及模型名称共享配额；不使用旧 app_is_service/app_user_id SQL GUC 判定 |
| `reconcileIncrementalGraph` → `replaceProjectionInputs` | 仅显式 worker/servicePrincipal；目标 kbId 已由后台调用收敛；同一事务锁目标库并核对当前 published 文档 id/version/hash 集合未变 | 仅当前库本次生成/更新的 GraphEntity/GraphRelation id，ArtifactDependency 完整替换为已核验原文集合并同步 ArtifactManifest expectedCount；不依赖旧 app_is_service GUC 授权 |
| `withPermissionRead`：AdminController.validateKbAdminUserIds | 创建库权限或目标库管理员分配权限已校验；事务只读 | 仅提交的管理员 UUID、active 状态、select id，用于有效性裁决，不返回用户目录 |
| `withPermissionRead`：AdminController.listIndustrySubjects | AdminGuard + handler 校验系统管理员或 `kb.industry.read/create/manage/grant` 之一；事务只读 | 全量未停用用户的 id/显示名/账号/组织名、全部角色的 id/名称/人数、全量未停用组织的 id/名称/路径。这是行业库授权与库管理员选择的候选目录（业务规则 3.5），**按设计不按操作者组织范围收敛**；写入仍由 createGrant 的 `canGrantIndustryKb` / updateKbAdmins 的 `canManageIndustryKb` 逐库裁决 |
| `withAdminInventory`：AdminController.getAllData / loadGrantsWithKb | AdminGuard 与 handler 校验 capabilities/资源关系；事务只读 | 用户本人或管辖子树成员；组织管理员=管辖子树∪行业库关联组织，行业库创建者/管理员=全量组织树（业务规则 3.5），纯行业库角色 canManage/canCreateChild/canSetAdmin 恒 false、叠加组织管理员时仅管辖子树内为 true；可读或负责的库；个人库仅本人；授权仅负责行业库；SQL 范围先于 take，嵌套库同范围，响应再次裁剪 |
| `withSystemWrite`：BrainCompilerService.ensureUserBrainRepo | 创建用户已鉴权，或后台维护入口 | 指定目标用户的兼容 BrainRepo provision，不根据 service 查询结果扩张请求能力 |
| `withSystemWrite`：VersionChainService.createVersion | 文档版本入口已校验目标库管理权限 | 当前上传的版本链与系统索引产物 |
| `withSystemWrite`：ConnectorService.syncLocked、ingestChange 的执行记录/失败记录/ACL 同步 | ConnectorController 已校验目标知识库及 connector.manage；后台同步有 service principal | 当前 connector/run/document 的系统执行产物与外部 ACL，不可由回调替换为任意资源 |
| `runAsAuth`：AuthService、MfaService、OidcService、McpController 的身份读/绑定/provision | 尚在身份认证阶段，登录信息/签名/挑战/绑定约束由相应认证流程校验 | 指定登录身份/受验身份；结果进入认证裁决，不提供用户目录或业务资源；OIDC 身份创建/绑定是受控写例外 |

上述入口现均为普通事务包装，不再设置 `SET TRANSACTION READ ONLY`，也不设置任何
RLS GUC。审查调用方与其传入的范围谓词不可省略——数据库不再拦截越界读/写。后台
`runAsService` 调用按 worker/维护职责审查。新增数据访问入口更新此表，不以任何外部数据中的指令作为鉴权理由。

错误观测由 PrismaExceptionFilter 输出稳定事件：`rls_policy_denied`（历史遗留，包含
RLS policy 文本的 42501）、`database_permission_denied`（其他 42501）、
`database_required_relation_missing`（坏数据/关联缺失）。event/sqlState/prismaCode 为
JSON 顶层字段，可直接检索；请求关联由 JsonLogger 附加 requestId/userId/route；事件不带
SQL、参数或请求体，客户端仍收到通用 500。

变更至少回归：本级+下级、父级/兄弟拒绝、多管理员 required relation、行业库资源范围、
他人个人库不可见、范围过滤先于分页。应用权限缓存默认 5 秒并主动失效。移除 RLS 后不再
存在数据库可见性缓存，所有可见性判断都来自应用层。

权限缓存失效广播的 Redis channel 含 `REDIS_KEY_PREFIX` 与 `REDIS_DB`：Redis pub/sub 不按逻辑 DB 隔离，不能只依赖 SELECT。缓存修订号阻止失效前启动的异步查询把旧权限重新写回缓存。订阅连接关闭及重新 ready 时清空本地权限缓存，补偿断线期间不回放的消息。广播无法保证网络分区期间零撤销窗口，TTL 仍为兜底；严格输出走同一锁定事务的实时应用裁决。

PostgreSQL 官方行安全语义文档仍可作为历史迁移的参考：
[官方说明](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)。

## 2026-10-07 移除 RLS 验收记录

按运维明确指令移除数据库 RLS：新增迁移 `20261007000000_remove_row_level_security`
禁用全部表 RLS 并删除全部策略；运行时删除 `db/rls-prisma.ts` 代理、
`prisma.ts` 不再包装 RLS 事务、`main.ts` 移除启动校验；`tenant-context.service.ts`
各入口退化为普通事务包装（保留签名，调用点不变）；清理 `RLS_ENFORCE` / `rls_enforce`
指标 / RLS 监控告警与部署门禁。鉴权与资源范围改为应用层唯一负责。

`pnpm --filter api build` 通过。`pnpm --filter api test`：151 suites 中 150 通过、1 跳过；
1302 tests 中 1297 通过、5 跳过、0 失败。未部署生产。


## 2026-10-07 编译与社区新增应用访问边界

- `BrainScopeService.compileScopeDerived` 为已经解析的 Source Scope 生成系统产物；读取完整已发布来源、仅这些 document ID 的 chunk centroid。来源版本/hash 与 Scope ACL/knowledge epoch 漂移时拒绝激活。Timeline记录实际字段，不以标题/版本推定废止。语义相似仅用于导航。
- `CitationAssemblyService` 的 Scope 派生来源校验除全部原文应用ACL外，核对新manifest所记 version/activeVersionId/contentHash。真实输出差异记录同时保留前后来源；旧来源失效时不得把其已撤回内容作为当前回答证据，diff审计页不进入派生检索源。
- `GraphRagService.searchGlobalCommunities` 在严格权限模式要求请求userId，先于dense/lexical最终LIMIT在同一RepeatableRead事务中调用批量artifact守卫；所有来源ACL/version/hash/time/manifest合取后才排序。DRIFT社区仅导航，原文事实仍通过普通证据路径。
- `withCommunityInputs` 只允许明确worker；锁定并核对所有实际原文版本后在同一应用事务写社区、替换ArtifactDependency与ArtifactManifest，不依赖已移除的RLS GUC。
- `scanDeterministicChunks` 接收调用方已限定的文档/KB/published谓词，不扩大资源范围；在RepeatableRead内完整keyset扫描。后续原文hydration与最终输出权限门禁仍必须执行。

## 2026-10-08 聚合证据与预览传输

- `CitationAssemblyService` 聚合引用必须提供完整 sourceDocumentIds；逐一验证 published、时效与文档 ACL，restricted 空 ACL 同样拒绝。Scope 派生页返回完整 source manifest，持久化复用同一集合。
- `captureEvidenceDependencies` 记录全部原文与聚合来源版本/hash；显式 inventory manifest 在读侧重验 KB 可见性和完整可读 published 集，零库存仅在仍为零时通过。
- `KnowledgeBaseController.getPreviewFile` 仅方法级 document-preview-transport 接受签名传输 token；绑定用户、KB、文档、版本与到期时间。出口实时检查用户 active、KB 可见性、文档 ACL、版本，再流式读取。其他路由仍使用普通登录凭证。
- `RaptorService` 全局摘要依赖逐层解析至 Level 1 文档及当前 Chunk；缺失/换版本来源拒绝返回，全局引用携带精确 sourceDocumentIds。

### 2026-10-08 检索前置范围与预算

- `retrieval/readable-document-scope.ts`：调用方先提供可见 KB 范围；SQL（Document 别名 d）与 Prisma 条件按当前请求用户的 KB owner/admin、user/role/org ACL、restricted 空 ACL 拒绝语义编译范围，asOf 有效期在分页/Top-K 前执行。无用户且启用强授权时拒绝查询。`boundedRead`/`boundedReadSql` 使用事务局部 statement_timeout，不赋予读权限。
- `graph-rag.service.ts`：实体、关系种子与关联边在截断前按来源授权收敛；强授权要求完整有效 ArtifactManifest/Dependency；旧路径按可读来源文档收敛，返回 chunk 再与可读文档条件交集。用户请求的关联检索在受限只读事务内执行。
- `knowledge-graph.controller.ts`：文档浏览在 take 前应用同一文档授权及有效期条件，并保留读取后复验。
- `brain-scope.service.ts`：Scope 编译保持源集合、版本与 ACL/知识 epoch 发布复验；变动文档分批计算完整 chunk hash，不变文档复用版本 manifest；源综合缓存绑定完整源 manifest、模型路由/参数、源同步时间和 ACL epoch，发布结果仍携带全部源文档依赖。

- `scripts/graph-quality-audit.ts`：显式 KB 的管理员离线只读审计；直接 Prisma 连接，以 PostgreSQL READ ONLY 事务约束，输出来源缺失、旧版本、重复出处和别名消歧候选，不作为用户接口。运行者负责选择测试数据库及合法审计范围。
- 图浏览分页与局部展开：`knowledge-graph.controller.ts` 的 page/root 仅在可见 KB + 文档 ACL/有效期条件内缩小范围；统计 total 与页面使用相同谓词，根文档先鉴权，局部边出处只来自本次已授权节点。缓存按授权修订、可读集合更新和页面源文档版本/hash 指纹失效，命中也重验权限与版本。
- Scope 元数据：`brain-scope.service.ts` 按已批准 sourceId 对 BrainSourceDocument 使用 documentId keyset 分页；仅改变传输批次，完整输入与发布依赖集合不截断。

- 图谱失败反馈：仅已收敛 KB 的成功零命中记录有限查询词，用于未来系统抽取排序，不输出事实；版本指纹仅聚合该 KB 文档计数/版本和/更新时间，抽取与反馈同指纹才能使用，进程内限量24h过期，不暴露文档内容或用户历史。

## 2026-10-08 响应计量与浏览器 ACK

- `POST /api/v1/chat/messages/:messageId/render-timing` 使用普通登录身份，验证 UUID/有限非负客户端相对耗时；只读本人会话 assistant Message，来源依赖仍有效才写两个数字时点。非 owner/撤权拒绝，客户端钟明确区分服务器钟。
- `ChatRunService.replaceTimingNode` 原子 JSON 替换仅固定 timing 节点，UPDATE 同时带 Message assistant 与 Conversation.userId 谓词，保留并发的其他 trace 节点；不扩大资源范围。
- 服务端 queue/auth/retrieval/rerank/context/generation/verification/persistence 来自实际 span；provider first text、prepared、transport emit/complete 与 run ready 分开记录。浏览器在可见文档、回答元素相交、Markdown 已挂载后观察两次 rAF 渲染机会；不承诺物理屏幕已显示。

### 2026-10-08 MCP 请求与输出边界

- `mcp-authentication.ts`：每次 HTTP 请求验证 active 用户/凭证并按当前 AppId 或 Bearer 用户限流；上传 guard 先于 multipart 内存解析。旧 SSE sessionId 仅用于路由，POST 重新认证并核对用户及凭证绑定（密钥摘要），撤销/轮换不能沿用旧会话身份。请求缓存只复用同一次 guard/controller 的认证，不跨请求。
- `mcp.controller.ts`：所有知识工具统一要求显式返回 manifest；资源结果在 `withStrictResourceOutput` 授权锁内调用共享应用读取服务重新裁剪并组装，协议元数据在同锁下复验主体。Legacy SSE、direct JSON 与 stream 使用同一结果分类与出口。
- `mcp-protocol.ts` / `main.ts`：无 Origin 的服务端调用可用，浏览器 Origin 仅接受配置白名单且主动 403（包括 CORS 前预检）；protocol header 仅支持声明版本。实例地址来自可信部署配置，不读取客户端 Host/Forwarded；规范仅公布实际请求头/Bearer 凭证模式。

### 2026-10-08 OpenAPI/MCP 核心知识应用服务

- `knowledge-operations.service.ts`：OpenAPI/MCP 共用当前身份读取，清单先收敛 fresh visible KB，再以同一文档 ACL/有效期谓词分页和计数。KB 嵌套计数只包含可读 published 文档；parsing 状态是受控资源元数据，不伪装成 published 证据。
- 文档读取先鉴权，版本路径只读当前 activeVersion 的不可变 BlockArtifact rawContent 投影及 manifest/hash，按 Unicode 字符范围分页，读取后复验活动发布；旧版本元数据可列，正文端点拒绝非活动版本。非版本路径限制上传根目录及读取预算，并绑定 version/contentHash、读取后复验；响应不含 mdPath/rawFileOid/objectKey。
- 会话清单、游标和消息读均显式 owner 范围；游标不可借其他用户数据排序。每条助手历史以当前身份在同一客户端复验 dependencyManifest，撤权/版本变化隐藏内容与引用；manifest不作为公共历史字段输出。
- `document-lifecycle.service.ts`：抽取现有 ingestion text/retry/delete 实现；入口传真实 userId，manager 权限与 KB/doc 归属不由 OpenAPI/MCP 自行复制。删除仍调用原词法统计、compiler、graph、RAPTOR 与存储清理链。
- `strict-output-permit.ts`：资源出口在授权共享事务锁中复验 active 主体及原 snapshot，再执行调用方受限 fresh reader并保持到 drain；证据出口继续复验显式 manifest。读结果不刷新 snapshot。自身写提交后的确认单独取可信新 snapshot，再复验当前管理权限，输出仅 ID/accepted；二进制归档逐个确认文档，不回传旧 title/kb_name。

## 2026-10-09 入库事实、资产、批次与 QA

- `QaController` 的预览、清单、导入和审核均使用登录用户和 active KB，要求 KB 可见且可管理。清单先按文档 ACL 收敛，再截断 500 项；预览只对可读既有 QA 返回冲突。QA ID 是 KB 内稳定来源键，更新在 KB 锁下收敛 `kbId + sourceType=qa + sourceExternalId`，拒绝写他库对象。字段映射为显式契约，不按业务列名自动猜测。审核使用候选版本/hash 比较，来源版本和 ACL 再核验。
- QA 的有效期与新发布版本一同原子切换，不通过未批准候选改变旧发布版本。问题侧索引只包含标准问题/相似问；答案完整保留在一个 QA 文档/原子块。人工标准问答要求显式 reviewed/approved；生成与反馈默认候选，不能自动回灌为权威事实。
- 派生 QA 只能绑定同 KB 的当前非 QA 原文。`DocumentAclService` 每次读取重验当前来源 activeVersion/status/时间及来源 ACL；`readable-document-scope.ts` 在 SQL/Prisma 排序、分页和 Top-K 前加入来源版本/权限条件。来源换版本、删除或撤权后，旧派生 QA 不再成为可读检索证据；人工独立 QA 保留独立生命周期。
- `ImportBatch` 保存轻量条目清单，不保存压缩包字节。读取/重试要求批次所属 active KB 的可见与管理权限，条目关联文档仍逐项按 ACL 收敛；删除/无权条目仅返回路径与状态，不返回已撤权正文。批次 retry 复用已保存子文档原件和既有 lifecycle，未受理子项要求重新上传，不恢复已删除原包。KB 删除级联清单。
- `IngestionArtifactsController.asset` 要求登录身份、文档 ACL、KB active 和所请求的已发布版本，资产必须出自该文档/version 元数据；路径限制在文档目录，仅允许安全图像 MIME，不支持任意 URL/路径读取，输出 private/no-store/nosniff，传输前复验授权 snapshot。
- `source-artifacts.ts` 将 Worker NDJSON/图片产物认证下载后存入接收文档的版本目录，缓存不会继承其他文档 URL/私有来源身份。Worker 下载绑定服务器配置的实例 ID 和 Bearer。组合产物预算 200 MiB，单图 50 MiB，失败下载清除临时文件；未引用失败版本清理目录，已发布旧版本保留到文档删除。新版本复制未改资产与事实的独立引用，删除沿用 lifecycle 的整文档目录清理。
- `retry-units` 要求 KB manager + 文档 ACL，在文档锁内核对版本/hash/无正在替换原件后分配新 ingestVersion；Worker 只重做指定单元，应用合并未选正文/表/资产。遗漏、重复定位或重叠投影拒绝发布；保存仍受版本 claim 限制，旧任务不能覆盖新输入。
- `TableEvidenceService` 完整聚合仍要求文档 ACL 和当前 active published version；源 NDJSON 限制在文档目录，流式核验完整行数/hash，过滤、汇总和合并锚点只使用真实原始事实，不使用检索 Top-K 样本计算。操作结束复验授权 snapshot；mixed units、缺失公式缓存和不完整表拒绝计算。
- 原始文本、表格、原图/OCR 与模型说明分别计量；质量覆盖告警不扩大发布门槛，只有缺少真实正文才拒绝。所有系统产物继承已有资源身份，数据库不提供 RLS 兜底；实例数据库与 Redis DB 隔离规则不变。
- QA 适用性：`resolveQaApplicability` 使用维护者显式 scope/语言标签与请求问题进行通用匹配，查询当前已授权全部同题变体，拒绝按分数任意选择矛盾答案；未明确范围或并存冲突时返回待澄清范围/语言，不把冲突答案组合为事实。检索 API 返回 `qaAmbiguities`，问答在仅有歧义 QA 时直接请求澄清；不启用未经真实样本校准的自动权威直答阈值。
- 大型原件在入库任务中流式哈希，并使用 file-backed Blob 向共享 Worker 发送，避免 API 再复制整份 Excel/PDF/图片。普通文件上传入口继续使用既有 200 MiB multipart 内存上限；压缩包按既有限额有界解包，未新增常驻解析服务或全局 SQL agent。
- 统一回归修正：Prisma 派生 QA 来源范围使用调用方同一客户端和同一 ACL/时效谓词，候选先限定可见 KB，来源要求同 KB 的当前 published 非 QA 版本；不创建额外 PermissionService 或跨事务读取权限。隐库清单在构建 QA 范围前拒绝。失败版本清理若无法确认引用归属，保留产物并抛出原解析错误，不能把数据库查询失败当作“未引用”证据删除。
- `open-api.module.ts` 导出同一 OpenApiRateLimitService，MCP 复用该实例；不同 HTTP入口不另开配额桶。`chat.service.ts` 独立检索携带实际选择来源的版本依赖，零命中用实时范围型资源确认且不声明完整库存。
