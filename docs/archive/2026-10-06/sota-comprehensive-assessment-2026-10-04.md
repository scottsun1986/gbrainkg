# GBrainKG 全面 SOTA 评估与行业对比

日期：2026-10-04  
基线：`main`，`v48.11`（`b719355`）及当前工作区代码和评测产物  
范围：入库、解析、索引、检索、图谱、生成、引用、权限、缓存、可观测性、评测、部署与多租户

## 结论

GBrainKG 已经是一个完整的企业级 RAG/知识库系统，不是简单的向量问答 Demo。代码已覆盖权限边界、版本时效、混合检索、证据绑定、故障隔离和多实例部署；在 BGE-M3 dense/sparse/multi-vector、过滤 HNSW、RRF、RAPTOR、contextual retrieval、GraphRAG 和句级 grounding 方面具备现代 SOTA 组件。

但目前不能称为“业内 SOTA”，也不能称为“公开基准领先”。原因不是缺少更多算法名词，而是缺少可复现、有效、同口径的端到端证据，且仍有生产级安全与性能闭环未完成：

1. 最新有效的业务端到端结果仍主要来自 2026-09-23；2026-09-27 的 50 题质量门是 401 空跑，不能作为成绩。
2. 旧版 `faithfulness` 是金标片段逐字子串命中率，不等于事实忠实度；当前代码已增加句级 judge 方案，但必须在真实认证环境重跑并发布新基线。
3. 已知公开结果显示 220 题 `hit_rate@5=0.947`、`MRR@10=0.918`、`context_precision=0.635`；这说明召回基础较强，但不足以证明答案正确，更不是跨系统 SOTA 对比。
4. 历史审计发现密钥回退、核心表 `FORCE RLS`、图谱截断稳定性和缓存内容校验等风险；仓库已有相应修复/迁移。2026-10-05 只读核查发现本机 `KnowledgeBase/Document/Chunk` 已开启 FORCE，但这不能替代隔离测试库的权限矩阵验证，身份表策略仍需专项验证。
5. 历史测试已达到 API `1060 passed / 5 skipped`、parser `47 passed + 4 subtests`，但单测通过不能替代真实语料、真实模型、真实权限矩阵和容量压测。

因此当前评级为：**架构 A-，企业安全 B，检索实现 A-，答案质量证据 C，性能证据 C，评测治理 B-，综合“先进实现、未证明 SOTA”。**

## 端到端流程与不变量

### 入库与知识编译

原始文件进入对象存储后，由 parser-worker 解析为规范 Markdown、结构化块、表格/OCR 元数据，再由 brain compiler 写入 canonical document、chunk、版本链、RAPTOR 节点和图谱投影。outbox 负责异步同步、租约、重试和 dead-letter。

关键不变量：原文版本不可变；派生内容必须带来源和版本；删除先清理派生索引再删除主记录；失败不能覆盖已有 parser 元数据；重放不能抢占仍持有租约的任务。

### 检索与回答

查询先做会话上下文改写和意图判断，再按授权知识库执行 dense、BM25/pg_trgm、sparse/multi-vector、图谱和外部检索臂，使用加权 RRF 合并并重排。随后构造证据包，进行 ACL、版本时效、证据依赖和 grounding 校验，最后生成带引用的答案并通过 SSE 输出阶段和增量内容。

关键不变量：每个候选都要受知识库和用户 ACL 约束；答案引用只能来自本次授权证据池；缓存键必须包含 source 集合、权限/知识 epoch、用户和模型范围；无法证明的内容应拒答或降级；同分结果必须稳定排序。

### 多租户与发布

实例共享 PostgreSQL、Redis、parser-worker、MinIO 和 Nginx，但每实例使用独立数据库和 Redis DB。部署脚本包含隔离、BYPASSRLS 和迁移预检。生产发布仍受仓库 `AGENTS.md` 的测试和明确指令门禁约束。

## 与主流方案的对比

下表保留方案中的能力对照假设，用于设计后续验证。本轮未逐项查证竞品当前版本、默认权限策略或实际性能，因此不能将表格作为行业排名、能力优越性或对外宣传的依据。

