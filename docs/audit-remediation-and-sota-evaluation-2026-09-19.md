# 审计整改与 SOTA 达标评测报告

日期：2026-09-19
依据：[GBrainKG 业务流程、缺陷与 SOTA 差距审计](project-business-flow-and-bug-audit-2026-09-19.md)
范围：本地开发/测试环境（共享 PostgreSQL 16 + pgvector 0.8.6、Redis、MinIO），**未触碰生产环境**
结论口径：所有数字均为本次在本机可复现实测；未实测的项目明确标注为“未验证”，不计入达标。

---

## 1. 整改总览

审计 §4 列出 4 项 P0、7 项 P1（规模与稳定性）、4 项 P1（评测可信度）与 2 项 P2。本次逐条处理结果：

| 审计条目 | 状态 | 交付物 |
| --- | --- | --- |
| P0-1 词法检索不是真正全库 BM25 | ✅ 已实现并可复现 | `apps/api/src/retrieval/lexical-tokenizer.ts`、`lexical-index-store.ts`、`lexical-index.service.ts`、迁移 `20260919120000_lexical_bm25_index`、回填 CLI、集成测试 |
| P0-2 过滤 HNSW 召回未验证 | ✅ 已实现并实测（发现旧默认严重欠召回，已修正默认值） | `searchChunksByVector` 启用 `hnsw.ef_search=200` + `hnsw.iterative_scan=relaxed_order`；`tests/evaluation/intl-benchmark/ann_recall_eval.py`（exact KNN 为 gold） |
| P0-3 无十万级真实文档证据 | ⚠️ 部分（本机隔离 schema：25k 文档 / 100k chunk 实测，非生产硬件/真实语料） | `apps/api/scripts/scale-seed.ts`、`scripts/run-scale-benchmark.sh`、`tests/evaluation/intl-benchmark/reports/` |
| P0-4 无公开基准有效结果 | ⚠️ 未验证（缺数据集与凭据，本次未做假跑） | 门禁改为 fail-closed（见下），拒绝把未跑通的基准记为通过 |
| P1 Graph 持久化 N+1 | ✅ 已实现 | `graph-rag.service.ts` 单语句批量 upsert（实体/关系）+ 单元测试更新 |
| P1 RAPTOR Level-2 重复重建 | ✅ 已实现 | `raptor.service.ts` 使用 Redis 分布式锁，多实例只跑一次 |
| P1 查询 fan-out 无统一 deadline / bulkhead | ✅ 已实现 | `apps/api/src/retrieval/retrieval-budget.ts`（`RetrievalDeadline` + `Bulkhead`），在 `chat.service.ts` 应用于词法/向量/子查询通道 |
| P1 title-affinity 任意截断 | ✅ 已实现 | `chat.service.ts` 改为按标题匹配度/长度排序后取前 20 |
| P1 进程内 parse/rerank/route cache 多实例不共享 | ✅ 已实现（LLM 派生缓存）+ 说明 | `apps/api/src/redis/redis.service.ts`，接入 `agentic-rag.service.ts`（expansion/plan 缓存）。解析结果跨进程复用原本已有 DB content-hash L2（`ingestion.service.ts`），本次未重复实现 |
| P1 BrainTopic 旧编译路径与图谱 UI 扫描路径并存 | ⚠️ 未整改（架构收敛，范围大，需单独评审） | — |
| P1 负反馈无人工复核/离线回归闭环 | ✅ 已实现 | 管理端 `GET/PATCH /api/v1/admin/feedback-cases`、`tests/evaluation/feedback-regression.ts`（回放 converted 用例） |
| P1 `global 30` fixture 名不副实 | ✅ 已澄清 | 报告中明确标注为本地合成/fixture 子集，不作为国际基准成绩 |
| P1 `eval_ragas_deepeval_suite.py` 命名误导 | ✅ 已改名并标注 | 重命名为 `answer_quality_heuristic_suite.py`，文件头声明非官方实现 |
| P1 live CI gate 可跳过 | ✅ 已改为 fail-closed | `tests/evaluation/ci-gate.sh` 新增 `GATE_STRICT=1`（缺凭据/服务即失败） |
| P2 Web ESLint 存量错误 | ✅ 已清零（error） | `apps/web` 59 → **0 error**（10 条 warning 为非阻断项：`<img>` 与 exhaustive-deps） |
| P2 trace/日志文本过长 | ⚠️ 未整改（可观测性改造，需与日志规范一并评审） | — |

