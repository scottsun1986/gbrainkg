# OpenAPI / MCP 接口审查

日期：2026-10-08。范围：对外 OpenAPI、全部 MCP HTTP 入口/工具及其真实业务调用层。基线提交：`dd1e419`。静态走查+针对性HTTP/方法复现；未修改业务、未运行生产操作。P1 为核心功能或安全范围错误，P2 为权限元数据、契约或资源控制问题。静态证据与随后复现记录分开。

## 接口清单

OpenAPI controller 前缀 `/open-api`，除规范端点外均使用 OpenApiGuard：

| 方法与路径 | 功能 | 实现 |
|---|---|---|
| GET /spec.json | OpenAPI 3.0.3 描述 | open-api/open-api.controller.ts:61 |
| GET /user/info | 当前用户 | 同文件:218 |
| GET /dict/kb-types | 类型字典 | :236 |
| GET /v1/knowledge-bases | 可见库及文档计数 | :249 |
| POST /v1/search | 用户范围检索 | :276 |
| POST /v1/chat/completions | SSE/JSON 问答、会话持久化 | :325 |
| POST /v1/documents/upload | multipart 文件/压缩包入库 | :578 |
| GET /v1/documents/status/:docId | 入库状态/质检 | :700 |

MCP controller 前缀 `/mcp`：

| 方法与路径 | 功能 | 实现 |
|---|---|---|
| GET /sse | 旧式 SSE，发送 endpoint | mcp/mcp.controller.ts:213 |
| POST /messages | SSE 会话提交或独立认证 RPC | :256 |
| POST / | Direct/Streamable RPC | :300 |
| POST /stream | 强制 SSE RPC | :310 |
| POST /upload | 独立 multipart 上传 | :427 |
| GET /spec | 接口与客户端配置 | :476 |

