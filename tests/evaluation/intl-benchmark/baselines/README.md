# 基准文件口径说明

| 文件 | 指标口径 | 是否可用于对比 | 说明 |
| --- | --- | --- | --- |
| `golden_baseline_v15_regraded.json` | `gold_title_fraction_v1` | **是（唯一权威）** | 由 `regrade_baseline.py` 把 v14 的 run 产物（stored ranked lists）用**当前 grader** 重新评分得到，含回归门禁阈值（基线 − 容差） |
| `golden_baseline_v14.json` | legacy 二元命中 | **否** | 由已废弃的 `run_eval.py` 生成：`recall@10 = 1.0 if 任意 gold 标题进入 top-10`，对 4 标题金标集只要命中 1 个即记 1.00 |

## 为什么 v14 不能再用

- legacy grader：`recall@k = 1.0 if any(gold in top-k) else 0.0`
- 当前 grader（`benchmark_suite.ranking_metrics`）：`recall@k = #distinct gold in top-k / #gold`

用当前 grader 重跑 v14 自己的产物，得到 2Wiki **0.725**、Hotpot **0.945**、MuSiQue **0.729**，
而 v14 文件记录的是 1.000 / 1.000 / 0.990。两者相差 0.27/0.06/0.26，
**跨口径比较会产生完全虚假的"退化"结论**（2026-09-20 的走查报告正是踩了这个坑）。

`benchmark_suite.py` 现在会在 `metric_definition` 不匹配时拒绝输出差值对比，
避免再次用不同尺子量同一件事。

## 重新生成基准

```bash
python3 tests/evaluation/intl-benchmark/regrade_baseline.py \
  --run 2wiki=results/intl-2wiki-20260913-121603.json \
  --run hotpot=results/intl-hotpot-20260913-132204.json \
  --run musique=results/intl-musique-20260913-134657.json \
  --out baselines/golden_baseline_v15_regraded.json
```

更换判定口径、更换金标集或更换抽样集之后，都必须重新生成该文件。