---

## 2. P0-1：引擎侧全库 BM25 词法通道

### 2.1 实现

- **通行空间（索引与查询同源）**：`lexical-tokenizer.ts` 对中文按 Unicode 分词后生成**词内二元组 + 一元字符**，对英文/数字保留完整词，标识符按分隔符切分为字母数字片段；所有 term 限定为字母/数字，与 PostgreSQL `'simple'` 解析器保持逐词一致。
- **词项前缀 `t<term>`**：PostgreSQL 文本解析器会二次切分输入（实测 `4e8c` → `4e8` + `c`，`x_y` → `x` + `y`）。因此索引与查询都用统一的 `t` 前缀写入，使每个词都以字母开头，解析器不再重切，索引与查询的词空间由结构保证一致（`npm run lexical:verify` 全量校验 12,604/12,604 chunk 零偏差）。
- **索引结构（迁移 `20260919120000_lexical_bm25_index`）**：
  - `ChunkLexicalDoc(chunkId, kbId, documentId, len, tsv tsvector)` —— tsv 由分词结果构造，`gin(tsv)` 支撑引擎侧候选解析。
  - `LexicalTermStat(kbId, term, df)` —— 语料级 document frequency，按文档增量维护（新增 posting 减旧 posting 的精确 delta）。
  - `KbLexicalStat(kbId, docCount, totalLen, statsVersion)` —— N 与 avgdl，`statsVersion` 落后时自助重建。
- **查询形状**：① 依 IDF 规则剔除 `df/N` 过高的非判别性 term（不是硬编码停用词表，全部由语料统计决定）；② `tsv @@ lexical_tsquery(terms)` 由 GIN 在全库范围解析候选，并按 `ts_rank_cd`（引擎侧相关性函数）排序后取窗口；③ 在窗口内用精确语料 df、N、avgdl 计算 Okapi BM25；④ ACL（kbId）与 `published` 门禁在同一条语句内完成；⑤ 单语句 `statement_timeout` 兜底。
- **写入路径**：`IngestionService` 发布后立即写入（best-effort），`EnrichmentProcessor` 将其纳入 `indexReady` 状态机（失败 → degraded + 重试），回填 CLI 可对存量全量重建，并自愈 `statsVersion`。

### 2.2 本地实测（本机 llmwiki 库：2,877 文档 / 12,604 chunk）

| 指标 | 结果 |
| --- | --- |
| 回填吞吐 | 12,604 chunk / 21–24 s ≈ **540–600 chunk/s**（单进程、逐文档，含增量统计维护） |
| 索引一致性 | 全量校验：`chunks = indexed = 12,604`、`postings = Σdf = 849,923`、逐 chunk 比对 tokenizer 输出与存储 tsv **0 处不一致**（`scripts/lexical-verify-all.ts`，退出码可用于门禁） |
| 索引体积 | `ChunkLexicalDoc` 21 MB（12.6k chunk，含 GIN 7.6 MB），约 **1.7 KB/chunk** |
| 源位置召回（自 24 字子串出题，80 条） | `found=78/80`、**Recall@10 = 0.975**、平均命中排名 **1.27** |
| 候选窗口保真度（50 条真实语料出题，40 字查询） | window=2000 与不设窗口的精确 BM25 **top10 重合度 1.0000**、源 chunk Recall@10 完全相同（0.82）；window=500/1000 分别降到 0.904/0.960 |
| 查询延迟（本机 12.6k chunk / 91 KB 全范围） | p50 ≈ 80 ms，p95 ≈ 566 ms（window=2000）；window=1000 时 p95 192 ms |
| 查询延迟（隔离 schema 100k chunk / 40 KB） | 常见词查询由候选预算与“最稀有 term 占比”护栏挡下（**5 ms 返回空**，交由向量/结构通道与旧候选池兜底）；可判别查询 p50 ≈ 137 ms |
| 降级路径 | 索引未回填/超时/异常 → 自动回退原候选池逻辑，答案不中断 |

