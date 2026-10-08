# 架构审查实施与验收记录

日期：2026-10-08。依据：[审查原文](ARCHITECTURE-CODE-REVIEW-2026-10-07.md)。本记录区分代码修复、自动化回归、真实环境实测；没有部署生产，没有产生全球 SOTA 或性能提升结论。

## F01–F10

| 项目 | 实施 | 回归入口与实测边界 |
|---|---|---|
| F01 聚合授权 | inventory 在文本构造前批量 ACL/时效过滤，按 KB ID 构造独立上下文；聚合强制精确 sourceDocumentIds；restricted 空 ACL 使用 DocumentAclService 一致裁决 | `review-regressions.spec.ts`、`citation-assembly.spec.ts`、`citation-assembly-acl.spec.ts`；真实模型请求/SSE/多主体撤权矩阵仍需测试实例验证 |
| F02 热缓存 | 子查询缓存复用 fallbackChunkToCitation 的统一转换，保留 documentId→docId、chunk/version/span/来源字段 | `review-regressions.spec.ts`、`retrieval-arms.spec.ts`；同语料冷热 Recall 成本由消融工具采集 |
| F03 惰性回填 | 编译成功后使用可达条件读取新卡片，实际新增条数决定 trace；强授权保持不执行未授权 compiled-truth 精确路径 | `chat.service.spec.ts`、`review-regressions.spec.ts`；未将编译次数当证据贡献 |
| F04 派生 guard | evidenceContext 保留 scope、sourceKeys、ACL/knowledge epoch 与用户；再次授权保持所选范围；全部来源核对版本/hash/时效/ACL | `review-regressions.spec.ts`、`citation-assembly-acl.spec.ts`；撤权后的历史一致性由同一 dependency validator 裁决 |
| F05 引擎策略 | chat/agent 统一 chunks_only 禁用引擎；空候选引擎结果不挤掉 DB 分支；可用性按真实引用判断 | `review-regressions.spec.ts`、`chat.service.spec.ts`；无引擎调用测试与实际 subprocess 观测分别记录 |
| F06 Top-K 前授权 | `readable-document-scope.ts` 编译 ACL/owner/admin/组织/时效等价谓词，dense、BM25/lexical、结构、图谱及浏览列表在 LIMIT 前约束；保留最终复验 | `readable-document-scope.spec.ts`、`lexical-index.integration.spec.ts`、图谱测试；ANN 过滤后的 Recall/EXPLAIN 须实测 |
| F07 能力闭环 | 采用审查明确允许的配置拒绝方案：CORE_VERSIONING 与 BGE sparse/maxSim 组合在启动时报错，避免宣布未构建索引 ready；核心 dense/BM25 不增加可选服务依赖 | `embedding.service.spec.ts`；未实现版本 sparse/multi-vector 工件，组合明确不支持 |
| F08 资源截止 | 检索臂统一预算登记；dense/lexical/graph SQL 和结构 ORM 在事务设置服务端 statement_timeout，按剩余预算约束；权限预算独立，撤权/取消不能吞为普通无结果；WeKnora shadow 移至离线比较 | `query-execution.spec.ts`、`readable-document-scope.spec.ts`、`lexical-index.integration.spec.ts`；慢查询截止后的数据库活动连接与模型 in-flight 仍需故障注入 |
| F09 历史依赖 | capture 追踪原文+所有聚合来源；混合中任一缺失 manifest 拒绝；inventory 为显式对象，source ID 与 KB 绑定，inventory+otherEvidenceDocumentIds 必须精确覆盖全 dependencies，零库存重验所选 KB 完整可读有效集合；历史/轮询/缓存复用 validator | `evidence-dependencies.spec.ts`、`chat-run.service.spec.ts`、`strict-output-permit.spec.ts`；删除/撤权/版本/时效以同一源清单裁决 |
| F10 预览传输 | 方法级 document-preview-transport 明确接受签名 token，绑定 user/KB/doc/version/expiry；其他入口保持登录认证；文件出口 fresh active、KB、文档 ACL、版本复验 | `document-preview-token.spec.ts`、`knowledge-base.controller.spec.ts`、`auth.guard.spec.ts`；OnlyOffice 真正服务端抓取未联调 |

## 节点、图谱质量与提示词建议

