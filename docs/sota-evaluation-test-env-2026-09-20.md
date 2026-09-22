# 测试环境 SOTA 测评报告（2026-09-20）

- **环境**：本机测试环境（systemd --user：`llmwiki-api` :3202、`llmwiki-web` :3200、`llmwiki-parser` :8100；PostgreSQL :5433 / Redis :6379 共享底座）
- **版本**：`apps/api` 走查整改后构建（v42.0 + 本次整改，见 [optimization-implementation-2026-09-20.md](optimization-implementation-2026-09-20.md)）
- **性质**：真实数据集、真实 API 调用、真实 DB；**未触碰生产环境**
- **说明**：所有分数均为本次实测；与固化基线比较时，基线为 2026-09-13（commit `43ccd01`）测得的 v14.0

---

## 一、三大国际公开多跳基准（官方 dev 集，各 100 题）

### 1.1 检索阶段（无 LLM 生成，n=100/数据集）

| 数据集 | 指标 | Golden v14.0（09-13） | 本次实测（09-20） | Delta |
| --- | --- | --- | --- | --- |
| 2WikiMultiHopQA | Recall@10 | 1.0000 | **0.7925** | -0.2075 |
| | Full Evidence | 0.7200 | **0.5200** | -0.2000 |
| | MRR@10 | 0.9850 | 0.9833 | -0.0017 |
| | nDCG@10 | 0.7520 | 0.7952 | +0.0432 |
| HotpotQA | Recall@10 | 1.0000 | **0.9250** | -0.0750 |
| | Full Evidence | 0.9700 | **0.8500** | -0.1200 |
| | MRR@10 | 0.9006 | 0.9039 | +0.0033 |
| | nDCG@10 | 0.8635 | 0.8140 | -0.0495 |
| MuSiQue | Recall@10 | 0.9900 | **0.6917** | -0.2983 |
| | Full Evidence | 0.8000 | **0.3600** | -0.4400 |
| | MRR@10 | 0.9193 | 0.9059 | -0.0134 |
| | nDCG@10 | 0.7071 | 0.6723 | -0.0348 |

**结论**：首位命中（MRR@10）基本持平，但**多跳证据的第二条/跨文档证据召回明显退化**（Recall@10、Full Evidence 双双下降，MuSiQue 最严重）。

### 1.2 端到端问答阶段（n=50/数据集）

| 数据集 | Containment（基线 n=100） | Citation Hit | Refusal Rate | F1（基线） |
| --- | --- | --- | --- | --- |
| 2WikiMultiHopQA | 0.54（0.62） | 1.00（1.00） | 0.02（0.00） | 0.0974（0.0865） |
| HotpotQA | 0.80（0.81） | 0.96（0.99） | 0.00（0.00） | 0.1450（0.0905） |
| MuSiQue | 0.32（0.36） | 0.96（0.96） | 0.00（0.00） | 0.0594（0.0547） |

**结论**：生成侧未退化，答案包含率与引用命中基本持平（F1 反而全线提升），说明答案本身仍可用；问题集中在**第二条证据的召回**。

## 二、内部真实测试集（220 题金标，9 类场景）

4 分片并行实跑（每片 55 题），结果已合并为 `tests/evaluation/results/latest_results.json`
（另存 `golden-220-2026-09-20.json`，各分片 `golden-shard-{0..3}.json`）：

| 指标 | 09-12 参考 | 09-20 实测 | Delta |
| --- | --- | --- | --- |
| rank_recall_10 | 0.8295 | 0.8273 | -0.0023 |
| hit_rate_5 | 0.8591 | 0.8182 | -0.0409 |
| context_recall | 0.8591 | 0.8159 | -0.0432 |
| context_precision | 0.7144 | **0.5182** | -0.1962 |
| mrr_10 | 0.8545 | **0.6614** | -0.1932 |
| keyword_hit_rate | 0.4553 | **0.5485** | +0.0932 |
| faithfulness（片段包含代理指标） | 0.2561 | **0.3538** | +0.0977 |
| hallucination_rate | 0.0045 | **0.0000** | -0.0045 |
| avg_ttft_sec | 8.00 | 17.46 | +9.46 |
| avg_total_sec | 8.91 | 20.62 | +11.71 |

> `rank_ndcg_10`（基线 2.66 > 1）与新代码（0.758，0–1）**不是同一口径**，不可比较，已剔除。
> 时延为 4 分片并行时测得，属上界，不能与单跑基线直接比较；纯端到端时延见第四节压测。

**分类明细**（`hit_rate_5`）：