| 维度 | GBrainKG | Glean/Azure AI Search/Vertex AI Search | RAGFlow | Dify | LlamaIndex/Haystack | Microsoft GraphRAG | Milvus/Weaviate/Qdrant + 自建 |
|---|---|---|---|---|---|---|---|
| 文档解析 | parser-worker、结构化块、表格、OCR、晚分块、contextual retrieval | 连接器和托管解析成熟，企业格式覆盖广 | 版面、表格、OCR 体验强 | 依赖插件/外部解析 | 组件丰富，需自行编排 | 不是完整解析平台 | 向量层本身不负责 |
| 向量/词法 | pgvector HNSW + BM25/pg_trgm + BGE-M3 dense/sparse/multi-vector | 托管混合检索和语义排序 | Elasticsearch/Infinity 等组合 | 依赖向量库和全文引擎 | 可组合，默认实现差异大 | 主要为图谱工作流 | 向量强，词法/融合需自建 |
| 重排 | BGE reranker、RRF、证据校准、预算与 bulkhead | 托管语义排序，调参少 | 有重排和引用链 | 通常可配置 reranker | 可插拔，生产一致性由用户负责 | 不是主要强项 | 需要自行接入 |
| 多跳/图谱 | GraphRAG、local/global 路由、RAPTOR、实体/社区投影 | 企业实体图和连接器强，但实现不透明 | 有知识图谱能力，深度依版本 | 通常依赖插件 | agent/workflow 灵活 | 社区摘要和全局检索成熟 | 图数据库或应用层自建 |
| 权限与撤权 | DB ACL、RLS、权限 epoch、最终证据校验、缓存范围隔离 | 源端 ACL/企业身份集成最成熟 | 有知识库/文档权限，细节依部署 | 基础租户/应用权限 | 默认不是安全产品 | 需自行补 ACL | 默认无业务授权语义 |
| 版本/时效 | 不可变版本、as-of、废止/生效校验 | 取决于连接器和索引策略 | 版本能力较强但需验证 | 主要是文档更新 | 需自行实现 | 图谱更新成本较高 | 需自行实现 |
| 引用与可审计性 | citation rebinding、句级 grounding、拒答和证据 trace | 产品级引用与审计成熟 | 引用体验好 | 基础引用 | 能实现但不默认闭环 | 研究型输出为主 | 自建 |
| 流式与延迟 | 阶段事件、增量稳定前缀；历史 TTFT 约 17s 均值，尚无新 P95 基线 | 托管系统通常延迟和容量更稳定 | 交互成熟，具体延迟依部署 | 体验成熟但链路较短 | 需自行优化 | 批处理/离线全局分析偏多 | 只解决检索层 |
| 评测治理 | golden、BEIR/SOTA10、门禁、自检和 judge 代码已具备；真实有效运行断档 | 厂商内部数据不可完全复核 | 有回归工具但公开口径有限 | 运营指标较多，科学基准有限 | Ragas/DeepEval 等生态丰富，易被误用 | 公开研究指标较多 | 需自行建设 |
| 运维与隔离 | 多实例、共享重型中间件、独立 DB/Redis、outbox dead-letter | 托管运维优势明显 | 自托管组件较多 | 部署简单，复杂隔离需补 | 取决于集成团队 | 研究/批处理成本高 | 组件运维由用户承担 |

### 判断边界

本轮代码核查能够确认 GBrainKG 的能力存在与实现约束。与其他系统的优劣判断仍需要官方文档核验，以及相同语料、权限模型、模型路由、资源预算和问题集下的配对评测。不能从组件数量推断答案质量或工程成熟度领先。

## 当前已达到的先进做法

1. **混合检索正确性**：RRF 而不是直接比较不同检索臂的原始分数；具备 rerank、去重、父文档和 section rescue。
2. **长文档和结构化内容**：contextual retrieval、late chunking、RAPTOR、表格证据与 OCR 路径形成完整链路。
3. **模型能力利用率**：BGE-M3 不只使用 dense 向量，还保留 sparse 和 multi-vector 能力，并有 capability 契约。
4. **安全失败模式**：RLS 运行角色、ACL 最终校验、缓存 scope fingerprint、撤权 epoch、outbox dead-letter 和生产启动校验均体现成熟工程判断。
5. **证据驱动输出**：引用重绑定、句级接地、数字一致性、拒答形态和流式阶段事件，明显高于普通“检索后直接 prompt”的系统。

## 仍未达到 SOTA 的关键差距

### 1. 质量证据不可宣称

