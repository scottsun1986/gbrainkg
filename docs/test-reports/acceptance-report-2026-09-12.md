# P0/P1 优化实施与全范围验收报告（2026-09-12）

实施依据：`docs/optimization-plan-fused-2026-09-12.md`。代码基线 `main@976753a` + 本次工作区改动。验收环境：本机 docker（postgres/redis/minio/gitea）+ systemd `llmwiki-api`，LLM=deepseek-v4-flash，Embedding=BAAI/bge-m3。

## 1. 实施内容总览

### P0-A 评测可信化
- `quality-gate.ts`：LLM judge 重写——每条引用的正文片段（800 字/条，≤8 条）进入 prompt，按原子断言逐条判定 supported/unsupported，faithfulness 改为断言支持比例（代码重数 judge 结果，不信任其算术）；contextPrecision 改为全部期望文档在完整引用列表的覆盖率；新增 nDCG。
- `test_retrieval_quality.py`：新增 Stage 0 独立检索排名评测（`POST /chat/search`，Recall@5/Recall@10/MRR@10/nDCG@10，gold=expected_doc_titles）；API 异常一律计 0 分并标 failure，不再 skip；支持 `EVAL_LIMIT`/`EVAL_KB_SCOPE`。
- `quality_gate.py`：门禁拒绝 dry-run、缺 runId/gitCommit、超 24h 过期、含 api_failure 的结果。
- `run-evaluation.ts`：结果绑定 runId/gitCommit/corpusVersion；引用正文片段随结果落盘。
- 修复 gbrain-adapter dist 类型漂移（fallbackMerged/evidenceSelection）与 Prisma client 漂移（effectiveFrom/indexReadiness 恢复 51 处引用）。

### P0-B 入库完整性
- `chunk-embedding.service.ts`：游标分批（64/批）续跑至耗尽；返回 {requested, embedded, failed, missing}；新增 `documentCoverage`。
- `enrichment.processor.ts`：embedding 覆盖率门控（missing>0 → degraded + BullMQ 重试，missing==0 才 ready）；任务携带 expectedVersion 防版本交错；**ready 后自动重新驱动 Source 发布**（自愈滞留）。
- `ingestion.service.ts`：保存事务内重验版本（CAS），陈旧任务不写库不误标失败。
- `brain-compiler.processor.ts`：Source 发布前 coreReady 门控（indexReadiness ready 短路，否则按块级覆盖统计拦截）。
- `brain-compiler.service.ts`：source-sync 重试窗口 3 次/3s → 30 次/20s（扛分钟级 embedding）。
- `contextual-retrieval.ts`：300 块硬跳过 → 章节分层预算采样（无悬崖）；60k 全文前缀 → 前后 1500 字滑动窗口；新增 `metadata.contextPrefix` 镜像；**修复推理模型导致富化全失败**（max_tokens 200→1200 + reasoning_content 兜底）。

### P0-C 证据验证与缓存收紧
- 流式证据核验门控（`chat.service.ts`）：句子级"先验证后转发"——数字/阈值类断言必须在被引证据中逐字出现（空白归一），否则暂扣；流末由 LLM 蕴含复核暂扣语句，仍不支持则丢弃且不展示（`grounding_gate` trace 全程可见）。`GROUNDING_STRICT=false` 可回退直通模式。
- 事后核验修复：有效角标不再自动计为 grounded，同样过数字+重叠检查——"编造内容戴真角标"通道关闭（单测覆盖：5000 元假扣罚、99.59% 篡改阈值均被拦截）。
- 缓存收紧：grounding 覆盖率 <0.8 不入缓存；语义缓存键版本 v3→v4（管线变更自动失效旧缓存）。

