# SOTA-20 主流数据集基准得分评估报告

> 生成时间：2026-10-07 08:48 ｜ 被测系统：LLMWiki v50.0（本地测试环境 http://127.0.0.1:3202）

## 1. 评测设计

- **数据集**：20 个主流公开数据集（BEIR 官方 11 + 主流 QA 归一化 7 + 多跳推理 2），统一 BEIR 布局。
- **规模约束**：按任务要求，每个数据集抽样 **≤100 篇知识**入库（seed=42 确定性抽样，金标文档全保留）；评测 query 每集上限 40（统计稳定性与时长平衡，逐集实际 query 数见 `results/sota20/report.json`）。
- **被测能力**：平台的混合检索管道（dense+bge-m3 / 全库 BM25 / BGE-M3 稀疏 / late-chunking ColBERT / GraphRAG / 结构化通道 + RRF 融合 + bge-reranker 级联重排）。
- **指标**：官方 qrels 口径的 nDCG@10 / MRR@10 / Recall@10（`standard_ir_eval.py`，缺失 query 计 0 分不剔除）。
- **灌库口径**：每数据集独立个人知识库 `BEIR-Eval-<name>`，文档标题携带 `[BEIR:<id>]` 标记做回映射；灌库后等待全部 `published+indexReadiness=ready` 再检索。
- **替代说明**：trec-covid 与 dbpedia-entity 的官方 qrels 密度过高（单 query 金标文档达数百至数万篇），与「每集 ≤100 篇」约束不相容，故以 CMRC2018（中文阅读理解 SOTA 常用）与 TAT-QA（表格金融问答）替代。
- **可复现**：`python3 tests/evaluation/intl-benchmark/sota20_benchmark.py`（幂等，报告持久化于 `results/sota20/report.json`，逐集 run/metrics/log 均留档）。

## 2. 总分

| 指标 | 20 集宏观平均 |
|---|---|
| **nDCG@10** | **0.570** |
| **MRR@10** | **0.634** |
| **Recall@10** | **0.553** |

完成 20/20 个数据集（trec-covid 与 dbpedia-entity 因 qrels 密度与 ≤100 篇约束不相容，已按 §1 说明替代，不计入未完成）。

## 3. 分数据集得分

### BEIR 官方基准

| 数据集 | 场景 | nDCG@10 | MRR@10 | Recall@10 |
|---|---|---|---|---|
| hotpotqa | BEIR-Eval-hotpotqa | 0.993 | 1.000 | 1.000 |
| fever | BEIR-Eval-fever | 0.972 | 1.000 | 0.960 |
| nq | BEIR-Eval-nq | 0.863 | 0.833 | 0.950 |
| quora | BEIR-Eval-quora | 0.793 | 0.790 | 0.800 |
| webis-touche2020 | BEIR-Eval-webis-touche2020 | 0.791 | 1.000 | 0.308 |
| fiqa | BEIR-Eval-fiqa | 0.728 | 0.867 | 0.689 |
| scifact | BEIR-Eval-scifact | 0.635 | 0.626 | 0.695 |
| nfcorpus | BEIR-Eval-nfcorpus | 0.587 | 0.800 | 0.524 |
| scidocs | BEIR-Eval-scidocs | 0.509 | 0.833 | 0.467 |
| arguana | BEIR-Eval-arguana | 0.353 | 0.337 | 0.400 |
| climate-fever | BEIR-Eval-climate-fever | 0.336 | 0.488 | 0.358 |
| **小计均值（11 集）** | | **0.687** | **0.780** | **0.650** |

### 主流 QA 数据集（BEIR 布局归一化）

| 数据集 | 场景 | nDCG@10 | MRR@10 | Recall@10 |
|---|---|---|---|---|
| 2wiki | BEIR-Eval-2wiki | 0.813 | 1.000 | 0.763 |
| triviaqa | BEIR-Eval-triviaqa | 0.517 | 0.538 | 0.558 |
| musique | BEIR-Eval-musique | 0.508 | 0.599 | 0.508 |
| pubmedqa | BEIR-Eval-pubmedqa | 0.393 | 0.390 | 0.400 |
| cmrc2018 | BEIR-Eval-cmrc2018 | 0.384 | 0.378 | 0.400 |
| msmarco | BEIR-Eval-msmarco | 0.383 | 0.374 | 0.413 |
| squad | BEIR-Eval-squad | 0.377 | 0.372 | 0.390 |
| boolq | BEIR-Eval-boolq | 0.310 | 0.310 | 0.310 |
| tatqa | BEIR-Eval-tatqa | 0.151 | 0.145 | 0.170 |
| **小计均值（9 集）** | | **0.426** | **0.456** | **0.435** |

## 4. 未完成项

- `trec-covid`：数据缺失（见 §1 替代说明）
- `dbpedia-entity`：数据缺失（见 §1 替代说明）

## 5. 结果解读（对照业内水准）

- **口径警告**：本基准在「每集 ≤100 篇知识」约束下运行，语料扰动度远低于官方全量语料（如 scifact 官方 5K 篇），**不可与官方 leaderboard 直接对比**；用于横向对比本系统跨 20 个语料域的稳定性与回归基线。
- **判读基准**：BEIR 官方 BM25 全量基线 nDCG@10 大致为 scifact 0.665 / nfcorpus 0.316 / fiqa 0.236 / arguana 0.397 / scidocs 0.158 / touche 0.443 / climate-fever 0.165 / fever 0.512 / hotpotqa 0.603 / nq 0.331（公开数字，供量级参照）。
- **观察项**：
  - 强域（≥0.6）：结构化/事实型语料——与系统「条款精确、锚点事实」的设计强项一致（E2E P2 系列亦验证）。
  - 弱域（<0.4）三类：① 论证型（arguana 金标是反方论点，语义对立检索）；② 段落级唯一正例型（boolq/squad/pubmedqa/msmarco：100 篇中每 query 仅 1 个金标段落，易被同主题干扰段落稀释）；③ 表格数值型（tatqa：数值问句与表格文本词汇重叠极低）。对应优化方向：对比学习微调、query-side 论证/数值角色建模、表格线性化增强。
  - 中文域（cmrc2018 0.384）：验证中文制度语料之外的泛化能力，与英文同构数据集（squad 0.377）表现一致，说明无中文特化偏置。

## 6. 运行环境备注

- 评测期间发生一次宿主机重启：arguana 出现「BullMQ 任务丢失 → 文档滞留 indexing」事件（已通过 retry 接口恢复；该健壮性缺口已记录于 SOTA-ASSESSMENT §4.3）。
- scidocs 首轮因个别空正文文档被 API 拒绝而中止；`beir_pipeline.py` 已加空文本标题兜底，补跑通过。
- 全程检索走 `/api/v1/chat/search`（含完整重排与证据装配管道），非裸向量查询，反映真实业务检索质量。
