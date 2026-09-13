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
