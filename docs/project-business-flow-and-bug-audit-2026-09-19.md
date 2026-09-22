# GBrainKG 业务流程、缺陷与 SOTA 差距审计

日期：2026-09-19

范围：API、Web、Parser Worker、GBrain Adapter、PostgreSQL/pgvector、GraphRAG、RAPTOR、评测与部署脚本

结论等级：代码审计 + 本地自动化验证；未执行生产部署，未用生产数据做压测

> 整改状态（2026-09-19 晚）：本文 §4 的 P0-1、P0-2、P1（Graph N+1 / RAPTOR 重复重建 /
> 查询 deadline 与 bulkhead / title-affinity 截断 / LLM 派生缓存跨实例共享 / 负反馈闭环 /
> 评测可信度 / Web ESLint）已完成代码整改并有本地实测证据；P0-3 完成隔离 schema 的十万级
> 本机实测（非生产硬件）；P0-4 公开基准仍**未验证**，门禁已改为 fail-closed 以免误记成绩。
> 详见 [审计整改与 SOTA 达标评测报告](audit-remediation-and-sota-evaluation-2026-09-19.md)。

## 1. 结论

项目已具备较完整的企业 RAG 骨架：多格式解析、质量门禁、权限隔离、稠密向量、词法候选、GBrain、GraphRAG、RAPTOR、跨编码器重排、引用与流式事实门控。此次修复消除了多项会造成错误答案、重复计算或十万级退化的缺陷。

但截至本次审计，**不能声称“全球真实超级 SOTA”或“已验证支持十万文档”**。原因不是组件名称不够多，而是尚无可复现的十万真实文档索引/并发报告，词法主通道不是真正的全库 BM25，过滤后的 HNSW 召回未与精确检索对照，公开数据集和端到端事实性评测也未完成有效实跑。

当前合理定位：**架构先进、正确性防线较强、已接近可规模化验证阶段；SOTA 和 100k 仍是待证目标，不是已证事实。**

## 2. 端到端业务流程

### 2.1 文档进入知识库

1. Web、OpenAPI 或 MCP 接收上传，执行身份、知识库权限、扩展名、大小与压缩包安全检查。
2. 原文件写入上传目录，`Document` 创建或递增版本；BullMQ 任务以 `documentId + version` 去重。
3. Ingestion Worker 读取文件并计算 SHA-256：
   - 先查进程内解析缓存；
   - 再查数据库中的跨进程内容哈希缓存；
   - 纯文本走快速路径；
   - 可支持格式先走 AnyDoc；
   - 扫描件、旧格式和布局复杂文档再进入 Parser Worker/OCR/VLM。
4. 解析结果经过内容质量评估、Markdown 清洗、结构化切块和可选 Contextual Retrieval。
5. 临时 `content.md` 与 chunks 通过文档版本围栏提交；质量不通过的文档进入 `needs_review`，不发布。
6. 合格文档进入 GBrain source 编译与发布流程；Outbox 负责可恢复的知识/权限变化传播。
7. Enrichment Queue 并行执行：
   - BGE-M3 chunk embedding 与覆盖率检查；
   - RAPTOR 文档级/全库级摘要树；
   - GraphRAG 实体、关系、社区摘要。
8. `indexReadiness` 从 `pending → enriching → ready/degraded`；完整索引后可重驱动发布。

### 2.2 查询与回答

1. 校验用户可见知识库，显式请求范围必须是可见范围的子集。
2. 装载并压缩对话历史，改写检索问题；解析 Source 范围、ACL epoch 和 knowledge epoch。
3. 用聚合 SQL 检查 Source 新鲜度，避免每次查询加载整个文档表和映射表。
4. 查询范围精确绑定的语义缓存；缓存命中仍重新校验文档权限和发布状态。
5. 主检索由 GBrain 执行；必要时组合：
   - pgvector/BGE-M3 稠密召回；
   - substring/pg_trgm 候选池上的局部 BM25；
   - GraphRAG local/global；
   - RAPTOR 宏观摘要；
   - 可选 WeKnora shadow/hybrid；
   - 多跳子问题与 bridge retrieval。
6. 对候选再次执行 ACL、生命周期和时间有效性过滤，再执行统一 rerank、证据去重/MMR/预算裁剪。
7. 无高置信证据时快速拒答；有证据时生成回答，句子级 grounding gate 拦截无支持或数字不一致的陈述。
8. 最终引用再次检查 `published` 与 ACL，SSE 输出后持久化 Message、Citation、trace；可信且非拒答结果才写语义缓存。

