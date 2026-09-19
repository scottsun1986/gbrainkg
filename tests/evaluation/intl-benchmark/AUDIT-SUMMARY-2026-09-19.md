# GBrainKG 评测审计摘要（2026-09-19）

本文件仅作为评测目录的快速索引。权威结论与完整证据见：

- `docs/project-business-flow-and-bug-audit-2026-09-19.md`
- `docs/project-evaluation-report-2026-09-19.md`

## 已确认

- 修正重复 doc ID 导致 nDCG/AP 虚高的问题。
- Recall、MRR cutoff、API 错误样本计分已校正。
- BEIR corpus 截断必须保留全部 qrel 正样本；上传或 readiness 不完整时评测失败。
- load test 现区分总 QPS、成功 QPS、成功/错误延迟，并排除 warmup。
- 删除两个仅包含模拟/硬编码成绩的旧脚本，新增标准 IR、BEIR、数据获取和负载工具。
- `pnpm benchmark:selftest` 全部通过。
- 全量本地测试：API 42 suites / 362 tests；Parser 21 tests + 4 subtests；Adapter 13 tests。

## 不得误用

- self-test 只验证评测程序，不是质量或性能成绩。
- dry-run/gold retrieval 只验证管线，不是检索成绩。
- 当前 `eval_ragas_deepeval_suite.py` 仍包含自定义启发式和可选 LLM judge，不能标记为官方 Ragas/DeepEval 结果。
- 本轮没有完成真实 100k 文档压测或公开数据集有效实跑，因此不得声称已达到全球 SOTA 或已验证 100k 容量。
