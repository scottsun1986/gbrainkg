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
RAGAS_API_BASE=http://127.0.0.1:3202 python3 tests/evaluation/intl-benchmark/answer_quality_heuristic_suite.py --judge stats

# LLM 仲裁模式（需要 DeepSeek/GPT API）
RAGAS_API_BASE=http://127.0.0.1:3202 OPENAI_API_KEY=xxx python3 tests/evaluation/intl-benchmark/answer_quality_heuristic_suite.py --judge hybrid --model gpt-4o
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
| 生成质量 | 启发式 RAG 质量套件（`answer_quality_heuristic_suite.py`） | Faithfulness / Answer Relevancy / Context P/R |
| 过滤 ANN 召回 | `ann_recall_eval.py`（exact KNN 为 gold） | Recall@K / short-result ratio / p95 |
| 十万级规模 | `scale_benchmark.py`（隔离 schema） | 写入成功率 / 索引体积 / p50-p99 |
| 规模与性能 | 10 万+ 文档索引（`beir_pipeline.py --ingest --limit-docs 100000`） | p95/p99 延迟 / QPS / error_rate |

> 注意：`answer_quality_heuristic_suite.py` 是本地启发式评分器，**不是**官方 Ragas/DeepEval 实现，
> 其分数只能作为本仓库的回归信号，不能作为官方框架成绩对外引用。该套件的 KB scope 必须通过 `RAGAS_KB_SCOPES`
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

## 运行基准前：清空语义缓存

同一问题在第二轮评测会命中第一轮写入的语义缓存答案，**跨运行对比因此失效**（实测：缓存里
可能还留着检索改进之前的旧拒答）。跑基准前请执行：

```bash
psql "$DATABASE_URL" -c 'DELETE FROM "SemanticCache";'
# 或让被测服务以 SEMANTIC_CACHE_ENABLED=false 运行
```

（拒答与无引用回答已不再写入缓存，见 `apps/api/src/chat/refusal-cache-guard.spec.ts`；
但正常答案仍会缓存，评测必须显式清空。）

### ⚠️ 删表是不够的：还有一层进程内 L1

`semantic-cache.service.ts` 在数据库之前还有 **进程内 L1 精确匹配缓存**
（key = `scopeFingerprint:knowledgeEpoch:normalizedQuery`，TTL 24h）。
只 `DELETE FROM "SemanticCache"` 不会清掉它，实测仍会命中并回放旧答案
（trace: `semantic_cache 命中相似问题缓存 (相似度: 1.000)`）。

**评测协议因此是二选一：**

1. **推荐的严格模式**：让服务以 `SEMANTIC_CACHE_ENABLED=false` 运行（每次独立生成）；
2. 或者：删表 **并且重启 API 进程**（重启才会清空 L1）。

为什么必须这样：企业金标里存在近义变体（`…影响绩效1/2/3`），相似度阈值 0.96 会把它们
折叠成**同一个答案**。实测 190 道可答题里有 **55-59 题的 ttft < 1s（缓存回放）**，
`multi_doc_synthesis` 类 15 题中有 8-10 题是回放——该类的指标实际只有 1-2 个独立样本，
会成类地"一起变好/一起变差"。公开多跳基准（2Wiki/HotpotQA/MuSiQue）题目互不相似，
实测 **0 次回放**（ttft 最小 1.6s），不受此影响。

## 单次运行的诊断工具链

聚合指标只能告诉你"掉分了"，下面三个工具回答"掉在哪"：

| 工具 | 回答的问题 | 用法 |
| :--- | :--- | :--- |
| `analyze_full_run.py` | 每题卡在检索还是生成？答案里有没有模型草稿/上游报错？ | `python3 analyze_full_run.py results/intl-2wiki-*.json` |
| `repro_chat.py` | 单题的完整 SSE 事件流（含 trace），用于把坏答案追到具体阶段 | `python3 repro_chat.py --kb <kb> --question "..."` |
| `regrade_baseline.py` | 历史产物在新口径下重评（口径不一致的对比会被拒绝） | `python3 regrade_baseline.py results/<old>.json ...` |

`analyze_full_run.py` 输出的四象限表是排查的主线索：

```
完整证据 + 答案正确   evidence retrieved and gold present in the answer
完整证据 + 答案错误   -> generation-side gap (the model had everything it needed)
证据缺失 + 答案正确   -> the gold was recoverable without the full evidence set
证据缺失 + 答案错误   -> retrieval-side gap
```

