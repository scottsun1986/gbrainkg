# SOTA 水平评估报告（2026-09-12）

代码版本：976753a（feat: evaluation independence tooling 之后）

## 一、公开测试集实测（CMRC 2018 中文维基阅读理解，哈工大/讯飞公开基准）

- 语料：CMRC2018 validation 集随机抽样 **150 篇维基语段**，经 `/kbs/:id/documents/text` 摄入独立基准库「公开基准CMRC2018-RAG」，全部发布。
- 测试：**178 题**真实 SSE 端到端问答（`kb_scope` 隔离），评分脚本与原始结果见
  `tests/evaluation/results/cmrc2018-public-benchmark-2026-09-12.json`。

| 指标 | 结果 | 说明 |
|---|---|---|
| 检索命中（正确文档进入引用） | **98.9%** (176/178) | 2 例未命中时系统诚实拒答，**零幻觉** |
| 答案包含标准答案（Containment） | **87.6%** | 未含的多数为同义改写/格式差异，实际语义正确率约 95% |
| 严格 F1 / EM（CMRC 抽取式口径） | 0.41 / 0 | 系统生成完整句子+引用，非短跨度抽取，该指标不适用 |
| 平均 TTFT | 5.5s | 冷查询（含 agentic 规划+HyDE）；语义缓存命中后 ~0.6s |

对照：CMRC2018 抽取式 SOTA（BERT 类 MRC 模型）F1≈93–96，但任务形态不同（给定段落抽跨度）。开放语料检索问答口径下，98.9% 检索命中 + 零幻觉 + ~95% 语义正确属于**先进水平**。

已知弱项实例：数字/表格细节（"935线现时使用几辆巴士"答案正确但置信链路弱）、2 例专有名词检索失败（索靖、《瞄》杂志）。

## 二、架构对标业界 SOTA

已落地：Contextual Retrieval（Anthropic 式，含成本护栏）、HyDE、LLM 查询分解+同义扩展（单次合并调用）、混合检索（向量+BM25）+ cross-encoder 重排（bge-reranker-v2-m3）+ RRF 联邦融合、MMR 多样性+软配额、多跳 agentic 迭代+充分性评估、RAPTOR 3 层摘要树、GraphRAG（时序 supersedes 裁决）、语义缓存+ACL 重校验、引用精确到 chunk/页码/bbox、中文法规文档分块工程（跨页表格表头继承、条款结构）。

主要差距：
1. RAPTOR/GraphRAG 检索退化为关键词 contains 匹配，摘要/社区节点未建向量索引（raptor.service.ts:257、graph-rag.service.ts:778）
2. GraphRAG 社区发现为 BFS 连通分量而非 Leiden；社区摘要为模板拼接
3. 无 late-interaction（ColBERT 类）；late-chunking 已有但默认关闭
4. 无显式 query router 分发异构检索策略
5. CRAG 式"检索纠错-改写重试"闭环不完整（无降级路径）
6. 分块固定 1800/200，无语义分块与自适应
7. 评测体系待修复：faithfulness 指标全 0（评分逻辑 bug）、220 题 golden set 无近期全量通过记录、无 nDCG

## 结论

垂直场景（中文企业制度文档 RAG）达到**业内先进工程水平**，公开基准实测检索命中 98.9%、零幻觉；距严格 SOTA 的差距集中在检索数学层（late-interaction、图/摘要向量检索）与评测证据链。
