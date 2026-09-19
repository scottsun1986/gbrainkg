# 国际三大公开基准标准化评测与防退化门禁套件 (v14.0+)

本项目已将三大经典国际多跳与复杂推理公开基准（**2WikiMultiHopQA**、**HotpotQA**、**MuSiQue**）固化为标准化评测与自动化回归工具。

**核心目标**：后续对 RAG 系统的任何优化（分块、检索、重排、Prompt、Agent 规划等），都必须能够便捷地执行这套基准测试，并与固化的 **Golden Baseline (v14.0)** 自动进行指标差值对比（Delta），确保**效果提升有据可查、系统性能杜绝退化**。

---

## 1. 固化基准构成

三大测试集均采用标准随机种子抽样，各自固定 100 题，并已入库为独立的固定知识库：

| 基准名称 | 知识库 ID | 特征场景 | 重点评测能力 |
| :--- | :--- | :--- | :--- |
| **2WikiMultiHopQA** | `83bd0133-643b-4a02-978a-f0015f7aac0c` | 跨实体显式/隐式跳跃、复合从属关系 | 桥接实体召回、跨文档关系链拼装、防噪音淹没 |
| **HotpotQA** | `eb0dfea7-29b9-4566-ba7a-c20f3b76ae2d` | 经典两跳比较、桥接问答 | 混合检索排序、关键证据首位命中、溯源引用 |
| **MuSiQue** | `c6b50c14-f357-45aa-a3ae-34ae58d2258f` | 2~4 步高难度依赖推理 | 深度长链推理、抗干扰识别、多步合成 |

---

## 1.5 Global 30 Benchmarks (Ragas & DeepEval)

新增支持全球 30 大国际权威基准的端到端评测，采用真实 API 调用而非模拟数据：

| 基准组 | 覆盖范围 | 评测框架 | 核心指标 |
| :--- | :--- | :--- | :--- |
| **开放域语义检索** | MS MARCO, Natural Questions, BEIR, SciFact | Ragas + DeepEval | Context Precision/Recall, Faithfulness |
| **多跳推理** | HotpotQA, 2WikiMultiHop, MuSiQue | Ragas + DeepEval | Answer Relevance, Groundedness |
| **表格与数值推理** | TAT-QA, TabFact | Ragas + DeepEval | Completeness, Triad Score |

**关键特性**：
- ✅ 真实 API 集成：通过 `/api/v1/chat/search` 和 `/api/v1/chat/completions` 实时调用系统
- ✅ 端到端延迟测量：包含检索 + 生成全链路耗时
- ✅ 错误率追踪：记录检索失败、API 超时等异常情况
- ✅ 双轨评估模式：统计度量（快速 CI）+ LLM-as-a-Judge（深度仲裁）

运行命令：
```bash
# 统计模式（快速，无外部 LLM 依赖）
RAGAS_API_BASE=http://127.0.0.1:3202 python3 tests/evaluation/intl-benchmark/eval_ragas_deepeval_suite.py --judge stats

# LLM 仲裁模式（需要 DeepSeek/GPT API）
RAGAS_API_BASE=http://127.0.0.1:3202 OPENAI_API_KEY=xxx python3 tests/evaluation/intl-benchmark/eval_ragas_deepeval_suite.py --judge hybrid --model gpt-4o
```

---

## 1. 固化基准构成

三大测试集均采用标准随机种子抽样，各自固定 100 题，并已入库为独立的固定知识库：

| 基准名称 | 知识库 ID | 特征场景 | 重点评测能力 |
| :--- | :--- | :--- | :--- |
| **2WikiMultiHopQA** | `83bd0133-643b-4a02-978a-f0015f7aac0c` | 跨实体显式/隐式跳跃、复合从属关系 | 桥接实体召回、跨文档关系链拼装、防噪音淹没 |
| **HotpotQA** | `eb0dfea7-29b9-4566-ba7a-c20f3b76ae2d` | 经典两跳比较、桥接问答 | 混合检索排序、关键证据首位命中、溯源引用 |
| **MuSiQue** | `c6b50c14-f357-45aa-a3ae-34ae58d2258f` | 2~4 步高难度依赖推理 | 深度长链推理、抗干扰识别、多步合成 |

---

## 2. 固化 Golden Baseline 标准 (`baselines/golden_baseline_v14.json`)

系统已将 `v14.0` 版本的全量实测结果作为官方基准底线（Golden Baseline）：