旧指标把 `faithfulness` 当作字符串子串；旧质量门有 401 空跑。当前修复增加了句级 entailment、环境错误分类和 fail-closed，但尚未形成一份经过认证、冻结语料、固定 commit、固定模型和可复现运行的公开基线。`hit_rate@5` 高也可能来自相邻 chunk 和简单文档标题题，不能替代 answer correctness、citation precision、citation recall、abstention 和多跳完备性。

### 2. 公共基准缺少同口径对照

SOTA10/BEIR harness 已存在，但必须保存 corpus manifest、qrels、run 文件、模型版本、索引参数和完整 trace。公开基准应至少覆盖 NQ/TriviaQA 或中文等价集、BEIR SciFact/NFCorpus/FiQA、HotpotQA、2WikiMultiHopQA、MuSiQue、RGB、表格/OCR、冲突版本和权限反例。没有对照组就不能说“领先”。

### 3. 延迟和容量没有生产证据

历史 TTFT 均值约 17.2s、总耗时约 21.1s；项目目标是首个可读文本 P95 ≤3s，但必须先使用现有 stage metrics 取得 retrieving/reranking/generating/verifying 的 P50/P95/P99。还缺 100k/1M chunk、10 实例混合负载、缓存命中/未命中、模型超时和降级场景的结果。

### 4. 安全闭环仍需测试库验证

仓库已有密钥回退修复和 `FORCE RLS` 迁移；本机三张核心内容表已 FORCE，未执行本轮迁移操作；`User/Role/OrgNode/UserOrg/UserRole` 的 RLS 策略不能简单开启，必须先证明 `SECURITY DEFINER` 权限计算不会被自身过滤破坏。FORCE 只约束不具备 superuser/BYPASSRLS 的表 owner；不会限制 superuser、BYPASSRLS 或策略允许的 service 上下文。本机只读核查确认迁移连接与授权函数 owner 为 `llmwiki`，具备 superuser/BYPASSRLS。不能宣称 FORCE 已隔离这类运维身份。安全验收必须包含跨实例、撤权后旧 token、缓存重放、管理员/运维 owner、导出和预览 token 等反例。

### 5. 架构可维护性制约持续优化

`chat.service.ts`、`retrieval-arms.ts`、`graph-rag.service.ts` 和 parser-worker 单文件承担过多职责。当前单测数量已显著增加，但编排、证据、输出和策略仍紧耦合，导致性能实验和替换检索器的成本高。拆分应以现有行为测试为护栏，不能先做大规模重写。

## 成为业内 SOTA 的验收门槛

下列门槛应按固定 commit、固定模型/embedding/reranker、冻结语料和至少三次重复运行发布；任何环境错误、缺语料或权限错误都必须使运行无效，而不是计入低分。

| 类别 | 最低可宣称门槛 |
|---|---|
| 检索 | BEIR/SciFact 等公开 qrels：nDCG@10、Recall@100、MRR；复杂多跳分别报告 bridge/entity coverage，不只报 hit rate@5 |
| 答案 | 句级 evidence entailment ≥0.90；citation precision/recall ≥0.90；数字/表格专项 ≥0.95；无证据问题正确拒答 ≥0.95 |
| 稳定性 | LLM judge 多采样 spread 受控；同查询排序和引用稳定；重试、超时、空结果有确定性降级 |
| 权限 | 0 个跨租户/跨 ACL 反例；撤权传播和缓存失效有明确 SLO；owner、迁移、导出、预览路径均有反例测试 |
| 性能 | 首个阶段 P95 ≤1s，首个可读文本 P95 ≤3s，最终答案 P95 ≤10s；报告冷/热缓存及各阶段分布 |
| 规模 | 100k/1M chunk、10 实例混合负载下报告 QPS、错误率、P95/P99、数据库/Redis/模型资源和降级率 |
| 生命周期 | 解析成功率、重复率、版本切换、删除清理、outbox dead-letter、回放和数据恢复均有可审计结果 |
| 可复现 | 保存 commit、配置、模型版本、语料 manifest、qrels、run、trace、原始响应和统计脚本；禁止仅提交汇总数字 |

## 分阶段路线图

## 本轮已落地优化

本轮继续审查并修正当前工作区的评测门禁与充分性裁决：