输出卫生扫描会把"模型思考文本外泄""上游报错当答案""空答案"单独计数：
这些形态会**同时**伤害用户体验和评测可信度（草稿文本里偶然出现 gold，会制造虚假命中）。

## 分片跑大数据集（220 题企业金标）

```bash
python3 shard_golden.py golden_dataset.json --shards 4 --prefix /tmp/golden-shard
for i in 0 1 2 3; do
  EVAL_RESULTS_NAME="golden-shard-$i.json" \
    python3 -m pytest test_retrieval_quality.py -q --golden-file=/tmp/golden-shard-$i.json &
done; wait
python3 merge_shards.py results/golden-shard-{0,1,2,3}.json --out results/golden-220.json
```

合并脚本复用 `test_retrieval_quality._compute_summary`，分片与单进程的结果口径完全一致。

## 检索臂策略（`RETRIEVAL_ARM_POLICY`）与实测记录

`.env` 里的 `RETRIEVAL_ARM_POLICY` 决定 GBrain 引擎臂（Brain 页面/编译真理那一臂）如何参与：
`engine_first` / `chunk_first` / `chunks_only`（关闭引擎臂）。

| 策略 | 企业 190 题检索 | 2Wiki R@10 | Hotpot R@10 | MuSiQue R@10 | 同批 190 题耗时 |
| :--- | :--- | ---: | ---: | ---: | ---: |
| `chunks_only`（当前默认） | hit@1 0.8438 / MRR 0.9031 | 0.8125 | 0.9550 | **0.7642** | **188.8s** |
| `chunk_first` | hit@1 0.8438 / MRR 0.9031（完全相同） | **0.8175** | 0.9550 | 0.7517 | 457.6s |

引擎臂本身的延迟实测为 **6.2s（单请求空闲）～12s（含子查询探针）**，远大于竞速窗口，
所以它几乎总是被中止——却仍让每个请求白等（`/chat/completions` 侧实测 12.0s 的
`gbrain_retrieval` 阶段，修复后 0.44s）。因此：

1. **默认 `chunks_only`**（更快且不劣）；
2. `/chat/completions` 现在**同样遵守该开关**（此前忽略它，并会在引擎臂侥幸赢下竞速时
   静默改用 `engine_first` 排序，与检索口径不一致）；
3. 若要让引擎臂真正可用，先把它自己的延迟压到窗口之内（子进程池 `GBRAIN_POOL_SIZE=2`
   与每题 1 主查询 + 最多 3 子探针争抢槽位是首要嫌疑），再重跑上表。

## 答案路径的证据深度（相关性地板与分组上限）

答案路径只把 3-6 条证据组装进 prompt，而检索已排出 18-50 条候选——"证据在库里但没进上下文"。
配对 A/B（同一批题、清缓存、n=50，`--mode full`）：

| 配置 | `RETRIEVAL_RELEVANCE_FLOOR_RATIO` | `RETRIEVAL_MAX_GROUPS_MULTIHOP` | MuSiQue 包含率 | HotpotQA 包含率 |
| :--- | ---: | ---: | ---: | ---: |
| 基线 | 0.35 | 默认（多跳 min(8, 2×子问题+2)） | 0.32 | 0.84 |
| A | 0.20 | 12 | **0.44** | 0.76 |
| B | 0.35 | 12 | 0.32 | 0.78 |
| C | 0.20 | 默认 | 0.38 | 0.80 |

读法：**地板决定候选池的广度，分组上限决定上下文深度**。
地板放宽对 MuSiQue（2-4 跳、需要第二/第三跳文档）有利，而单纯提高分组上限会稀释
HotpotQA（2 跳就够）的上下文。

**n=100 配对复核已确认配置 C（地板 0.20、分组上限默认）可以采用**（与上一轮 n=100 同题对比）：

| 数据集 | 包含率 前→后 | 检索指标 | 平均时延 |
| :--- | :--- | :--- | ---: |
| MuSiQue | 0.280 → **0.330**（9 修好 / 4 退步） | 完全一致 | 38.9s → 24.1s |
| HotpotQA | 0.740 → **0.760**（7 / 5） | 完全一致 | 28.7s → 12.1s |
| 企业 190 题 | — | hit@1/MRR 无变化 | 188.8s → 195.0s |