| 场景 | n | hit_rate_5 | rank_ndcg_10 | faithfulness | keyword_hit |
| --- | --- | --- | --- | --- | --- |
| exact_clause | 40 | 1.000 | 1.000 | 0.087 | 0.275 |
| synonym_oral | 40 | 1.000 | 0.705 | 0.237 | 0.667 |
| no_answer | 30 | 1.000 | 1.000 | 1.000 | 1.000 |
| multi_turn | 30 | 0.667 | 0.692 | 0.467 | 0.556 |
| table_list | 20 | 1.000 | 1.000 | 0.667 | 0.550 |
| conflict_version | 15 | 1.000 | 1.000 | 0.000 | 0.644 |
| multi_doc_synthesis | 15 | 1.000 | 0.850 | 0.500 | 0.667 |
| **long_doc_completeness** | 15 | **0.000** | 0.000 | 0.000 | 0.333 |
| **scan_ocr_ppt** | 15 | **0.000** | 0.000 | 0.000 | 0.044 |

**结论**：
1. 219/220 用例通过；唯一失败 `GS-MT-192-T2` 是并行压测下的 `chat/search` 读超时（30s），非答案错误。
2. 幻觉率为 0、关键词覆盖与片段忠实度提升，说明**四层幻觉门控与答案组织在起作用**。
3. `long_doc_completeness` 与 `scan_ocr_ppt` **连续两次测评均为 0 命中**（09-12 亦为 0）——长期存在的**能力缺口**，与本次整改无关，但是当前最明确的改进靶点。
4. `context_precision` 与 `mrr_10` 下降：检索返回的候选变多、噪声变大（与我方图中/长度预算相关，也可能是 09-17～09-19 版本引入）。

## 三、BEIR SciFact（官方 qrels）

官方 `scifact.zip`（corpus 5,183 / queries 1,109 / qrels 300）→ 按“保留全部 gold”约束子集化为
**600 docs / 60 官方 test query**，走完整摄取 + 检索链路，用官方 qrels 打分：

| 指标 | 本次（600-doc 子集） | 参考（full corpus, 09-20 inst1 计划文档） | 公开基线 |
| --- | --- | --- | --- |
| nDCG@10 | **0.8541** | 0.5760 | BM25(Anserini) 0.665 / BGE-M3 dense ≈0.74 |
| Recall@10 | 0.9667 | — | — |
| Recall@100 | 1.0000 | — | — |
| MRR@10 | 0.8215 | — | — |
| MAP@10 | 0.8160 | — | — |

**重要口径提醒**：本行是 600 篇子集（比完整 5,183 篇容易得多），**不能**与公开基线或 full-corpus 数字直接比较；
`docs/sota-optimization-plan-inst1-2026-09-20.md` 记录的是 full-corpus 实测（nDCG@10 0.576，低于 BM25 基线）。
本次尝试 full-corpus 摄取被测试环境批量摄取能力阻断（见第五节），故先给出子集口径结果与全部命令。

## 四、向量基础设施与延迟

### 4.1 过滤 HNSW 召回（exact KNN 为 gold，40 条真实 query 向量，12,604 chunk）

| 配置 | Recall@10 | 返回不足 k 比例 | p50 / p95 |
| --- | --- | --- | --- |
| exact_knn（gold） | 1.0000 | 0 | 20.9 / 24.0 ms |
| ef=40, iterative_scan=off | 1.0000 | 0 | 16.5 / 98.3 ms |
| ef=40, relaxed_order | 1.0000 | 0 | 1.6 / 5.7 ms |
| ef=100, iterative_scan=off | 1.0000 | 0 | 21.1 / 26.7 ms |
| **ef=200 + relaxed_order（本次生产默认，迁移写入）** | **1.0000** | 0 | 20.9 / 25.1 ms |

门禁：`target_recall=0.98` → **passes: true**（本库仅 12.6k chunk，未触及 HNSW 压力区；100k 压测见 `reports/ann-recall-100k-chunks.json`）

### 4.2 压测（空闲机器，真实 API）