RPC 方法：initialize、ping、tools/list、tools/call、resources/list、prompts/list；后两项恒为空。公开工具：chat_knowledge、aggregate_knowledge_table、list_knowledge_bases、get_document_status、get_user_info、get_file_upload_guide。`search_knowledge` 按已有明确产品决策只保留兼容别名且执行问答，未在 tools/list 公布（不是意外死代码）；`upload_document` 已明确移除。注册证据：[mcp.service.ts:48](../apps/api/src/mcp/mcp.service.ts#L48)、[RPC 分派:166](../apps/api/src/mcp/mcp.service.ts#L166)。

## 已确认问题

### R01 P1：OpenAPI 上传成功后 HTTP 不结束

`uploadDocument` 注入非 passthrough `@Res()`，不支持类型分支显式 json，但普通成功及压缩包成功仅 return R；Nest 已进入手动响应模式，建档/入队成功却没有写出响应。调用方超时重试可重复入库。[签名:587](../apps/api/src/open-api/open-api.controller.ts#L587)、[压缩包成功:648](../apps/api/src/open-api/open-api.controller.ts#L648)、[普通成功:689](../apps/api/src/open-api/open-api.controller.ts#L689)。建议统一显式响应或 passthrough，验证真实 HTTP 结束与失败后无重复写入。

### R02 P1：裁剪为空的 KB 范围被解释成全部可见

OpenAPI 新会话将显式不可见范围过滤成 []；已有会话的 kbScope 全被撤权也得到 []。MCP 新旧会话均预先过滤。聊天层随后将空数组视为未指定，扩至全部可见 KB。不是读取未授权 KB，而是违反选中范围，检索/模型接触其他可见资料。[OpenAPI:372–380](../apps/api/src/open-api/open-api.controller.ts#L372)、[MCP:461–470](../apps/api/src/mcp/mcp.service.ts#L461)、[聊天范围:2012](../apps/api/src/chat/chat.service.ts#L2012)。OpenAPI 已有会话显式非法 KB 会403，不能误称所有分支一致缺鉴权。建议区分 omitted/explicit-empty/revoked-empty，明确范围无剩余时停止。

### R03 P1：两个消费端忽略最终 replace

ChatService 会用 replace 修正已增量发送的回答，OpenAPI 各收集路径与 MCP 仅累加 delta/token。因此 JSON、历史持久化及 MCP 结果可能保留校验前文本；OpenAPI strict SSE 虽缓冲并发送原 replace 帧，数据库仍保存旧 answer。触发：开启增量输出且最终核验改写回答。[生产者:5691](../apps/api/src/chat/chat.service.ts#L5691)、[OpenAPI:423](../apps/api/src/open-api/open-api.controller.ts#L423)、[非strict:466/527](../apps/api/src/open-api/open-api.controller.ts#L466)、[MCP:513](../apps/api/src/mcp/mcp.service.ts#L513)。建议统一事件归约，replace 覆盖累计文本、传输和持久化采用同一最终值。

### R04 P1：数据型 error 被当作成功完成

ChatService 可 next({type:error}) 后 complete；这不同于 RxJS error 回调。消费端未将其置为失败，complete 仍创建 assistant 并返回成功，甚至返回部分旧回答/空回答。[生产者:2042](../apps/api/src/chat/chat.service.ts#L2042)、[OpenAPI:419/464/525](../apps/api/src/open-api/open-api.controller.ts#L419)、[MCP:509–577](../apps/api/src/mcp/mcp.service.ts#L509)。建议识别 terminal error，失败不写成功消息，拒绝/失败依赖与正常知识结果区分。

### R05 P1：OpenAPI 非 strict 历史缺少来源依赖

非strict SSE/JSON 忽略 done.dependency_manifest，写 assistant 未保存 dependencyManifest；SSE 还丢引用。当前开启授权的历史读取对 assistant 按依赖复验，缺依赖会遮蔽内容；不是“无权限校验所以历史直接越权”。[SSE持久化:490](../apps/api/src/open-api/open-api.controller.ts#L490)、[JSON持久化:547](../apps/api/src/open-api/open-api.controller.ts#L547)、[历史复验:101](../apps/api/src/chat/conversation.controller.ts#L101)。MCP 收集并保存 done 依赖（service:512/561），不属于此项。建议所有模式持久化一致的最终答案、引用、manifest，并测试撤权后历史隐藏。

### R06 P1：SSE sessionId 路径跳过每次凭证核验与限流

建立连接后，POST /messages 只用 session.user，忽略本次凭证/身份；凭证禁用、删除、轮换后仍可调用，约4小时才清理。知道 sessionId 的另一请求可使用该身份，无主体绑定。授权快照复验用户状态/全局修订，不检查 credential；用户禁用在 CORE_AUTH_ENFORCE=1 时仍有防线。[session分支:268](../apps/api/src/mcp/mcp.controller.ts#L268)、[清理:96](../apps/api/src/mcp/mcp.controller.ts#L96)、[真实凭证验证:238](../apps/api/src/auth/user-credential.service.ts#L238)、[授权快照:25](../apps/api/src/permission/authorization-revision.ts#L25)。建议每次认证、绑定会话主体/凭证版本、重新限流；sessionId 仅承担传输路由，不将其当作长期认证替代品。

### R07 P1：strict legacy SSE 元数据/表格输出必被拒绝

POST /messages 对所有 RPC 默认 knowledge=true，未传返回 manifest。initialize、tools/list 无依赖，strict permit 明确拒绝；表格工具仅把 manifest 放结果内，也未传至该出口。Direct 路径已经分类并解析 resultManifest，存在传输不一致。[legacy出口:281](../apps/api/src/mcp/mcp.controller.ts#L281)、[Direct分类:330](../apps/api/src/mcp/mcp.controller.ts#L330)、[严格依赖:23](../apps/api/src/permission/strict-output-permit.ts#L23)。建议两个传输复用相同分类和结果解析，协议元数据仅验证主体，知识内容验证显式 manifest。

### R08 P2：可见 KB 的文档统计包含 restricted 库存

两个列表直接 _count.documents，KB 可见不等于所有文档可见；返回被 ACL 禁止文档的存在数量，还混入非发布文档。没有分页前文档谓词。[OpenAPI:256](../apps/api/src/open-api/open-api.controller.ts#L256)、[MCP:592](../apps/api/src/mcp/mcp.service.ts#L592)。建议用户库存与可管理库存分开，用户计数采用可读文档谓词。

### R09 P2：参数/schema 只是描述，未形成运行时契约

MCP 仅检查 payload 是 object，未验证 jsonrpc/ID/params；工具未执行 schema 校验。对象 prompt 会变成 "[object Object]" 并调用模型；非法 type 枚举被忽略，UUID可能进入 Prisma 后才报错。OpenAPI 也使用 any/局部手写转换。[MCP:149](../apps/api/src/mcp/mcp.service.ts#L149)、[参数分派:205](../apps/api/src/mcp/mcp.service.ts#L205)、[prompt:442](../apps/api/src/mcp/mcp.service.ts#L442)。建议共享工具注册与验证，区分协议错误/执行错误，设置长度、数组和分页上限。

### R10 P2：MCP 上传拒绝暴露不可见 KB 名称；上传解析发生在认证前

按任意 KB UUID 查询后，禁止错误包含库名。[service:286–296](../apps/api/src/mcp/mcp.service.ts#L286)。另 FileInterceptor 先接受最多200MB内存文件，controller 才 authenticate；OpenAPI 的 guard 则在 interceptor 前运行。[controller:428–440](../apps/api/src/mcp/mcp.controller.ts#L428)。未实测代理入口限制，不声称已完成外网DoS复现。建议统一不可用错误、认证 guard 前置，再限制上传资源。

### R11 P2：规范和上传指引与实际认证/实例不一致

MCP spec 宣布 app_id/app_secret query，authenticate 未使用 query；指引选择最新 active AppId，而非本次凭证，还固定默认生产 URL并要求 Bearer 用户提供“相同AppSecret”。[spec:518](../apps/api/src/mcp/mcp.controller.ts#L518)、[authenticate:120](../apps/api/src/mcp/mcp.controller.ts#L120)、[guide:679–686](../apps/api/src/mcp/mcp.service.ts#L679)。建议仅公布真实支持的认证，传递当前认证方式，采用可信实例地址，避免 URL携带密钥。

OpenAPI 3.0.3 [Parameter Object](https://spec.openapis.org/oas/v3.0.3.html#parameter-object)要求路径参数明确且required。OpenAPI spec 缺 multipart requestBody、docId path parameter、SSE响应 schema、限流/权限/校验失败响应及实际 Bearer 描述，通用 R.data 没有具体结果契约。[spec:99–211](../apps/api/src/open-api/open-api.controller.ts#L99)。另 POST /v1/search 无 @HttpCode 或手写Response，Nest默认成功状态为201，而spec仅列200：[路由:276](../apps/api/src/open-api/open-api.controller.ts#L276)、[规范:158](../apps/api/src/open-api/open-api.controller.ts#L158)。此状态契约差异为静态确认，未单独HTTP复现。建议 schema 来自共享 DTO/结果定义，规范与路由清单对照验证。

### R12 P1：无证据拒答缺少显式非证据终态

ChatService 的 AbortError 拒答仅输出 answer_kind:refusal，没有dependency_manifest；strict许可只接受明确的 non_evidence/version=1/outcome=refusal|failure，否则验证非空来源依赖。OpenAPI strict和MCP Direct会把合法的无证据拒答拒绝为来源失效。[拒答done:1201](../apps/api/src/chat/chat.service.ts#L1201)、[严格许可:20–27](../apps/api/src/permission/strict-output-permit.ts#L20)。建议产生类型化非证据终态并保留该分类，不能用空依赖放行有事实回答。仅此缺依赖分支，不声称所有拒答失败。

### R13 P2：strict 输出边界未覆盖 OpenAPI 检索/元数据入口

OpenAPI /v1/search最终直接return R，没有strict transport permit；KB清单/状态也没有对输出缓冲进行同一原子授权裁决。MCP Direct仅把chat/search/aggregate分类为knowledge，KB库存/文档状态只检查授权修订。底层已有ACL并不等于“从最后检查到写出期间不可撤权”的strict承诺。[OpenAPI检索:301](../apps/api/src/open-api/open-api.controller.ts#L301)、[MCP分类:330](../apps/api/src/mcp/mcp.controller.ts#L330)。建议明确strict涵盖的内容类型，并给知识检索、授权元数据各自合适的复验/清单依赖；此处仅静态边界差异，未复现撤权竞态。

## MCP 标准与产品覆盖

### R14 P2：现代传输宣告与协议实现不匹配

官方 [2025-11-25 transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) 与 [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) 区分 Streamable HTTP 和旧 HTTP+SSE。当前 initialize 固定返回2024-11-05，未读客户端 protocolVersion（service:172）；现代 POST /mcp 同样返回旧版本。HTTP入口未校验MCP-Protocol-Version。应明确支持版本并协商，保留旧版兼容而非将旧版或合法协商选择本身当漏洞。

现代 GET /mcp 应支持 SSE 或返回405；当前没有对应处理，通常404。MCP HTTP必须主动验证 Origin，无效 Origin 返回403；main.ts:105–106 callback(null,false)只停止添加CORS响应头，不会返回HTTP403，CORS未允许响应头不等于服务端拒绝；无Origin的服务端客户端仍应允许。会话 ID是可选能力，未设置现代 session header本身不是缺陷；resources/prompts也是可选，空列表不构成协议漏洞。Accept同时包含JSON/SSE而服务器选择SSE合法。旧/messages响应格式和自定义 progress/token通知应按对应协议独立核对，不把产品扩展当标准支持。

| 核心能力 | OpenAPI | MCP | 最小必备目标/现有复用 |
|---|---|---|---|
| KB发现 | 有，无分页、计数待修 | list_knowledge_bases | 受限分页/可读计数 |
| 个人KB创建 | 无 | 无 | 管理扩展项，可复用 knowledge-base.controller:196；不列协议必需 |
| 文档清单 | 无 | 无 | list_documents，ACL/时效在分页前 |
| 文档正文/出处/版本定位 | 无 | 无 | read_document、list_document_versions；返回doc/version/hash，不泄未授权来源 |
| 二进制上传 | 有，响应挂起 | 仅工具指引+HTTP侧通道 | 继续复用multipart；产品明确不支持Base64，不建议新增URL抓取/SSRF面 |
| 原生文本入库 | 无 | 无 | ingest_document_text；复用 ingestion.controller:295，文本不是Base64文件 |
| 状态查询 | 有 | get_document_status | 当前管理/可读语义分开 |
| 生命周期重试/删除 | 无 | 无 | retry_document、delete_document，复用 ingestion.controller:366/430；严格管理权限 |
| 独立检索 | 有 | search_knowledge未公开且转问答 | 新增retrieve只读检索工具，复用searchKnowledgeForAgent；保持旧search_knowledge问答兼容别名，不强制更改历史产品决策 |
| 问答/引用 | 有 | chat_knowledge | 修复范围、replace、error及持久化一致性 |
| 完整表格聚合 | 无 | aggregate_knowledge_table | 保留当前ACL/发布版本校验 |
| 会话发现/历史 | 仅chat传已知ID | 同左 | list_conversations、get_conversation；owner+逐消息manifest复验 |
| 图浏览、治理、批量索引 | 无 | 无 | 扩展项；不是最小协议必需，也不要求暴露全部管理员业务 |

主要知识库核心业务尚未通过 MCP 完整覆盖。工具命名是建议；实现应复用已授权业务服务与统一schema，避免controller互调或另写无权限SQL。

## 已有权限防线与验证边界

OpenAPI guard 每次核对active凭证、active用户并限流；MCP Direct authenticate也这样做。两类会话读取有 id+userId 所有者条件，上传有 canManageKnowledgeBase，文档状态有 DocumentAclService，检索底层有ACL/状态/时效裁剪。表格工具检查可读文档与当前发布版本。不能概括为“接口均无鉴权”。

严格输出已存在授权快照/共享锁/来源manifest复验；Direct MCP知识结果可传manifest。问题是部分入口/事件消费/持久化未正确使用，且非strict不等于无需来源依赖。动态撤权验收必须包含凭证撤销、KB/文档ACL变化、版本切换、冷热缓存及历史读取；只验证单元mock成功不足以证明部署行为。

本轮未实施修复；只新增审查文档。标准客户端互操作、多实例/代理Origin和动态撤权端到端尚未验证。

## 独立复现记录

由gpt-6-luna验证，临时spec已删除，未改业务、未访问生产数据库、未运行全量测试：

- 现有MCP 3 suites、26项通过；不能据此否定上述未覆盖分支。
- 真实Nest+Supertest复现OpenAPI普通上传：文件系统/数据库/权限/ingestion为mock，已执行建档，600ms内HTTP不结束而超时；这是框架HTTP响应行为复现，不是真实解析集成或压缩包成功路径实测。
- 真实HTTP复现缓存session分支：注入credential已禁用标记，POST /messages返回200，verifyCredential及rate check调用均为0。未执行真实SSE建立→凭证禁用的完整生命周期，因此不能声称完成动态撤销集成验证。
- 直接service验证非对象payload返回-32600、缺prompt返回isError:true；未验证错误jsonrpc版本是否被HTTP接受。工具隐藏及兼容转发已有spec明确覆盖，属产品决策。
- 局部覆盖率：MCP controller 61.82% statements、service 68.54%；该次统计OpenAPI controller/guard为0%，不是全仓库覆盖率。
- 日志 `/tmp/gbrain-interface-review-luna-20261008-{targeted,http,direct,coverage}.log`，报告 `/tmp/gbrain-interface-review-luna-result.txt`。

建议修复顺序：上传响应与最终事件消费→范围空集→凭证/会话→strict契约及持久化→schema/协议和核心工具补齐。由REST/OpenAPI/MCP共享已授权应用服务，禁止跨controller调用、伪造JWT或复制权限与索引删除清理逻辑。
