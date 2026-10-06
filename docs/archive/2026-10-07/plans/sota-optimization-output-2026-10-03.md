# GBrainKG SOTA 差距分析与优化输出

日期：2026-10-03　基线：`main@70bf8da` + 未提交工作区（234 文件变更）
范围：代码静态复核 + 已有评测结果文件。未运行线上查询、未部署、未改代码。

## 一、结论

架构层面已接近企业 RAG 主流形态（dense+BM25+graph+rerank、不可变版本、RLS、授权 revision、严格输出），**但端到端质量证据与 SOTA 差距明显**，主要瓶颈不在召回，而在「证据→答案」与延迟：

| 证据文件 | 关键数字 |
| --- | --- |
| `tests/evaluation/results/latest_results.json`（09-23，40 题 exact_clause） | Recall@5/nDCG@10/MRR 均 1.0；**faithfulness 0.11**、keyword hit 0.33；**平均 TTFT 17.2s**、总耗时 21.1s |
| `quality-gate-report-2026-09-27…json`（golden 50 题） | 通过率 **40%**，hitRate 0.32；clause_query / cross_document / ocr_scanned_pdf / factual_precision 四类均 **0%**；permission 1.0 |

注意：09-27 报告可能受「环境缺语料」影响（同目录存在 corpus_absent 机制），需在冻结语料上重跑确认；但 09-23 结果在召回满分条件下 faithfulness 仍仅 0.11，说明生成/对齐链路存在真实问题。现有 golden 集为 50 + 220 题，低于 roadmap 自定的 1000 题/每桶 50 题门槛，目前**不能声称 SOTA**。

## 二、既有缺陷复核（对照 2026-10-01 两份报告）

| ID | 问题 | 当前状态 | 位置 |
| --- | --- | --- | --- |
| B-1 | 无真实流式，整篇答案一次 `delta` | **仍存在** | `apps/api/src/chat/chat.service.ts:5366` |
| B-2 | `kb.industry.read` 可拿全量组织树 | **部分仍存在**：`canReadOrg \|\| canReadIndustry` 即返回 allOrgs | `apps/api/src/admin.controller.ts:583-584` |
| B-3 | bootstrap `kbs`/`knowledgeBases` 重复 | **仍存在** | `apps/api/src/auth/session.controller.ts:32` |
| B-5 | 语义缓存只做精确匹配，`similarityThreshold` 死代码 | **仍存在** | `apps/api/src/chat/semantic-cache.service.ts:18,86` |
| B-6 | ACL 剔除引用后 `index <= size` 误删合法引用 | **仍存在** | `apps/api/src/chat/citation-assembly.ts:958` |
| B-7 | RAPTOR 摘要分数冒充校准置信度 | 已修复（`scoreSource: 'synthetic'`） | `apps/api/src/raptor/raptor.service.ts:991` |
| B-8 | 图谱关系 `take` 无 `orderBy`，召回随机 | **仍存在** | `apps/api/src/graph-rag/graph-rag.service.ts:1709,1713,1936` |
| B-9 | outbox 毒丸 | 部分缓解：`retryCount < 10` 后不再调度，但无 dead 状态/告警 | `apps/api/src/brain-compiler/brain-outbox.service.ts:58` |
| B-10 | 删除后 RAPTOR 孤立 | 删除路径已调用 `removeDocument` | `apps/api/src/ingestion/ingestion.controller.ts:464` |
| B-11 | 替换失败覆盖 parserMetadata | **仍存在**：整体写为 `{ pendingError }`，丢失原元数据 | `apps/api/src/ingestion/ingestion.service.ts:850` |
| R-3 | 会话一次返回全部消息 | **仍存在**，无分页 | `apps/api/src/chat/conversation.controller.ts:31` |

其他发现：`apps/web/package.json` 依赖 `xlsx@0.18.5`。npm 上的这个版本有已公开的原型污染（CVE-2023-30533）和 ReDoS（CVE-2024-22363）漏洞，修复版只在 SheetJS 官方 CDN 发布。建议改用 CDN 的 0.20.x 版本并锁定，或把表格解析移到 parser-worker 里做。

## 三、与 SOTA 的差距（按影响排序）

| 维度 | 当前 | SOTA 参照（Glean / Azure AI Search / Perplexity / Contextual Retrieval） | 差距 |
| --- | --- | --- | --- |
| 答案忠实度 | faithfulness 0.11（召回满分时） | 引用级 grounding ≥0.9，句级引用 | **最大差距**：证据已召回但没有转成有据答案 |
| 首字延迟 | 平均 TTFT 17s，答案一次性下发 | 首个可读文本小于 2s，逐 token 流式 | 先缓冲整篇再对齐，体感慢一个数量级 |
| 复杂文档 | OCR / 条款 / 精确事实三类 0% | 版式感知解析、单元格/bbox 级引用 | 解析与表格证据链薄弱 |
| 缓存 | 精确字符串匹配 | 带 ACL 重验的向量近似缓存 | 改写或近义问题全部未命中 |
| 图谱召回 | 无排序截断 | 按权重/中心度取 top-k，按查询类型选 local/global/DRIFT | 高价值多跳边可能被丢弃 |
| 评测体系 | 50 + 220 题，judge 未开启 | 冻结集 1000+ 题，配对 bootstrap，LLM 与人工盲评 | 样本量和统计效力都不足以支撑结论 |
| 权限 | permission 1.0，RLS 与撤权序列化已验证 | 源端原生 ACL 同步 + 撤权 SLO | 本项已接近 SOTA，剩余真实连接器验证 |

