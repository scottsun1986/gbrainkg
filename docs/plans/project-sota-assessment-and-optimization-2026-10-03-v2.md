# GBrainKG 项目实现全面评估与优化方案（第二次，纯代码视角）

日期：2026-10-03
基线：`main@70bf8da` + 未提交工作区（280 个文件变更，其中 252 个已修改、新增文件见 `git status`）
方法：只读项目源码本身（`apps/`、`packages/`、`deploy/`、`scripts/`、`tests/`），**不采信任何既有 md 报告中的结论**。
既有两份报告（`docs/plans/sota-optimization-output-2026-10-03.md`、`docs/p0-p2-optimization-2026-10-03.md`）仅作为「待验证的主张清单」逐条对照代码。
未运行线上查询，未部署，未改任何代码。

---

## 一、总体结论

架构层面确实已经达到企业级 RAG 的常见形态，且部分工程细节做到位（RLS 失败关闭、HNSW 过滤召回、outbox 死信、增量流式、语义缓存范围键）。但**「是否业内最佳」的答案是：架构在合格线以上，质量与安全在合格线以下，且当前仓库内的评测证据不足以支撑任何 SOTA 宣称——不是分数低，是分数无意义。**

三条决定性结论：

1. **官方质量门报告（09-27）完全无效**：`quality-gate-report-2026-09-27T04-02-52-146Z.json` 中 50/50 条全部返回 `HTTP 401: {"message":"Invalid or missing credentials."}`，成功率 0.40 只是「缺 token 时把每条判为失败」的产物，不能作为质量证据。第一份报告把它当作「通过率 40%」引用，属误读。
2. **faithfulness 0.11 不是模型不忠实，是评测口径本身无意义**：`tests/evaluation/test_retrieval_quality.py:337` 把 faithfulness 定义为「答案里是否**逐字包含**金标片段」的字符串子串命中率，且金标片段是 `["规定了","绩效考核"]` 这类通用词。`exact_clause` 桶里模型答「未检索到/无法回答」时 `keyword_hit_rate=0`、`faithfulness=0`；开放式综述答对了但没有逐字抄片段时同样得 0。**该指标与真实忠实度的相关性接近于零。** 在 `latest_results.json` 里它与 keyword 同步低到 0.11/0.325，恰好是中文字符短语子串匹配失败的指纹。
3. **召回满分是真的，但不是这个系统独有的功劳**：40 题 `exact_clause` 集 `rank_recall_5/nDCG@10/MRR` 全 1.0，靠的是同一篇文档的相邻 chunk——该桶 40 题全部针对同名文档的不同条款，属于最简单的一类；220 题全集 `context_precision=0.635`、`hit_rate_5=0.947`、`rank_mrr_10=0.918` 才是更可信的数。

因此本报告的定位是：**架构评估 + 评测体系证伪 + 真实缺陷清单 + 可执行的优化方案**。

---

## 二、代码规模与结构事实

| 项 | 数值 |
| --- | --- |
| API 非测试 TypeScript | 约 4.4 万行 / 176 文件（另有 124 个 `.spec.ts`） |
| `chat/chat.service.ts` | 5782 行（单类，编排全部聊天链路） |
| `chat/retrieval-arms.ts` | 2078 行 |
| `graph-rag/graph-rag.service.ts` | 2179 行 |
| `chat/citation-assembly.ts` | 1225 行 |
| `chat/agentic-rag.service.ts` | 960 行 |
| Web（Next.js） | 66 个 ts/tsx 文件 |
| parser-worker (Python) | 2764 行 / 9 文件（`main.py` 单文件 2106 行） |
| Prisma schema | 880 行 |

`chat.service.ts` 单类承载「规划 → 召回 → 证据包 → 流式生成 → 接地门 → 引用装配 → 缓存」的全链路，是最大的结构风险点，也是理解成本瓶颈。两次既有报告都提过拆分，至今未动。

---

## 三、前次 P0 清单的逐条代码复核