> 说明：本地语料含大量近重复合成文档（如 `## 记录 N` 压力测试段），因此“源位置召回”按 **query term 覆盖率 ≥ 0.9 判定命中**，否则指标衡量的是重复度而非通道质量。

候选预算（`LEXICAL_CANDIDATE_BUDGET`，默认 8000）与最稀有 term 护栏是用 2.5% 源召回换取的延迟上界：不设预算时，10 万 chunk 语料上一句 13 个 term 的常见词查询要 **2.18 s** 才能排完 95,757 个候选（`ORDER BY ts_rank_cd ... LIMIT 2000` 实测），预算化后同一查询 757 ms、被护栏挡下时 5 ms。需要更高召回时调大预算即可（代价是线性延迟）。

### 2.3 回归测试

`apps/api/src/retrieval/lexical-index.integration.spec.ts`（真实 PG，独立 schema，用后即删）：

1. 稀有词 chunk 排在样板文本之前；
2. **截断回归**：60 个文档 300 个高频样板 chunk 之后、documentId 排序最末的“唯一相关 chunk”仍进入 top-10（旧 `ORDER BY documentId, ord LIMIT n` 会丢）；
3. ACL 与 `published` 门禁：越权 KB 与未发布文档均不可见；
4. 三方一致：tokenizer 输出 = 存储 tsv = 词频统计；
5. 幂等：同文档重复索引后统计量不变。

---

## 3. P0-2：过滤 HNSW 召回验证

生产查询改为在事务内设置 `hnsw.ef_search`（默认 100）与 `hnsw.iterative_scan=relaxed_order`，并对查询加 `statement_timeout`。

实测（`ann_recall_eval.py`，60 条真实 query 向量，exact KNN 为 gold，按过滤选择率分桶）：

**（a）本机真实语料 12.6k chunk（过滤选择率 5–30%）**

| 配置 | Recall@10 均值 | 最差样例 | 返回不足 k 的比例 | p50 / p95 |
| --- | --- | --- | --- | --- |
| ef_search=40, iterative_scan=off | 0.9983 | 0.9 | 0 | 12.2 / 81.4 ms |
| ef_search=40, relaxed_order | 0.9983 | 0.9 | 0 | 1.6 / 5.1 ms |
| ef_search=100 | 1.0000 | 1.0 | 0 | 18.8–19.1 / 19.7–20.5 ms |

**（b）隔离 schema 100k chunk / 40 KB（过滤选择率 2.5%，每条查询只允许看 1 个 KB）**

| 配置 | Recall@10 均值 | 完美召回比例 | **返回行数均值** | **返回不足 k 的比例** | p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| ef_search=40, iterative_scan=off（旧行为） | **0.2067** | 0.000 | **2.1** | **100%** | 3.0 / 5.8 ms |
| ef_search=100, iterative_scan=off | 0.4450 | 0.100 | 4.5 | 90% | 5.4 / 22.2 ms |
| ef_search=200, iterative_scan=off | 1.0000 | 1.000 | 10.0 | 0% | 21.4 / 26.3 ms |
| ef_search=40, iterative_scan=relaxed_order | 0.9533 | 0.783 | 10.0 | 0% | 12.5 / 17.9 ms |
| ef_search=100, iterative_scan=relaxed_order | 0.9583 | 0.800 | 10.0 | 0% | 13.1 / 23.1 ms |
| **ef_search=200 + relaxed_order（本次生产默认）** | **1.0000** | 1.000 | 10.0 | 0% | **21.3 / 26.7 ms** |