注意 n=50 时 HotpotQA 曾显示 −0.04（噪声），n=100 复核为 +0.02 ——
**任何单次 n=50 的差异都不要当成结论**。

## 第二跳桥接证据救援（`RETRIEVAL_CHAT_BRIDGE_RESCUE`，默认开启）

多跳题库里最典型的失败形态是：**答案文档就在候选池里，但被相关性地板剪掉**。
实测样例（HotpotQA `In what state is the manufacturer of Bisquick headquartered?`）：

| 池内名次 | 文档 | 交叉编码分数 | 是否含答案 |
| :--- | :--- | ---: | :--- |
| 1 | Bisquick | 0.8022 | 否 |
| 4 | General Mills | 0.0633 | 是（"headquartered in Golden Valley, Minnesota"） |

第二跳文档与"总部的州"这句话字面不相似，分数只有第一跳的 1/13，因此必然被地板剪掉。
`bridge-rescue.ts` 的规则：首跳已选证据里出现的**多词大写实体**（且不在问题中）如果
在候选池里有**同名文档**，并且该文档覆盖了首跳证据缺失的**问题要点**，就把它补回答案上下文
（每问最多 2 条，标记 `floorExempt`/`bridgeRescue`，写 trace 与 `[BRIDGE_RESCUE]` 日志）。
可用 `RETRIEVAL_CHAT_BRIDGE_RESCUE=false` 关闭。

实测（n=100 配对、清缓存）：

| 数据集 | 仅地板 0.20 | +门控救援 | 触发率 |
| :--- | ---: | ---: | ---: |
| MuSiQue | 0.330 | **0.360** | 9/100 |
| HotpotQA | 0.760 | 0.750（本区间波动 0.730-0.760） | 5/100 |

**未加要点闸门的版本被实测否决**（HotpotQA 0.760 → 0.720，且逐题核对发现多数"退步"
只是同义改写把连续 gold 短语拆开导致的评分假阴性）——闸门就是因此加上的。

## 定向回归集与重复测量（判定改进是否真实）

单次 n=100 的包含率波动实测为 **±0.03-0.07**（同配置不同时间窗：0.760 / 0.730 / 0.750），
与我们要追的改进量级相同。两个开关让判定变得可靠：

```bash
# 1) 只复跑历史失败题（把一个类别放大成高灵敏度探针）
EVAL_SET_PATH=/tmp/genfail-hotpot.json QA_WORKERS=3 \
  python3 benchmark_suite.py hotpot --mode full

# 2) 同题重复 N 次：mean=期望值、majority=多数票、pass@N=上限
QA_REPEATS=3 QA_WORKERS=3 python3 benchmark_suite.py hotpot --mode full
```

实测（HotpotQA 失败集 20 题）：`mean=0.35, majority=0.35, pass@3=0.35`
——同一次运行内**没有**采样随机性，说明这一格的差异来自运行期状态，而不是"这次运气不好"。
配套的 `CHAT_LOG_CONTEXT_PREVIEW=true`（可选 `..._CHARS`）会把真正喂给模型的每条证据打进日志，
用来判定失败属于"段落没进上下文"还是"进了没用上"。

### 已实测否决的旋钮（不要再重复）

| 旋钮 | 结果 |
| :--- | :--- |
| `RETRIEVAL_MAX_GROUPS_MULTIHOP=12` | 定向失败集 +1/+2/−1，噪声内无收益 |
| `RETRIEVAL_DOC_COMPLETENESS=true`（给已选文档补次优段落） | HotpotQA 7/20→**2/20**，MuSiQue 2/24→1/24，2Wiki 1/16→2/16（有害，默认关闭） |
| `RETRIEVAL_ASPECT_PASSAGE_RESCUE=true`（按问题要点在已选文档内定位段落） | 60 题失败集：基线 9 → 追加 5 / 替换 5（两种都更差，默认关闭） |
| `CHAT_REFUSAL_DISCIPLINE=true`（拒答前强制核对相关句子） | 60 题失败集：基线 8 → 7（无效，默认关闭） |

三次独立实验（按分数补段落 / 按要点追加 / 按要点替换）都指向同一结论：
**"给上下文加或换证据"这条路线已在本系统上被证伪**，不要再重复。
配套结论：归一化包含率与严格包含率**相同**（300 题合计 0.590 vs 0.590），
所以"失败多半是措辞不同"这个直觉也是错的——gold 串确实不在答案里。