| ID | 前次主张 | 代码实测 | 证据位置 |
| --- | --- | --- | --- |
| B-6 引用误删 | 已修 | **确认真修**。改为集合差集 + `survivingIndices` 精确重映射，不再用 `index <= size` | `chat/citation-assembly.ts:930-975` |
| B-11 元数据保护 | 已修 | **确认真修**。改为 `{ ...priorMetadata, pendingError }` 合并写入 | `ingestion/ingestion.service.ts:849-857` |
| xlsx 漏洞 | 已修 | **确认真修**。web 依赖指向 SheetJS 官方 CDN `xlsx-0.20.3` | `apps/web/package.json:22` |
| B-9 outbox 毒丸 | 已修（含死信） | **确认真修且超出报告**：`dead` 状态 + `incOutboxDeadLetter` 指标 + 告警日志 + `replayDeadLetter` 重放入口 | `brain-compiler/brain-outbox.service.ts:76-109,125` |
| B-8 图谱无排序 | 部分修 | **部分仍存在**。热点路径已加 `orderBy:[{weight:'desc'},{id:'asc'}]`（1777、1967 行），但 4 处 `take` 仍无 `orderBy`：实体匹配（1732）、ARM 种子实体（1936）、社区列表（2066）、社区/实体回填（2132、2142）。前三处决定召回内容，截断仍依赖存储顺序 | `graph-rag/graph-rag.service.ts:1732,1936,2066,2132,2142` |
| B-2 组织树越权 | 报告称已修 | **未在本次复核范围内定位到修复点**。`admin.controller.ts` 的组织树查询改为 `orderBy:[{path},{sort}] + take: inventoryLimit`，但权限分支（`canReadOrg \|\| canReadIndustry`）是否已收窄需以权限矩阵用例实测为准；建议以测试断言而非代码阅读确认 | `admin.controller.ts:575-584` |
| B-1 无真实流式 | 已修 | **确认真修**。`IncrementalAnswerStreamer` 按 tidy 稳定行边界增量下发，`StageReporter` 推 `retrieving/reranking/generating/verifying` 阶段事件 | `chat/answer-stream.ts`、`chat/chat.service.ts:1793,4809,5345` |
| B-5 向量缓存 | 已修 | **确认真修**。`lookupByVectorSimilarity` 在同 `scopeFingerprint` + `knowledgeEpoch` 桶内做余弦近似匹配，阈值可配 | `chat/semantic-cache.service.ts:146-172` |

**结论**：前次 P0 六项中四项确认修好，一项部分修（图谱排序），一项需测试确认。

---

## 四、架构评估：哪些真的处于或高于业界常规

以下为代码核实无误、且确实属于企业 RAG 正确形态的部分：

- **混合检索融合**：`fusion-rerank.ts` 实现加权 RRF（Cormack 2009），`k=60`，WeKnora 臂权重可配。是教科书式正确做法，没有跨臂比较未归一化分数的常见错误。
- **ANN 过滤召回**：向量臂在 10 万 chunk、1/40 KB 过滤下实测 Recall@10，`hnsw.ef_search=200 + iterative_scan=relaxed_order` 达 1.000，且注释解释了为何把参数放在数据库级而非每查询 `SET LOCAL`（避免耗尽 Prisma 连接池）。这是**稀缺的、有实测支撑的工程决策**。
- **检索准入**：`RetrievalDeadline` 全臂共享墙钟预算 + `Bulkhead` 限并发，防止单一慢存储拖垮整个请求。是教科书式的扇出保护。
- **RLS 失败关闭**：`RLS_ENFORCE=1` 时强制要求 `DATABASE_URL_APP`（NOBYPASSRLS 专用角色），启动期拒绝缺失配置；运行角色创建语句硬编码 `NOBYPASSRLS NOSUPERUSER`。13 张租户表启用 RLS 并有策略 DDL。
- **语义缓存范围键**：`semanticCacheScopeKey` 把**选中源集合 + ACL epoch + 知识 epoch + 用户 ID + 模型名**全部编入键。用户 ID 入键的理由写在注释里（答案提示词携带个人长期记忆与会话上下文）——这一条比多数生产系统做得严。
- **outbox 语义**：`dispatchInternal` 只重放 `retryCount < max` 且跳过 BullMQ 仍持有租约的 `active/delayed` 任务（不抢租约），单条失败不阻塞同批后续事件。这是成熟的消息中继写法。
- **成熟文档处理**：上下文前缀检索（`contextual-retrieval.ts`）、晚分块（`verified-late-chunking.ts`，含 capability 契约校验）、RAPTOR 树、内容去重、canonical block 均已落地。
- **BGE-M3 全能力使用**：dense 1024 维 + sparse + multi-vector（MaxSim），且有 capability 契约校验（`hybrid-capability.ts`），维度/词表/多向量维度全部验证后才启用。多数系统只用了 dense 部分。

