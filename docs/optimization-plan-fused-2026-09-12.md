# RAG 系统融合评估结论与统一优化方案（2026-09-12）

融合来源：
- **A 报告**（本方）：`docs/test-reports/sota-assessment-2026-09-12.md` —— 架构对标 + CMRC 2018 公开基准端到端实测（150 篇 / 178 题）
- **B 报告**（另一方）：`docs/rag-core-assessment-and-implementation-plan-2026-09-12.md` —— 代码审计 + 定向单测 + 国际实践对照

基线：`main@976753a`。

---

## 1. 两份评估的交叉验证

### 1.1 融合判定

**不能认定达到国际 SOTA（以 B 的严格口径为准）；但短文档公开基准实测证明管道端到端基本可用，且具备完整的高级 RAG 功能广度。**

| 维度 | 融合判定 | 论证来源 |
|---|---|---|
| 功能广度 | 业内先进（双方一致） | A：contextual retrieval/HyDE/RAPTOR/GraphRAG/MMR/多跳均真实落地；B：同样确认功能存在 |
| 正确性根基 | **存在实质缺口**（B 独有发现，A 已逐条复核属实） | embedding 400 上限、enrichment 无覆盖校验置 ready、角标即 grounded、版本竞态、评测 judge 缺证据正文 |
| 检索有效性 | 短文档域实测优（98.9%），长文档域**未验证且结构上存疑** | A 的 CMRC 语料为单段短文（每篇≈1 chunk），永远不会触发 B 发现的 400/300 截断缺陷——A 的实测无法反驳 B 的 P0 |
| 速度/成本 | 有实测锚点（冷 TTFT 5.5s）但无系统基线 | A 给出冷/缓存对照；B 指出根因（简单题扩词、重复 embedding、CLI 扇出）并要求计量 |
| 评测有效性 | **双套评测均存在方法学缺陷，互为印证** | B 指出 TS faithfulness 只查引用、judge 无正文；A 的 CiteHit 指标用最终引用而非检索排名，与 B 对 Python harness 的批评同源 |

### 1.2 关键论证：为什么 A 的实测与 B 的 P0 不矛盾，且互相补位

1. **A 的"98.9% 检索命中 / 零幻觉"只覆盖短文档域。** CMRC 语料每篇为单段落（约 200–500 字），1 doc = 1 chunk：
   - B 的 `embedDocumentChunks(maxChunks=400)` 截断（`chunk-embedding.service.ts:30`）不会触发；
   - B 的 RAPTOR 前 300 块截断（`raptor.service.ts:79`，已核实 `take: max(20, RAPTOR_MAX_CHUNKS||300)`）不会触发；
   - 版本竞态（富化任务无 versionId、按 documentId 全删块）未经历多版本交错。
   因此 A 的实测是**下界证据**（管道在简单域可用），不能作为整体质量结论。
2. **A 的"零幻觉"是观察结论，B 揭示的是机制不保证。** A 抽查 8 个低分案例均为同义改写而非编造；但 B 核实生成层"带有效角标即计 grounded、delta 先发后验"（`chat.service.ts:3844`，已核实：`hasValidTag` 直接 `groundedStatements++`，无内容比对）。观测为真 ≠ 机制闭环。
3. **B 未做端到端实测，A 补上了这一环。** B 明确"未运行付费端到端评测"；A 的 178 题真实 SSE 流证明：150/150 摄入发布、拒答行为正确（2 例未命中均诚实拒答而非编造）、语义缓存命中后 TTFT 0.6s。这些是静态审计无法给出的可用性证据。
4. **双方独立发现同一批架构弱点**（RAPTOR/GraphRAG 检索退化为关键词 contains、late-chunking 死代码、BFS 社区、评测链最弱），交叉证实可信。
5. **B 补足 A 的盲区**：A 未跑单测——B 跑了，8 套中 4 套编译失败（Prisma client 产物漂移、`BrainQueryResult` 类型缺失），即当前无全绿可复现基线。A 未审计成本与版本竞态。

### 1.3 分歧裁决（三点）

