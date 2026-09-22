# 走查整改实施记录（2026-09-20）

依据：[GBrainKG 代码走查 × 业界 SOTA 方案对标评估报告](code-review-and-sota-benchmark-evaluation-2026-09-20.md)
以及本文档末尾列出的"复核修正"（走查报告中不成立或描述失真的部分）。

范围：`apps/api`、`apps/parser-worker`、`packages/database`、`deploy/`、`scripts/`、`tests/evaluation`、`.github/workflows`。
**未触碰生产环境**（未拉取、未迁移、未重启 meetings2 / knowledge.5gsailor.com）。

按用户指令，**所有需要本地部署模型的项目一律不做**（见文末"未实施项"）。

---

## 1. 必须优先修复的正确性问题

| # | 问题 | 修改 | 关键文件 |
| --- | --- | --- | --- |
| 1 | 语义缓存跨用户泄漏（同 Scope 用户可回放他人答案） | 缓存键掺入 `userId`；并且当答案由个人记忆或历史会话生成时**禁止写缓存**（缓存只在"单轮、无私有上下文"的安全集合中生效） | `apps/api/src/chat/chat.service.ts`（`semanticCacheScopeKey`、`emitCitationsAndComplete`）、`apps/api/src/chat/semantic-cache-scope.spec.ts` |
| 2 | HyDE 开关自相矛盾（默认部署永不执行） | 统一为单一开关 `hydeEnabled()`：新名 `AGENTIC_HYDE_ENABLED`，旧名 `HYDE_ENABLED` 仅作为显式开启的兼容别名；两条规划路径共用同一判定 | `apps/api/src/chat/agentic-rag.service.ts` |
| 3 | 合成/托底分数污染绝对阈值（拒答门禁、相关性地板） | 引入 `scoreSource: 'rerank' | 'native' | 'synthetic'` 与 `calibratedScoreOf()` / `evidenceConfidenceScores()`；拒答门禁只读校准分，无重排时降级并在 trace 中显式标注；相关性地板的"最佳分"锚定在校准分上 | `apps/api/src/chat/chat.service.ts`、`apps/api/src/raptor/raptor.service.ts`、`apps/api/src/chat/score-provenance.spec.ts` |
| 4 | 多跳桥接候选靠"抬分"越过相关性地板 | 改为**不污染分数**：保留真实交叉编码分，改用 `floorExempt` 标记豁免分数剪枝 | `apps/api/src/chat/chat.service.ts`（`applyRerank`、`selectEvidence`） |
| 5 | 新实例库 HNSW 参数缺失（Recall@10 0.21 且无报错） | 新增迁移按**当前库**写入 `hnsw.ef_search=200 / iterative_scan='relaxed_order' / max_scan_tuples=20000`；`bootstrap-new-server.sh`、`provision-instance.sh` 一并设置；`deploy-prod.sh` 发布时预检并告警 | `packages/database/prisma/migrations/20260920120000_hnsw_query_settings/`、`scripts/*.sh` |
| 6 | L2 内容哈希去重实际走全表扫描 | Prisma 的 `path/equals`（`#>` 谓词）用不上 GIN 索引，改为 `parserMetadata @> '{"contentHash":…}'` 原始查询，并补表达式索引 | `apps/api/src/ingestion/ingestion.service.ts`、`packages/database/prisma/migrations/20260920130000_document_content_hash_expression_index/` |
| 7 | 删除文档后 BM25 的 df/N 永久漂移 | 新增 `unindexDocument()`：删除前按 delta 回退 `LexicalTermStat.df`、删除归零词项、按实际 postings 重算 `KbLexicalStat`，并接入删除路径 | `apps/api/src/retrieval/lexical-index-store.ts`、`lexical-index.service.ts`、`apps/api/src/ingestion/ingestion.controller.ts` |
| 8 | Contextual Retrieval 结构化跳过字段错位（长文档每块白付 LLM） | 改为按 `metadata.breadcrumb` / `heading_hierarchy` 判定层级 | `apps/api/src/ingestion/contextual-retrieval.ts` |
| 9 | Contextual 前缀无持久缓存，重试/重传全量重付费 | 新增 `ContextualPrefixCache` 表 + 以"模型+完整请求载荷"为键的持久 memo（抽取行语义被保留，prompt 版本变更不会命中旧值），并补 2% 概率的保留期清理 | `apps/api/src/ingestion/contextual-prefix-cache.ts`、`contextual-retrieval.ts`、`packages/database/prisma/migrations/20260920140000_contextual_prefix_cache/` |
| 10 | 结构元文本进入 BM25/向量索引（污染 df 与长度归一化） | 新增 `indexableChunkText()`：剥离 `<!-- 大纲层级 -->`、bbox、表格结构摘要样板，**保留表格行语义与 `[上下文:]` 前缀**（与 Anthropic 做法一致）；BM25 与嵌入共用同一投影 | `apps/api/src/ingestion/chunk-text.ts`、`apps/api/src/retrieval/lexical-index-store.ts`、`apps/api/src/embedding/chunk-embedding.service.ts` |