## 四、优化输出（路线）

均保持通用实现（corpus-agnostic），不引入业务同义词或业务专用加权分支。

### P0：正确性与安全（1 周内，小改）

1. **B-6 引用误删**：把 `index <= survivingIndices.size` 去掉，只保留 `survivingIndices.has(index)`，并补中间引用被剔除的单测。
2. **B-2 组织树越权**：`canReadIndustry` 只返回 industryScopeKbs 关联的组织节点；`users/roles` 按 `canReadOrg/canReadRoles` 分别输出。补一个仅持有 `kb.industry.read` 的权限矩阵用例。
3. **B-8 图谱排序**：三处 `take` 加 `orderBy: { weight: 'desc' }`，让结果确定，可复现。
4. **B-11 元数据保护**：改为合并写入 `{ ...doc.parserMetadata, pendingError }`。
5. **B-9 死信**：`retryCount >= 10` 时置为 `dead` 状态，并接入 observability 告警和管理端重放入口。
6. **xlsx 漏洞**：升级或替换。

### P1：质量主线，解决 faithfulness 0.11

1. **先诊断再改**：在 40 题 exact_clause 集上导出「召回 top-k → 证据包 → 最终答案」三段内容，逐题标注问题出在哪一环：上下文预算截断、ordered-answer 重排、section-align、grounding-gate 误杀，还是评测指标本身对中文改写过严。faithfulness 和 keyword hit 同时偏低，也可能是评测口径的问题，需要先排除。
2. **句级引用与蕴含校验**：每句答案绑定 span，用 NLI 或 LLM 校验，未被支撑的句子删除或标注；不要用词面重合度作为最终判据。
3. **复杂文档专项**：为 OCR、条款、表格建 bbox/单元格级金标准（每类 ≥50 题）；表格走 `table-evidence` 结构化通道，返回单元格坐标。
4. **评测扩容**：golden 扩到 1000 题以上，覆盖 11 个查询桶；开启 LLM judge（多采样，记录 spread），每月抽样人工盲评；复用 `tests/evaluation/core-flow/paired_gate.py` 作为发布门禁。

### P1：体验主线，TTFT 从 17s 降到 3s 以内

1. **B-1 增量流式**：按段落或句子切块，每块对齐、校验后立即推送 `delta`。`KNOWLEDGE_STRICT_OUTPUT=1` 保持现有缓冲语义，作为产品可选契约。
2. **阶段进度事件**：先推 `retrieving → reranking → verifying` 状态，前端显示真实阶段，并分别统计首个状态、首个文本、最终答案三个耗时的 P50/P95。
3. **自适应检索预算**：证据覆盖足够时提前结束探针和多跳，不再固定跑满 30/60/90 秒预算；用配对消融证明质量非劣。
4. **B-5 向量缓存**：利用已有的 `queryEmbedding` 列，在相同 scopeFingerprint 和 knowledgeEpoch 下做余弦相似匹配（阈值 0.96），命中后仍走 `validateEvidenceDependencies`。
5. **B-3 / R-3 载荷**：删除重复的 `knowledgeBases` 字段（先确认前端无引用）；会话改游标分页，按页批量做权限校验，trace 按需读取。

### P2：架构

1. 把 `chat.service.ts`（5706 行）按 计划 / 召回 / 证据包 / 输出 拆分，现有契约测试作为护栏。
2. 对 sparse、MaxSim、late chunking、contextual prefix 逐项做 shadow A/B，收益不显著的不扩大启用范围。
3. GraphRAG 按查询类型路由（局部事实、全局主题、多跳），不对每道题默认启用图谱。
4. 容量验证：10 万块 / 20 并发、100 万块 / 50 并发、10 实例混合负载；ANN 在可见比例 100%/10%/1% 下对照精确搜索。
5. 治理 Web lint 存量（116 errors），单独开 PR 处理。

## 五、验收指标（SOTA 宣称门槛）

| 指标 | 当前 | 目标 |
| --- | --- | --- |
| faithfulness / 引用 precision | 0.11 / 0.40 | ≥0.90 / ≥0.90 |
| golden 通过率（冻结语料） | 40% | ≥85%，且每桶 ≥70% |
| OCR / 表格 / 条款 类 | 0% | ≥75% |
| 首个可读文本 P95 | ~17s（均值） | ≤3s |
| 最终答案 P95 | ~21s（均值） | ≤10s |
| 越权 | 0 | 0（硬失败） |
| 评测规模 | 270 题 | ≥1000 题，每桶 ≥50 题，配对 CI 下界 ≥ -1pp |

## 六、建议执行顺序

1. P0 六项小修复：本地 `pnpm test` 加权限矩阵回归，汇报后等待发布指令。
2. 冻结语料，在测试环境重跑两份评测，确认 0% 的类别是否由语料缺失造成。
3. 做 faithfulness 三段诊断，结论决定 P1 质量主线的具体改法。
4. 增量流式和阶段进度，与第 3 步并行。

未验证：真实供应商的质量与成本、生产 Web Vitals、竞品同语料对比。本文数字全部来自仓库内的历史结果文件，不代表当前生产状态。