- 严格模式强制开启独立 entailment judge，分数门槛默认继承 faithfulness，采样次数必须为 3–5 的整数。NaN、无穷、越界值、禁用 judge 却设置正门槛都会在 API 请求前失败。
- 每个答案的全部采样都须成功；不能用成功一次的分数代替三次采样。答题需返回有效断言表，不接受仅返回标量分数；正确拒答可返回空断言表和有效分数。
- 未测量的 faithfulness 报为 null；部分 judge 失败使报告 valid=false。开发模式关闭 judge 时明确显示 NOT MEASURED，不能当作发布证明；原有引用存在性门槛保留并独立命名为 Grounding Presence (proxy)，避免取消已有防护。
- judge 检查完整答案，避免只判断前 1200 字而遗漏后半段。证据输入仍沿用前 8 条引用、每条最多 800 字的预算；它衡量的是这些引用片段的蕴含，不能宣称覆盖完整原文。
- 空答案不能通过拒答或总体通过率；单个明确拒答标记不能因旧版 every 判定而成为正常答题通过。
- 已启用实时门禁的失败全部累计，最终非零退出；不再因 set -e 提前退出而丢失后续检查，也不再在开发模式把失败打印为“全部通过”。
- 充分性裁决保持 insufficient，即使没有新查询词；缺少引用原句而被降级的 sufficient 也不会被重新升级。调用方仍按原有跳数上限停止检索，最终回答由既有证据门控制。此修复保证裁决与 trace 正确，不等于强制所有复杂问题拒答。

验证（2026-10-05，本地工作区）：`pnpm test` 全量通过，API 136 套件、1145 tests passed、5 skipped；随后增加一项充分性回归，定向 22/22 通过。parser 47 tests + 4 subtests 通过；API typecheck/build/lint、评测代码独立类型检查、评测 harness 自检、新增 judge CLI/报告/门禁编排集成自检、shell 语法与 diff 检查通过。CLI 集成自检使用临时模拟端点，不代表真实模型质量成绩。

本轮没有认证评测凭证，未跑真实 50 题质量门、公开基准或容量压测；没有运行数据库迁移或重启服务。已有生产运行配置的本机数据库仅做只读元数据核查，不视为隔离迁移验证环境。下一步仍按 P0/P1/P2 的证据依赖顺序推进，避免没有基线时猜测改算法或直接拆分编排。

### P0：证据和安全（先完成）

1. 在隔离测试环境 apply `FORCE RLS` 迁移，跑 verify、权限矩阵、撤权和缓存重放测试。
2. 使用认证端点重跑 50 题 release gate；开启句级 judge，多采样并发布有效性字段。
3. 冻结 220 题企业集和一套公开 BEIR/多跳集，保存原始 run 与 trace；把 `faithfulness`、snippet match、answer correctness 分开命名。
4. 审核所有签名密钥、预览 token、MCP/管理端点、导出和连接器回调，不允许公开常量或隐式生产回退。

### P1：质量和性能

1. 按检索空、证据弱、答案未接地、错误拒答、引用错误五类输出诊断，而不是直接改 prompt。
2. 用 stage metrics 取得延迟分布，再按意图关闭不必要的图谱/多跳/全量扫描；以配对消融证明质量不下降。
3. 增加表格单元格、OCR bbox、冲突版本、中文多跳和权限反例的人工盲评。
4. 以 100k/1M chunk 和 10 实例为基准做容量压测，验证共享 PostgreSQL/Redis/parser 的资源边界。

### P2：产品化和可维护性

1. 将聊天编排拆成 query planning、retrieval、evidence policy、answer/stream 四个模块，保留现有行为测试。
2. 建立月度回归、模型/索引升级的 paired gate、成本和质量 Pareto 报告。
3. 补连接器同步、源端 ACL、删除证明、数据恢复和租户级审计日志，向商业知识库的运营完整度靠拢。

## 最终判定

GBrainKG 已实现“权限约束的知识生命周期 + 证据可审计回答”这一组合。代码覆盖面支持继续开展质量与安全验证，不足以证明领先其他系统。当前更准确的定位是：**可进入 SOTA 竞争的企业知识库底座，而非已经被证明的 SOTA 系统**。

只有在有效评测、公开基准对照、权限反例为零、阶段延迟和容量数据达标后，才应对外使用“业内 SOTA”表述。在此之前，对外应使用“企业级混合检索与可审计 RAG，已具备 SOTA 组件和路线”这一可证据支持的表述。