### P1-A/B/C 查询与检索优化
- 简单问题 0 规划 LLM：`planQuery` simple 分支跳过扩词调用（实测 trace `query_rewrite: 1ms`，原为一次 LLM 调用）；`AGENTIC_SIMPLE_EXPANSION=true` 可恢复。
- 语义缓存复用共享 EmbeddingService（内存缓存去重，缓存查询与检索臂同向量只调一次）。
- 词法通道统一 `document.status='published'` 过滤（高优先词、章节、逐词、亲和扩展、邻居扩展全部 5 处候选入口）。
- RAPTOR：全文档覆盖（300 上限→5000 防跑飞护栏 + 250 块窗口化聚类）；摘要节点向量索引（新列 embedding vector(1024)+HNSW）+ 向量优先检索 + 懒回填自愈；Level-2 全局树同样向量化。
- GraphRAG：社区摘要嵌入（建社区时写向量）+ Global Search 向量优先、关键词兜底（AUTO_GRAPH_EXTRACT_ENABLED 默认关闭，属成本护栏）。
- 时效裁决：权限复核层新增生效期/生命周期门（repealed、未生效、已失效文档永不进候选，所有检索臂统一）；版本冲突检测升级为 supersedes 链家族分组 + 同标题合并回退（支持改名版本与无链路旧数据，单测覆盖）。

### 基础设施修复（实施中发现并修复的存量缺陷）
1. **9 个迁移从未应用**：RaptorNode 表、Document 时效字段、indexReadiness 等全部缺失（RAPTOR 在此环境从未真正生效）——已 `prisma migrate deploy` 对齐。
2. **Chunk.embedding 列缺失**：平台 pgvector 语义臂一直静默失效（此前检索纯靠 GBrain+关键词）——已补列+HNSW 索引；CMRC 2 例专有名词失败因此修复。
3. **残留 tsv 触发器**：手工部署的 `trigger_update_chunk_tsv` 引用已删列，导致所有 Chunk INSERT 报 Prisma P2022 "column `new` does not exist"（入库全挂）——已删并固化进迁移文件。
4. **迁移文件修正**：drop_unused_tsv 补充正确的触发器/函数清理名；新增摘要节点向量列迁移。

## 2. 单元与集成测试

- 全量 `pnpm --filter api exec jest`：**29 套件 / 222 用例全绿**（含新增 grounding-gate 14 例、chunk-embedding 5 例、enrichment 5 例、brain-compiler 门控 5 例等）；`tsc --noEmit` 零错误。
- 3 个旧用例按新语义更新（角标不再免检、superseders 查询次数、门控拦截断言）；其中版本冲突用例暴露并修复了家族合并回退的真实缺陷。

## 3. 验收结果

### 3.1 长文档入库完整性（P0-B）— 通过
合成 1041 块（17.3 万字）制度文档：
| 验收项 | 结果 |
|---|---|
| embedding 覆盖率 | **1041/1041 = 100%**（旧代码上限 400，后 641 块永无向量） |
| indexReadiness | pending → enriching → **ready**（覆盖率门控通过） |
| RAPTOR 覆盖 | 31 节点全部向量化；第 501/510/515 节等尾部章节有专属摘要；Level-1 全景引用最后 6 块中的全部 6 块 |
| 发布链路 | indexing → **published**（coreReady 门控 + 30×20s 重试 + 富化后自愈再驱动，两篇长文档均发布） |
| 尾部事实检索 | 尾部锚点（第 520 节）问答正确回答并引用 ✓ |

### 3.2 CMRC 2018 公开基准复测（178 题 / 150 篇语料）— 提升且零幻觉

| 指标 | 基线（优化前） | 复测（优化后） |
|---|---|---|
| 引用命中 CiteHit@5 | 98.9% (176/178) | **100%** |
| 答案包含标准答案 | 87.6% | **88.8%** |
| TopicHit | 98.9% | **100%** |
| 幻觉 | 0 | 0 |
| 平均 TTFT（冷） | 5.5s | 5.5-6.0s（与长文档富化并发，见 3.4） |

基线中 2 例专有名词失败（索靖、《瞄》杂志）全部修复——根因即 Chunk.embedding 列缺失导致的平台向量臂失效。

### 3.3 业务 golden set 回归（220 题，runId 0be72497，commit 976753a）— 通过

前置：黄金文档所在 7 个企业库 141 块全部富化回填（100% 向量覆盖）+ domainTerms 配置（见 3.5）。完整结果归档于 `tests/evaluation/results/golden-set-regression-2026-09-12.json`。

| 指标 | 全量 220 题 | 可答题集 160 题* |
|---|---|---|
| 端到端 hit@5 | 0.859 | **0.994** |
| MRR@10 | 0.855 | 0.99 |
| 排名 Recall@5（/chat/search） | 0.830 | 0.953 |
| 排名 nDCG@10（修正公式**） | 0.809 | 0.925 |
| no_answer 正确拒答率 | 30/30 = 100% | — |
| 真实幻觉 | **0** | **0** |
| API 错误 | 1（多跳题 120s 读超时，计 0 处理正确） | — |
| TTFT 中位 / p90 | 5.76s / 14.31s | — |