这些不是「接近 SOTA」，而是「已进入 SOTA 做法的清单」。问题在别处。

---

## 五、真实缺陷清单（按影响排序）

### P0：正确性与安全

| # | 缺陷 | 位置 | 影响 |
| --- | --- | --- | --- |
| S-1 | **JWT/会话签名密钥有硬编码回退值** `secret \|\| 'llmwiki-local-development-secret'` | `auth/auth.service.ts:69`、`auth/oidc.service.ts:118` | 生产若漏设 `AUTH_SECRET`，任何知道该常量的人可伪造任意用户身份的 token。这是**最高危**的单点，必须改为启动期硬失败（同 `production-bootstrap.ts:13` 对管理员口令的做法） |
| S-2 | **核心租户表只 `ENABLE` 未 `FORCE` ROW LEVEL SECURITY** | `migrations/20260922200000_rls_tenant_isolation/migration.sql:232-244` | 表 owner 绕过策略。应用以 NOBYPASSRLS 角色连接时可缓解，但迁移/运维角色（`llmwiki_instN` 迁移用户）仍可越表。后续迁移（dense_generation_snapshots 等）已对个别新表用 `FORCE`，说明团队知道该怎么写，只是核心表没回补 |
| S-3 | **身份表全部关闭 RLS**（`User`/`Role`/`OrgNode`/`UserOrg`/`UserRole`） | 同上 `:372-376` | 授权判定所依赖的表无行级保护，一旦应用层权限判断出现分支遗漏即直接越权。需确认应用层是否对这些表有等价强制过滤 |
| S-4 | **外部 LLM 响应内容直接写入语义缓存，无来源校验** | `chat/semantic-cache.service.ts:store` | 缓存投毒面：被接管的模型端点（或提示注入）产出的答案会按范围键缓存并对同范围用户重放。已有 `validateEvidenceDependencies` 依赖重验，但未校验答案内容与证据的蕴含关系 |
| S-5 | **图谱 4 处 `take` 无 `orderBy`** | `graph-rag.service.ts:1732,1936,2066,2132,2142` | 召回内容随存储顺序变化，不可复现；高权重边可能被截断丢弃。B-8 只修了最热的两处 |

其余安全项**核实为已正确实现**，不构成缺陷：OpenApiGuard 强制 `X-App-Id/X-App-Secret` 双因子并对凭证路径限流；`AdminGuard` 覆盖全部管理端点；MCP 控制器（`mcp.controller.ts`）无 `@UseGuards`，但该类只有 `spec` 与 SSE/消息端点，需按实际暴露的 nginx 路由确认是否为可匿名调用的工具面（列为待确认，非结论）；`production-bootstrap.ts:13` 对首个管理员口令做了硬失败校验。

### P1：质量与证据（这是「是否业内最佳」的真正答案）

