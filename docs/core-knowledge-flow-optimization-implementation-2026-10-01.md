# 核心知识流程优化：实施与验收

对应 [优化设计](core-knowledge-flow-optimization-design-2026-09-30.md)。开发基线 `9ae72da`；实现位于当前未提交工作区。没有执行生产部署、生产迁移或生产服务重启。

**已实现权限与依赖屏障、不可变发布、模型指纹隔离、统一请求预算、精确回答缓存、完整表格计算、共享 Parser 的取消与公平调度，以及增量图谱。** 可选模型增强保留开关。功能与一致性测试通过；真实语料的精度、P95、成本和十实例容量尚未验收，不能据此宣称达到 SOTA 或降低 25%。

## 1 实施范围

| 设计阶段 | 实现及主要代码 | 验证与边界 |
| --- | --- | --- |
| 0：基线与评测 | `tests/evaluation/core-flow/paired_gate.py`；复用标准 IR、ANN、压测；QueryExecution 记录计划、预算、供应商 usage、依赖及停止原因 | 门禁自测通过；质量基线、实际计费和混合负载需在隔离环境采集 |
| 1：权限契约 | `permission/*`、`db/*`、Role.code、Document.aclMode；新增 ACL 管理面板 | API 单测及真实角色 SQL 矩阵通过；最后一条授权删除后仍 restricted；缺失身份不升级为 service |
| 2：修订与撤权 | `authorization-revision.ts`、`evidence-dependencies.ts`、`strict-output-permit.ts`；派生产物 RLS、历史消息依赖 | 真实数据库验证撤权提交与严格输出许可顺序；授权失败阻断模型调用和输出 |
| 3：模型空间隔离 | `embedding/model-fingerprint.ts`、`GenerationVector`、重排 pair 缓存 | 同文本不同修订不能误复用；未知修订不复用持久模型产物；generation 构建、切换和回退集成通过 |
| 4：不可变核心发布 | `ingestion/document-version-store.ts`、Outbox、原文 BlockArtifact、dense/lexical manifest | 缺覆盖回滚、旧版服务、乱序栅栏、重复投递、双通道一致性通过 |
| 5：预算与取消 | `retrieval/query-execution.ts`、`request-signal.ts`、`retrieval-budget.ts`、`model-admission.ts`、Prisma 池预算 | HTTP/SQL 取消与有限并发；跨 API/Worker 的实例模型速率配额；不把客户端取消等同于远端 GPU 停止 |
| 6：查询精度 | 三档计划、校准配置、asOf、`retrieval/table-evidence.service.ts`、精确回答缓存 | 数值、单位、时点、缓存依赖的单测通过；自适应策略收益仍待消融 |
| 7：差量与解析 | `graph-rag/incremental-projection.ts`、社区输入指纹、模型产物缓存；Parser OCR 图片产物缓存和可终止子进程；持久意图对账 | 真实图谱验证未变文档零抽取/零写入、只更新受影响行、撤回及并发栅栏；OCR 新旧质量与增量 token 比例需实测 |
| 8：增强接入 | BGE-M3 capability、共享上下文 pooling 契约、共享 Parser MaxSim；模型配置可选择候选 reranker | 错维度、修订、窗口及 offset 拒绝；仓库未新增重型编码模型服务，实际模型能力需外部共享服务满足契约 |

保持 PostgreSQL + BGE-M3 dense + BM25/pg_trgm + GraphRAG + Reranker 主架构。没有新增独立向量库、图数据库、每实例 Python 服务或业务专用同义词规则。

## 2 关键行为变化

### 权限