| 原审查建议 | 实施与证明边界 |
|---|---|
| §3 区分“启动/召回/消费/有效” | QueryExecution 以稳定 evidence ID 记录各臂启动/跳过、候选、授权、重排、上下文估计 tokens、最终引用、耗时与退出原因；同前缀文本不再充当 RAPTOR 去重 ID。质量有效性由配对消融证明，trace 数量不代表增益 |
| §3 RAPTOR 重叠与来源 | 全局 Level 2 的 sourceChunkIds 原来实际保存 Level 1 节点 ID，现于 RepeatableRead 来源快照解析至精确文档与当前原文 Chunk，并将当时 sourceManifest 传至后续过滤防止更新后重新盖版本；文档摘要同样验证实际源 chunks，缺失/换版本拒绝；真实版本传入引用，拒绝把旧摘要包装当前版本 |
| §3 图谱质量只读审计 | 新增 `apps/api/scripts/graph-quality-audit.ts`；显式 KB UUID、只读事务、SQL timeout，报告无来源、失效版本/缺失 chunk、重复 provenance、别名碰撞和多来源实体复核候选。未连接真实数据运行，不声称已证明同名错合并或别名归一正确 |
| §3 浏览图与事实图区分 | Web 使用“文档关系浏览”并明确共同主题是相关线索；检索 GraphEntity/Relation 继续以 provenance 约束。不同图数量不能混称事实关系数 |
| §5.2-1 数据与指令层级 | 主回答 system 保留可信规则，原文、标题、历史、个人记忆改为 user 消息结构化 JSON；明确数据不得修改指令。来源含编号、document/version/chunk/evidenceRefs，最后展示编号保持一致。未宣称完整防御所有 prompt injection |
| §5.2-2 规则冲突与计算 | 决定性取值忠实来源，允许保留含义的日期翻译与应用类型化计算；主生成器不假定该请求提供工具，计算只接受 coverage=1 的应用结果；既有表格聚合路径保持完整范围裁决 |
| §5.2-3 语言路由 | 去掉“无汉字即 English”强制英文结论；按用户指定语言或问题语言作答，包括日/韩/阿语。多语言效果必须独立金标验证，未声称覆盖全球语言 |
| §5.2-4 前缀缓存 | 删除“100% KV cache hit”注释保证；稳定规则与实际供应商缓存 tokens 指标分开。没有伪造缓存命中率 |
| §5.2-5 句级核验 | 删除最终 judge 证据前 6000 字符截断；请求内按 statement、完整 evidence、source manifest、model/endpoint/policy、authorization 复用结果；失败不缓存。词面/LLM judge 均不视为形式逻辑证明 |
| §5.3 最小提示结构 | 保留本项目引用/范围/多跳/冲突等策略，可信通用规则与对应任务的动态指令分离；目录和表格专用规则按结构计划/表格证据加载；结构化资料作为数据。未复制开源产品允许外部常识的规则 |

图谱只读审计由具备授权范围的操作者在测试数据库运行：

```sh
cd apps/api
pnpm exec ts-node scripts/graph-quality-audit.ts <测试知识库UUID>
```

DATABASE_URL 必须预先指向测试实例；该脚本不切换身份、不改图、不自动合并节点。别名碰撞和多来源实体只产生人工复核候选，不能据计数自动判为错合并。实体消歧须按出处属性裁决；没有新增业务专用同义词或正则加权分支。

## §6 性能与复杂度逐项映射

