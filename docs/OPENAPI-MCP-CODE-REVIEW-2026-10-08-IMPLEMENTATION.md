# OpenAPI/MCP 审查实施记录（2026-10-08）

基线 `dd1e419`；保留原审查文档。开发 gpt-6.1-sol，执行测试/构建 gpt-6-luna。无生产发布、迁移、重启或生产数据操作。

## 逐项修复

| 项 | 实施 | 回归依据 |
|---|---|---|
| R01 | 普通/ZIP 上传显式完成 HTTP200，不再混用裸 Res 与返回对象 | OpenAPI controller 真实 Nest+Supertest 请求 |
| R02 | 接口层区分缺省/all与显式空集；非法/不可见范围拒绝，既有会话范围全撤权停止 | MCP service、OpenAPI controller 非法输入零后端/范围测试 |
| R03–R05 | REST/MCP 共用终态事件归约；replace覆盖草稿，数据型error/缺done失败且不持久partial；成功依赖/引用/trace完整持久化，数据库失败不报成功 | external-chat-events、两类controller/service |
| R06 | 每次HTTP重新验证当前用户/凭证及限流；legacy session绑定主体/凭证/密钥摘要；上传guard先于Multer；跨入口复用同限流实例 | authentication/controller/session/http/guard |
| R07 | 元数据、资源、证据分别由同一输出许可责任层处理；表格聚合取真实显式manifest，协议元数据不伪装为知识证据 | strict MCP transport/permit |
| R08 | 可见KB计数只含可读published文档；清单及total同一ACL/时效谓词 | knowledge-operations |
| R09 | 工具发现、运行时输入与OpenAPI共用schema；严格类型/UUID/分页/日期/未知字段限制，非法参数在后端前拒绝；保留旧QA别名合法字段 | knowledge-tool-schema、MCP service、OpenAPI controller |
| R10 | 上传在解析前认证，先管理鉴权再读KB名称；typed HTTP错误保留原状态 | MCP upload HTTP、service |
| R11 | 实际Bearer/App凭证、multipart、实例URL、必填路径参数、成功200与返回封装同步规范；指南只用当前认证方法及可信实例配置 | OpenAPI spec/guard/controller、MCP guide/protocol |
| R12 | 无引用拒答明确typed non_evidence refusal；失败独立failure终态，不能复用草稿 | reducer、MCP/OpenAPI consumer |
| R13 | strict知识资源在共享锁内fresh ACL reader重建；检索显式来源依赖，零命中重新范围确认；新读接口及multipart写确认同样保护 | strict output/资源/检索测试 |
| R14 | 支持2024-11-05与2025-11-25协商/协议header校验；现代GET明确405；非法Origin主动403；标准SSE仅最终RPC和请求token对应递增progress | protocol/controller/HTTP |

所有知识读保持原授权 snapshot；仅完成写操作的最小确认取得新可信 snapshot，复验当前 manager 和资源归属，避免自身版本修订误报失败。读结果不会借刷新掩盖外部撤权。资源元数据允许合法 parsing 状态，不硬塞 published-only evidence manifest、不使用 skipValidation 开关。

## 核心覆盖闭环

公开15个工具，另保留未公开的search_knowledge问答兼容别名；get_user_info及get_file_upload_guide继续提供身份/当前实例指引。

| 业务 | MCP工具/HTTP | OpenAPI |
|---|---|---|
| KB发现 | list_knowledge_bases | GET v1/knowledge-bases；旧默认数组兼容，显式分页返回envelope |
| 文档清单/状态 | list_documents、get_document_status | GET v1/documents、v1/documents/status/:docId |
| 原文/版本定位 | read_document、list_document_versions | GET v1/documents/:docId、/:docId/versions |
| 原生文本入库 | ingest_document_text | POST v1/documents/text |
| 重试/删除 | retry_document、delete_document | POST v1/documents/:docId/retry、DELETE v1/documents/:docId |
| 二进制上传 | 既有POST /mcp/upload与get_file_upload_guide | 既有POST v1/documents/upload |
| 独立检索 | retrieve | POST v1/search |
| 问答/引用 | chat_knowledge；隐藏search_knowledge仍转问答 | POST v1/chat/completions |
| 会话发现/历史 | list_conversations、get_conversation | GET v1/conversations、/:conversationId |
| 完整表格聚合 | aggregate_knowledge_table | 保留原MCP聚合服务 |

