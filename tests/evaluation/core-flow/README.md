# 核心流程评测契约

复用 `../intl-benchmark/standard_ir_eval.py`、`ann_recall_eval.py`、`load_test.py` 与现有人工复核导出，不将固定业务题库结果当成通用架构收益。

每个真实运行记录 `runId / gitCommit / workingTreeHash / corpusHash / policyVersion / modelFingerprints`。`workingTreeHash` 包括未提交修改及新增文件，避免同一个 commit 下的不同代码被配对。每条 `cases` 记录 `id / bucket / authorizationScopeHash / asOf`，以及 0–1 的 `correctness / citation_precision / fact_coverage / evidence_coverage / unauthorized / span_correct`、实际 `latency_ms / cost_usd`。成本使用实际供应商 usage、缓存计费和部署摊销；估算 token 不能冒充实账，缺失成本的运行不通过门禁。

```bash
python3 tests/evaluation/core-flow/paired_gate.py \
  --baseline /tmp/core-baseline.json --candidate /tmp/core-candidate.json \
  --out /tmp/core-gate.json --require-multihop-gain
```

最低 1000 题、每桶 50 题；配对 bootstrap 固定种子、3000 次重采样。质量绝对门槛和 1 个百分点非劣下界同时约束；任何越权直接失败。P95 和总成本分别要求下降 25%。样本不足、置信区间跨越非劣边界、字段缺失都失败，不把“不显著”视为等效。此脚本不联网，不创建或修改实例。

消融必须单独保存条件：dense+BM25；+graph；+sparse；+MaxSim；结构前缀；LLM 前缀；shared-context late chunking；固定计划；adaptive；关闭缓存；精确缓存。不同重排器必须带不同模型修订及校准文件。流量矩阵：10 万块/20 并发、100 万块/50 并发、10 实例混合入库；ANN 在 100%/10%/1% 可见比例分别以精确搜索为参照。使用显式测试 API、独立数据库和 Redis DB，不运行脚本默认生产地址。

`test_paired_gate.py` 只验证门禁计算，不提供项目质量或性能结论。