- 系统管理员以稳定 `Role.code=system_admin/super_admin` 判断。显示名、`builtin=true` 或 `permissions=*` 不再各自隐含内容超级权限；角色 code 不允许随意改写。
- 系统管理能力不自动开放他人个人库、受限正文。KB owner/KbAdmin 的管理范围仍限定在指定库。
- `inherit` 明确继承知识库；`restricted` 只授予指定 user/role/org，删除最后一条不恢复继承。首次迁移按旧 ACL 是否存在回填模式。
- 权限、账户、成员、组织及文档可见性变更与 AuthorizationState 修订同事务提交。请求向主库读取修订与最近有效期边界；异步通知不作为访问正确性的前提。
- RLS 保护原文、索引、派生产物和缓存。混合摘要要求用户可读全部实际输入；更新派生正文会保守合并新旧依赖，只有已验证的后台完整重算能替换依赖集合。
- 历史会话中的助手知识回答按当前依赖再授权。没有完整依赖的旧回答不直接回显；个人事实仍按本人身份隔离。
- CORE_AUTH_ENFORCE 下远端 GBrain 正文检索关闭，直到远端具备可同步验证的完整版本/权限 provenance；本地授权混合检索与图谱继续工作。

普通输出模式在模型前与正文批次前复核并取消，监视间隔不是延迟达标证明。严格模式仅覆盖聊天 completions 和 MCP 的受控输出：先缓冲，再持有数据库共享许可至 transport 接受/排空；撤权事务取得排他许可后才能提交。上限 8 MiB，排空超时 5 秒。慢连接可能延长撤权提交等待；已被客户端或模型供应商接收的数据不能追回。其他 JSON、预览和下载入口继续执行当前权限检查，不将其描述为全部具有严格流式许可。

### 入库与索引

- 新版本持有独立原文路径、不可变 blocks、原文 span/hash 与索引文本 hash。LLM 上下文前缀可进入 indexText，不能变成引用原文。
- 新版构建、失败或待审期间保留旧 activeVersion；明确删除/撤回即时关闭查询可见性。核心发布要求 dense 与 lexical 的同一 manifest 覆盖率 100%，并检查 ingestVersion 栅栏。
- Chunk 与倒排是 activeVersion 的读投影；短事务中整体切换。图谱、RAPTOR 等辅助意图持久化并独立重试，不阻塞原文首次可检索。
- 模型 generation 保存不可变向量快照，构建不覆盖在线投影；回退只作用于当前内容版本，不能复活旧内容、删除或撤权。
- 向量、OCR、上下文前缀及图谱产物缓存均绑定实例、模型/部署修订及实际输入。未知修订不假定与历史空间兼容。
- 增量图谱按文档版本保存抽取分片，未变文档不重复抽取；节点与边保留 source contexts。仅同名不足以断言现实实体相同，surface_form 合并仅供导航。社区输入未变时复用摘要；聚类仍可能扫描可用图，不承诺所有聚类计算都严格局部。
- 删除图谱/RAPTOR 行同时清理依赖。历史文档版本保留；本次没有启用可能破坏历史引用的自动版本删除策略。

### 查询

| 计划 | dense / lexical / graph | 重排 pair | 扩检轮数 / 新探针 | 证据 token | 检索时限 | 模型调用 / 估算输入 token |
| --- | --- | --- | --- | --- | --- | --- |
| Fast | 40 / 40 / 10 | 40 | 0 / 0 | 4000 | 1.5 s | 4 / 24000 |
| Standard | 60 / 60 / 20 | 80 | 1 / 2 | 8000 | 3 s | 8 / 48000 |
| Deep | 80 / 80 / 20 | 120 | 2 / 4 | 12000 | 6 s | 16 / 96000 |

预算包含排队及首轮已消耗时间，升级不重新起表。生成调用计入总调用/token 上限，检索结束后不继续受检索截止时间限制。未开启 adaptive 时保留兼容计划。估算 token 用于准入，供应商 usage 单独记录；缺 usage/账单不能声称已核算真实成本。

- query/block/reranker route+model+revision 相同的 pair 请求内复用；已知修订才允许跨请求评分缓存。
- 相关性分数不冒充正确概率。`RERANK_CALIBRATION_FILE` 必须匹配路由、模型、修订、语料和独立验证集；未知配置不产生伪置信度。
- `asOf` 要求带时区的合法 ISO 时点，贯穿执行上下文、RLS、效力和缓存。历史效力仍使用当前访问权限。
- 回答缓存只做精确问题及完整作用域命中，不按 0.96 向量相似直接复用；任一依赖版本、hash、权限或效力失效，整条 miss。缓存 TTL 不越过最近权限/效力边界。
- 长表通过完整已授权不可变 Markdown 计算 count/sum/min/max/avg；使用精确十进制及有理平均数，拒绝缺失、混合单位或超预算数据，附完整行范围/hash。主回答提示禁止用 Top-K 抽样推断总量。
- 表格工具是显式结构化 API/MCP 工具；本次不宣称任意自然语言聚合问题都能自动定位表格并调用工具。