DocumentLifecycleService复用原完整入库/重试/索引删除链；KnowledgeOperationsService由REST/OpenAPI/MCP调用，不跨controller、不伪造JWT。删除工具标记 destructiveHint。个人KB管理、图谱治理、resources/prompts为扩展，不新增未要求管理员功能；空可选资源列表不是协议缺陷。

原文端点读取当前发布版本的 raw block 投影（`content_format=published_raw_blocks`），携带活动版本、manifest/source hash、块出处；它不是上传文件的字节副本。offset/limit按Unicode字符、有界页面可取尾部；版本列表只公开安全元数据，正文目前限定当前active版本。旧markdown读取≤8MiB，超限明确拒绝，hash或读取后版本不一致拒绝；新版本路径不访问可变content.md。

二进制继续multipart，未引入Base64、任意URL抓取或服务器路径入库。标准MCP Accept JSON/SSE不会启用自定义增量通知；显式`stream=true`才输出`notifications/gbrain/chat`自定义frame（含replace/error），标准客户端只收合规progress及最终RPC。progress仅请求`params._meta.progressToken`存在时发送、数字单调递增；不冒充logging notification。依据官方[progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)、[logging](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging)、[transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。

## 验证与真实限制

- Luna首批：事件归约/原ingestion controller 2套12项通过。
- 第二批：类型错误及测试类型错误已发现并修复；当批结果不作为完成证据。
- 第三批：API build通过；13套中10通过，107项中100通过、7失败；失败原因分别为旧测试ID/UUID契约、测试headers缺失及mock污染、Jest提升初始化顺序，已修并新增strict上传/通知回归。真实Nest HTTP4项通过，依赖数据库使用mock。
- 第四批：API build通过；13套中12通过，118项中117通过；唯一旧SSE fixture缺少progressToken却期望标准progress，已改为合法token并保留原断言。新增strict上传和通知负向/递增/opt-in测试均通过。
- 首次终轮：新strict上传的union类型编译失败导致3套未执行，10套96项通过；未运行全量。独立审查发现OpenAPI strict上传仍返回预先构造详细payload，补为同一fresh mutation receipt；同时修union收敛/空白。
- 修后最终API build、13套针对性及根目录 `pnpm test`：待Luna终轮结果更新。

真实Nest+Supertest验证HTTP框架、认证guard/解析次序和状态/终止行为，但依赖服务/数据库使用mock；不宣称实测真实PostgreSQL跨连接撤权锁、BlockArtifact SQL或真实模型/存储入库全生命周期。未部署生产；新增访问边界记录于[RLS-BOUNDARIES.md](RLS-BOUNDARIES.md)。

## 复核补充修复（2026-10-08 二次核验）

对 R01–R14 逐项复核，全部修复成立；复核中另发现两处实现残留并已修正：

- **历史读取依赖复验未按授权开关收敛（关联 R05）**：`KnowledgeOperationsService.readConversation` 无条件调用 `validateEvidenceDependenciesInClient`。该函数对缺失 manifest 一律返回 false，导致 `CORE_AUTH_ENFORCE≠1`（开发/测试/非强制部署）时，`get_conversation`（MCP）与 `GET /open-api/v1/conversations/:id` 会把全部无 manifest 的助手回答替换为“来源已失效”，且与 `chat/conversation.controller.ts` 的 `authorizationEnforced()` 门控不一致。现改为仅在授权强制时复验；强制模式行为不变（撤权仍隐藏）。
- **检索结果泄漏内部来源依赖（关联 R13）**：`searchKnowledgeForAgent` 为满足 `captureEvidenceDependencies` 的清单校验，把 `sourceManifest/sourceDocumentIds/evidenceRefs/inventory/inventoryScope` 挂到返回的每条检索结果上，这些内部字段经 `POST /v1/search`、MCP `retrieve` 与原生 `/chat/search` 外泄，与规范自述“Internal source manifests are never emitted”矛盾。现新增 `publicSearchResult` 投影，仅在完成依赖捕获后剥离上述字段再返回；`documentVersionId/contentHash/span` 等既有出处字段保留。

复核验证：`pnpm --filter api build` 通过；`npx eslint` 变更文件无告警；API 全量 `jest` 176 套通过、1547 项通过（5 项按既有配置跳过），含新增的两项回归。