拒答样本**全部带引用**（说明是模型在有证据时仍拒答），但提示级"拒答纪律"也无效。
因此这一类别需要的是**段落级检索本体**（而不是继续调整上下文组装或提示词），
验收请直接用上面的 60 题探针集 + 同窗 A/B。

## 上下文覆盖率探针（诊断"缺证据"还是"没用上证据"）

```bash
# 需要被测服务以 CHAT_LOG_CONTEXT_PREVIEW=true 运行
python3 context_coverage_probe.py /tmp/ccp-cases.json --limit 30 --out /tmp/ccp-result.json
```

它把实际喂给模型的证据从日志取出，直接判断 gold 是否在上下文里，输出三桶：
`上下文含 gold 且答对 / 含 gold 但答错（生成侧）/ 不含 gold（检索选择侧）`。

**短 gold 有假阳性**：`1978`、`Rome`、`Tisch` 这类字符串会在 20k+ 字符上下文里偶然出现，
因此"含 gold"是高估。脚本头部已写明该警告；短 gold 需配合"句子级命中 + 覆盖问题要点"再采信。

配套的真实缺陷修复：拒答词表原先过窄（不认 `not specified / not state / not recorded` 等
实际话术），导致拒答复核几乎不触发——现已统一用 `isRefusalAnswerText` 并补齐话术
（`apps/api/src/chat/refusal-cache-guard.spec.ts` 覆盖）。
`CHAT_REFUSAL_FOCUS_RETRY`（拒答后把覆盖问题要点的句子喂回模型再问一次）**默认开启**：
它在上下文缺证据时无效（0-1/9），但在**保底机制把答案句补进上下文之后**立刻见效——
6 道"gold 在上下文却拒答"的题里 4 道变成正确答案，无答案类 30 题从 1 失败变成 0 失败，
同窗失败集 21/60 vs 关闭时 20/60（无副作用）。代价是拒答型题多一次 LLM 调用。

> 教训：**早期对某机制的否决不能永久采信**——上游（检索）修好后必须重测。本轮即是实例。
>
> 触发率（日志 `Refusal replaced by a focused answer`）：60 题定向失败集 4+ 次，
> **全量 n=100 集 0 次**——它的前置条件很窄（整段答案是纯拒答 + 上下文有覆盖问题要点的句子），
> 因此主流场景零成本，只有"拒答但证据在手"时才多一次调用。

### 两个"潜力真实但暂不上线"的加深变体（默认关闭）

| 变体 | 60 题失败集 | 无答案类 30 题幻觉失败 | 状态 |
| :--- | ---: | ---: | :--- |
| 基线 | 21/60 | **0** | 已上线 |
| `RETRIEVAL_TOP_RANK_DOCS=8`（上下文保底 5→8 篇） | — （7 道难题 0→3 答对） | 6 | 默认 5，变体关闭 |
| `CHAT_REFUSAL_FOCUS_POOL_DOCS=8`（拒答复核时提供池内 6-8 名句子） | **28/60** | 9 | 默认 0，变体关闭 |

两者都能把"答案在候选池第 4-16 名"的难题答对，但都会诱发**对无答案题编造答案**：
现有"句子命中 2 个问题词即视为相关"的判据不足以区分"这段文字回答了问题"与"它只是共用两个词"。
**下一步的核心是造出可靠的段落级相关性判据**，验收标准即上表两列（潜力 28/60 + 无答案必须 0 失败）。

### ⚠️ 复核结论（同日）：那两个变体的"提升"是模型先验，不是检索能力

给加宽路径加上**严格证据审核**（只判"片段是否明确包含答案"，并附上已确认前置事实、允许一次桥接、
失败即 fail-closed）后，审核员对 7 道难题提供的片段**全部判 NO**。把片段原文打出来后确认它是对的：

| 问题 | 期望 | 实际提供的片段 |
| :--- | :--- | :--- |
| Sadok Sassi 国家队首届世界杯年份 | 1978 | 「The **Rugby League** World Cup … first held in **1954**」、「He was a goalkeeper and played for Club Africain and the Tunisian national team.」 |
| Ceaușescu 纪录片导演出生地 | Timişoara | 「…documentary film **directed by Andrei Ujică**」、「Valentin Ceaușescu (born 17 February 1948)…」 |