### 2.3 反馈、重试和删除

- 手工重试先递增文档版本，再产生新版本任务；旧任务不能覆盖或标坏新版本。
- `not_useful` 反馈现在会创建/更新 `FeedbackCase`，保存问题、答案、证据和 trace，形成可审计的评测素材。
- 删除文档先撤销 GBrain 内容，再删除数据库记录，并同步清理 GraphRAG 来源、RAPTOR 文档节点和全库摘要；上传目录递归清理。

## 3. 本次已修复

| 优先级 | 问题 | 修复结果 |
|---|---|---|
| P0 | 查询前把 source 的全部文档及映射加载进 Node 内存，100k 文档时为 O(N) | 改为单次聚合 SQL，只返回计数和 stale 标志 |
| P0 | 内容哈希命中后 AnyDoc 分支仍会再次解析 | parser 分支仅在 `parsed` 为空时执行；增加回归测试 |
| P0 | 旧 ingestion job 可把新版本标记为 failed | `markFailed` 增加 version fence；只在最终重试失败时执行一次 |
| P0 | 旧解析任务可在事务版本检查前覆盖新 `content.md` | 先写版本化临时文件，DB 版本围栏成功后原子 rename |
| P0 | 删除文档后 RAPTOR Level-2 仍含已删除知识 | 删除时同步失效文档节点和 Level-2，再调度重建；空库清除旧 Level-2 |
| P0 | Graph relation 写失败被吞掉但文档仍标 ready | 聚合失败并抛出，让 enrichment retry/degraded 生效 |
| P0 | 图关系由多文档共享时，删除一个文档会删掉整条关系 | JSONB provenance 改为按 documentId 剥离，仅在无来源时删除关系 |
| P0 | 无 score 的证据默认按 1.0，绕过快速拒答 | 缺失 score 按 0 处理；测试数据显式提供分数 |
| P1 | `GraphEntity.properties.docIds` 仅 create 时写入 | 批量原子合并来源文档 ID，避免来源丢失和逐实体更新 |
| P1 | 图片未配置 OCR/VLM 时仍暗中调用百度 OCR | 明确失败，不再发起无凭据的外部调用 |
| P1 | embedding cache 只按 model name + text，切换同名模型会复用错误向量 | key 加入 base URL、模型名、维度；单次请求只读取一次配置 |
| P1 | SemanticCache 采用 DELETE + INSERT，存在并发缺口 | 唯一索引 + `ON CONFLICT DO UPDATE` 原子替换 |
| P1 | WeKnora 绑定只查 qualityStatus，可能带入未发布文档 | 同时要求 `status=published` |
| P1 | 最终引用允许 `indexing` 文档 | 最终门禁统一为 `published` |
| P1 | chunk 页码写 `page_no`，部分回答路径只读 `pageNumber` | 两种键统一读取，优先 `page_no` |
| P1 | Citation、FeedbackCase 表存在但主流程不写 | Chat persistence 写 Citation；负反馈创建/更新 FeedbackCase |
| P1 | Graph 名称 contains 与 JSONB provenance 清理缺关键索引 | 新增 name trigram、properties/provenance GIN 索引迁移 |
| P1 | BEIR 截断 corpus 可能删掉 qrel 正样本，上传失败仍继续评分 | corpus limit 必须保留全部 gold；上传/ready 数量不一致即失败 |
| P1 | nDCG/AP 接受重复 doc ID，可能大于 1；Recall 实为 hit rate | ranking 去重，修正 Recall/MRR/AP/nDCG 和自测 |
| P1 | API 错误样本从准确率分母消失 | 错误请求按 0 分计入核心质量指标；延迟单独统计成功/失败 |
| P2 | load test QPS 只计算成功请求且无 warmup | 总 QPS、成功 QPS、成功/失败延迟分开；warmup 不计统计 |

数据库迁移仅新增到仓库，**未在生产执行**。

## 4. 尚未解决的主要差距

### P0：阻止 SOTA/100k 声明

1. **词法检索不是真正全库 BM25。** 当前流程先用 `contains`/trigram 截取有限候选，再在候选池内计算 BM25；一般候选仍可能按 `documentId, ord` 截断，高频词下会在评分前丢掉真正相关文档。需要 PostgreSQL 中文 FTS/ParadeDB/OpenSearch 等能在引擎层按 BM25 排序的通道，并做等价 ACL 过滤。
2. **过滤 HNSW 的召回未验证。** 当前按 KB/status 过滤一个全局 HNSW。pgvector 官方说明近似索引的过滤发生在候选扫描后，可能少返回；0.8+ 可用 iterative scan，多租户还可分区。必须做 exact KNN 对照，测 Recall@K 后再选 `ef_search`、iterative scan 或分区方案。
3. **没有十万真实文档证据。** 缺少 100k 文档、真实 chunk 分布、并发写入、索引体积、p50/p95/p99、Recall@K、错误率和恢复测试报告。
4. **没有公开基准有效结果。** 已有 BEIR/MIRACL 风格工具，但本次只验证了评测代码自测；没有可接受的真实数据结果文件。