| # | 缺陷 | 位置 | 影响 |
| --- | --- | --- | --- |
| Q-1 | **faithfulness 指标是逐字子串命中率，与忠实度无关** | `tests/evaluation/test_retrieval_quality.py:337` | 中文字符短语子串匹配天然低命中，open-ended 答案必然得 0。0.11 与 0.325 同步低是同一失败机制的产物。第一份报告据此判定「生成链路存在真实问题」属**基于错误指标的错误归因** |
| Q-2 | **官方质量门无有效运行** | `results/quality-gate-report-2026-09-27...json` | 50/50 HTTP 401，成功率 0.40 无意义。三个桶报 0% 只是「全部 401」的投影 |
| Q-3 | **LLM judge 默认关闭** | `quality-gate.ts:56` `LLM_JUDGE_ENABLED = GATE_LLM_JUDGE === 'true'`；报告中 `judge.enabled=false, meanSampleSpread=null` | 「多采样 judge + spread」的机制写好了但从未在门禁中启用，等于没有独立判据 |
| Q-4 | **关键模块无单测** | `chat/retrieval-arms.ts`、`ingestion/ingestion.service.ts`、`chat/fusion-rerank.ts`、`retrieval/hybrid-retrieval.service.ts` 均**无 `.spec.ts`** | 「992 passed」覆盖的是有测试的模块；召回与融合这两个决定答案质量的核心恰恰没有单测护栏 |
| Q-5 | **金标集规模与代表性不足** | `golden_dataset.json` 220 题，其中 30 题 `corpus_absent=true`（实际计入 190）；9 桶中 `long_doc_completeness`/`multi_doc_synthesis`/`conflict_version` 各仅 15 题 | 单桶 15 题的统计效力不足以支撑任何桶级结论 |
| Q-6 | **09-27 门禁之后的证据断档**：仓库内最新的有效端到端结果仍是 09-23（`latest_results.json`）与 09-27 的 401 空跑 | `tests/evaluation/results/` | 本次会话新增的 25+ 用例（单测层面）之后，**没有任何一次真实端到端评测记录**。这是当前「不能宣称 SOTA」的直接原因，与模型能力无关 |

### P2：性能与结构

| # | 缺陷 | 位置 | 影响 |
| --- | --- | --- | --- |
| P-1 | **TTFT 均值 17.2s / 总耗时 21.1s** | `latest_results.json` | 真正原因是首字之前要跑完：权限计算 → 文档清单/表格/大纲三个**穷举式预扫描**（`outlineDocumentTitle` 路径最多扫 5000 chunk）→ 多臂召回 → rerank → 生成首句。增量流式已上线，但流的是**门控通过后**的稳定前缀，首句仍需等一次完整 LLM 首批 + 接地判定 |
| P-2 | **单类编排 5782 行** | `chat/chat.service.ts` | 理解、测试、并行化改造的成本瓶颈；两次报告均提拆分未动 |
| P-3 | **图谱默认参与每题** | `chat.service.ts` 召回链 | 局部事实题不需要图谱，但代码路径默认跑；GraphRAG 本身的 local/global 路由（`graph-route.spec.ts`）已存在，缺的是「按查询类型是否启用图谱」的开关 |
| P-4 | **parser-worker `main.py` 2106 行单文件** | `apps/parser-worker/src/main.py` | 与 API 侧同构的结构债 |

---

## 六、优化方案（按「先修证据、再修实现」排序）

核心判断：**当前不是「改了会更 SOTA」，而是「先让评测可信，否则任何优化都无法证明有效」。** 因此顺序与第一份报告相反。

### 阶段 0：让评测可信（最高优先，1-2 天，不依赖任何模型改动）

1. **修 faithfulness 定义**（Q-1）。把逐字子串命中改为**句级蕴含判定**：复用仓库已有的 `citationAssembly.judgeEntailment`（`citation-assembly.ts:825`，已有批量 JSON 输出与超时），对每个答案句判定是否被其引用证据蕴含；无引用句单列。金标片段从 `["规定了","绩效考核"]` 这类通用词改为**句级参考事实**。
2. **门禁启用 judge 与多采样**（Q-3）。CI 中设 `GATE_LLM_JUDGE=true`、`GATE_LLM_JUDGE_SAMPLES=3`，把 `meanSampleSpread/maxSampleSpread` 纳入通过条件（spread 超阈值即判不稳定而非判通过）。
3. **修复质量门的 401 空跑**（Q-2）。在门禁脚本中增加前置断言：若失败条目中 401 占比 > 5%，直接以「环境未就绪」硬失败退出，而不是产出一份 0.40 的报告。
4. **冻结语料 + 固定 commit 重跑**，产出第一份有效基线（当前 09-23 之后再无有效端到端数）。

### 阶段 1：安全（1 天内可完成，纯小改）