| 分歧 | 裁决 |
|---|---|
| A 原结论"达到业内先进工程水平（接近 SOTA）" vs B"不能认定 SOTA" | **采纳 B**。A 的结论限定改写为："功能广度先进 + 短文档公开基准可用性下界成立"；整体 SOTA 认定需 B 要求的条件化证据（固定任务/数据/模型/资源 + 同条件对比 + 可信指标） |
| RAPTOR/GraphRAG 摘要节点向量化放 P2（B 未列，其"P2 按坏例投资"原则）还是 P1（A 建议） | **放 P1**。理由：这不是新增功能，而是修复"已重投入模块退化为关键词 contains"的缺陷；改动小（摘要节点入 pgvector + 检索改向量召回），且 A 的架构分析表明全局综述/全景类问题当前基本失效。Leiden 社区算法、LLM 社区摘要等真正的新功能维持 B 的 P2 消融门禁 |
| 是否引入 OpenSearch BM25 | **采纳 B 的门禁式引入**：先修 contains 通道（补 published/版本过滤 + trigram），P1 消融证明完整证据召回不下降且成本/延迟收益可解释后，才启用独立搜索服务；低流量部署留在过渡模式且不得宣称已实现 BM25 |

另：B 发现的迁移冲突（Prisma `20260910130000_drop_unused_tsv` 删除 simple tsv vs 未跟踪 `deploy/migrations/001_search_optimization.sql` 恢复）裁决为**以 Prisma 删除为准**（simple 分词不解决中文、代码未使用该 tsv），未跟踪 SQL 中的 trigram 部分并入 P1 词法通道改造统一评审。

---

## 2. 统一优化方案

原则（采纳 B）：PostgreSQL 保存版本与原始证据；核心检索路径可独立完成问答；GBrain/摘要/图谱为可选增强；所有路径共用授权、预算与证据协议。A 补充：所有改造以第 3 节双轨评测判定，禁止以功能数量作为验收。

### P0 —— 正确性根基（先于一切性能/功能工作）

**P0-A 评测可信化（双方一致的第一优先）**

1. 修 TS 评测：faithfulness/contextPrecision 重写——LLM judge 必须收到**证据正文**（非标题），增加 nDCG；`quality-gate.ts:168,260,276`。
2. 修 Python harness：以 `/api/v1/chat/search`（`chat.controller.ts:62`）获取**检索排名**计算 Recall@K/MRR/nDCG，替换"最终引用即命中"；API 异常计入失败不得 skip；门禁排除 dry-run/过期结果。
3. 建立双轨评测（详见第 3 节）：业务留出集（B 规格，400 题按文档家族分离）+ 公开泛化轨（A 的 CMRC 2018 harness，已归档 `tests/evaluation/results/cmrc2018-public-benchmark-2026-09-12.json`，固定 seed=42 可复现）。
4. 所有评测结果绑定 commit、语料/模型/索引版本、runId（B 要求）。
5. 修复 4 套编译失败的测试与 Prisma client 漂移，恢复全绿基线（B §7）。

**P0-B 入库完整性（B 独有，已核实）**

6. `embedDocumentChunks` 改游标分批（64/批）续跑，返回 requested/embedded/failed/missing；required 块缺失不得 coreReady（`chunk-embedding.service.ts:30`、`enrichment.processor.ts:43`）。
7. 富化/编译任务携带 versionId + pipelineVersion；提交时 CAS 校验；旧任务晚到只写自己的版本（`ingestion.service.ts:137,319`、`brain-compiler.processor.ts:69`）。
8. 块删除按版本而非 `documentId` 全删；Source 发布校验 coreReady。
9. RAPTOR 去除 300 块截断：逐章节分批摘要覆盖全文（与 P1-C 摘要覆盖合并实施）。

**P0-C 证据与缓存（B 独有，已核实）**

10. 角标不自动通过：所有事实断言与所引原文做确定性比对（数字/单位/否定/比较方向），其余走 NLI/LLM 蕴含（`chat.service.ts:3844`）。
11. strict 模式缓冲验证后再输出首段；失败删改/补检/拒答（当前 delta 先发后验无法撤回）。
12. 缓存只收验证通过内容；语义缓存键补 ACL/库/知识版本/asOf/模型提示版本，仅限低风险单轮 FAQ（`semantic-cache.service.ts:34`）。

### P1 —— 性能与检索质量