**片段里根本没有答案**——那些"答对"是模型凭世界知识补的。
**结论：这两个变体保持关闭**；同时记住一条指标含义：
**"答对"不等于"检索到了"**（本批 30 道难题里 12 道答对中，有 6 道 gold 并不在上下文中）。
`verifyPassageContainment`（默认开启，仅作用于加宽路径）保留为未来任何加宽实验的强制自检。

### 追加（同日）：类型化段落定位 + 联动筛选仍未能证实收益，但发现**候选池不稳定**

新增并单测（默认关闭/仅作用于加宽路径）：

| 组件 | 作用 |
| :--- | :--- |
| `answerTypeOf` / `matchesAnswerType` | 判断问题要的是年份/日期/数量，并按类型优先选句（共用词多 ≠ 承载所问事实） |
| `selectTypedPassageSources` 的联动闸门 | 候选句所在**文档标题**必须与**首跳证据**有词面联动（否则 "Olle Nordin … 1978 World Cup" 这类干扰句会压过真正的桥接文档） |
| `verifyPassageContainment` | 只判"片段是否明确包含答案"的严格审核（fail-closed），加宽实验的强制自检 |

结果 = 0/7（与基线相同），但换来两条硬结论：

1. **"答对"必须能被审核员复现**——该审核已能区分"模型先验答对"与"证据里真有答案"；
2. **候选池本身不稳定**：同一问题在不同运行返回的候选差异极大（有时是 Sadok Sassi + Tunisia，
   有时是 England + New York Yankees）。这既破坏评测可复现性，也解释了"池深 4-16 名"结论时有时无。
   **下一阶段优先排查这条检索不稳定性**（rerank 服务超时降级？探针召回差异？缓存态？）。

### 更正（同日稍后）：不存在"池不稳定"，那是我把题喂给了错误的 KB

该题（`5ab6f741…`）属于 **HotpotQA**，而临时脚本用了 **MuSiQue** 的 KB，
所以池里才出现英格兰/洋基。用正确 KB 连跑 5 次 → **池 5/5 完全一致**。
教训：跨数据集脚本必须按 qid 前缀路由 KB，并在结论里写明所用 KB。

### 顺带修掉的真问题：头部文档保底只按分数序

同一题里 Tunisia 页**按池位置第 3、按分数第 6**（首位 0.898 压倒，其余 ≤0.098），
仅按分数的 top-5 保底把它漏掉 → 上下文没有答案句。Rome Protocols 那题则相反（分数第 2、位置第 7）。
**修法：两种排序取并集**（`planTopRankGuarantee`，N=5），并用单测固化这两个真实池形态。

验证：目标题现在给出 **"…first FIFA World Cup appearance in 1978 [5]"**（引用真实来源页）；
GS-NA 无答案类 **30/30 通过**；三套 n=100 聚合值落在窗口噪声带内（0.79 / 0.40 / 0.69）。

## ⭐ 先看这一条：生成模型是主导因素（2026-09-21 实测）

同一份代码、同一套配置，**只切换主 LLM**（`ModelConfig.isDefault`，设置页可改）：

| 口径 | 推理型 `mimo-v2.5` | `deepseek-chat` |
| :--- | ---: | ---: |
| 60 题定向失败集 | 21/60 | **32/60** |
| HotpotQA n=100 | 0.79 / 0.80 | **0.90** |
| MuSiQue n=100 | 0.37 / 0.40 | **0.51** |
| 2Wiki n=100 | 0.66 / 0.69 / 0.73 | **0.78** |
| 无答案类 GS-NA / 企业金标 220 | 30/30 · 220/220 | **30/30 · 220/220** |
| 端到端耗时（HotpotQA n=100） | 832s | **409s** |

**教训：调检索工程之前先测模型维度**——本次一个配置切换的收益超过此前十几轮检索侧改动之和。
评测时请把"主 LLM"作为一等变量记录（`Applied DB model routes (llm=…)` 日志可直接确认当前生效模型）。

### 换模型后重测旧机制 + 修掉非 ASCII 实体 bug

- **宽池拒答复核 + 严格证据审核**：在强生成端**变安全**（无答案类 30/30，此前弱模型 9/30 编造）
  但收益仍为 **0**（失败集 32/60 两者相同）→ 继续默认关闭；`verifyPassageContainment`
  从此可作为"加宽类实验"的可靠安全闸门。