5. **移除密钥回退**（S-1）：`auth.service.ts:69`、`oidc.service.ts:118` 改为生产环境缺失即抛错启动失败，与 `production-bootstrap.ts:13` 一致。
6. **核心表回补 `FORCE ROW LEVEL SECURITY`**（S-2）：对 `Document/Chunk/KnowledgeBase/GraphEntity/GraphRelation/RaptorNode/Conversation/Message/Citation` 补 `ALTER TABLE ... FORCE ROW LEVEL SECURITY`，复用已有 `verify.sql` 的校验模式。
7. **身份表权限确认**（S-3）：对 `User/Role/OrgNode/UserOrg/UserRole` 增加应用层强制过滤的单测，或改为启用 RLS + 放行策略。
8. **图谱补排序**（S-5）：4 处 `take` 加 `orderBy`，与已修的两处保持一致。
9. **缓存写入加来源校验**（S-4）：`store` 前要求答案句级蕴含判定通过（与阶段 0 第 1 项共用同一实现）。

### 阶段 2：质量主线（依赖阶段 0 的基线）

10. **跑一次三段诊断**（工具已存在）：`npx tsx tests/evaluation/faithfulness-diagnose.ts --bucket exact_clause --limit 40`，输出「召回 → 证据包 → 答案」三段，按 `retrieval_empty / evidence_weak / ungrounded_sentences / refusal` 归因。**用新指标**判定生成链路是否真有缺陷——在此之前不改生成逻辑。
11. **补核心单测**（Q-4）：`retrieval-arms.ts`、`fusion-rerank.ts`、`ingestion.service.ts`、`hybrid-retrieval.service.ts`。融合与召回的顺序稳定性、空结果、超预算回退是最小必测集。
12. **表/条款/OCR 专项**：`table-evidence.service.ts` 与 `table-aggregation.ts` 已存在，缺的是对齐金标（单元格级）；OCR 桶同理。

### 阶段 3：性能与结构

13. **TTFT 拆解**（P-1）：先用 `StageReporter` 已有的阶段事件统计「首个 stage / 首个 delta / 完成」三段 P50/P95，定位 17s 花在哪一段，再做针对性优化。预扫描三路径（文档清单/表格/大纲）应改为**按查询意图择一**，而非顺序尝试。
14. **拆 `chat.service.ts`**（P-2）：按「规划 / 召回 / 证据包 / 输出」四块拆，现有 124 个 spec 作为行为护栏。
15. **图谱按查询类型启用**（P-3）：复用现有 `graph-route`，加「不启用图谱」分支，用配对消融证明质量非劣。

### 需要外部资源、本会话无法闭环

- 10 万/100 万 chunk 容量压测与 10 实例混合负载（前报告已给协议，协议本身合理）。
- 金标扩到 1000+ 题与月度人工盲评（内容工作）。
- Web 115 个 lint 存量（结构性重构，单独 PR）。

---

## 七、验收指标（修正后）

| 指标 | 当前真实值 | 目标 | 说明 |
| --- | --- | --- | --- |
| **评测有效性** | 无有效运行 | 门禁硬失败于环境未就绪 | **先决条件** |
| **faithfulness** | 0.11（指标无效） | 句级蕴含 ≥0.90 | 换指标后重新测量 |
| context_precision（220 题） | 0.635 | ≥0.85 | 现有 09-23/09-21 数据可比 |
| hit_rate@5（220 题） | 0.947 | ≥0.95 | 已接近 |
| 首字延迟 P95 | 17.2s（均值） | ≤3s | 需先做阶段 3 第 13 项拆解 |
| 越权 | 未测（无一例反例） | 0，硬失败 | 需权限矩阵用例 |
| 核心模块单测 | 4 个关键模块为零 | 全部覆盖 | Q-4 |

---

## 八、一句话回答「是否业内最佳」

**不是。** 架构选择与若干工程细节（HNSW 过滤召回、RLS 失败关闭、outbox 死信、范围键语义缓存、BGE-M3 全能力使用）确实达到或超过企业 RAG 的常规水准，这部分无需改造。但两处硬伤使其无法被称作业内最佳：

1. **评测体系目前不可信**——官方质量门跑出的是 401 空跑，faithfulness 指标定义与忠实度无关。一个无法证明自己有效的系统，无论实现多好，都不构成 SOTA 宣称。
2. **密钥回退值**（`auth.service.ts:69`）是可以在生产直接导致身份伪造的缺陷，安全基线未闭合。

先修这两条，其余优化才有意义。