结论：审计的假设被实测证实——**过滤 HNSW 在选择性过滤下会严重欠召回**（旧默认返回不足 10 行、Recall@10 仅 0.21），`iterative_scan` 把它拉回 0.95 以上，而 `ef_search=200 + relaxed_order` 达到 1.00 且仅 +20 ms。因此生产默认已从 `ef_search=100` 提升到 `200`（`VECTOR_EF_SEARCH`，可调）。原始报告：[reports/ann-recall-100k-chunks.json](../tests/evaluation/intl-benchmark/reports/ann-recall-100k-chunks.json)。

---

## 4. P0-3：十万级规模实测（隔离 schema）

运行方式：`bash scripts/run-scale-benchmark.sh`（`SCHEMA=scale_bench`，脚本拒绝 `public`）。

> 声明：本次为本机容器内 **合成语料 + 复用真实向量分布** 的隔离 schema 压测，**不是**生产硬件上的真实十万文档导入报告，也不构成“100k 已验证”的结论。

配置：`SCHEMA=scale_bench`（专用 schema，脚本拒绝 `public`），25,000 文档 / **100,000 chunk**，40 个知识库。

| 阶段 | 实测 |
| --- | --- |
| chunk + 词法索引写入 | 100,000/100,000 成功（**successRate = 1.0，0 失败**）；本机单进程吞吐约 40–150 chunk/s（随索引增长衰减，见下） |
| 词法索引一致性 | postings = 100,000 chunk，Σdf = **9,615,368**，词表 **361,967**，`indexConsistent=true` |
| 向量回填（复用真实向量分布的两两平均） | 100,000 行 / **11.1 s** |
| HNSW 索引构建（m=16, ef_construction=64） | **136.9 s** |
| 体积 | `Chunk`（含 1024 维向量 + HNSW）**1,413 MB**；`ChunkLexicalDoc`（含 GIN）**172 MB**；`LexicalTermStat` **55 MB** |
| 过滤 ANN 召回 | 见 §3（b），选择率 2.5% 下旧配置 0.21 → 现默认 1.00 |
| 词法通道延迟 | 可判别查询 p50 ≈ 137 ms（40 KB 全范围）；常见词查询被预算/护栏挡下，5 ms 返回空并回退旧通道 |

规模化的瓶颈已经定位清楚：**词法索引维护是逐文档多次往返**（`previousTerms` 读取 + postings upsert + 词频 delta + 语料统计 delta，约 7 次往返/文档），因此写入吞吐随表增长下降到 ~40 chunk/s，是本机十万级导入的主要成本。后续优化方向是批量合并同批文档的统计 delta（一次往返处理 N 个文档），而不是缩小索引。

---

## 5. P1 稳定性与多实例整改

- **统一 deadline + bulkhead**：`RetrievalDeadline` 给所有检索臂共享墙钟预算（默认 15 s），`Bulkhead` 限制并发 DB 密集臂（默认 12，队列 200，饱和即降级），词法/向量/子查询三条路径均已接入。
- **Redis 分布式协调**：`RedisService` 提供 `getJson/setJson/withLock/singleFlight`，Redis 不可用时全部降级为进程内行为，不影响正确性；RAPTOR Level-2 构建加分布式锁，LLM 派生缓存（查询扩展、查询规划）改为多实例共享 + single-flight。
- **GraphRAG 批量持久化**：实体改为单条 `INSERT ... ON CONFLICT ("kbId","name") DO UPDATE ... RETURNING`，关系改为单条 `ON CONFLICT ("sourceId","targetId","relationType")` 批量 upsert（保留 weight≤10 封顶与 provenance 并集去重语义），消除逐条 N+1。
- **title-affinity 排序**：拉取 200 条候选后按“精确 basename 命中 > 命中 token 数 > 标题更短 > 稳定 ID”排序取 20，消除存储顺序截断。
- **负反馈闭环**：管理员可将 `not_useful` 案例标记为 triaging/converted/dismissed，converted 必须填写 correction；`tests/evaluation/feedback-regression.ts` 通过管理端 API 拉取 converted 用例、重放问题并校验答案（拒答/关键词缺失/与旧答案完全相同均判失败），支持 `FEEDBACK_GATE=1` 阻断发布。