13. **QueryOrchestrator + RetrievalBudget**（B）：从近 4000 行 ChatService 拆出路由。路由表采纳 B §4.3：编号/条款题 0 规划 LLM 直查；普通事实题 0 扩词/0 HyDE、1 次 embedding、1 次重排；复合题 ≤3 子问题并发；全局综述走摘要慢路。超时 deadline 贯通全链。**验收锚点（A 实测）**：当前冷 TTFT 5.5s → 普通题已验证首段 p95 ≤ 4s。
14. **词法通道 BM25 化**（B，含 §1.3 裁决的两步走）。
15. **RAPTOR/GraphRAG 摘要节点向量索引**（A，见 §1.3 裁决）：摘要/社区节点 embedding 入 pgvector，检索由 contains 改向量召回+重排；GraphRAG global search 由关键词重叠改 embedding 匹配（`raptor.service.ts:257`、`graph-rag.service.ts:778`）。
16. **原文/检索表示分离**（B）：`rawText` 与 `searchText`（title+heading+可选 contextPrefix）分字段；生成与验证只引 rawText——修复 contextPrefix 混入证据的缺陷（`contextual-retrieval.ts:137`）。
17. **入库瘦身**（B）：质量门禁前移到付费富化之前；富化按需触发（仅指代/语义不自足块），修 300/301 块行为突变与每块重发 60k 字。
18. **时效与文档家族**（B）：familyId/supersedesVersionId 建模；asOf 前置过滤 `effectiveFrom ≤ asOf < effectiveTo`；单版本废止不再跳过裁决（`chat.service.ts:2602`）。
19. 缓存与 embedding 复用（B）：请求内 singleflight 共享 query embedding；先查无 embedding 的精确缓存。

### P2 —— 按坏例投资（单项消融通过才上线）

20. Late Chunking（现为死代码 `late-chunking.ts`，A/B 一致确认）：先测结构分块在留出集的失败模式，再独立实验。
21. Leiden 层次社区 + LLM 社区摘要（现 BFS + 模板，`graph-rag.service.ts:562,614`）。
22. 视觉多向量/图表索引（B）：先统计图表是否主要失败源。
23. 语义分块/自适应 chunk size（A）：以留出集坏例驱动。

---

## 3. 验收与评测制度（双轨）

**轨道一：业务留出集**（B 规格）——400 题按文档家族分离开发/留出，含条款数字、同义问、多跳、长文尾部（针对性覆盖 P0-B 截断缺陷）、表格、时效、无答案；另建 ≥100 个权限/版本故障场景。

**轨道二：公开泛化轨**（A 已建）——CMRC 2018 固定抽样（150 篇/178 题，seed=42），作为外部语料回归，防业务集过拟合；扩展为 500+ 篇时需覆盖长文档（多 chunk）以持续检验 P0-B。

**指标与门槛**（B 为主，A 补充）：

| 验收项 | 门槛（初始值，固定环境后校准） |
|---|---|
| 入库完整性 | eligible chunks 向量/词法覆盖 100%，缺失即非 coreReady；长文首中尾均覆盖 |
| 检索质量 | 留出集完整证据 Recall@20 ≥ 90%；nDCG@10 报告并纳入回归 |
| 生成质量 | supported claim precision ≥ 98%；可答题正确率 ≥ 90%；无答案正确拒答 ≥ 95%（A 实测拒答行为已达标） |
| 回归 | 同条件准确率下降 ≤1pp，报 bootstrap 95% CI；不得以提高拒答率换忠实度 |
| 速度 | 普通题检索+重排 p95 ≤1.5s、整答 p95 ≤10s；复杂题 ≤20s；普通题规划调用=0、embedding ≤1 |
| 成本 | 按 B §5 公式记录单位有效回答成本；缓存命中/未命中/重试单列 |
| 安全 | 越权候选不进生成；版本切换/撤权/缓存回放专项全过 |

规模曲线：1万/10万/100万块 × 并发 1/10/50 × ACL 可见比 1%/10%/100%，报 p50/p95/p99 与失败率。

迁移策略（B）：expand → 回填双写 → shadow 对比（禁重复计费）→ 按库灰度；旧索引保留一个发布周期。

---

## 4. 实施顺序

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| P0-A | 评测可信化 + 全绿编译基线 + 双轨评测建立 | 脏结果不能绿灯；CMRC 轨可一键复跑且绑定 runId |
| P0-B | 入库完整性 + 版本化 CAS | 401/2600 块长文全量入库；部分失败不 ready；v1 晚于 v2 不覆盖 |
| P0-C | 证据验证 + 缓存收紧 | 错数字+真角标不能作为已验证事实输出/入缓存 |
| P1-A | QueryOrchestrator 瘦身 | 普通题 0 规划 0 扩词；冷 TTFT 从 5.5s 降至验收线 |
| P1-B/C | BM25 两步走 + 摘要节点向量化 + raw/search 分离 + 时效 | 消融数据支持切换；长文尾部/时效率项用例通过 |
| P2 | 按坏例逐项消融 | 单项收益 + 资源预算可接受才上线 |

P0 三项完成前，不做任何 P1 性能优化或新功能——理由：评测不可信则无法证明优化有效（A/B 在这一点上独立得出相同结论），索引不完整则检索优化的收益测量全部失真。
