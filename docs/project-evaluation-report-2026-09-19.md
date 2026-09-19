# GBrainKG 实施与测评报告

日期：2026-09-19

环境：本地开发工作区；未连接生产、未执行生产迁移、未发布 `meetings2` 或 `knowledge.5gsailor.com`

## 1. 已执行验证

| 项目 | 结果 | 说明 |
|---|---:|---|
| `pnpm test:all` | 通过 | API 42 suites / 362 tests；Parser 21 tests + 4 subtests；Adapter 13 tests，全部通过 |
| API 定向回归 | 通过 | ingestion、version fence、processor、embedding、GraphRAG、RAPTOR、chat、semantic cache 等新增/相关测试通过 |
| Parser image fail-closed | 通过 | 未配置 OCR/VLM/Docling 时返回 failed，未调用百度 OCR |
| `pnpm build` | 通过 | API、Web、shared-types、gbrain-adapter 构建成功 |
| `pnpm benchmark:selftest` | 通过 | standard IR、benchmark suite、BEIR pipeline、dataset fetch、load test 的 harness 自测通过 |
| Python `py_compile` | 通过 | Parser 与国际评测脚本无语法错误 |
| `git diff --check` | 通过 | 无 trailing whitespace / whitespace error |
| `pnpm lint` | 未通过 | API lint 通过；Web 为 59 errors / 12 warnings，阻止“质量门禁全绿” |

全量测试于报告落盘前重新执行，退出码为 0。

## 2. 本次新增的关键回归断言

- 持久内容哈希缓存命中后 AnyDoc 调用次数为 0。
- 旧版本 parsing claim、chunk save、canonical Markdown publish 和 terminal failure 均受 version fence 约束。
- BullMQ 中间重试不把文档标为终态 failed；最终失败携带 expectedVersion。
- 同名 embedding 模型切换 base URL 后不会命中旧向量；单次 embedOne 不重复读取模型配置。
- Graph entity 会合并新文档来源；relation 保存错误会向 enrichment 暴露。
- 删除文档时 RAPTOR 文档节点及 Level-2 全库摘要同步失效；空库不保留全局摘要。
- 未配置图像提取器时 fail-closed 且不调用百度 OCR。
- IR ranking 中重复 doc ID 不会令 nDCG/AP 超过 1；Recall 是 gold 覆盖比例，MRR 正确执行 cutoff。
- BEIR corpus limit 必须包含所选 query 的全部正样本；上传或 ready 数量不足不生成有效成绩。
- load test 区分总 QPS/成功 QPS及成功/错误延迟，warmup 不进入结果。

## 3. 性能与规模结论

### 已有静态证据

- Source freshness 从“读取全部 Document + BrainSourceDocument 后在应用内比对”变为数据库聚合判断，应用侧复杂度由 O(N) 行传输/分配降为 O(source count) 结果。
- chunk 批量写入、embedding 批处理、并行 enrichment、内容哈希去重、查询/重排缓存均已存在。
- chunk trigram、HNSW、document composite index 以及本次 Graph JSONB/trigram 索引覆盖了主要热路径。

### 尚无动态证据

本次没有 100k 真实文档集、可用线上模型/评测凭据和隔离压测环境，因此以下数值**未测，不可推断**：

- 100k 文档总导入时长和成功率；
- 总 chunks/向量规模、HNSW 构建时间和磁盘/内存占用；
- 1/10/50/100 并发下的 QPS、p95/p99、首 token 延迟；
- 过滤 ANN 相对 exact KNN 的 Recall@K；
- BEIR/MIRACL/MMTEB 的真实 nDCG/Recall/MRR；
- 端到端 faithfulness、拒答精度、引用支持率。

因此，本报告不提供臆造的性能数字，也不把 self-test 当 benchmark 成绩。

## 4. 评测工具可信度说明

| 工具 | 可用于 | 不可用于 |
|---|---|---|
| `standard_ir_eval.py --selftest` | 验证指标实现与去重/cutoff | 证明检索质量 |
| `benchmark_suite.py --selftest` | 验证错误计分、Recall/MRR/nDCG 边界 | 声称 30 个国际基准成绩 |
| `beir_pipeline.py --selftest` | 验证 gold 保留、manifest、ready gate | 证明 BEIR 已跑通 |
| `load_test.py --selftest` | 验证统计聚合 | 证明系统吞吐 |
| dry-run/gold retrieval | 测试评测管线 | 任何质量排行或 SOTA 声明 |
| 当前 `eval_ragas_deepeval_suite.py` | 内部启发式诊断 | 冒充官方 Ragas/DeepEval 成绩 |

## 5. 下一轮必须执行的真实测评

1. 建独立测试实例，生成 100k 文档 manifest；上传后等待 `status=published AND indexReadiness=ready`，数量必须严格一致。
2. 对每种 ACL 选择率执行 exact vector 与 HNSW 对照；基于结果启用 pgvector iterative scan、调整 `ef_search` 或按 KB 分区。
3. 接入真正 engine-level BM25，并与 dense-only、lexical-only、hybrid+rerank 做消融。
4. 实跑 BEIR 多域、MIRACL/MMTEB 多语和企业 hard negatives，保留原始 qrels/run/config/model hash。
5. 端到端使用官方 RAGChecker/Ragas/DeepEval 中至少一种真实实现，加人工盲审校准 judge 偏差。
6. 运行分阶段负载：检索-only、生成-disabled、完整 SSE；分别报告 DB、embedding、rerank、LLM 等待时间。
7. 将准确率、引用支持率、拒答质量和 p95/p99 写入 fail-closed CI gate，未配置 live 环境时不得显示“通过”。

## 6. 发布状态

- 代码仅在本地工作区修改。
- 新增数据库迁移尚未应用到任何生产数据库。
- 根据项目部署铁律，需用户审查本报告并明确书面指令后，才允许测试环境之外的发布动作。