- **修复实体抽取的非 ASCII 截断**：旧正则把 `Andrei Ujică` 抽成 `Andrei Ujic`、
  `Nicolae Ceaușescu` 抽成 `…Ceau`，导致桥接探针拿不存在的名字去检索
  （实测直接造成"Timişoara"这类题的第二跳永远取不到页面）。
  改用 Unicode 感知模式并统一实现（`bridge-rescue.extractCapitalisedCandidates`），
  目标题已答对，失败集 32/60 → **34/60**，GS-NA 保持 0 幻觉。

### 桥接链的另外三处缺陷（同日继续修复）

| 缺陷 | 后果 | 修复 |
| :--- | :--- | :--- |
| 关系词表无亲属称谓（`\bmother\b` 匹配不到 "grandmother"） | 祖辈/亲属类多跳题**不触发桥接探针** | 补齐英/中亲属词表 |
| 实体名重复上限 `{1,3}` | "Axel Julius De la Gardie" 被截成 "…De la"，标题精确匹配失败 | 放宽到 `{1,6}` + 防提前结束断言 |
| 桥接救援要求正文**字面出现**问题要点词 | 答案页写 "son of … and Ebba Brahe"（没有"grandmother"）被拒 | **被首跳证据点名的实体**不再强制字面匹配（每问仍限 2 篇） |

**验证**：60 题失败集 34/60 → **37/60**；2Wiki n=100 **0.78 → 0.83**；
HotpotQA 0.89、MuSiQue 0.50（噪声内）；GS-NA 30/30 保持 0 幻觉。
样例：「paternal grandmother」从"资料未记录"变成
**"…was Ebba Brahe [1][6]"**（trace `bridge_rescue` 补入父亲页）。

## 头部文档保底（`RETRIEVAL_TOP_RANK_GUARANTEE`，默认开启，已实测有效）

多跳失败最隐蔽的一种形态：**答案文档就在候选池里、分数还排第 2，却被"比值地板"整篇剪掉**。
实测（Rome Protocols 题，gold = a failed coup attempt）：

```
/chat/search 池:      1-3 Rome Protocols | 4 Engelbert Dollfuss(含答案)
问答路径内部池:        1 Rome Protocols(.896) | 2 Yehuda Avner(.001) | 3 Herb Gray(.013)
                      | 4 Seaford(.002) | 5 List of PMs(.000) | … | 7 Engelbert Dollfuss(.165)
相关性地板 = 0.896 × 0.2 = 0.179  →  0.165 的答案文档被剪掉
```

问答路径会把分解探针的候选并进池子，其中大量条目分数≈0.000，所以**池内位置不代表相关性**：
保底必须**按分数取 top-N 不同文档**（默认 N=5），每篇只补它分数最高的那一个 chunk，
绝不给已出现的文档再加第二段（后者已实测有害）。

同窗实测：

| 口径 | 关闭 | **开启** |
| :--- | ---: | ---: |
| MuSiQue n=100 答案包含率 | 0.300 | **0.400** |
| 60 题定向失败集合计正确 | 8-9 / 60 | **21 / 60** |
| HotpotQA n=100（与本周基线比） | 0.72-0.76 | **0.77** |
| 2Wiki n=100（与本周基线比） | 0.66 | **0.69** |

日志/`trace` 关键字：`[TOP_RANK_GUARANTEE]` / `top_rank_guarantee`（逐题可见补入了哪几篇）。

### 保底深度 N：实测取 8（2026-09-21 晚）

| 口径 | N=5 | **N=8** |
| :--- | ---: | ---: |
| MuSiQue 失败样本 20 题（同窗配对，原本全错） | 0.10 | **0.20** |
| MuSiQue n=100 | 0.50 | **0.54** |
| 2Wiki / HotpotQA n=100 | 0.83 / 0.89 | 0.83 / 0.88 |
| 无答案类 GS-NA | 30/30 | **30/30（0 幻觉）** |

背景：对 MuSiQue 失败集随机抽样 20 题做覆盖率探针 → **60% 是检索侧缺口**，
且其中 **11/12 的答案串就在语料里**（只是在候选池第 6-16 名的"非预期页面"上，
例如 gold="Johan Remkes" 在 North Holland 页）。加深保底正是补这一类。

注意：§12 曾在**弱生成端**否决过 N=8（无答案题会编造 6/30）；在强生成端（deepseek-chat）
复测为 **0/30 幻觉**。同一改动在不同生成能力下后果完全不同——评测必须记录模型变量。