## 3 配置与启用顺序

下表是配置契约，不是已经写入生产的配置。布尔值格式按表填写，不混用 `1` 与 `true`。

| 配置 | 启用条件 / 行为 |
| --- | --- |
| `RLS_ENFORCE=1`、`CORE_AUTH_ENFORCE=1` | 请求使用专属 NOBYPASSRLS、非 superuser 运行角色；CORE_AUTH 强制要求 RLS。先在测试实例验证所有入口 |
| `CORE_VERSIONING_ENABLED=1` | 完成新迁移，固定 embedding 部署修订，按 KB 重入库建立真实原文及新 manifest 后切换 |
| `EMBEDDING_DEPLOYMENT_REVISION` | 不可变权重/网关部署版本；也可使用模型配置 deploymentRevision。更新权重必须更新此值 |
| `EMBEDDING_TOKENIZER_REVISION` | tokenizer 固定版本；与投影、维度及修订一起构成指纹 |
| `CORE_GRAPH_INCREMENTAL_ENABLED=1` | 依赖 CORE_VERSIONING；图谱模型修订稳定后按测试 KB 灰度 |
| `ADAPTIVE_RETRIEVAL_ENABLED=true` | 通过固定计划与 adaptive 的独立配对消融后开启 |
| `KNOWLEDGE_STRICT_OUTPUT=1` | 必须授权强制；测试聊天/MCP 慢连接和撤权并发；单独报告缓冲 TTFT |
| `CONTEXTUAL_RETRIEVAL_ENABLED=true` | CORE_VERSIONING 模式默认不付出 LLM 前缀成本；显式开启后只处理结构规则判定的短块/指代块 |
| `CONTEXTUAL_LLM_DEPLOYMENT_REVISION` | 或模型配置 deploymentRevision；缺少则不复用持久前缀产物 |
| `PARSER_DEPLOYMENT_REVISION`、`OCR_DEPLOYMENT_REVISION`、`VLM_DEPLOYMENT_REVISION` | 实际部署修订；缺失相关修订时不复用 API 解析缓存。OCR 页/图片缓存也要求实例身份及已知 OCR 修订 |
| `BGE_M3_HYBRID_ENABLED=true` | capability 为 bge-m3-representations-v1；模型、修订、tokenizer、dense/sparse 元数据匹配；默认关闭 |
| `BGE_M3_HYBRID_DEPLOYMENT_REVISION`、`BGE_M3_CAPABILITIES_ENDPOINT` | 固定共享网关修订及 capability URL；可使用模型配置路由，独立端点可设 BGE_M3_HYBRID_ENDPOINT |
| `BGE_M3_MAXSIM_ENABLED=true` | 与 hybrid 分开评测；同一 capability 明确支持 multi-vector；在共享 Parser 计算，默认关闭 |
| `BGE_M3_LATE_CHUNKING_ENABLED=true` | 外部共享 encoder 必须满足下节契约；默认关闭 |
| `LATE_CHUNKING_ENDPOINT`、`LATE_CHUNKING_DEPLOYMENT_REVISION` | 固定 encoder 根地址和修订；可设 LATE_CHUNKING_API_KEY，不写入指纹或日志 |
| `RERANK_DEPLOYMENT_REVISION`、`RERANK_CALIBRATION_FILE` | 固定重排器修订及 held-out Platt 文件；至少 200 个验证样本，不能在测试集拟合 |
| `CORE_EXTERNAL_ACL_REQUIRED=1` | 强制源 ACL 映射；CORE_AUTH_ENFORCE 也会强制。先补齐连接器映射与身份绑定 |