---

## 6. 测试与门禁

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter api test` | **370 passed / 5 skipped（375）**，43 套件通过 + 1 跳过 |
| 词法通道集成测试（真实 PG） | 5/5 通过 |
| `pnpm run test:parser` | 21 passed（4 subtests） |
| `pnpm run test:adapter` | 通过 |
| 评测自测（IR / benchmark_suite / BEIR / fetch / loadtest / ann_recall） | 全部通过 |
| `apps/web` ESLint | **0 error / 10 warning**（整改前 59 error） |
| `scripts/lexical-verify-all.ts` 全量一致性 | 12,604/12,604 chunk 零偏差，`postings = Σdf` |
| `apps/web` `tsc --noEmit` | 通过 |
| `apps/api` `tsc --noEmit` | 通过 |
| CI 门禁 | 离线门禁默认执行；live 门禁在 `GATE_STRICT=1` 时 fail-closed（缺凭据/服务即失败），并接入 filtered-HNSW Recall@10 独立门禁 |

---

## 7. SOTA 门禁达成判定（对照审计 §5）

| 审计门禁 | 判定 | 证据 / 缺口 |
| --- | --- | --- |
| 1. 真实 100k 文档全量导入成功率 ≥ 99.9%，可重试且无跨版本污染 | ⚠️ 部分 | §4：本机隔离 schema 100k chunk 写入成功率 1.0/0 失败；真实 10 万文档、生产硬件、跨版本围栏压力测试仍未执行 |
| 2. 过滤 ANN Recall@10 ≥ 0.98（exact KNN 为 gold，多规模/多选择率） | ✅ 两档规模均通过 | §3：12.6k chunk 0.9983–1.0000；100k chunk + 2.5% 过滤选择率下 ef_search=200 + iterative scan = **1.0000**（旧默认 0.2067，已修正）。仍建议补 500k chunk 与真实语料复测 |
| 3. 公开基准（BEIR + MIRACL/MMTEB + 私有 hard-negative）nDCG/Recall/MRR/MAP | ❌ 未达成 | 无数据集与有效实跑结果；门禁已 fail-closed，不再把 dry-run 记为成绩 |
| 4. 端到端 claim-level 与人工双盲抽检（正确性/完整性/faithfulness/拒答/引用支持率） | ❌ 未达成 | 现有 `answer_quality_heuristic_suite.py` 为启发式评分，已声明非官方 Ragas/DeepEval |
| 5. 固定硬件与索引规模下 p50/p95/p99、QPS、首 token、错误率 | ⚠️ 部分 | 词法/ANN 延迟已在 12.6k 与 100k chunk 两档实测；端到端 QPS/首 token/错误率与并发压测仍未执行 |
| 6. live gate fail-closed、可复现配置/模型版本/数据哈希/原始 run 文件 | ✅ 已完成 | `ci-gate.sh` 严格模式 + 新增 `ann_recall_eval`/`feedback-regression` 报告落盘 |

**结论：现在仍不能宣称“全球真实超级 SOTA”或“已验证支持十万文档”。** 本次整改消除的是审计指出的**正确性与规模路径缺陷**（词法通道不再按存储顺序截断、过滤 ANN 有可对照的召回度量、查询有统一预算、多实例不再重复计算、评测门禁不再可静默跳过），并把“未验证”从模糊表述变成了可执行门禁。

达到 SOTA 声明所需的剩余工作（按优先级）：

1. 在测试环境导入真实 10 万文档语料，产出导入成功率/重试/跨版本污染报告（脚本已就绪，`scripts/run-scale-benchmark.sh` 指向隔离 schema）。
2. 跑通 BEIR 多领域 + MIRACL/MMTEB 多语 + 私有 hard-negative，落盘 nDCG@10/Recall@10/100/MRR/MAP 原始 run 文件。
3. 端到端 claim-level 评测 + 人工双盲抽检，或真正接入官方 Ragas/DeepEval 并把结果单独署名。
4. 在固定硬件上补全 p50/p95/p99、QPS、首 token、错误率与 100k 规模下的 filtered ANN Recall@K 复测。
5. 架构收敛（BrainTopic 旧路径、图谱 UI 扫描路径）与内部 trace 结构化，作为下一轮工程债清理。

---

## 8. 复现命令

```bash
# 1) 词法索引回填 + 一致性校验
pnpm --filter api lexical:backfill            # 全量回填（幂等）
pnpm --filter api lexical:backfill -- --rebuild-stats
pnpm --filter api lexical:verify              # tokenizer ↔ postings ↔ 统计 一致性
pnpm --filter api lexical:probe "员工报销交通费标准"
pnpm --filter api lexical:recall -- --samples=150
pnpm --filter api lexical:window -- --samples=50

