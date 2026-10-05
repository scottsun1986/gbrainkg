# 历史 SOTA 结果审计（2026-10-05）

本审计只读核验了归档结果并作离线重算，没有请求 live API、修改评测或产品源码、启动高负载任务。逐题行、SHA-256、重算值、样本覆盖、置信区间和限制见 [JSON 审计记录](./historical-audit-2026-10-05.json)。

## 判定

现有 SOTA10、国际多跳与企业集均不能证明全球 SOTA。SOTA10 BEIR 是每库不超过 30 篇文档的 gold-guaranteed 子集；国际多跳是每集 100 题、300 篇金标覆盖语料；企业历史结果有 220 行名称，但多个汇总实际只计 190 个可检索案例。它们可用作内部诊断，不能与全量公开榜单同口径排名。

这份审计只重算历史产物。没有 2026-10-05 live 新系统成绩；其他评测运行线应独立报告，不能拼进本历史基线。

## 可复核的历史结果与问题

- **SOTA10。** 10 个当前结果文件的逐题行数、qid 覆盖和汇总指标相符；重算 QA containment/F1/EM 等与保存的汇总相符。任务包明确采用最多 30 题、最多 30 篇文档，并保证 gold 文档入库。四个 BEIR 数据集不是官方完整 corpus/qrels/run，缺少 nDCG@10、Recall@100 所需的全量 qrels 与完整 unique-doc ranking。模型版本、运行 commit、语料 manifest/hash 也未保存在这些结果中。
- **重复排名位置。** SciFact 原始排名 780 个位置中有 144 个重复内部文档 ID；按 unique-doc ranking 压缩重算，nDCG@10 从 0.9705 变为 0.978103，Recall@10 仍为 1.0。结果显示重复项会扭曲截断名次；这个样本的分数没有因此虚高，而是被重复项占位压低。其余 SOTA10 任务包无大小写归一后的重复标题。内部 title/id 映射可能丢失碰撞信息，但现存任务包没有可证明它导致虚高的例子。
- **国际多跳 profile=300。** 2Wiki、Hotpot、MuSiQue 均为 100/100 qid 完整、无重复，归档报告的语料 SHA-256 与 manifest 文件 SHA-256 相符。按逐题保存的文档 ID 排名去重后，nDCG@10 分别为 **0.8238 / 0.9772 / 0.8395**，归档值为 **0.8131 / 0.9716 / 0.8393**；差异来自重复文档位置占据排名 cutoff，去重后排序前移。归档 top-10 中的重复文档位置为 **33/1000、11/1000、1/1000**。更高的 retrieved-title recall 并不等于完整证据支持，也不能替代官方答案/支持事实指标。
- **多跳失败桶（title-level full-evidence × 答案 containment/alias proxy）。** Hotpot 100 题有 8 题“证据完整但答案 proxy 未命中”，95% bootstrap CI 为 3%–14%；2Wiki 有 32 题“答案 proxy 命中但 gold title 证据不完整”（32%，CI 23%–41%）及 10 题答案 proxy 未命中；MuSiQue 有 22 题证据完整但答案未命中（22%，CI 14%–30%）、15 题证据不完整且答案未命中（15%，CI 8%–22%）。这些是排序优化与答案合成的实际诊断证据，但 proxy 不是人工正确性判定。三组 containment 分别为 0.92 [0.86, 0.97]、0.90 [0.84, 0.95]、0.61 [0.52, 0.70]。TTFT P50/P95 分别为 38.65/64.55s、63.25/98.28s、47.44/81.08s。MuSiQue 有 1 个 QA API error（qid `4hop2__103790_14670_8987_8529`）；Hotpot、2Wiki 为 0。置信区间采用固定 seed 的逐题 bootstrap，只表示这些样本内的不确定性，不代表跨运行波动。
- **企业 220 题。** golden dataset 有 220 个唯一 ID。2026-09-20 原始结果有 220 行，但记录了 1 个 API failure；另 `long_doc_completeness` 和 `scan_ocr_ppt` 共 30 题在后续运行被确认 corpus-absent，早期结果未标缺失且各自 rank hit@5=0，不能归因于检索排序。2026-09-21 的 final/round3/no-cache 等文件仍有 220 条原始行，但摘要 count=190，排除了这 30 题；final hit@5=0.9474（95% CI 0.9158–0.9789）、MRR@10=0.9305（CI 0.8966–0.9613）、context precision=0.6351（CI 0.5785–0.6914）。应表述为 190 个 corpus-present 案例。
- **企业失败桶线索。** 可检索结果中 multi_turn hit@5=0.6667（30 题），是明确的检索错失桶；conflict_version hit@5=1.0 但 legacy snippet-match proxy=0；exact_clause hit@5=1.0 而 proxy 仅 0.0625。后两者值得优先审查答案/引用，但原始 JSON 没有 answer、检索标题/ID、引用片段，不能断言为答案错或不忠实。历史 `faithfulness` 没有 `faithfulness_measured` / judge trace，按当前定义只能称 **snippet-match proxy**，真正 faithfulness 为 **未测量**。企业归档只保留聚合 error 数和逐题 api_error 文本，不能完整审计认证与 transport 状态；也没有可检查重复 title/chunk 的结果载荷。

## 口径与下一轮排序优化优先级

1. **MuSiQue 多跳证据覆盖与合成（最高）**：有效语料下 title-level full evidence 仅 0.66，且 34/100 题属于证据不完整；其中 1 题 QA 超时（其检索行仍标记证据不完整），另外 15 题答案 proxy 未命中、18 题答案 proxy 命中。另有 22 题证据完整但答案 proxy 失败。先以失败 qid 对照 bridge-hop 文档排名，再区分排序和答案合成。
2. **2Wiki 完整支持文档召回**：full evidence 0.61；32/100 题答案 proxy 命中但缺少一个或多个 gold titles，说明答案命中不能代替完整多跳证据。
3. **企业 multi_turn 检索**：现存 30 个可检索案例 hit@5 约 2/3；需结合原始 query→doc 排名复查。长文和 OCR 桶当前属于语料缺失，先补齐后才能评价排序。
4. **Hotpot 答案合成**：99/100 有完整 title-level 证据，但 8 题答案 proxy 未命中；说明该探针上的剩余失败以生成/抽取为主。官方支持事实分数仍需另行保存预测支持句和对应 gold。
5. **拒答、引用、API 错误单独跟踪**：MuSiQue 有 10 个 citation miss 和 1 个 API error；不能把 transport error 混作模型质量。企业历史结果缺少原始输出，暂时不能从旧报表推导答案、引用或拒答准确率。

这些优先级是对现存小样本历史运行的排查顺序，不是对全量系统能力排序。BEIR 需要官方 corpus/qrels 与完整 run，并报告 nDCG@10、Recall@100；Hotpot 要保存官方 answer/support/joint EM/F1 所需逐题内容并分 distractor/fullwiki；MuSiQue 要报告 Ans/Full 以及 answer_f1/support_f1。金标定制语料和小样本结果继续作为隔离诊断集，不纳入公开排行榜比较。本报告未使用 MAP：没有可按完整官方 BEIR qrels 重评分的历史 run。