## 2. GraphRAG 能力补齐

| 项 | 修改 |
| --- | --- |
| 社区检测 | BFS 连通分量 → **Louvain**（确定性实现，`apps/api/src/graph-rag/louvain.ts`）；超大图/显式关闭时回退 BFS |
| 社区摘要 | 模板字符串 → **LLM 社区综述**（实体+关系+证据片段输入，JSON 输出，失败/未配置时模板兜底） |
| 层级社区 | 新增 level-1 层：以 level-0 社区为节点、跨社区关系权重求和后再跑 Louvain，写回 `parentCommunityId` |
| 实体消解 | 新增别名归并（pg_trgm 相似度 + 同类型包含关系 + 中文法定后缀规则），把表面积形式写入 `aliases`，关系解析到同一节点；候选查询同时支持 `name` 与 `aliases` |
| 图进排序通道 | 新增 `searchRelatedChunkIds()` 与检索侧"图谱通道"：一跳+受限两跳邻域的证据 chunk 参与 **RRF 第三路融合**（`RETRIEVAL_GRAPH_RRF_WEIGHT`，默认 0.8），而非仅追加 800 字符上下文 |
| 类型与跳数 | `EntityType`/白名单补 `person`；`searchLocalGraph` 真正实现受限两跳（并在上下文中标注"间接"） |
| 关系权重 | `LEAST(weight+0.5, 10)` → `GREATEST(old, incoming)`：权重回到"最强证据强度"，重复摄取/重建不再单调膨胀 |

## 3. 解析服务（parser-worker）

- 启动即探测能力：`/health` 现在区分 `local_docling_configured` 与 `local_docling_enabled/docling_installed/pymupdf_installed/page_vlm_enrichment_available`；配置了本地模型但镜像没装时**启动日志报错**，不再静默回退。
- 生产镜像加入 **PyMuPDF**（纯栅格化库，无模型权重）；docling/MinerU 仍不进镜像，改为 pyproject 的 `layout-models` 可选依赖，`bootstrap-new-server.sh` 可用 `INSTALL_LOCAL_LAYOUT_MODELS=1` 显式安装。
- HTML 抽取由正则剥标签改为 `html.parser` 结构化抽取：保留标题层级、表格单元格边界（`|` 分隔）、丢弃 script/style。
- 遗留 `.doc`：调用 antiword 前校验 OLE2 魔数 + 大小上限。
- 任务生命周期：区分"保留条目上限"（`PARSER_MAX_TASKS`）与"在飞任务上限"（`PARSER_MAX_INFLIGHT`）；卡在 queued/processing 超过 `PARSER_TASK_STALE_SECONDS` 的任务被判定失败并释放容量。
- 鉴权比较改 `secrets.compare_digest`；镜像以非 root（uid 10002）运行。
- 移除未使用的 minio 依赖。

## 4. 评测体系

- **门禁阈值单一真源**：新增 `tests/evaluation/gate-thresholds.sh`，`ci-gate.sh`、`ci.yml`、`quality-gate.yml` 全部引用，消除 0.80 / 0.90 双门禁打架。
- **报告命名纠偏**：`ragas_deepeval_*` 产物重命名为 `heuristic_answer_quality_*`，脚本写入路径同步，并在既有 JSON 中写入"非官方 Ragas/DeepEval"声明字段。
- **judge 自一致性**：`GATE_LLM_JUDGE_SAMPLES>1` 时多次判定取均值，并在报告中输出 `meanSampleSpread/maxSampleSpread`，让"判定不稳定"可见。
- **离线段子纳入 CI**：`.github/workflows/ci.yml` 新增 `evaluation` 作业，运行 IR/BeIR/基准/ANN/压测/fetch 的 selftest（无需语料与凭据，本地已验证全绿）。
- **公开基准 runbook**：`tests/evaluation/README.md` 增加 BEIR/官方 qrels 的完整命令、产物保留要求、多跳基准需 `RETRIEVAL_BENCHMARK_PATTERNS=1`，并说明两份金标集（50 / 220）的用途差异。

## 5. 其他