资源预算：

- `DB_CONNECTION_BUDGET=80` 默认表示分配给当前应用进程集合的可用连接预算，应先扣除运维及其他服务。`SHARED_INSTANCE_COUNT` 优先，其次 `HOST_INSTANCE_COUNT`，默认 1；`DB_PROCESSES_PER_INSTANCE` 默认 2。自动每池上限 `min(16, floor(budget / instances / processes))`，非法/不足分配会拒绝启动。显式 `PRISMA_CONNECTION_LIMIT` 或 URL connection_limit 覆盖自动值，运维必须重新核对整机总和。
- `MODEL_HOST_RPM` / `MODEL_HOST_INPUT_TPM` 与 `HOST_INSTANCE_COUNT` 按实例平分共享网关分钟配额，各实例 API/Worker 在专属 DB 原子计数。可用 `MODEL_QUOTA_RESOURCE_ID` 合并网关别名；未配置配额不启用此限制。这不是远端 GPU 的物理并发或停止证明。
- Parser 保持单个共享服务：`PARSER_CONCURRENCY=4`、`PARSER_PER_INSTANCE_CONCURRENCY=2`、`PARSER_QUEUE_LIMIT=64` 默认；MaxSim 全局默认 2、每实例 1、等待队列 16，`MAXSIM_TIMEOUT_SECONDS=5`。超时终止子进程并回收后归还槽位。`/resource-metrics` 返回受保护的 active/queued/per-instance 状态。
- 不改变实例数据库与 Redis 隔离：实例 N 用 `llmwiki_instN` / `REDIS_DB=N-1`；不能通过合并 BullMQ Redis DB 实现全局配额。

### 真实 late chunking 的外部契约

`GET /capabilities` 必须返回 `contract=shared-context-pooling-v1`、固定 revision、tokenizerRevision、model、dimensions=1024、offsetUnit=utf16、maxChars（1024–256000）。`POST /late-chunking` 输入共享原文窗口和块 offsets；返回同修订、sharedContext=true、truncated=false、windowHash、全部块 ID、同 offsets、有限 1024 维向量及覆盖块的 tokenOffsets。`POST /query` 返回同修订的查询向量。

独立字符串数组附带 `late_chunking=true` 会被拒绝。仓库实现客户端合同验证、独立 generation、查询通道和错误回退；外部权重编码/pooling 服务须由共享推理端提供，不能仅凭 metadata 自证编码过程正确，仍需服务合同测试与消融。

## 4 接口兼容性与数据迁移

### 接口

| 接口 | 变化 |
| --- | --- |
| `GET /api/v1/documents/:id/acl` | 返回 `{aclMode, entries}`，原先直接使用数组的客户端需要更新 |
| `PUT /api/v1/documents/:id/acl` | 显式提交 aclMode 和 entries；省略 mode 时受限；恢复继承必须 `inherit` 且 entries=[] |
| `GET /api/v1/documents/:id/acl-subjects?type=user\|role\|org&q=...` | 管理员解析授权对象，仅名称/ID，至少两个字、最多 30 项 |
| `GET/POST /api/v1/documents/:id/index-generations` | 管理者查看/请求 build 或 activate；返回构建事件，需等待 Outbox 完成；activate 需要当前内容版本的 ready dense generationId |
| `POST /api/v1/documents/:id/replay-failed-artifacts` | 仅管理者重放仍属于 active/building 的失败产物事件，用新事件 ID 防止旧队列任务 ID 阻断 |
| 聊天/search 与 MCP | 接受合法 asOf；MCP 新增 aggregate_knowledge_table，现为六个工具 |
| `POST /api/v1/chat/table-aggregate` | 先传 documentId/versionId 列举 tables，再传 tableId、operation、零基 column 执行；32 MiB 源文件、10 万行上限 |
| 文档版本 API | 禁止通过任意 mdPath/objectKey 重指向来源，替换正文走正常入库接口 |

连接器 `config.aclMapping` 示例（UUID 替换成经核对的本地对象）：