### 保底深度扫参结果（同窗 n=100）

| N | MuSiQue | 2Wiki | HotpotQA | 合计 |
| :--- | ---: | ---: | ---: | ---: |
| 5 | 0.50 | 0.83 | 0.89 | 2.22 |
| 8 | 0.54 | 0.83 | 0.88 | 2.25 |
| **12** | **0.59** | **0.87** | 0.87 | **2.33** |
| 16 | 0.56 | — | — | — |

**取 N=12**（MuSiQue 失败样本同窗配对：0.10 → 0.20 → 0.25）。N=16 回落 —— 更深的候选最终被噪声抵消，
拐点在 12。安全性：N=8/12 下无答案类 GS-NA 均 30/30（0 幻觉）。

最终配置（deepseek-chat + N=12）下的企业金标复跑：**220/220 通过、0 API 失败、0 幻觉**，
context_recall 0.947 → **0.955**、MRR 0.926 → 0.931、时延不变。

## SOTA 门禁（`sota-gate.sh`）——把本轮发现固化下来

```bash
bash tests/evaluation/intl-benchmark/sota-gate.sh quick   # 检索门禁 + 无答案安全 + 定向失败集（~20 分钟）
bash tests/evaluation/intl-benchmark/sota-gate.sh full    # 追加三套 n=100 端到端（~60 分钟）
```

四道闸门（阈值统一从 `tests/evaluation/gate-thresholds.sh` 读取）：

| # | 闸门 | 拦的是什么 |
| :--- | :--- | :--- |
| 1 | 公开基准检索（n=100 ×3，对比 v15 基线） | 召回/排序退化 |
| 2 | 公开基准端到端（n=100 ×3，full 模式） | 生成与引用退化 |
| 3 | **无答案类 GS-NA 30 题（幻觉率必须 ≈0）** | 系统对"资料里没有"的问题编造答案——本会话它曾静默崩过两次 |
| 4 | **定向失败集回归（`regression/hard-multihop-*.json` + `floors.json`）** | "聚合指标看着变好、历史失败题却被打坏"这类静默退化（曾出现 21/60 → 5/60） |

最近一次运行结果（2026-09-22，含 §31 桥接修复 + 重新标定的下限）：
检索门禁 ✓、GS-NA 30/30 幻觉率 0.000 ✓、
定向失败集 hotpot 14/20、musique 13/24、2wiki 14/29（下限 12/10/10，容差 1 题）→ **PASSED**。
下限的标定方法见 `regression/README.md`（同一构建多次实测的较低值）。

### 桥接链缺陷清单（2026-09-21 ~ 09-22，共修 7 处）

| # | 缺陷 | 症状 | 修复 |
| :--- | :--- | :--- | :--- |
| 1 | 实体抽取用 ASCII `\w` + 结尾 `\b` | `Andrei Ujică`→`Andrei Ujic`、`Ceaușescu`→`Ceau` | Unicode 感知正则 |
| 2 | 关系词表无亲属称谓 | "grandmother" 匹配不到 `\bmother\b` → 探针不触发 | 补齐英/中亲属词表 |
| 3 | 人名段数上限 `{1,3}` | `Axel Julius De la Gardie`→`Axel Julius De la` | 上限放宽 + 防提前结束 |
| 4 | 桥接救援要求正文**字面出现**要点词 | 答案页写 "son of … and Ebba Brahe" 被拒 | "被首跳证据点名"即通过（限 2 篇） |
| 5 | `inContext` 判据用**整个候选池** | 仅被检索到（后被选择丢弃）的文档会抑制自己的探针 | 只看首跳实际用到的证据 |
| 6 | 桥接候选只扫"前 4 条证据" | 前 4 条可能是同名无关页；最高分的桥接页排第 8 从未被扫 | 按**分数序**扫描、深度 12、候选上限 16 |
| 7 | 桥接种子要求**存在同名文档** | 答案页标题不是该实体时（`David Gest` → 答案在 `Liza and David`），种子被跳过，探针从未执行 | 仅提及、无同名文档的**多词专名**也允许探测（`RETRIEVAL_CHAT_BRIDGE_MENTION_PROBE`，默认开启） |

第 6 条的确定性验证：`Who was in charge of the place where Bergen is located?`
由"资料未记录"变成 **"Johan Remkes was the King's Commissioner of North Holland…"**。

