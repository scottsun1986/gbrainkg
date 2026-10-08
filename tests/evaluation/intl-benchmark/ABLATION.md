# 配对消融实验

`ablation_eval.py` 复用 `standard_ir_eval.py` 的官方 qrels 指标与 `paired_ir_eval.py` 的配对 bootstrap。它比较真实采集文件，不包含基准成绩。固定语料、切块、embedding、reranker、generator、judge、预算、并发、缓存状态和每个模型价格；baseline 使用 dense+BM25+rerank，候选每次仅增加一个通道，另行测联合组合。私有语料与公开全量协议分别报告。

```sh
python3 tests/evaluation/intl-benchmark/ablation_eval.py \
  --manifest /path/to/experiment.json --out /path/to/report.json
```

可选 `--collect` 顺序执行 manifest 每个 variant 的显式 argv `command`。参数支持 `{dataset}`、`{repeat}`、`{out}`；运行目录是 manifest 所在目录，拒绝覆盖已有 run。命令应调用现有真实评测客户端或实验采集器，不能自动部署、切换生产配置或生成假答案。默认只读比较，收集失败立即终止。

Manifest：

```json
{
  "baseline": "dense_bm25_rerank",
  "protocol": {
    "chunker": "config-hash", "embedding": "model/config-hash",
    "reranker": "model/config-hash", "generator": "model/config-hash",
    "judge": "blind-review-policy/model-hash",
    "budget": "budget-config-hash", "concurrency": 1, "cache": "cold",
    "pricing": {"currency": "USD", "models": {
      "model-id": {"inputPerMillion": 1, "cachedInputPerMillion": 0.1, "outputPerMillion": 2}
    }}
  },
  "datasets": [{"name": "dataset", "corpus": "corpus.jsonl", "queries": "queries.jsonl",
    "qrels": "qrels.tsv", "labels": "labels.jsonl", "inputScope": "full-corpus-verified"}],
  "variants": [
    {"name": "dense_bm25_rerank", "features": ["dense", "bm25", "rerank"],
     "protocol": "COPY_THE_PROTOCOL_OBJECT_HERE",
     "provenance": {"gitCommit": "sha", "workingTreeHash": "sha256", "modelFingerprint": "sha256", "judgeFingerprint": "sha256"},
     "runs": {"dataset": ["baseline-1.jsonl", "baseline-2.jsonl"]}},
    {"name": "plus_graph", "features": ["dense", "bm25", "rerank", "graph"],
     "protocol": "COPY_THE_PROTOCOL_OBJECT_HERE",
     "provenance": {"gitCommit": "sha", "workingTreeHash": "sha256", "modelFingerprint": "sha256", "judgeFingerprint": "sha256"},
     "runs": {"dataset": ["graph-1.jsonl", "graph-2.jsonl"]}}
  ]
}
```

示例 `protocol` 占位需替换为同一个完整对象。价格示例仅为格式，不代表服务商报价。每个实际调用模型，包括重写、embedding、rerank、judge，应出现在 `pricing.models` 和 `usage.byModel`；不能把所有调用套用生成模型单价。

独立题目标签 `labels.jsonl`：

```json
{"qid":"q1","answerable":true,"evidenceChains":[["doc-a","doc-b"],["doc-c","doc-d"]]}
```

`evidenceChains` 表示可选的完整必要证据链，每条链中的文档都必须召回；稳定 chunk/block ID 的评测应把排名与 qrels 全部统一为对应 ID。无证据链标签时该指标为 null，不伪造覆盖。qrels 必须包含全部题目，不可回答题使用零相关度记录。每个 repeat 的 topic 集必须完整相同；失败请求也必须保留。

真实 run JSONL 每行：

```json
{"qid":"q1","docids":["doc-a","doc-b"],"success":true,
 "grading":{"supportedClaims":2,"totalClaims":2,"correctCitations":2,"totalCitations":2,"answerCorrect":true,"refused":false},
 "usage":{"modelCalls":1,"inputTokens":100,"cachedInputTokens":0,"outputTokens":20,"latencyMs":400,"visibleMs":300,
   "byModel":{"model-id":{"modelCalls":1,"inputTokens":100,"cachedInputTokens":0,"outputTokens":20}}}}
```

`grading` 来自独立金标/盲审或锁定策略的模型评委并人工抽样；不能用生成器自评替代。`visibleMs` 从请求开始到用户首个可用文本，缓冲输出不能用模型首 token 冒充。usage 取实测供应商用量/应用观测，未采集的值不能填零。失败请求的耗时和模型消耗同样计入。此处零调用仅在真实未发模型请求时成立。

报告包含 Recall/nDCG/MRR/MAP、完整链与逐链覆盖、事实支持、引用准确、答案准确、可回答题错误拒答、不可回答题无依据回答、成功率，以及每题调用/tokens/成本/总耗时/首个可见文本耗时。成本和耗时给出 P50/P95/P99；比较按题目聚合多次运行，输出所有指标的配对差值与同时 95% CI。单题/无共同适用题目仅描述，CI 为 null。小样本成本分位数仅描述，不能据此承诺 SLA。

SHA256 覆盖实际 corpus、queries、qrels、labels 和每次 run；提交、工作区、模型、评委指纹进入报告。文件 hash 不能证明线上实例实际加载了该语料，`inputScope` 必须如实标记 unverified，只有另行完成加载与配置核对后才可标记 verified。工具拒绝 fixture/dry_run 作为效果证据。