```json
{
  "syncAcl": true,
  "aclMapping": {
    "mode": "restricted",
    "subjects": {
      "user:external-user-id": {"subjectType": "user", "subjectId": "<local-user-uuid>"}
    },
    "localSubjects": []
  }
}
```

外部 public 位只记录，不隐式开放本地。明确设置 `mode=inherit` 是管理员的本地映射决策。映射未知、非法或源 ACL 不可验证时保持受限。文档记录外部 revision/ACL/同步状态及 sourceConnectorId；历史单连接器 KB 可自动绑定，多个连接器的歧义文档必须人工核对，不能靠 externalId 猜测归属。

### 迁移顺序

新增 **24 项 expand 迁移**，从 `20260930100000_core_auth_contract` 到 `20261001013000_publication_guard_lookup`；总计 69 项历史+新增迁移已在空测试库应用通过。没有改写既有历史迁移。

1. 在测试实例备份，记录 schema、角色属性、配置、文档及 ACL 清单；先应用新增表/字段/函数/触发器，生成 Prisma client，再部署测试代码。运行角色应由既有 provision/reconcile 流程授予基础表权限。
2. 核对 Role.code 映射、ACL 模式和个人库权限差异。新旧 deny/allow 差异不能用授权并集掩盖。新迁移还清理当前实例运行角色的旧 app.service/user_id 默认值，禁止请求角色 superuser/BYPASSRLS。
3. 固定 embedding revision；旧 Chunk 的未知 embedding_fingerprint 不回填为“当前模型”。旧 BlockArtifact.rawContent 缺失或 manifest 不兼容时按 KB 重入库，建立可验证原文 span 与新索引；不能直接把 enriched content 冒充原文。
4. 比较原文 hash、块数、manifest、模型指纹、来源绑定、权限矩阵和检索效果；完成后在测试实例开启 CORE_VERSIONING/CORE_AUTH。连接器先完成显式 ACL 映射。
5. 构建新 dense generation 后核对覆盖和指纹，再 activate；查询模型配置与 active generation 的切换需要协调，本次不是一个跨配置原子事务。配置不匹配期间过滤不兼容向量并保留已授权 lexical 路径，不将旧空间混入召回。
6. 在已通过质量/成本门禁的测试 KB 分别启用 adaptive、增量图谱、LLM 前缀、sparse/MaxSim/late chunking，禁止一次叠加后无法归因。

回退使用策略开关及同内容版本的 retained generation，保留新 schema 和当前权限契约；不通过旧 ACL 语义或破坏性 down migration 回退。严格版本切换后若要关闭版本模式，必须先验证旧消费者读取的投影和证据绑定，不能临时绕过授权或复活已撤回内容。

生产发布仍须用户明确书面指令，并使用已有 deploy-prod.sh 流程；本文不构成发布授权。

## 5 已执行验证

| 检查 | 结果与证据 |
| --- | --- |
| 根 `pnpm run test --env-mode=loose --force` | 6/6 任务通过；API 112 suites、858 passed、5 skipped；Web 41 passed；包含依赖构建 |
| API/Web 构建与类型检查 | Nest/TypeScript、Next 生产构建通过；未使用正在运行的 Web 构建目录 |
| Parser | 47 passed，4 subtests passed；`/tmp/gbrain-core-parser-final2.log` |
| GBrain adapter | 13 passed；`/tmp/gbrain-core-adapter-final.log` |
| 隔离 DB 入库/generation/输出许可 | 覆盖不全回滚、旧版可用、乱序/幂等、双通道 manifest、generation switch/rollback、撤权等待排空和旧修订不输出 |
| 隔离 DB 图谱 | 初建、未变零重算/写入、单文档变化、未受影响节点稳定、撤回依赖清理、并发版本变化回滚 |
| 真实角色 RLS SQL | 个人/组织/行业库、稳定管理员、restricted 空 ACL、派生全输入、普通更新依赖合并、效力和原子模型配额通过 |
| 空库迁移 | 69 项通过；发现并修复新增 CREATE OR REPLACE 的历史参数名兼容问题；`/tmp/gbrain-core-fresh-migrations-valid2.log` |
| 新运行角色 grants | llmwiki_inst99999 专用测试库，NOBYPASSRLS/非 superuser/NOLOGIN 角色；权威状态不可写、配额可调用、后台缓存/图谱分片不向用户暴露；`/tmp/gbrain-core-runtime-grants-final.log` |
| 评测计算 | paired gate 4 个自测通过；标准 IR、ANN 和压测工具离线自测通过，不等同真实质量/性能通过 |