### P1：规模和稳定性

- Graph entity/relation 持久化仍有串行 N+1；社区构建仍可能扫描全 KB。
- RAPTOR Level-2 是全量摘要重建，debounce 仅进程内；多实例会重复执行。
- 查询可并发 fan-out 主问题、多个子问题、Graph/RAPTOR/WeKnora，缺统一 deadline、DB statement timeout 和全局 bulkhead。
- title-affinity 先取 20 个文档且缺相关性排序；通用词法候选截断顺序不合理。
- 进程内 parse/rerank/route cache 多实例不共享；需要 Redis 二级缓存与 singleflight。
- BrainTopic 旧编译路径与 source-centric 路径并存；知识图谱 UI 扫描路径与持久 GraphRAG 并存，维护成本高。
- 负反馈现已落案例，但尚无人工复核、gold 转换、离线回归、灰度发布的完整闭环。

### P1：评测可信度

- `global 30` 本地 fixture 有重复/合成内容，不能称为 30 个官方国际基准。
- `eval_ragas_deepeval_suite.py` 主要是自定义启发式/可选 LLM judge，并非直接运行官方 Ragas/DeepEval；文件名会造成误解，应改名或真正接入官方实现。
- dry-run 使用 gold 构造 retrieval，只能用于 harness self-test，不能作为质量成绩。
- live CI gate 在凭据/服务缺失时可跳过；SOTA 发布门禁必须 fail-closed。

### P2：工程债务

- Web ESLint 仍有存量错误，主要为 `any`、effect 内同步 setState、未使用变量；详见评测报告。
- 部分 trace/日志文本较长。面向用户的回答已有拒答和预算控制，但内部诊断可继续改为结构化短码，减少存储和观察成本。

## 5. 真正达到目标的建议门禁

按准确度优先，建议以下全部满足后才使用“SOTA/100k 已验证”：

1. 真实 100k 文档全量导入成功率 ≥ 99.9%，失败可重试且无跨版本污染。
2. 用精确 KNN 作 gold，过滤 ANN Recall@10 ≥ 0.98；不同 KB 大小和 ACL 选择率均覆盖。
3. 至少 BEIR 的多领域集合 + MIRACL/MMTEB 多语检索 + 企业私有 hard-negative 集，报告 nDCG@10、Recall@10/100、MRR、MAP。
4. 端到端用 claim-level 评测和人工双盲抽检，报告正确性、完整性、faithfulness、拒答 precision/recall、引用支持率。
5. 固定硬件和索引规模下报告 p50/p95/p99、QPS、首 token、总耗时、错误率；质量指标先达标，再优化延迟。
6. 所有 live gate 在发布流水线 fail-closed，并保存可复现配置、模型版本、数据哈希和原始 run 文件。

## 6. 外部校准依据

- pgvector 官方文档：过滤近似索引可能减少返回结果；0.8+ 提供 iterative scan，多租户可考虑分区。<https://github.com/pgvector/pgvector>
- BEIR：18 个公开异构检索数据集，覆盖 lexical、sparse、dense、late interaction 和 reranking。<https://arxiv.org/abs/2104.08663>
- BGE-M3 官方说明：一个模型支持 dense、lexical 和 multi-vector，多语言、多粒度。<https://bge-model.com/bge/bge_m3.html>
- Microsoft GraphRAG：Local、Global、DRIFT 与 Basic Search 的用途不同；Global Search 是资源密集型。<https://microsoft.github.io/graphrag/query/overview/>
- RAPTOR（ICLR 2024）：递归 embedding、clustering、summarization 用于长文档多层抽象检索。<https://proceedings.iclr.cc/paper_files/paper/2024/hash/8a2acd174940dbca361a6398a4f9df91-Abstract-Conference.html>
- RAGChecker：以 claim-level entailment 分离检索与生成诊断，并用人工偏好做 meta-evaluation。<https://github.com/amazon-science/RAGChecker>

这些工作是目标设计依据，不等于项目已复现其论文成绩。