| 原优化行 | 实施 | 仍需实测的内容 |
|---|---|---|
| 先修 F02–F05 | 缓存转换、回填条件、guard 保留、禁用引擎零调用与空结果 fallback | 冷热效果和通道独有增益 |
| embedding 与 lexical/结构并行 | 移除基础召回前全批 prime 阻塞，dense 臂自行复用模型指纹 embedding cache，lexical/结构同时启动 | 多并发下 embedding 调用/连接峰值 |
| Source 新鲜度与答案缓存顺序 | 不可省略授权/知识修订保持在前；已验证答案缓存先于 Source 新鲜度；chunks_only 跳过不使用的 Source 检查；现有异步对账继续承接同步 | 缓存动态撤权、首次索引落后时的一致性与后台收敛时间 |
| 多次 grounding/judge | statement/source/model/policy/auth 的请求内判定复用，无尾部截断 | 实际调用、tokens 降幅与事实支持率 |
| SQL/模型分支预算 | QueryExecution 统一阶段记录、服务端 SQL 上界、为生成预留调用和输入预算；授权检查独立预算；shadow 离线 | 人工慢 graph/SQL/embedding 的 in-flight 与池回收 |
| RAPTOR/Scope/社区重叠 | 稳定来源去重、导航回原文；QueryExecution 记录最终贡献，消融工具逐臂与联合比较 | 没有证据证明哪个通道可删除，所以未仅因节点重叠擅自删索引 |
| Scope 全量与增量 | keyset 分页读取 source 文档元数据并完整扫描 source chunk manifest，复用未变化版本/hash 的 manifest 与 source synthesis，受控并发 3；model/config/source manifest 指纹约束复用 | 大语料内存、编译耗时、模型费用；完整清单不冒充全部事实已综合 |
| 图 UI 高频词与链接 | 高频共同词不构造二次方文档 clique，共同主题节点保持导航；ACL 在 take 前裁剪；图 API 独立文档分页、按根节点加载局部边和出处，前端按需翻页/展开；缓存按授权修订、可读集合更新及文档版本/hash 指纹失效，浏览和事实语义明确 | 大图交互及版本化边投影缓存收益须按真实 UI 使用负载验证 |
| §6.2 结构偏置与动态预算 | 至少半数位置覆盖，剩余按实体关系未解析/类型冲突代理信号与成功图谱零命中反馈分配，可增加采样但不超过配置硬上限；full 模式全覆盖。失败反馈仅未来抽取优先级，不写事实，按 KB 知识版本指纹隔离、24h 过期、每作用域100词/最多128作用域，进程内保存；反馈身份进入增量产物指纹。Scope 长综述按问题取段 | 信号不是校准置信度；结构/表格金标与召回、成本收益尚未实测；失败反馈未跨进程持久共享 |
| §6.3 计量 | evidence ID 贯穿候选、授权、重排、上下文和最终引用；模型计调用及实际 usage、预算退出，report 携带 authRevision/versionManifest；现有 ChatRun 阶段保留 | ChatTiming 输出真实 queue/auth/retrieval/rerank/context/generation/verification/persistence spans（重叠区间合并）；providerFirstText/answerPrepared/transportFirstText/transportComplete/runReady 分开。服务器trace持久化 pipeline_timing，poll返回 timing/runReadyMs/pollServedMs；浏览器实际 Markdown 挂载且可见相交后双 rAF 观测，经 owner+来源授权 ACK 写 client_render_timing。双 rAF 只是渲染机会，非物理显示保证；费用需真实供应商用量，估算context tokens不冒充账单tokens |

## §7 评测与发布证据门槛

新增 [配对消融工具说明](../tests/evaluation/intl-benchmark/ABLATION.md) 与 `ablation_eval.py`，复用现有 official-qrels IR 和配对 bootstrap。固定 corpus/chunker/embedding/reranker/generator/judge/预算/并发/cache/各模型价格，支持显式 argv collector；默认只读已采集实验，不更改或部署服务。每题失败也进入完整 repeat，模型用量缺失不得补零。

| §7 验证建议 | 实施/产物 |
|---|---|
| 正确性矩阵 | F01–F10 的授权、restricted 空 ACL、不同 KB/版本、冷热缓存、引擎禁用、超时、预览 token、依赖及零库存回归入口如上；新增应用访问边界见 `RLS-BOUNDARIES.md`。真实多主体 SSE/轮询/模型输入联测仍应执行 |
| 固定基线与逐臂消融 | manifest 的 baseline dense+BM25+rerank；独立增加 GBrain/graph/RAPTOR/Scope/HyDE/DRIFT/补检以及联合组合；固定协议不同直接拒绝比较 |
| 检索与答案分开 | Recall/nDCG/MRR/MAP 从 qrels；必要证据链召回/完整链、独立标注事实支持/引用准确/答案正确、可回答错误拒答/不可回答无依据回答分开统计 |
| 同协议公开任务 | corpus/queries/qrels/labels 与全部 run SHA256，提交/工作树/模型/评委指纹进入报告；私有与公开分库，不混分；inputScope 未验证必须标 unverified |
| 成本/规模/故障/CI | 每题 calls、input/cached/output tokens、按真实模型价格成本、P50/P95/P99 耗时与首个可见文本、成功率；重复运行按 query 配对，同时 95% bootstrap CI；普通/复杂、冷热、规模、ACL 选择率、并发与故障注入以不同固定实验 manifest 运行 |

只有实际完成加载范围核对、金标/评委盲审抽样、完整协议与配对实验，才有依据关闭长期无独有有效证据的通道或对具体维度声明结果。工具存在与单测通过不等于全球 SOTA，默认缓冲输出的模型首 token 不等于用户首个可见答案。

## 验证记录（分页、动态预算与计量补项前）

