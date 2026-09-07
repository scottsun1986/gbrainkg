# LLMWiki / GBrainKG 源码复核与上游复用优化方案

评估日期：2026-09-06。范围：`apps/api`、`apps/web`、`apps/parser-worker`、`packages`、部署配置及相关设计文档。**整个 `3dbuilding` 目录均排除，未扫描。**

本次为源码审查和优化方案，不修改业务实现、不迁移数据库、不更新运行中的上游服务。已有未提交优化按工作区实际代码评估，不以历史验收报告代替验证。

## 1. 结论与架构取舍

项目已有可用的企业知识平台基础：稳定知识库 Source、组织/行业/个人权限、规范 Markdown、增量同步、Source/Scope 双级维护、引用和问答 Trace。GBrain 已通过官方 CLI 接入，AnyDoc 已通过官方 npm 包接入，这些方向应保留。

但目前不能认定为全面符合生产最佳实践。最近的部分优化扩大了自研范围，同时引入了证据校验旁路、重复解析、迁移缺失和不一致质量门禁。尤其“参考 WeKnora”在当前代码里主要表现为自写 GraphRAG，并不是使用 WeKnora 的服务能力；名称相同不能证明效果相同。

**推荐决策：当前保留 GBrain 为主要知识引擎，统一使用官方 AnyDoc 绑定，平台只保留业务权限、文档生命周期、适配与审计。WeKnora 作为独立服务候选进行受控对比；只有可验证地减少自研且满足本项目权限需求，才按知识库迁移检索职责。不要默认把三套完整检索/图谱/Wiki 系统同时上线。**

“不改源码”应理解为不修改 GBrain、WeKnora、AnyDoc 的上游核心源码。修正本项目的调用、业务权限和适配代码仍是必要工作；仅调整配置无法消除本文中的全部缺陷。

## 2. 证据基线与验证边界

### 2.1 上游源码快照

本次从 GitHub 读取并浅克隆官方仓库到临时目录，对照的是确定提交，非搜索摘要或移动的 main 内容。