\* 数据集含 30 题 no_answer（无 gold 文档，惯例计满分）与 30 题期望文档在本环境不存在（特种设备检验规程.pdf、2026年度培训计划.pptx 未入库——数据集与部署环境不匹配，非系统缺陷；系统对这 30 题全部诚实拒答、零编造）。可答题集 = 220 − 60。

\** 验收中发现并修复 harness 的 nDCG 缺陷：同一 gold 文档的多个分块重复计增益导致 nDCG 可 >1（实测 4.28），已改为标准二值 nDCG（每 gold 文档按最高排名计一次）并以修正公式复测全量（归档 `ranking-ndcg-corrected-2026-09-12.json`）。

分类明细：exact_clause(40)、synonym_oral(40)、multi_turn(30)、table_list(20)、multi_doc_synthesis(15) 全部 1.000；conflict_version(15) 0.933（唯一失败即超时案例）；no_answer(30) 拒答 100%。质量门禁（hit@5≥0.80）通过。

### 3.4 时延（P1-A）
- 简单事实题冷查询：TTFT 中位 **5.33s** / p90 5.51s（n=8）。
- trace 分解：query_rewrite **1ms**（规划 LLM 已消除，原为一次调用）→ gbrain_retrieval 2603ms（2.5s 竞速窗口为主）→ rerank 191ms → llm_generation ~2.1s。
- 快路径已达成"普通题 0 规划调用、1 次 embedding"；对照方案 §5"≤4s 已验证首段"的初始目标，剩余 lever 为将 2.5s 竞速窗口降至 ~1.2s（fallback 高置信时提前终结），属下一轮参数校准（方案明确该目标"固定硬件/模型后校准"）。
- 语义缓存命中路径 TTFT ~0.6s 不变；注意缓存门槛收紧后，长答案的缓存命中率会下降（宁缺毋滥，符合设计）。
- 发布后一次性 Source 新鲜度重建可达 ~44s（稳态毫秒级），为既有机制非本次引入。

### 3.5 存量语料治理（验收中执行）
- 黄金文档所在 7 个企业库共 141 块全部富化回填至 100% 向量覆盖 + RAPTOR 树 + readiness ready（通过队列直接投递，验证了存量回填路径）。
- domainTerms 机制实测生效：为集团总部库配置考勤领域词后，"迟到扣钱"类口语查询的排名从"花名册/绩效办法霸榜、考勤手册未进前十"修复为**考勤手册 top-4**。此为上游 v9 移除硬编码词表后的设计化替代路径（KB 级配置），非代码回归。

## 4. 遗留事项与建议

1. ~~contextual 富化修复待重启生效~~ **已部署并线上验证**：重启后新上传文档富化 Success 24/26（修复前 0/149 全失败；根因为 deepseek-v4-flash 推理模型将 max_tokens 200 全部消耗于 reasoning_content）。
2. **CMRC 库等历史文档 RAPTOR 树缺失**：建表前富化的文档需一次存量重富化扫描（本验收已对企业库执行，方法已验证）；建议产品化一个 admin"重富化"入口。
3. **GraphRAG 社区向量化已实现但默认关闭**（AUTO_GRAPH_EXTRACT_ENABLED），启用需评估 LLM 成本，符合方案"图谱为可选增强"定位。
4. rawText/searchText 完整字段分离未做（涉及 chunker/GBrain 编译协同），当前以 metadata.contextPrefix 镜像 + 门控将前缀视为证据的一部分实现目标的大部分；列为后续 P1-C 收尾项。
5. 时延下一步：竞速窗口参数化（fallback 高置信提前终结，目标已验证首段 ≤4s）+ 复杂题 p95 ≤20s 达标（当前 p90 14.3s、1 例 >120s 超时）+ 按方案做 1万/10万/100万块规模曲线压测。
6. golden 数据集与部署环境的文档对齐：补录《特种设备检验规程.pdf》《2026年度培训计划.pptx》或从数据集拆分环境专属子集，消除 30 题无效测量。
7. P2 项（late chunking、Leiden、视觉多向量、语义分块）按方案门禁保持未启用，待单项消融证明收益后上线。