第 7 条的确定性验证：`Who is the wife of the man who produced the documentary of the pop star
who sings I Want to Rock with You?` 由"资料未记录"变成 **"The wife of David Gest … is Liza Minnelli"**；
同窗 n=100：MuSiQue 严格 0.51→0.62、LLM 复评 0.44→0.51，HotpotQA/2Wiki 无退化，
无答案类 GS-NA 仍 30/30、幻觉率 0.000。

### 多跳缺口分层：检索 vs 选择 vs 生成

"答错"要先分层，否则会一直改错地方。三种测量（越靠后越可靠）：

| 层 | 怎么测 | MuSiQue 拒答型失败 42 题的实测 |
| :--- | :--- | :--- |
| 语料里有没有 | 直接 SQL 全文扫描 gold 串 | 24 题在语料里（3 题确认不在，15 题短串未判定） |
| 检索到没有 | `/chat/search` top-50 里找 gold | **30/42 检索到了** |
| 进上下文没有 | `CTX_PREVIEW` 的来源**标题**里找那篇文档 | 12 题抽样：0 题进上下文、6 题"检索到但没进"、4 题"检索就没命中" |

配套工具：`context_coverage_probe.py --pool` 会把"gold 在池里/在上下文里"分开报出来
（需要服务以 `CHAT_LOG_CONTEXT_PREVIEW=true CHAT_LOG_POOL_PREVIEW=true CHAT_LOG_POOL_TEXT=true` 运行）。

> ⚠️ 该脚本曾有一个真实缺陷：`journalctl --since` 用的是 UTC 格式化串，而 journalctl 按**本地时间**解析，
> 在 UTC+8 主机上每次都会多读 8 小时日志（实测单次请求"读到" 12,229 条上下文行），
> 把"gold 在上下文"整体抬高。现已改用 `--since @<epoch>`。

同轮另有三处"加宽"尝试（逐条抽取、内容探针、seed 无条件使用）**实测无收益已撤回**。

## ⚠️ 包含率（containment）不能单独作为结论依据（2026-09-22 修正）

严格子串包含率有两种系统性误判，2026-09-22 首次量化：

**假阳性——拒答被算成答对。** gold 串很可能是问题实体本身（`Korea`、`Cork`、`1981`），
于是"资料未记录 X"的拒答句里随便提一句 gold 就被判为命中。一份 MuSiQue n=100
实测里 **15 条"答对"属于这一类**（9 条在另一配置下），全部带显式拒答从句：

```
gold: Korea
ans : they only state that he was the 24th ruler of the Goryeo dynasty of Korea …;
      The reference materials do not record his place of birth;      → strict=1.0（实际是拒答）
```

**假阴性——答对了但措辞不同。** `counties of Lithuania` vs `Lithuania's 10 counties`、
`Brian Thomas Moynihan` vs `Brian Moynihan`、`ATS - 6 (…)` vs `ATS-6`。

因此每次跑题后都用**两个补充量尺**复核，三个数字一起看（`--gate` 与 `floors.json`
目前仍以严格包含率为准，回归对比必须沿用同一把尺子）：

1. **`alias_match`（套件内置，随每次运行自动记录）**：gold 的别名形式
   （括号别名、"A or B"、首尾名）也算命中，专治假阴性。
2. **`regrade_answers.py`（LLM 复评，专治假阳性）**：

```bash
export DEEPSEEK_API_KEY=sk-...
python3 regrade_answers.py results/intl-musique-<ts>.json
# -> results/intl-musique-<ts>.graded.json
#    summary.llm_correct / strict_false_negative_qids / strict_false_positive_qids
```

它只问模型一个问题——"这条回答是否给出了与 gold 相同的事实"，不看检索过程，
因此无法通过改语料作弊，也不会奖励"复述问题词"。

实测影响（同窗、同构建，MuSiQue n=100）：严格 0.55 / 别名 0.56 / **LLM 复评 0.44**
——**严格包含率把 15 条拒答算成了答对，把整套基准分数抬高了约 0.11**。
HotpotQA 硬探针方向相反（严格 0.70 → LLM 0.90，4 条假阴性）。

**结论：单看严格包含率的 A/B 可能把"更爱拒答"误判成"更准"。** 任何结论都要
`strict + alias + llm` 三列同时成立，且优先采信在**定向失败集**（同题配对）上的方向。