# 2) 词法通道集成测试（真实 PG，独立 schema）
DATABASE_URL=... pnpm --filter api test:lexical-integration

# 3) 过滤 ANN 召回（exact KNN 为 gold）
pnpm benchmark:ann-recall -- --limit 60 --k 10 --ef-search 40 100 --iterative-scan off relaxed_order

# 4) 十万级隔离 schema 压测
CHUNKS=100000 bash scripts/run-scale-benchmark.sh

# 5) 负反馈回归与严格门禁
API_BASE=http://127.0.0.1:3202 TEST_PASSWORD=... pnpm evaluate:feedback
GATE_STRICT=1 CHECK_INTL=1 pnpm gate
```

---

## 9. 生产发布记录（inst1 / meetings2 / knowledge.5gsailor.com）

发布方式：`bash scripts/deploy-prod.sh --target=inst1`（本地构建 → rsync → 迁移 → 重启 → 健康巡检）。

**发布前保险**（`/data/backups/pre-deploy-20260919-213551/`）：
`llmwiki-schema.sql.gz`（schema-only dump）+ `gbrainkg-code.tgz`（代码快照）。

| 阶段 | 结果 |
| --- | --- |
| 迁移 | 应用 3 个迁移：`20260919100000_graph_search_indexes`、`20260919110000_semantic_cache_atomic_upsert`、`20260919120000_lexical_bm25_index` |
| 服务 | `llmwiki-api` / `llmwiki-web` / `llmwiki-parser` 全部 active |
| 健康巡检 | API(3000) OK · Web(3200) OK · 公网网关 HTTP 200 · GBrain 引擎状态 OK |
| 词法索引回填 | 77,244 文档 / **91,732 chunk**，耗时 1,144 s（**80 chunk/s**，2 vCPU 生产机） |
| 回填后一致性 | `chunks = indexed = 91,732`，`postings = Σdf = 9,711,926`，词表 232,251，`mismatchedChunks = 0`，`consistent = true` |
| 过滤 ANN 抽检（只读 20 样本） | 新配置（ef_search=200 + iterative_scan）**min=10 / avg=10.00 / 短结果 0-20**；旧配置（ef=40 无迭代）min=7 / avg=9.75 / **短结果 2-20** |

说明：生产机为 2 vCPU / 3 GB，exact-KNN 金标准会打满页缓存影响线上服务，因此**未在生产跑重基准**（§3 的 Recall@K 证据来自 12.6k 与 100k chunk 两档隔离环境）。生产只做了轻量只读抽检。

---

## 10. 缺陷修复：回答正确但引用指向无关文档（2026-09-19 生产反馈）

### 10.1 现象

测试环境提问「王群丽是谁？干了什么事。」：回答正确，但引用指向 `【0907】智云江苏-重点平台卡位及纵向一体化工作周通报(3).pdf`。

### 10.2 根因（有运行时日志与落库 trace 为证）

```
[PROMPT_SOURCES] [1] 【0907】智云江苏-…周通报(3).pdf … [7] 我的宝藏老师.docx
```

- 检索、证据选择、prompt 编号**全部正确**：王群丽所在文档是 prompt 里的**来源 7**（`gbrain_retrieval` topEvidence 也是它，score 0.95）。
- 落库的 `citation_validation` 已是 **warning**：`referencedCitations=[1]`、覆盖率 33%（3/9 句有据）。
- 即：**模型自己把角标写错了（应为 [7]，写成了 [1]）**，而流水线只是把 `[n]` 机械映射到 prompt 第 n 条证据，缺少“角标是否真的支持该句”的纠正环节 → 前端展示了 [1] 对应的周通报。

### 10.3 修复

在句子级 grounding 门禁中新增**确定性角标重绑定**（`findSupportingEvidenceIndex` / `rebindCitationMarkers`，`chat.service.ts`）：

1. 带角标的句子若**不能**被其所引证据支持 → 在当次 prompt 的证据池中重新寻找真正支持该句的证据（复用同一套 `statementSupportedBy` 判定：字符重叠阈值、极性冲突、数字一致性），取重叠度最高者；
2. 命中则**改写该句角标**为新证据序号后再流式输出（用户看到的就是正确引用）；未命中才按原逻辑暂扣/告警；
3. 新增 `citation_rebinding` trace 节点，warning 表示本次回答发生过角标纠正（可观测、可审计）；
4. 暂扣语句在复核放行时也会先做同样的角标修复。

### 10.4 验证

| 验证 | 结果 |
| --- | --- |
| 单元测试 `citation-rebinding.spec.ts` | 5/5 通过（错标重绑定 / 正确不动 / 无支持则不改 / 重复角标收敛 / 与证据矛盾时不误绑） |
| **真实数据复放**（本机故障消息 `90f509cc…`，真实证据文本） | 5 句带角标语句中 **2 句被判定错标并重绑定**：`[1] 周通报(3).pdf → [2] 我的宝藏老师.docx`，且重绑定目标通过支持度校验 |
| 全量 API 测试 | 380 用例：375 passed / 5 skipped |
| 生产（inst1） | 已发布，bundle 含 `citation_rebinding`，服务健康 |

> 修复后的判定仍是确定性的、语料无关的：不引入业务词表，不依赖模型自我纠错。

---

## 11. 发布过程中发现并修复的两个构建陷阱

1. **rootDir 漂移**：`apps/api/scripts/*.ts` 进入 tsconfig 编译范围后，tsc 把 rootDir 上提到包根，产物变成 `dist/src/main.js`，而 systemd 与 `deploy-prod.sh` 都指向 `dist/main.js` → 发布会起不来。已通过 `tsconfig.build.json` 的 `rootDir: ./src` + `exclude: scripts` 修正。
2. **增量缓存导致静默空产物**：`deleteOutDir: true` 会清空 dist，但 `tsconfig.build.tsbuildinfo` 留在 dist 之外，tsc 认为产物仍是最新 → `nest build` 成功却**不产出任何文件**。已将 `tsBuildInfoFile` 移入 `dist/`，删除即失效，二次构建仍为增量。

两项均在本地与生产发布中验证（`dist/main.js` 与 `dist/bootstrap/lexical-index-cli.js` 均正确生成）。

---

## 12. 当前状态与后续

已完成：本地部署验证 → 生产 inst1 发布 → 迁移 → 词法索引回填与全量校验 → 过滤 ANN 抽检 → 引用角标缺陷修复与发布。

待用户配合 / 后续：

1. **生产端到端复测**：inst1 的管理员口令与我持有的初始化文件不一致（未猜、未重置）。请用你们的测试账号在 inst1 复问该问题；我可以据 `Message.citationsSummary` + `processingTrace.citation_rebinding` 直接核对引用是否已指向正确文档。
2. **重基准**：exact-KNN 金标准与 BEIR/MIRACL 实跑建议在 8C16G 以上的测试机或维护窗口执行（生产机 2C3G，不适合）。
3. 如需在 inst1 建立可复现基准，建议单独开辟一个实例（如 instN）承接评测流量，避免影响客户实例。