- 语料无关化：系统提示词与查询规划提示中移除具体公司/考勤/差旅/绩效示例；面向 2Wiki/HotpotQA 的英文拆解模板收敛到 `RETRIEVAL_BENCHMARK_PATTERNS`（默认关，评测脚本显式开）；新增 `corpus-agnostic-policy.spec.ts` 作为回归门禁。
- 答案上下文硬上限：`RETRIEVAL_CONTEXT_TOKEN_HARD_CAP`（默认按预算 ×1.25），超限丢弃尾部证据并写 trace。
- WeKnora 融合改为**段落粒度**（文档 + 片段指纹），文档级"双路验证"信号单独计算，不再把同文档多片段拼成一坨。
- 嵌入侧：缓存改 LRU；单条维度异常不再整批置空；新增 `EmbeddingModelState` 记录每个 KB 的嵌入模型/维度，检索前检测模型漂移（默认跳过向量通道并告警，`VECTOR_ALLOW_EMBEDDING_MODEL_DRIFT=true` 可放行）。
- Prisma 连接池显式上限（`PRISMA_CONNECTION_LIMIT` / `PRISMA_POOL_TIMEOUT_SECONDS`）。
- 部署脚本：`--frozen-lockfile`（依赖不再漂移）、初始管理员密码不再默认 `123456`（未提供时随机生成并只打印一次）、发布任意实例都会同步并重启共享 parser、Redis 实例号上限校验。
- 删除死代码：`invalidateByEpoch`（按 epoch 键天然失效）、`fitEvidenceContext`（第二套未被调用的上下文构建器）。

## 6. 验证证据

全部在开发工作区完成，未触碰生产：

| 验证 | 结果 |
| --- | --- |
| `apps/api` `tsc --noEmit` | 通过 |
| `apps/api` `jest` | 49 个 suite 通过（1 个需数据库的集成 suite 跳过），396 passed / 5 skipped |
| `apps/parser-worker` `pytest` | 30 passed（含新增 HTML/`.doc`/容量用例） |
| `@llmwiki/gbrain-adapter` 契约测试 | 通过（0 fail） |
| `apps/web` `tsc --noEmit` | 通过 |
| 评测脚本 selftest（IR/BeIR/benchmark/ANN/load/fetch） | 全部通过 |
| Shell 语法 `bash -n`（modified scripts） | 通过 |
| 迁移链路 | 在临时库 `llmwiki_migration_check` 上从零 `prisma migrate deploy` 成功；确认新表/索引存在且库级 `hnsw.*` 参数已写入 |
| 真实数据库 SQL 校验（临时库 `llmwiki_sql_check`，含合成数据） | 删除文档后 postings 归零、`df` 归零并清理、`KbLexicalStat` 归零；实体消解把"X"并入"X有限公司"并写入 alias、不产生重复节点；图谱通道返回 provenance chunk 且不重复计权；`EmbeddingModelState` upsert 正常 |
| `EXPLAIN` 验证 | `#>` 形式走 Seq Scan（旧代码），`@>` 形式走 `document_parser_metadata_gin_idx`（新代码） |

## 7. 未实施项（及原因）

| 项 | 原因 |
| --- | --- |
| Docling / MinerU / 本地版面模型 / 公式 OCR 通道 | **需要本地部署模型**，按指令不做；已改为可选依赖 + 能力位如实上报 |
| bge-m3 sparse / ColBERT 多向量、late chunking | 需要模型侧提供 learned sparse / 多向量输出（等同引入本地或多向量服务），按指令不做；DB 侧模型版本标记已补 |
| LLM listwise 重排 | 需要接入具备 listwise 能力的重排模型路由，属模型选型决策 |
| 镜像化发布 + 蓝绿回滚 | 属于发布架构改造，需要生产侧决策与演练窗口，未擅自变更 |
| 移除 MinIO 容器 | 按 AGENTS.md 属于"共享中间件"，且可能被外部使用；已确认应用代码零调用并在 deploy/README.md 说明可停用 |
| `processChat`（约 2300 行）拆分 | 纯重构、回归面大且需要真实 LLM 端到端验证，建议单独排期；本次已移除其中两处死代码与两处错误的分数/字段逻辑 |

## 8. 复核修正（走查报告中不成立或需修正的部分）

1. `/parse` 公网免认证：实际部署挂载的 `deploy/docker/nginx.prod.conf` 没有 `/parse` location，被引用的 `infra/nginx/nginx.conf` 在全仓库无任何引用（属历史文件）。
2. "L2 去重无表达式索引"：索引存在（GIN jsonb_path_ops），真实原因是 Prisma 生成的 `#>` 谓词用不上它。
3. "BEIR/官方 qrels 零实跑产物"：仓库内已有 220 题金标实跑（`latest_results.json`，`dry_run:false`）、CMRC2018 178 条公开基准实测、以及 SciFact 官方 qrels 实测矩阵（`docs/sota-optimization-plan-inst1-2026-09-20.md`）。
4. ANN 报告 `gate.passes:false` 的归因：门禁把对照基线（ef=40）也纳入"全部配置达标"，属度量设计缺陷；生产配置（ef=200）实测 Recall@10 = 1.0。
5. `[上下文:]` 前缀"污染 BM25/向量、应分离索引"：与 Anthropic Contextual Retrieval 原始做法相反；真正需要剥离的是 HTML 注释型结构元文本（已按此实施）。
6. 内部金标"仅 50 题"：另有 220 题 `golden_dataset.json`；两者用途不同，已在 README 说明。