| 指标 | 2WikiMultiHopQA | HotpotQA | MuSiQue | 门禁最低要求 (Gate Threshold) |
| :--- | :--- | :--- | :--- | :--- |
| **Recall@10** | 1.0000 | 1.0000 | 0.9900 | **>= 0.9500** |
| **Full Evidence (全证据召回)** | 0.7200 | 0.9700 | 0.8000 | **2Wiki>=0.68, Hotpot>=0.90, MuSiQue>=0.75** |
| **MRR@10** | 0.9850 | 0.9006 | 0.9193 | 监控比对 |
| **可答题拒答率 (Refusal Rate)** | 0.0000 (0%) | 0.0000 (0%) | 0.0000 (0%) | **<= 0.0500 (<= 5%)** |
| **Answer Containment (包含率)** | 0.6200 | 0.8100 | 0.3600 | **2Wiki>=0.55, Hotpot>=0.75, MuSiQue>=0.30** |
| **Citation Hit (引用命中率)** | 1.0000 | 0.9900 | 0.9600 | 监控比对 |

---

## 3. 标准化执行命令

在项目根目录下，可通过以下 npm 命令或 Python 脚本一键执行：

### ① 极速检索回归（推荐日常优化使用，耗时仅几秒）
仅评测检索召回、排位与多跳证据完整度，无需大模型生成，速度极快：
```bash
pnpm benchmark:intl:retrieval
```

### ② 全量端到端评估（包含 LLM 生成与引用判定）
评测完整的端到端问答质量（包含率、拒答率、引用命中率、响应延时）：
```bash
pnpm benchmark:intl
```

### ③ 质量门禁自动比对与拦截（CI/CD 集成）
自动对比 Baseline，若核心指标出现超过容忍度的退化，则直接退出状态码 1：
```bash
pnpm benchmark:intl:gate
```

### ④ 抽样 Smoke 冒烟验证
快速抽取前 5 题执行检索测试，快速验证接口连通性：
```bash
pnpm benchmark:intl:smoke
```

---

## 4. 高级 CLI 用法 (`benchmark_suite.py`)

支持灵活组合参数针对性测试：
```bash
# 单独测试 2Wiki 数据集的检索
python3 tests/evaluation/intl-benchmark/benchmark_suite.py 2wiki --mode retrieval

# 单独测试 HotpotQA 前 20 题的端到端问答
python3 tests/evaluation/intl-benchmark/benchmark_suite.py hotpot --mode full --limit 20

# 仅对比历史结果文件，不重新发请求
python3 tests/evaluation/intl-benchmark/benchmark_suite.py --compare-only \
  tests/evaluation/intl-benchmark/results/intl-2wiki-20260913-121603.json,tests/evaluation/intl-benchmark/results/intl-hotpot-20260913-132204.json --gate
```

---

## 5. 输出示例说明

运行后终端会自动打印出结构清晰的比对看板：
```text
### 数据集: 2WIKI (n=100, mode=full)
| 指标名称                         | Golden v14.0    | 当前实测            | 差值 (Delta)      | 判定状态     |
|------------------------------|-----------------|-----------------|-----------------|----------|
| Recall@10                    | 1.0000          | 1.0000          | +0.0000         | ➖ 持平     |
| Full Evidence (全证据)          | 0.7200          | 0.7500          | +0.0300         | ✅ 提升     |
| Answer Containment (包含率)     | 0.6200          | 0.6400          | +0.0200         | ✅ 提升     |
| Refusal Rate (可答拒答率)         | 0.0000          | 0.0000          | +0.0000         | ➖ 持平     |
```
- `✅ 提升`：当前版本效果优于 Golden Baseline
- `➖ 持平`：指标浮动在 0.001 以内，保持稳定
- `⚠️ 退化`：指标出现下滑，需排查改动原因

---

## 6. 标准 IR 评测（官方 qrels）与 10 万级压测

> 以下三个脚本是本轮新增的**可信评测**链路，替代基于标题匹配的启发式 IR 指标；
> 检索与生成分离评估，指标严格由官方 qrels 计算，失败样本记 0，绝不使用黄金答案兜底。

### 6.1 `standard_ir_eval.py` — 官方 qrels 标准指标

消费标准 BEIR qrels 与 TREC 风格 run 文件，计算 `nDCG@k / Recall@k / MRR@k / MAP@k`。