- `ablation_eval.py`：Luna 执行 `python3 -m unittest test_ablation_eval`，4 项通过；仅验证指标/协议/缺失用量拒绝，未运行真实基准。
- 最终 `pnpm test`：Turbo 6/6 任务通过；API 167 个 suites 通过、1 跳过，1446 项通过、5 跳过；Web 75/75 通过，Web 构建通过。
- API 构建通过；定向回归 20 个 suites、313 项通过；真实本地测试数据库 lexical integration 5/5 通过。
- CORE_AUTH_ENFORCE × CORE_VERSIONING_ENABLED 四种组合各 8 个 suites、66 项通过；这些是自动化契约回归，不代表真实服务组合已完整联调。
- 图谱只读审计脚本独立 TypeScript 检查通过，未读取实际图数据；`git diff --check` 通过。
- 日志：`/tmp/gbrain-review-full-test-sealed.log`、`/tmp/gbrain-review-targeted-sealed.log`、`/tmp/gbrain-review-api-build-sealed.log`、`/tmp/gbrain-review-lexical-final.log`、`/tmp/gbrain-review-matrix-auth{0,1}-version{0,1}.log`。验证由 gpt-6-luna 执行。
- 尚未实测：OnlyOffice 服务端抓取、动态权限完整端到端矩阵、ANN/SQL explain 与故障后的资源回收、大规模编译/图浏览、完整公开协议与私有集消融、真实费用/延迟。
- 未发布生产。

### 计量字段采集链

- SSE 最终 `done.pipeline_timing` 与历史 `processingTrace[id=pipeline_timing].details`：服务器相对耗时与 phases；数据库消息写入/引用写入是 persistence，遥测 JSON 更新不计为业务持久化。
- `GET /chat/runs/:runId` 的 `timing.runReadyMs/pollServedMs`：从该 run.startedAt 起的完成/读取时点；不能与服务器请求startedAt的时点直接相减。
- `processingTrace[id=client_render_timing].details.firstVisibleMs/finalVisibleMs`：从本浏览器发送问题前 performance.now 起算。当前轮询一次显示完整回答，所以首可见和最终可见可相等；未前台可见不会 ACK；刷新后没有原始客户端钟就不编造耗时。
- 消融 collector 的 `usage.visibleMs` 映射客户端 `firstVisibleMs`，`usage.latencyMs` 由客户端完整终态请求/轮询计时取得；不得用providerFirstText替代。独立运行客户端未执行浏览器观测时，该字段未采集，应拒绝完整延迟比较而非填零。
- `usage.byModel` 仍须采集真实供应商/模型网关明细并按模型计价，现有 QueryExecution 聚合用量不能伪造为逐模型用量。collector是显式实验适配器，工具不会自动请求API或补不存在的usage字段。


## 补项后的最终验证

2026-10-08，由 `gpt-6-luna` 独立 CLI 验证稳定工作区：

- 根目录 `pnpm test`：Turbo 6/6；API 168 suites 通过、1 跳过，1460 项通过、5 跳过；Web 76/76 通过。
- API build 与 Web build（包含 TypeScript 检查）通过；计量、图分页/缓存、动态抽取、Scope、权限定向 13 suites、108 项通过；`git diff --check` 通过。
- 动态预算新增覆盖位置与优先级、采样增加/硬上限/zero/full；反馈覆盖 KB/知识版本作用域隔离、多批输入100词上限、128作用域上限及24h过期。反馈只影响未来抽取，不替代版本/授权裁决。
- 图分页回归覆盖页面/total、知识版本变化失效与局部来源授权；Scope 覆盖201文档跨页完整manifest。计量回归区分供应商、准备、传输与浏览器渲染机会，覆盖owner约束、输入校验及原子trace更新。
- 补项首轮发现的图页面出处调用参数不足、Prisma count类型分支、旧cache spec缺少新增范围读取mock均已修复；稳定工作区终轮重跑通过。Web workspace不直接提供 `tsx`，孤立调用未运行，仓库定义的测试命令已成功执行对应渲染计量测试。
- 日志：`/tmp/gbrain-final-luna-rerun-focused.log`、`/tmp/gbrain-final-luna-rerun-pnpm-test.log`、`/tmp/gbrain-final-luna-rerun-api-build.log`、`/tmp/gbrain-final-luna-rerun-web-build.log`；最终报告 `/tmp/gbrain-final-luna-rerun-result.txt`。

代码建议已落实；真实OnlyOffice、多主体浏览器端到端、实际语料图谱审计、完整配对基准、大规模编译/图浏览及故障资源回收仍未实测。测试通过不能证明生产尾延迟、供应商成本或通道质量增益；不关闭未经消融证明无效的现有通道。F07采用拒绝不支持的配置，非新增版本化hybrid通道；F08不保证所有I/O即时取消。Scope增量和阶段/可见计量已实现，性能数值待实采。未执行生产发布、迁移或服务重启。