| 项目 | 官方仓库 / 提交 | 本项目使用情况 |
| --- | --- | --- |
| WeKnora | [Tencent/WeKnora，3d3bb7f6d1acca8caa84bb73b189fe46c30967a9](https://github.com/Tencent/WeKnora/tree/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9)，提交日期 2026-09-06 | 检查范围内未发现正式 WeKnora 服务/SDK 适配；GraphRAG 注释有参考说明 |
| AnyDoc | [firecrawl/anydoc，261fc257d17c3eab0f673be31c408fd9fdc2171a](https://github.com/firecrawl/anydoc/tree/261fc257d17c3eab0f673be31c408fd9fdc2171a)，提交日期 2026-08-28（北京时间） | npm 依赖已固定为 `0.2.4`；本机 CLI 报告 0.2.4。生产路径仅由 API Node 端持有官方包，Parser 不再重复调用 CLI |
| GBrain | [garrytan/gbrain，8c70f6255047a7647adb30b1d6333a48068d9fa5](https://github.com/garrytan/gbrain/tree/8c70f6255047a7647adb30b1d6333a48068d9fa5)，提交日期 2026-09-03 | 部署 Dockerfile 固定 `GBRAIN_VERSION=0.47.6.0`；本次上游快照 package 版本为 0.48.2.0 |

AnyDoc 属于 Firecrawl，并非腾讯仓库。GBrain 当前上游能力不能未经契约测试便当成已部署 0.47.6.0 的能力。本次没有执行升级。

### 2.2 已执行的验证

| 检查 | 结果 | 能证明 / 不能证明 |
| --- | --- | --- |
| API：`./node_modules/.bin/jest --runInBand --silent`，目录 `apps/api` | 8 suites、45 tests 通过 | 单元行为通过；大量依赖使用 mock，不能证明数据库迁移、真实权限闭环和检索准确率 |
| API：`./node_modules/.bin/tsc --noEmit` | 通过 | 编译契约通过；不能发现 `as any` 绕过的数据库模型运行时问题 |
| Parser：`python3 -m unittest discover -s apps/parser-worker/tests -v` | 6 tests 通过 | 本机 CLI 可用、CSV 转换和部分质量规则有效 |
| 实际加载 GraphRagService，以内存仓库替身返回已删除来源的图关系 | 旧片段仍进入 `formattedContext` | 复现了方法未查询来源文档状态的事实；未在业务数据库注入测试数据 |
| 同样方法输入完全不相关问题和已有社区 | 仍返回 1 个社区 | 复现无相关性阈值时无关摘要仍入选 |
| 官方 AnyDoc PDF fixtures + 当前安装 npm 0.2.4 | 文本 PDF 成功；混合 PDF 返回 `needsOcr` / pages=[2]；扫描 PDF 返回 pages=[1,2] | 证实可以直接消费官方结构化 OCR 错误，而不必重新猜测所有 PDF 页 |
| 当前 `marked` 解析含无害事件属性的 HTML 字符串 | 输出保留 `onerror` 属性 | 证实解析不等于净化；未在真实页面执行攻击脚本 |

系统 PATH 未找到 pnpm，因此改用已安装的本地 jest/tsc，未安装或升级依赖。未执行访问生产数据库的 E2E、压力测试或上游完整测试套件；本文不报告不存在的准确率、QPS 或性能提升百分比。

## 3. 需求对应关系

根据当前业务代码和已有设计，本项目的关键需求是：多级组织与角色管理；组织库、行业授权库和个人私有库；Office/PDF/图片/文本入库；中文条款定位、引用预览、跨文档问答；知识图谱和权限范围内的派生知识；管理员配置模型；异步任务可恢复；后续上游升级容易。

其中个人库 owner-only、管理权限与阅读权限分离、动态行业授权，以及业务文档发布/撤回规则，是必须由本项目明确保证的业务约束。不能因为 WeKnora 有租户 RBAC，就推定其工作空间 Admin/Owner 语义与本项目完全一致。

## 4. 已经落实、应当保留的实现

1. [brain-source.ts](../apps/api/src/brain-compiler/brain-source.ts) 以知识库 ID 生成稳定 Source key，权限变化不会改变内容身份。
2. [permission.service.ts](../apps/api/src/permission/permission.service.ts) 区分可管理、可阅读、个人所有者及行业授权。
3. [canonical-document.ts](../apps/api/src/brain-compiler/canonical-document.ts) 优先读取规范正文，避免把有重叠的切片简单拼接为事实源。
4. [brain-compiler.service.ts](../apps/api/src/brain-compiler/brain-compiler.service.ts) 使用 Source 中心同步，并以 Source/文档/版本组成同步任务键。
5. [chat.service.ts](../apps/api/src/chat/chat.service.ts) 原始引用按 published 状态复核；派生页验证来源集合、`aclEpoch`、`knowledgeEpoch` 和来源文档。
6. [brain-scope.service.ts](../apps/api/src/brain-compiler/brain-scope.service.ts) 在 Source 内调用官方 synthesize，保存派生来源；失败回退有标记。
7. [quality.py](../apps/parser-worker/src/quality.py) 把解析成功与内容质量分开，支持乱码、空内容和 OCR 低置信度检查。
8. [model-credential.ts](../apps/api/src/model-credential.ts) 使用 AES-GCM 保存模型凭据；[GBrain Adapter](../packages/gbrain-adapter/src/index.ts) 使用参数数组启动 CLI、有超时和并发控制，不修改上游核心。

这些基础值得继续使用。下面的问题说明的是边界尚未闭合，不意味着整套系统需要推倒重做。

## 5. 按优先级排列的源码发现

### F01 / P0：新增图谱上下文绕过文档状态与证据校验

位置：[graph-rag.service.ts:348](../apps/api/src/graph-rag/graph-rag.service.ts#L348)、[chat.service.ts:275](../apps/api/src/chat/chat.service.ts#L275)、[chat.service.ts:758](../apps/api/src/chat/chat.service.ts#L758)。

Local/Global 图检索仅接收 kbIds，未按 provenance 中 documentId 校验存在性、published 状态、版本和引用有效性。生成的 `graphRagContext` 直接加入模型上下文，不经过原始 citations 的过滤方法。图谱模型也没有到 Document 的关系约束。

因此，某文档删除/撤回后，只要库仍可见且图数据未清理，旧条款可能继续影响回答。这是同库失效证据问题，不能仅凭本次复现断言已发生跨用户数据泄露。真实最小复现已确认旧来源片段可被该方法返回。

建议：先让未通过证据校验的图结果退出回答路径；保留它作为可明确标注的发现视图也必须过滤失效来源。随后优先使用 GBrain 官方 graph/links/facts 或 WeKnora 返回的可回溯 chunk，统一映射成 Evidence，再进入唯一的 ACL/版本/发布状态校验器。

验收：删除、撤回、跨选库、撤销授权及来源版本变更后，旧证据不能进入 rerank、LLM、引用或图谱预览。

### F02 / P0：Markdown 预览存在未净化 HTML 注入路径

位置：[page.tsx:380](../apps/web/src/app/page.tsx#L380)、[page.tsx:758](../apps/web/src/app/page.tsx#L758)、[nginx.prod.conf](../deploy/docker/nginx.prod.conf)。

当前 `marked.parse` 的输出直接交给 `dangerouslySetInnerHTML`；异常回退还会直接把原文插入 HTML。已确认解析器保留事件属性。生产 Nginx 的 script-src 允许 unsafe-inline，不能依靠现有 CSP 消除该路径。可利用性取决于攻击者能否提供并让其他用户查看文档；未做生产攻击验证。

对比：WeKnora 的 [security.ts](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/frontend/src/utils/security.ts) 使用 DOMPurify，文档预览调用净化方法。

建议：直接使用维护中的 HTML 净化库，建立唯一 MarkdownRenderer；高亮和净化顺序统一，异常时使用 React 文本渲染。先做 allowlist 净化，再逐步收紧 CSP。无需复制 WeKnora 整个安全工具文件，也无需修改 marked 源码。

### F03 / P0：图谱模型有 Schema、无配套生产迁移

位置：[schema.prisma:511](../packages/database/prisma/schema.prisma#L511)、[migrations](../packages/database/prisma/migrations)、[docker-compose.prod.yml:87](../deploy/docker-compose.prod.yml#L87)。

`GraphEntity`、`GraphRelation`、`GraphCommunity` 已写入 Schema；现有 SQL migrations 未发现建表内容。生产 bootstrap 使用 `prisma migrate deploy`，并不会根据 Schema 自动建表。

新环境通过现有迁移部署时无法获得这些表；相关服务又 catch 异常继续运行，可能表现为系统可用但图谱静默失效。现有环境是否经手工 db push 创建过表，本次未连接数据库确认。

建议：先决定是否保留本地持久化图谱。保留则提交完整迁移并做空库/已有数据迁移测试；退出该实现则先停用调用并设计兼容撤除，不能删 Schema 后遗留调用。不要通过直接修改上游数据库补救。

### F04 / P1：API Fast Path 绕过统一质量门禁

位置：[ingestion.service.ts:120](../apps/api/src/ingestion/ingestion.service.ts#L120)、[ingestion.service.ts:155](../apps/api/src/ingestion/ingestion.service.ts#L155)、[quality.py](../apps/parser-worker/src/quality.py)。

纯文本非空即标记 passed/1.0；AnyDoc 输出只需十个有效字符即 passed/1.0。Python Worker 才执行更完整的质量检查。结果是同一份内容因选中引擎不同而得到不同质量结论。

不能把 AnyDoc 的转换成功当成 OCR 完整、字体无乱码或图片文字已被识别。官方 AnyDoc 对混合 PDF 的 OCR 页会报错，实测也正确报错，不能把“它一定静默丢混合 PDF 页”当作问题；真正问题是本项目未统一处理错误/质量/资产。

建议：所有路径统一返回 ParseResult，再过一个质量门禁。保留快速转换；去掉快速免检。以 needsOcr 类型直接驱动页级 OCR；记录质量规则版本与异常分类。

### F05 / P1：AnyDoc 重复集成、格式能力与部署环境不一致

位置：[ingestion.service.ts](../apps/api/src/ingestion/ingestion.service.ts)、[anydoc_extractor.py](../apps/parser-worker/src/extractors/anydoc_extractor.py)、[main.py:32](../apps/parser-worker/src/main.py#L32)、[ingestion.controller.ts:47](../apps/api/src/ingestion/ingestion.controller.ts#L47)、[parser.Dockerfile](../deploy/docker/parser.Dockerfile)。

API 用 npm binding，Worker 再调用本机 CLI；失败时可能重复转换。服务内部尝试的格式集合包括 ODT/EPUB/RTF 等，但 API 和 Worker 的接收白名单较窄，存在不可达分支。Python 镜像既不装 AnyDoc CLI，也未声明官方 Python AnyDoc 包，不能用本机 CLI 测试通过来代表容器能力。

建议：选择一个解析入口。低改造方案是统一在独立任务进程中使用已有 Node npm binding，Python 仅承接确有需要的 OCR/版面解析；另一方案是 Worker 使用官方 Python binding，但须验证 0.2.4 对应轮子、接口及目标架构，不应两者长期并存。格式能力从引擎能力清单派生，并在镜像内执行契约测试。

### F06 / P1：自研 GraphRAG 缺少语义与生命周期可靠性

位置：[graph-rag.service.ts](../apps/api/src/graph-rag/graph-rag.service.ts)。

抽取是标题、书名号、词尾和 WikiLink 规则；社区是有向邻接遍历、每簇最多 30 个实体；摘要是固定模板。Local Search 的查询切词主要按标点，整句中文通常形成长词；Global Search 只给最近少量社区计分，即使全部零分也选入。

同一关系重复 upsert 会增加权重 0.5，却不合并新 provenance；同名实体 update 不合并 docIds；入库传入的是 splitMarkdownIntoChunks 的数组，其中没有数据库生成的 chunkId，因此调用路径会丢失细粒度引用。社区先删后逐个建，非原子替换。这些问题位于本项目代码中，并非上游缺陷。

建议：不继续追着 WeKnora 的内部算法仿写。优先复用一个上游图检索实现；若业务确实需要独立展示图，仅保存带 source/version/provenance 的投影。规则发现结果应标注为候选关联，不充当证实的事实或模型生成的研究结论。

### F07 / P1：Outbox 尚非事务型闭环，任务幂等有缺口

位置：[brain-outbox.service.ts:40](../apps/api/src/brain-compiler/brain-outbox.service.ts#L40)、[ingestion.service.ts:79](../apps/api/src/ingestion/ingestion.service.ts#L79)、[ingestion.controller.ts:139](../apps/api/src/ingestion/ingestion.controller.ts#L139)。

业务修改、创建 BrainChangeEvent、Redis enqueue 分别执行；Outbox 方法不接受业务事务对象。事件写入后 enqueue 失败存在 pending 残留窗口；在本次扫描范围未找到专门补投 pending/超时 processing 的 dispatcher。定期权限 reconcile 有补偿价值，但不等于所有事件可靠投递。

解析 enqueue 没有稳定 jobId，多实例启动恢复、用户重试可能重复解析；已具备版本任务键的 Source sync 应保留。建议把业务修改与事件放同一个 PostgreSQL 事务，dispatcher 租约领取、可重投；消费者按文档版本幂等。继续使用 Prisma + BullMQ，没必要引入另一套消息基础设施。

### F08 / P1：Parser 异步状态为进程内字典，超时和读鉴权不一致

位置：[main.py:51](../apps/parser-worker/src/main.py#L51)、[main.py:1029](../apps/parser-worker/src/main.py#L1029)、[ingestion.service.ts:216](../apps/api/src/ingestion/ingestion.service.ts#L216)。

tasks 存在内存中；多 worker/实例的 POST、GET 可能落在不同进程；重启丢失任务。满 5000 个任务时最老任务可能被删除，不区分是否在运行。POST 依赖 verify_auth，但 GET `/parse/{task_id}` 无同等依赖，会返回正文；服务如可被直接访问，持有 task_id 者可读取结果。

API 默认等 300 秒，OCR 默认允许 900 秒，导致 API 已重试而 OCR 旧任务仍在跑。建议让 BullMQ 成为唯一任务状态/重试所有者，Python 提供内部解析执行接口；若继续异步，则状态持久化并绑定调用主体。统一 timeout budget、取消语义和孤儿任务回收；所有结果读取验证身份。

### F09 / P1：检索适配层偏厚、资源限制并非进程全局

位置：[gbrain-adapter/index.ts:264](../packages/gbrain-adapter/src/index.ts#L264)、[index.ts:981](../packages/gbrain-adapter/src/index.ts#L981)、[index.ts:1067](../packages/gbrain-adapter/src/index.ts#L1067)。

Adapter 约 1114 行，包含进程池、Git、配置、正文定位、缓存和跨 Source 汇总。多个 Service 各 new 一个 Adapter，各自持有并发池和锁，因此 `GBRAIN_MAX_CONCURRENCY=4` 不是整个 API/多实例合计 4。queryMany 分批逐源 query，每个 Source 会各自展开、重排、回填正文；最终只保留 8/40 个结果之前已经产生较多成本。

缓存 key 缺模型/文档版本；本地 invalidate 无法跨实例即时失效。去重 key 对非 document 派生页缺少 source identity。遇到 CLI 非预期 JSON 时回退空数组，易把协议变化误报为“无知识”。diagnostics.stages 固定列出多个阶段，不能作为这些阶段本次真实成功执行的证据。

建议：依赖注入共享 Adapter；跨实例 Source 写锁与任务配额外置；缓存含 Source 知识世代、模型配置世代和查询参数；协议用 schema 验证，区分无结果/降级/协议错误。研究官方 HTTP/MCP 的有范围联合读取，版本兼容后再迁移，不能向无 scope 全局端点直连。

### F10 / P1：正文回填和流式生成缺少统一 token/取消预算

位置：[markdown-chunker.ts](../apps/api/src/ingestion/markdown-chunker.ts)、[gbrain-adapter/index.ts:977](../packages/gbrain-adapter/src/index.ts#L977)、[chat.service.ts:761](../apps/api/src/chat/chat.service.ts#L761)。

`length / 4` 是粗略字符估计，不是中文实际 token；回填正文用字符预算且逐 Source 单独计算；超过剩余预算的父页整体跳过，长文可能只剩旧 snippet。最终生成 fetch 未设置 signal，而改写路径有 12 秒超时；模型流式读取也未见统一的连接断开取消链。

建议：使用模型 tokenizer 或保守校准预算，把系统提示、历史、图证据、正文、输出预留纳入一个预算；优先定位命中章节与相邻块。以请求级 AbortSignal 贯穿调用，设置首 token/总时长/无数据超时。引用定位信息与检索引擎切片独立映射，避免把本地切片误认成 GBrain 实际索引切片。

### F11 / P2：工程组织和配置面仍有较高维护成本

位置：[page.tsx](../apps/web/src/app/page.tsx)、[admin.controller.ts](../apps/api/src/admin.controller.ts)、[model-config.service.ts](../apps/api/src/model-config.service.ts)。

前端主文件约 6754 行且 eslint-disable；AdminController 约 1962 行；多个服务直接 new PrismaClient。DTO 多为结构类型/any，使全局 ValidationPipe 无法自动替代字段运行时校验。模型配置动态注入环境和 CLI 配置，应对并发请求、旧配置缓存和 embedding 维度变更建立明确流程。

建议：拆出文档/权限/会话/模型管理模块，统一 PrismaService 与 API client；使用 DTO/schema 约束上游协议；凭据加密方案保留。把模型配置变更作为有版本的管理操作，禁止在问答热路径反复写共享配置。按风险拆分，无需一次重写 UI。

## 6. 与 WeKnora / AnyDoc 源码逐项对比

| 能力 | 当前实现 | 上游实现证据 | 本项目取舍 |
| --- | --- | --- | --- |
| Office 解析 | API npm + Python CLI 两入口 | AnyDoc 官方 [Node API](https://github.com/firecrawl/anydoc/blob/261fc257d17c3eab0f673be31c408fd9fdc2171a/node/anydoc.js) 提供 toMarkdown/toMarkdownBytes/toDocument | 直接用官方绑定，合并入口；不复制 Rust parser |
| 图片/结构保留 | 主要只取 Markdown 字符串 | AnyDoc [类型定义](https://github.com/firecrawl/anydoc/blob/261fc257d17c3eab0f673be31c408fd9fdc2171a/node/index.d.ts) 有 blocks/assets；WeKnora [backend_cgo.go](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/internal/infrastructure/docparser/anydoc/backend_cgo.go) 提取资产并保留位置关系 | 用官方文档模型取资产；OCR/VLM 是否开启由配置和内容决定 |
| PDF OCR | API 捕获所有异常统一退回 Worker | AnyDoc [pdf.rs](https://github.com/firecrawl/anydoc/blob/261fc257d17c3eab0f673be31c408fd9fdc2171a/src/formats/pdf.rs) 返回 NeedsOcr；Node 暴露页码 | 消费结构化错误，保留本项目已有百度 OCR；hosted OCR 不是默认必选 |
| 引擎选择 | 扩展名 if/else，多处列表 | WeKnora [engines.go](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/internal/infrastructure/docparser/engines.go) 注册引擎、检查可用性和默认引擎 | 若继续本地解析，只实现薄配置路由；选用 WeKnora 时直接配置其引擎 |
| 切片与上下文 | 字符窗口、section metadata、父页回填 | WeKnora [merge.go](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/internal/application/service/chat_pipeline/merge.go) 包含父块解析、邻块扩展、重叠合并和去重 | 检索块交给一个引擎；平台仅保留文档引用定位，不自建第二套完整 chunk pipeline |
| 重排 | GBrain 原生优先，平台有补偿重排 | WeKnora [rerank.go](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/internal/application/service/chat_pipeline/rerank.go) 独立阶段、阈值和错误降级、trace | 优先复用主引擎重排；只有跨引擎候选融合时才需要统一额外重排 |
| 实体/关系抽取 | 正则+模板 | WeKnora [graph.go](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/internal/application/service/graph.go) 调模型抽取并维护实体/关系与 chunk 的联系 | 不继续把本地规则图包装为同等 GraphRAG；复用 GBrain 或独立 WeKnora 服务 |
| 图检索 | kbIds 过滤后直接拼上下文 | WeKnora [search_entity.go](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/internal/application/service/chat_pipeline/search_entity.go) 有 KB/Knowledge namespace，图候选再回到 tenant 内 chunk | 统一证据结构和 ACL；不把原始图字符串当可信上下文 |
| API 权限 | 业务 ACL 较贴合本项目 | WeKnora [rbac.go](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/internal/router/rbac.go)、[qa.go](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/internal/handler/session/qa.go) 校验调用目标和 API key scope | 保留业务 ACL；引擎 scoped identity 加一层保护，不能用上游管理员权限替代 |
| 异步任务 | BullMQ 外层 + 内存 Python task 内层 | WeKnora [knowledge_task_options.go](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/internal/application/service/knowledge_task_options.go) 配置队列、重试和超时 | 保留 BullMQ，统一任务所有者；无须照搬 Asynq |
| 安全渲染 | marked → raw HTML | WeKnora [security.ts](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/frontend/src/utils/security.ts) 使用 DOMPurify | 直接用净化库，统一渲染入口 |
| 升级隔离 | GBrain CLI + 固定版本较好，AnyDoc 容器不一致 | WeKnora 自身 [go.mod](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/go.mod) 暂时 vendor AnyDoc Go binding，[build-anydoc-lib.sh](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/scripts/build-anydoc-lib.sh) 对固定 crate 暴露序列化方法 | 不把腾讯的 Go/CGo 临时兼容补丁搬到本项目；使用官方 npm/Python 包或完整 WeKnora 发布镜像 |

注意：WeKnora 此快照的 Go binding/crate 版本与本项目 npm 0.2.4 并不相同；不能直接认为腾讯集成更新。上游自身也有 fallback、vendor 与边界条件，需要按实际发布包测试，不应将其当作无缺陷标准。

## 7. 三种可选架构与推荐路径

| 方案 | 职责 | 适用条件 | 主要代价 | 建议 |
| --- | --- | --- | --- | --- |
| A：GBrain 主引擎 + 官方 AnyDoc | GBrain 管检索/图知识/记忆/派生；本项目管业务和文档生命周期 | 延续当前能力、看重长期知识和低迁移成本 | Adapter 和任务链需要收敛 | **当前推荐** |
| B：WeKnora 文档检索 + GBrain 记忆/派生 | WeKnora 管原始文档索引/检索，GBrain 只承担明确的记忆或精选派生任务 | 试点证明 WeKnora 更适合文档问答、多模态/连接器需求 | 两服务运维、权限映射、跨系统撤回和引用映射 | 验证后采用，不默认双重索引全量原文 |
| C：WeKnora 全面承接知识引擎 | 文档、检索、图和 Wiki 统一在 WeKnora | 其能力及权限模型完整满足要求，GBrain 差异价值不再需要 | 迁移大、需重验私有库和组织权限 | 作为长期替代选项，不建议立即执行 |

本次代码审查能支持 A 的短期优先级，不能替代 A/B 的真实业务检索评测。若 B 获胜，应明确迁移检索职责，而不是把 WeKnora 每次问答结果再交给 GBrain 重检索/再重排。

### 7.1 推荐结构

```text
业务前端
   │
业务 API：身份、组织/行业/个人 ACL、文档状态、模型配置、引用、审计
   ├── ParsePort → 解析任务进程 → 官方 AnyDoc → 必要时 OCR/版面解析
   │                                  │
   │                           统一 ParseResult 与质量门禁
   ├── PostgreSQL：业务元数据、规范正文版本、Outbox、引擎资源映射
   ├── BullMQ Worker：同步、删除、重试、维护与补偿
   └── RetrievalPort → 当前 GBrain / 试点 WeKnora（按库指定主引擎）
                             │
                     统一 Evidence + 最终 ACL/版本校验
                             │
                       统一上下文预算 → LLM → 可追溯引用
```

各上游使用自己的数据库/命名空间和迁移工具。本项目不读取或改写 WeKnora 内部表，也不向其内部 service 包建立源码依赖；GBrain 同理。规范正文与业务文档版本是跨引擎重建的稳定来源。

### 7.2 应由平台维护的最小契约

- `ParseResult`：schemaVersion、documentId、version、engine/version、markdown、blocks、assets、pageCoverage、needsOcrPages、warnings、qualityStatus。
- `Evidence`：engine、engineResourceId、businessKbId、documentId、documentVersion、sourceId、chunk/span、page/section、text、scoreKind、score、provenance。
- `RetrievalScope`：userId、明确非空的允许 KB/Source 集合、selectedKbIds、aclEpoch、knowledgeEpoch；没有权限时禁止发请求，不允许空数组被引擎解释为全库。
- `EngineMapping`：业务 KB/document/version → 引擎 KB/knowledge/source/slug；唯一键及同步状态持久化。引用永远返回业务 ID，不暴露可绕过业务 ACL 的上游直链。
- `EngineCapabilities`：支持的格式、结构化 OCR 错误、联合检索、图查询、删除、取消等；能力不足显式降级，不能捕获异常后报告成功。

这些是本项目适配接口，不是假称上游已经提供同名 API。

### 7.3 WeKnora 如何做到不改源码接入

已核对源码存在以下检索入口：`POST /api/v1/knowledge-search`，支持 query、knowledge_base_ids、knowledge_ids，返回检索结果而非生成答案；还有 KB hybrid-search、knowledge/chunk 管理入口。依据：[routes_chat.go](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/internal/router/routes_chat.go)、[session/types.go](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/internal/handler/session/types.go)、[routes_knowledge.go](https://github.com/Tencent/WeKnora/blob/3d3bb7f6d1acca8caa84bb73b189fe46c30967a9/internal/router/routes_knowledge.go)。

实施时使用官方发布镜像和 HTTP API，建立独立 `weknora-adapter`。先映射业务库/文档，再用受限凭据检索，结果映射成 Evidence 后复核业务权限。浏览器不接触服务管理员 key。retrieval-only 端点不应假定自动执行 Agent QA 的所有 query-understand/graph/Wiki 阶段，需验证返回契约和配置。

个人库应根据威胁模型选择上游私有工作空间/独立实例/受限机器身份，避免映射到一枚可读全企业数据的浏览器 key。业务“超级管理员不读他人个人库”仍由本项目权限层和上游隔离设计共同保证。

### 7.4 GBrain 如何继续减薄适配

短期保留已工作的官方 CLI，只治理单例、锁、缓存、协议解析和预算。中期验证官方 MCP/HTTP scoped client：OAuth `--federated-read` 控制可读 Source，底层范围限制可作为业务 ACL 的第二层。参考：[官方企业 Brain 教程](https://github.com/garrytan/gbrain/blob/8c70f6255047a7647adb30b1d6333a48068d9fa5/docs/tutorials/company-brain.md)。

授权 scope 不是每次请求随便传一个数组就自动生效；客户端授予范围、当前用户权限、选定库三者必须取交集。不能把当前逐 Source query 换成无范围全局 query。是否能完全复用当前 0.47.6.0，要通过真实协议测试再决定。

## 8. 实施顺序和验收条件

| 阶段 | 工作 | 退出标准 |
| --- | --- | --- |
| 第一阶段：可信性收敛 | F01 图证据校验、F02 安全渲染、F03 迁移一致性；统一 ParseResult 质量门禁；结果接口鉴权 | 失效文档不进入回答；HTML 事件不执行；空库迁移成功；所有引擎同门禁 |
| 第二阶段：减少自研与环境差异 | AnyDoc 单入口；能力驱动格式配置；Prisma/Adapter 单例；错误分类；冻结上游版本 | 开发/镜像解析契约一致；无需依赖宿主机隐式工具；不修改上游源码 |
| 第三阶段：可靠性 | 事务 Outbox、dispatcher、版本幂等、删除 tombstone、取消/超时、跨实例锁和缓存世代 | 重启/Redis 短断/重复投递不漏不重；删除后无残留可读证据 |
| 第四阶段：检索成本与上游试点 | GBrain 联合检索契约验证；WeKnora 独立沙盒；同语料评测；按库路由 | 安全边界先通过，随后比较定位准确性、引用、延迟与成本；选择一个主检索引擎 |
| 第五阶段：升级和工程治理 | UI/服务分模块；自动契约测试；升级预演；备份恢复演练 | 上游版本更新只涉及版本清单/适配契约，业务功能不依赖上游内部表或文件 |

以上是实施顺序，不承诺未经测量的工期或性能收益。先处理 P0/P1，前端拆分不应阻塞数据正确性修复。

### 必补验收样本

1. 文档生命周期：上传、重复上传、重试、版本更新、撤回、删除、删后立即问答、删后重建索引。
2. 权限：组织父子级、行业授权撤销、个人 owner-only、管理员管理但不读取、明确选库、空 scope、跨 Source 同标题。
3. 解析：文本/扫描/混合 PDF、坏字体、图片型 PPTX、Office 嵌图、合并表格、超长表、加密文档、超时、损坏文件；Word/表格允许格式以镜像真实能力为准。
4. 引用：正确文档、正确版本、正确章节/页码、原文一致性；图事实必须映射到这些证据。
5. 故障：创建事件后 Redis 不可用、Worker 重启、重复消息、解析超时、上游协议变更、模型不可用、客户端断开。
6. 安全渲染：事件属性、恶意链接、SVG、原始 HTML、代码块、高亮后再净化、解析失败回退。
7. 检索评测：精确条款、同义改写、跨文档对比、全部清单、无答案、矛盾版本；记录 Recall@K、MRR/nDCG、引用正确率、无答案误答率、P50/P95、token/成本。目录数量使用业务 SQL，不让向量 Top-K 冒充完整列表。

A/B 评测使用相同授权语料、相同问题和尽可能一致的模型/预算；区分“引擎原生模式”和“平台统一处理模式”。评测阈值须依据业务标注和基线确定，本次没有凭空给出准确率提升目标。

## 9. 上游升级纪律

1. 维护依赖清单：上游版本/tag、commit、镜像 digest、API/schema 版本、模型与 embedding 维度、解析器版本。lockfile 已起作用，不应忽略已有锁定成果。
2. GBrain、WeKnora、AnyDoc 独立升级，优先官方已发布工件；检索引擎和 embedding 模型不要同批变更。
3. 用脱敏代表性语料做升级前后契约和检索回归；对任何权限回归拒绝切流。
4. 灰度按 KB/租户明确路由，记录当前主引擎。切换前同步 watermark 对齐；回退前确认迁移兼容，不盲目把旧二进制连回不可逆新 Schema。
5. 业务 DB、原文件/规范正文、GBrain Git Source、引擎数据库分别备份；恢复流程必须演练。
6. 若上游缺少接口：先配置/公开 API/官方扩展点，再独立适配；确有缺口可提上游 issue/PR。本次只提出方案，没有发送外部消息或提交 PR。
7. 不复制 WeKnora 的 Go internal 包、vendor 目录、Rust patch 构建脚本到业务仓库；不在上游源码内塞业务组织 ACL；不依赖未承诺的数据库表。

## 10. 最终建议

当前最值得做的优化是让已有 GBrain/AnyDoc 能力经过一致的权限、质量与任务契约，而不是增加更多名称类似的自研模块。近期选 A，先修复可信性和部署一致性；WeKnora 用官方服务进行真实试点，证明确有业务增益后再接管明确的能力边界。这样既保留已投入的业务能力，也能把未来升级控制在工件版本和薄适配层内。