```bash
# 自检（无需数据/服务）
pnpm benchmark:ir:selftest

# 评测已产出的 run
python3 tests/evaluation/intl-benchmark/standard_ir_eval.py \
  --qrels /data/beir/scifact/qrels/test.tsv \
  --run run_scifact.jsonl --k 1,5,10,100 --output metrics_scifact.json
```

run 文件格式（每行一个查询）：
```json
{"qid": "q1", "docids": ["d3", "d1", "d9"]}
```

### 6.2 `beir_pipeline.py` — 摄取 + 检索，产出 run

把 BEIR 语料写入指定 KB（文档标题带 `[BEIR:<id>]` 标记以便回映），
再对官方 queries 检索并产出 run 文件。

```bash
pnpm benchmark:beir:selftest

python3 tests/evaluation/intl-benchmark/beir_pipeline.py \
  --dataset-dir /data/beir/scifact \
  --api-base http://127.0.0.1:3000 --kb-id <kb-uuid> \
  --ingest --limit-docs 100000 --limit-queries 300 \
  --run-out run_scifact.jsonl --manifest-out manifest_scifact.json
```

10 万级流程：`--ingest --limit-docs 100000` 会抽样摄取 10 万文档；随后需等待
解析/发布完成（`indexReadiness`）再执行检索，最后用 `standard_ir_eval.py` 打分。

### 6.3 `load_test.py` — 并发延迟 / 吞吐 / 错误率

```bash
pnpm loadtest:selftest

python3 tests/evaluation/intl-benchmark/load_test.py \
  --api-base http://127.0.0.1:3000 --kb-id <kb-uuid> \
  --endpoint search --concurrency 16 --requests 500 \
  --queries queries.txt --output load_report.json
```

报告包含真实 p50/p95/p99、QPS 与 error_rate，无任何 fake padding。

### 6.4 建议的 10 万级 SOTA 评测矩阵

| 维度 | 数据集 | 指标 |
| :--- | :--- | :--- |
| 英文检索 | BEIR (SciFact / NFCorpus / fiqa / arguana) | nDCG@10 / Recall@100 / MAP |
| 英文问答检索 | MS MARCO, Natural Questions | MRR@10 / Recall@k |
| 多跳检索 | HotpotQA / 2WikiMultiHopQA / MuSiQue | Recall@k, 证据链覆盖 |
| 中文检索 | DuRetrieval / T2Ranking / C-MTEB | nDCG@10 / Recall@k |
| 生成质量 | RAGAS + DeepEval (`eval_ragas_deepeval_suite.py`) | Faithfulness / Answer Relevancy / Context P/R |
| 规模与性能 | 10 万+ 文档索引（`beir_pipeline.py --ingest --limit-docs 100000`） | p95/p99 延迟 / QPS / error_rate |

> 注意：`eval_ragas_deepeval_suite.py` 的 KB scope 必须通过 `RAGAS_KB_SCOPES`
> JSON 注入（未注入时使用内置兜底映射，仅用于本地冒烟）。

### 6.5 `fetch_datasets.py` — 数据集下载与清洗

```bash
pnpm benchmark:fetch:selftest
pnpm benchmark:fetch -- --list
pnpm benchmark:fetch -- --dataset scifact --output-dir /data/beir
pnpm benchmark:fetch -- --dataset nq --output-dir /data/beir \
  --limit-docs 100000 --limit-queries 500 --seed 42
# 归一化本地已有数据集
pnpm benchmark:fetch -- --local-dir /path/to/dataset --output-dir /data/beir
```

子集化保证**每个保留查询的全部黄金文档都在语料中**，避免 qrels 指向缺失文档导致指标失真。

### 6.6 CI 门禁

`scripts/ci.sh` 现包含：

1. 单元层（API / Parser / Adapter）；
2. **评测脚本自检层**（`pnpm benchmark:selftest`，无需网络/服务，校验指标数学、BEIR 子集化、延迟分位数）；
3. **官方 qrels IR 回归门禁**（可选）：设置 `BEIR_QRELS`、`BEIR_RUN` 后自动运行，
   阈值通过 `IR_GATE_THRESHOLDS` 覆盖（默认 `ndcg@10=0.5,recall@100=0.8`）。

```bash
# 本地/CI 运行
BEIR_QRELS=/data/beir/scifact/qrels/test.tsv \
BEIR_RUN=run_scifact.jsonl \
IR_GATE_THRESHOLDS="ndcg@10=0.6,recall@100=0.9" \
bash scripts/ci.sh
```

> 任一指标低于阈值则 CI 失败，防止检索质量静默退化。