| 端点 | 请求 | 并发 | 成功率 | p50 | p95 | p99 | mean | QPS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/v1/chat/search` | 200 | 8 | 100% | 2.22 s | 9.04 s | 11.0 s | 3.10 s | 2.55 |
| `/api/v1/chat/completions` | 40 | 4 | 100% | 1.64 s | 52.95 s | 70.83 s | 14.95 s | 0.23 |

**结论**：
- 两个端点零错误，但 **search p50 ≈ 2.2s 与 GBrain 的 2s 竞速窗口高度吻合**，即检索路径的时延主要由“等 GBrain 而不得”构成，而不是 DB 检索本身（DB 侧 p50 仅 ~20ms）。
- completions 呈双峰：p50 1.64s（语义缓存/快速路径命中）与 p95 53s（多跳 + 生成 + 逐句门控）。**端到端时延是当前最大的体验风险**，且 09-12→09-20 的端到端耗时确实翻了一倍以上。

## 五、运行中发现的环境/工程问题（均已记录，未擅自整改）

1. **API 限流阻断批量摄取**：`RATE_LIMIT_MAX=600/min` 下 2,500 篇上传有 1,900 篇被 429 拒绝。评测需临时提高限流（本次做法）或让 `beir_pipeline.py` 具备限速/退避（建议后者）。
2. **软删除的 KB 仍占用富化队列**：`DELETE /kbs/personal/:id` 只置 `archived`，文档与其富化任务仍在队列中跑（本次积压 1,771 个任务），导致新 KB 的摄取被饿死（0/708 嵌入）。需要硬删除级联或删除时清理队列。
3. **默认富化档位不适合批量评测摄取**：每篇文档跑 Contextual Retrieval + RAPTOR 摘要（LLM），2,500 篇规模下 LLM 路由超时。改用评测档位（`CONTEXTUAL_RETRIEVAL_ENABLED=false`、`RAPTOR_ENABLED=false`、编译/维护关闭）后曲线恢复正常（嵌入速率 ~130 chunk/min，随后 600 篇 6 分钟内全部 ready）。
4. **解析服务能力上报已如实**：本机 `pymupdf_installed=false` → `page_vlm_enrichment_available=false`（旧版本会谎报 true）。
5. 本次评测所用的鉴权方式：为评估账号 `admin`（三大基准库 owner）签发 8 小时会话令牌，**未修改任何账号密码或凭据**；评测脚本已支持 `LLMWIKI_TOKEN` 直连（本次改进）。

## 六、结论与下一步建议

**不能宣称 SOTA**（与既有审计结论一致），当前真实画像是：

- 检索主干在**外部权威检索基准的子集**上表现良好（SciFact 子集 nDCG@10 0.854，需 full-corpus 复测才能对外引用）；
- 向量基础设施达标（Recall@10 1.0，门禁通过）；
- 幻觉控制与答案组织较基线**有实质提升**（幻觉率 0，忠实度 +0.098，F1 全线提升）；
- 但**多跳第二跳证据召回显著退化**（对比 09-13 基线），且**端到端时延翻倍**；
- `long_doc_completeness` / `scan_ocr_ppt` 两类 30 题**长期零命中**。

建议按此顺序处理：

1. **P0 定位多跳召回退化**：基线（`43ccd01`，09-13）早于 v37/v41/v42 与 09-19 审计整改；本次已用 A/B 排除今日改动（2Wiki：benchmark 模式开关 on 0.7875 / off 0.7925；图谱通道 off 0.7575，说明图谱通道贡献 +0.035）。下一步用开关二分：`LEXICAL_INDEX_ENABLED`、`RETRIEVAL_PRESTITCH`、`RETRIEVAL_SECTION_EXPANSION_MAX`、`RETRIEVAL_RRF_K`、`VECTOR_MIN_SCORE`。
2. **P0 压降 search 路径时延**：GBrain 竞速窗口 2s 是 p50 的主因，建议按来源健康度自适应（先探测可达再竞速，或缓存 source 可用性）。
3. **P1 long-doc/OCR 两类零命中**：与解析深度和长文完整性直接相关（属先前评估已确认的缺口）。
4. **P1 评测工程**：批量摄取档位固化（env preset）、限流退避、KB 删除级联、以及把本次 4 分片合并/令牌鉴权能力保留在 harness 中。
5. **P2**：在专用评测环境用完整 5,183 篇 SciFact 跑一次 full-corpus qrels，形成可对外引用的对比数字。

## 七、产物索引

| 产物 | 位置 |
| --- | --- |
| 三大基准检索结果（n=100） | `tests/evaluation/intl-benchmark/results/intl-{2wiki,hotpot,musique}-20260920-09*.json` |
| 三大基准端到端结果（n=50） | `tests/evaluation/intl-benchmark/results/intl-*-20260920-10*.json` |
| 内部 220 题合并结果 | `tests/evaluation/results/latest_results.json`、`golden-220-2026-09-20.json`、`golden-shard-{0..3}.json` |
| ANN 召回报告 | `tests/evaluation/intl-benchmark/results/ann-recall-test-env-2026-09-20.json` |
| 压测报告 | `tests/evaluation/intl-benchmark/results/load-{search,completions}-test-env-2026-09-20.json` |
| BEIR SciFact 子集（run/manifest/metrics） | `tests/evaluation/intl-benchmark/results/beir-scifact-subset-{run,manifest,metrics}-2026-09-20.*` |