集成运行：`python3 tests/integration/run-core-checks.py --unit`；细节见 [集成测试说明](../tests/integration/README.md)。最后一次完整日志：`/tmp/gbrain-core-integrated-final13.log`。测试数据库与用户业务数据隔离；SQL fixture 回滚，Node fixture 清理自身用户/KB。

## 6 待上线验收的实测项目

开发代码与合同测试不能替代以下实测。增强能力保持关闭，直到对应项目通过：

1. 至少 1000 道隔离问题，十类桶（单事实、改写、跨语言、表格、多跳、历史、冲突、无答案、权限、文档注入）各至少 50 道；开发集不进入测试集。paired_gate 检查出现的桶大小，评测负责人另核对十类是否齐全。真实 usage/账单与部署摊销记录成本。
2. ANN 对照精确搜索，100%/10%/1% 可见比例；正确率、引用精度、事实覆盖、span 绑定、无答案误断言/误拒答分别报告。
3. 10 万块、100 万块及十实例查询+入库混合负载；P50/P95/P99、失败/超时、DB 排队、Parser 槽位、辅助任务年龄及远端模型实际在途工作。
4. 原生/OCR/复杂表格的数值与阅读顺序精度；10% 内容变化的编码 token 与全量成本比较；真实 late encoder、sparse、MaxSim、新 reranker 独立消融。
5. 普通模式撤权取消延迟、严格模式慢连接/自然到期；预览、下载、会话、MCP、Open API 及跨实例对象前缀专项。

paired_gate 约束绝对质量、配对非劣 95% CI、零次测试越权、P95/成本各降低 25%，可要求多跳完整证据提高 5 个百分点。它不自动证明全部 SLO，也不产生真实评测数据。当前没有这些结果，不能写“全部性能验收通过”。


## 2026-10-01 发布回归补充

- 修复 adaptive 开关关闭时仍创建请求级期限的问题，保持基线请求生命周期；新增 4 个开关边界测试。
- 可见知识库计算的组织/管理员辅助查询复用外层事务，修复后台权限对账嵌套申请连接造成的池耗尽；对账并发限制为 4。新增独立事务替身回归。
- RLS 事务始终设置数据库 statement_timeout/lock_timeout；Prisma 回调超时本身不能取消正在运行的 SQL。
- 第 24 项增量迁移将 Chunk 的 publication guard 改为 definer 的父文档点查，保留 published + 当前 ACL 判定，避免重复执行 Document RLS。当前业务测试库共 70 项迁移。对同一测试库 3466 条可读分块的 count，原查询超过 15 秒超时，修改后约 512ms；这是该查询的实测，不代表全系统或 SOTA 基准。
- release-baseline-gate 是保持增强功能关闭的代码/schema 发布门禁：完整单元、角色 SQL/版本/generation/图谱集成、Parser、adapter、评测计算自测、排版浏览器、真实 25 场景回归。默认 full 门禁保持原样；baseline 拒绝开启 CORE_AUTH/版本/增量图谱/adaptive/sparse/MaxSim/late。源码、产物、测试配置摘要相同且一小时内可复用通过记录。
- 多源冲突用例允许显式 TEST_CONFLICT_KB_NAME，将 gold 预期绑定到其对应语料；测试用户的全范围里存在 13 套历史 E2ESCORE 重复语料，不能将这些库的回答与另一语料的 gold 混评分。未修改匹配阈值或生产检索业务分支。
- 官方 qrels、1000 道配对质量/成本、真实反馈/A-B 样本仍未齐备，不能声明 SOTA 收益或开启增强策略。生产发布进度见 deployment-request-2026-10-01.md。
