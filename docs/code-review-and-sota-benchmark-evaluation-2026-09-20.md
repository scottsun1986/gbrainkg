# GBrainKG 代码走查 × 业界 SOTA 方案对标评估报告

- **日期**：2026-09-20
- **性质**：只读评估，未改动任何代码
- **范围**：`apps/api`（检索/问答/摄取/图谱/RAPTOR/嵌入/评测）、`apps/parser-worker`、`packages/database`、`tests/evaluation`、部署脚本与基础设施；同步调研 2025–2026 业界知识库/RAG 方案
- **方法**：四个方向并行深度走查（摄取线 / 检索问答线 / 图谱与评测 / 解析与数据层与部署）+ 互联网 SOTA 方案调研；关键高危结论均经人工二次复核确认

---

## 一、总体结论（TL;DR）

**本项目不是"业内超 SOTA"。更准确的定位是：架构选型与 2025–2026 业界共识完全对齐、工程质量高于绝大多数开源 RAG 项目，但存在三类硬伤：**

1. **算法内核"外壳大于内核"**——GraphRAG 社区摘要是不经 LLM 的模板字符串、社区检测是 BFS 而非 Leiden、RAPTOR 是固定 3 层伪树（`parentNodeId` 从未写入）、bge-m3 只用了 dense 输出（sparse/ColBERT 能力闲置）。
2. **存在若干高危缺陷**——其中语义缓存跨用户泄漏（已人工复核）在多用户生产环境属 P0 级隐私问题；HyDE 开关自相矛盾导致默认部署永不执行；多处合成分数/托底分数污染拒答门禁与相关性地板。
3. **评测体系"框架完备、实跑不足"**——BEIR/官方 qrels/ANN recall/压测脚本齐备但零实跑产物；项目自身审计文档（`docs/audit-remediation-and-sota-evaluation-2026-09-19.md`）亦承认"不得声称 SOTA"。

**同时应公正指出**：混合检索 + 交叉编码重排 + Agentic 多跳 + Contextual Retrieval + 逐句 Grounding 门控 + 权限三重校验这条主干属于一线水准设计；版本双栅栏、扫描页子集 OCR、带 Recall@10 实测的 HNSW 调优、"跑不了即失败"的 CI 门禁等细节，超过 RAGFlow/Dify 等主流开源项目的同类实现。

---

## 二、系统架构与端到端流程综述

```
上传(Web/压缩包/文本/API/MCP)
  → BullMQ 队列(jobId=ingest-{docId}-v{version}, 幂等)
  → 三级解析去重(进程内 parseCache → DB contentHash → anydoc/Python parser-worker)
  → 质量门禁(content-v2, 三态: passed/needs_review/rejected)
  → 结构感知分块(markdown-chunker: 标题/条款/表格/页码感知)
  → Contextual Retrieval(LLM 为每块生成上下文前缀, 滑动窗口)
  → 版本双栅栏事务入库(queue-time + 事务内 re-check)
  → 富化(向量化 ‖ 全量 BM25 ‖ RAPTOR ‖ GraphRAG, readiness 状态机)

问答:
权限范围计算 → 语义缓存(命中后逐条 ACL 重验) → 指代消解改写 → 投机并行检索
→ 意图分类/查询分解/术语扩展(/HyDE) → 7 路混合检索(引擎侧 BM25+向量+ILIKE 多路+标题亲和)
→ RRF 融合 → GBrain CLI 2.5s 竞速 → RAPTOR/图谱宏观增强 → 权限复核
→ CRAG 弱证据升级 → 交叉编码重排 → Agentic 多跳循环(≤3 hop, LLM 充分性裁决)
→ 统一证据选择(MMR+子问题配额) → 版本冲突裁决 → lost-in-the-middle 组装
→ 快速拒答门禁 → 流式生成 → 逐句 grounding 门控 + 引用重绑定 + NLI 复核
→ 第三层 ACL 校验 → 落库/条件写缓存
```

---

## 三、分模块走查结果

### 3.1 数据摄取线（Ingestion）

**亮点（超常规水准）**

| 能力 | 位置 | 说明 |
|---|---|---|
| 版本双栅栏 | `ingestion.service.ts:176,444` | queue-time + 事务内双重校验，防旧任务覆盖新版本；有专门回归测试（`ingestion-version.spec.ts`） |
| 压缩包防护 | `archive-extractor.ts:25-90` | zip-slip 路径净化 + zip-bomb 双重预检，500 文件/500MB 上限 |
| 中文质量门禁 | `content-quality.ts:66-147` | 条款编号连续性（中文数字解析）、表格列坍塌检测、页覆盖率 <40% 告警——同类项目罕见深度 |
| 崩溃恢复 | `ingestion.service.ts:51-109` | 启动扫描滞留文档；indexing 且已有 chunks 的直接从富化边界续跑，不重解析大 PDF |
| 词法统计精确增量 | `lexical-index-store.ts:144-264` | 逐 KB 精确 df delta 维护 |
| 发布门禁 | `lexical-index-cli.ts --verify` | 词法索引完整性校验可作发布门禁 |

**主要问题（关键项）**

| # | 位置 | 问题 |
|---|---|---|
| 1 | `ingestion.controller.ts:172-190` | **重传 = 新文档**：无按文档 ID/内容哈希的 upsert，同文件重复上传产生两套并行索引（L2 hash 去重只省解析不省存储/索引） |
| 2 | `markdown-chunker.ts:85` | 章节正则把行首小数（如"2023.5 万"）误判为标题 → 文档被切碎、面包屑污染 |
| 3 | `contextual-retrieval.ts:144-146` | `metadata.section.includes('>')` 字段错位（`>` 实际在 `breadcrumb`，见 `markdown-chunker.ts:345-347`）→ 结构化跳过失效，长文档每块白付 LLM 费用 |
| 4 | `contextual-retrieval.ts`（全局） | 上下文结果**无持久缓存**（不按 docHash/chunkHash 落盘），retry 端点 bump 版本后全量重付费；对照 Anthropic prompt caching 可省约 90% |
| 5 | `lexical-tokenizer.ts` + `markdown-chunker.ts:324-341` + `contextual-retrieval.ts:254` | 注入的 `<!-- 大纲层级 -->`、`<!-- 表格结构摘要 -->`、`[上下文: …]` 元文本进入 Chunk.content → **BM25 分词与向量均被元文本污染**，全库 df 膨胀、排序偏移 |
| 6 | `enrichment.processor.ts:103` | 4 个富化子任务 allSettled，任一失败 BullMQ 整体重试（attempts=3）→ RAPTOR/GraphRAG 的 LLM 费用重复支出，无子任务级断点 |
| 7 | `graph-rag.service.ts:617-619` | 重摄取时关系权重 `LEAST(weight+0.5, 10)` 单调膨胀——权重实际度量"被 reindex 次数"而非语义强度；旧 chunkId provenance 在重摄取路径不清理 |
| 8 | `ingestion.service.ts:207-214` | L2 去重 JSONB 查询无表达式索引 → 未命中 L1 时全表扫描 |
| 9 | `ingestion.controller.ts:353-364` | 文档删除路径不修正 `LexicalTermStat.df`/`KbLexicalStat` → BM25 的 N/df 永久漂移直至手动 rebuild |
| 10 | `content-quality.ts:44,85` | 分页符 `\f` 被当异常控制字符（chunker 却当合法页标记）；条款跳空阈值 `>10` 硬编码 → 多部分汇编文档误卡 needs_review |
| 11 | `ingestion.service.ts:34-37` 等 | 硬编码：上传根 `/tmp/llmwiki/uploads`、parser `127.0.0.1:8100`、向量维度 `vector(1024)` 写死（换嵌入模型即崩）、块大小/重叠无环境变量 |

### 3.2 检索与问答线（Retrieval + Agentic RAG）

**亮点（部分设计业界少见）**

| 能力 | 位置 | 说明 |
|---|---|---|
| 语义缓存 ACL 重验 | `chat.service.ts:2547-2563` | 缓存命中后逐条重放 ACL/时效校验，任一失效即弃缓存重检索 |
| 四层幻觉防线 | `chat.service.ts:4422-4527, 4603-4648, 5727-5833` | 流式逐句门控（极性冲突+数值单位换算）→ 引用重绑定 → NLI 蕴含复核 → 输出侧非法角标剔除；带角标句子只对被引来源验证，堵"真角标假事实"漏洞 |
| 拒答不写缓存 | `chat.service.ts:5892-5909` | 拒答/低覆盖率（<0.8）答案不进缓存，防污染 |
| 引用重绑定回归 | `citation-rebinding.spec.ts` | 独立回归用例 |
| 过滤 HNSW 召回实测 | `chat.service.ts:1600-1614` | 附 100k 语料 Recall@10 实测矩阵（ef=200+relaxed_order → 1.0） |
| 检索护栏 | `retrieval-budget.ts`、`chat.service.ts:1158-1160` | 15s Deadline + 12 并发 Bulkhead |

**主要问题（关键项）**

| # | 位置 | 严重度 | 问题 |
|---|---|---|---|
| 1 | `chat.service.ts:283-300, 2671, 3812, 5926-5942` | **P0** | **语义缓存跨用户泄漏**：缓存 key = `版本盐\|sourceKeys\|aclEpoch\|kbEpoch\|model`，**无 userId**；但生成 prompt 含**个人记忆**（:2671 按用户加载、:3812 注入）与**会话历史**——用户 A 含私有上下文的答案可被同 scope 用户 B 命中回放；写缓存条件中无个人记忆排除项（已人工复核确认） |
| 2 | `agentic-rag.service.ts:202 vs 481` | 高 | HyDE 开关自相矛盾（`!=='false'` vs `==='true'`）→ **默认部署 HyDE 永不执行**，与 :194-199 注释矛盾（已复核） |
| 3 | `chat.service.ts:5187-5198` | 高 | rerank 多跳托底 `max(rawCrossScore, 兜底虚构分0.88)` 把启发式虚构分扶正 → 无关 hop 候选越过 0.35 相关性地板进入上下文 |
| 4 | `chat.service.ts:4216-4263` + `raptor.service.ts:982` | 高 | 快速拒答门禁形同虚设：fallback 分数为归一化 0.05–0.99（top1 恒 ≥0.95 > 0.25 阈值）；RAPTOR 合成分钳到 0.75+ 亦可抑制本应触发的拒答 |
| 5 | `chat.service.ts:190` | 中 | 0.40 字符集重叠是弱归因（去重字符集合而非 n-gram）→ 防数值造假、防不住定性捏造 |
| 6 | `chat.service.ts:4342-4359` | 中 | 系统提示词内嵌具体公司示例与考勤/差旅场景规则——**违反 AGENTS.md 的 corpus-agnostic 铁律**；英文多跳正则明显为 HotpotQA/2Wiki 定制（`chat.service.ts:866-916`、`agentic-rag.service.ts:932-938`），属评测过拟合 |
| 7 | `context-budget.ts:48-85` + `chat.service.ts:4160-4182` | 中 | token 总预算只有软约束（`fitEvidenceContext` 死代码，最终组装无硬封顶） |
| 8 | `chat.service.ts:2403` | 中 | `processChat` 单方法约 2300 行、`searchChunksFallback` 约 750 行，回归面过大 |
| 9 | `chat.service.ts:5043-5064` | 中 | WeKnora RRF 按文档合并丢失块级粒度，且融合发生在权限复核之后 |
| 10 | `semantic-cache.service.ts:216-234` | 中 | `invalidateByEpoch` 全仓库无调用方（死代码），权限回收依赖 epoch bump 及时性 |

### 3.3 知识图谱（GraphRAG）

| 能力 | 本项目实现 | 业界参照（MS GraphRAG / LightRAG / HippoRAG 2） | 结论 |
|---|---|---|---|
| 实体/关系抽取 | 正则全量 + LLM 抽样 30%（`llmSampleRate=0.3`, `maxLlmChunks=20`，`graph-rag.service.ts:368-369`），无 gleaning 多轮 | LLM 全量 + gleaning | 折衷可接受 |
| 实体消解 | `(kbId,name)` 精确唯一键；`aliases` 恒为 `'[]'`（:508），pg_trgm 索引只用于查询未用于消解 | 名称+描述归并 / PPR 上下文 | **缺失**——同义实体分裂节点 |
| 社区检测 | BFS 连通分量 + 30 节点硬截断（:781,786），注释自认 "Simple BFS" | Leiden/Louvain 层级 | **落后** |
| 社区摘要 | **模板字符串**（:869,920："本知识社区涵盖了以下核心实体…"，已复核），非 LLM | LLM 逐层生成 + map-reduce | **落后** |
| 层级社区 | schema 有 `level/parentCommunityId`，两处 create 均 `level: 0`，从未使用 | 多层级社区 | 半伪实现 |
| 全局搜索 | 社区摘要向量 top-k 直接拼 prompt（:1161-1247） | map-reduce 汇总 | 简化版 |
| 图检索与主检索融合 | **不进 RRF 排序通道**；仅 800 字符上下文追加（`chat.service.ts:4199-4201`）+ 固定 0.88 分 citation 注入（:1524） | GraphRAG local search 图结构+社区文本共同排序；HippoRAG 2 的 PPR 传播排序 | **落后——最划算的升级点：把一跳邻居 chunk 并入 RRF 第三通道** |
| 增量与删除 | 社区指纹复用 + 文档删除两阶段清理（:673-760），幂等 | — | 良好 |
| 其他 bug | prompt 允许 `person` 类型但校验白名单不含（:253 vs :306）→ person 实体必然误分类；`searchLocalGraph` 注释称 2-hop 实际仅 1-hop（:1022 vs :1053-1062） | | |

### 3.4 RAPTOR 与嵌入

- **RAPTOR**（`raptor.service.ts`，1076 行）：窗口化伪 k-means++（固定分位数 0.73 选心，非 D² 随机采样，牺牲初始化多样性换确定性）+ 固定 3 层（非递归树）+ **展平进向量库检索**（无论文的 collapse-tree 遍历）；`parentNodeId` 从未写入；多层合成分数（向量命中钳 0.75-0.98、摘要 0.9、大纲 0.93）**污染统一阈值体系**（见 3.2 问题 #4）。亮点：软分配阈值规则、Level 2 全库树的 Redis 分布式锁 + 防抖、delete-then-insert 原子重建。
- **嵌入**（`embedding.service.ts`）：bge-m3 1024 维**仅用 dense 输出**，其 sparse + ColBERT 多向量能力全部闲置（检索侧稀疏通道是独立 tsvector/BM25，非 learned sparse）；批量 32、6000 字截断、singleflight 去重、md5(content) 表达式索引去重（细节到位）；**DB 侧无嵌入模型版本标记**——换模型后新旧向量混存风险（服务端缓存 key 防了，DB 没防）；缓存淘汰是 FIFO 非 LRU；`embedBatch` 单条维度异常整批置 null（放大 32 倍重试成本）。

### 3.5 文档解析服务（parser-worker）

**能力矩阵**：13 种格式（md/txt/csv/html/doc/docx/xls/xlsx/pptx/pdf/png/jpg/jpeg）+ 压缩包（API 层解压）。PDF 混合路由（`main.py:1100-1183`）：页级分类（text/scanned/mixed）→ 复杂版面走 Docling（**仅 dev 环境**）→ 否则 pypdf；扫描页**子集 OCR**（只送扫描页，省钱设计是亮点）→ 按原始页序合并。

**主要发现**：

| # | 位置 | 问题 |
|---|---|---|
| 1 | `parser.Dockerfile`、`bootstrap-new-server.sh:223-227` | **Docling/PyMuPDF 不在生产镜像与 venv** → PDF 深度解析全靠百度云 OCR（生产默认 `OCR_PROVIDER=none`，纯扫描件直接失败）；`vlm_extractor.py:152-155` 的 `import fitz` 容错使 **PDF 页级 VLM 富化在生产容器静默失效** |
| 2 | 全局 | **公式处理完全没有**（无 LaTeX/公式 OCR 通道）；PDF 表格结构仅靠云 OCR，无跨页表格结构合并、无合并单元格处理 |
| 3 | `main.py:229-231` | HTML 用正则剥标签，`<td>` 边界被空格吞掉，无 readability/trafilatura 正文抽取 |
| 4 | `main.py:260-280` | .doc 用 antiword（年久失修、有历史 CVE），容器以 root 运行（`parser.Dockerfile` 无 USER） |
| 5 | `infra/nginx/nginx.conf:77-93` + `main.py:137-145` | **安全隐患**：nginx 将 `/parse` 反代到 8100，回环放行看到的是 nginx 本地源 IP → `AUTH_TOKEN` 未配置时等于公网免认证解析接口 |
| 6 | `main.py:96-104` | 卡死的 queued/processing 任务永久占用 `PARSER_MAX_TASKS=5000` 容量（清理只覆盖 completed/failed） |
| 7 | `main.py:151` | Bearer 比较非常量时间（应 `secrets.compare_digest`）；百度 access_token 走 URL query 进访问日志 |
| 8 | `deploy-prod.sh:180-184` | 共享 parser 只随 inst1 发布重启 → 只发 inst2+ 时 parser 代码版本漂移 |

**对照**：MinerU 2.5 / Marker / Docling / RAGFlow DeepDoc 均带本地版面模型 + 公式 LaTeX + 表格结构合并；本项目解析本质是"原生格式轻量抽取 + 云 OCR 兜底"，深度落后，但"页级分类 + 子集 OCR + 质量门禁 hold-for-review"的工程化高于多数开箱方案。

### 3.6 数据层与部署

| 主题 | 发现 |
|---|---|
| 自研 BM25 | 三张表（`ChunkLexicalDoc` tsvector+GIN / `LexicalTermStat` 逐 KB df / `KbLexicalStat` N·avgdl）+ CJK bigram 分词（`Intl.Segmenter`）+ `t<term>` 前缀技巧防 PG 二次切分 + rarest-first df 预算（实测 2.2s→0.2s）+ SQL 内精确 Okapi BM25(k1=1.2,b=0.75)。**全场最硬核自研**；弱点：df 漂移无自愈、无短语/邻近查询、存储近翻倍 |
| HNSW | m=16/efC=64；查询侧 DB 级 `ef_search=200 + iterative_scan=relaxed_order` 有 Recall 实测，但**参数不在任何 migration** → 新部署默认值下自家实测 Recall@10=0.2067（`docs/audit-remediation-and-sota-evaluation-2026-09-19.md:95`）；ci-gate 默认 ef=100 与生产 ef=200 自相矛盾，自家 ANN 报告 `gate.passes: false` |
| 连接池 | Prisma 无 `connection_limit` 显式配置，两处代码注释自证池已被打爆（`lexical-index-store.ts:414-419`、`chat.service.ts:1610-1613`） |
| 多实例隔离 | 按库 + Redis DB 索引（`REDIS_DB=N-1`）+ 部署强校验门禁——干净；但 **Redis databases=16 封顶，第 17 实例越界无校验**，且与 Redis Cluster 不兼容封死水平扩展；PG 单角色带 `BYPASSRLS`，无 per-tenant 资源配额；共享 parser 无租户队列（单点） |
| 死重 | MinIO 容器：全 apps/ 无任何 SDK 调用，`rawFileOid` 实际存本地路径（schema 注释与实现漂移） |
| 发布工程 | 脚本化扩容/发布 + REDIS_DB 强校验预检（好）；但非镜像化发布、`--frozen-lockfile=false`（依赖可漂移）、无蓝绿/回滚、CI 门禁与发布流水线未打通（deploy 可 `--skip-build`） |
| 安全 | `ADMIN_INITIAL_PASSWORD` 默认 123456（有 mustChangePassword 缓解）；DB 密码经 SSH 命令行/psql -c 明文传递；AES 凭证密钥派生自明文 env 文件 |

### 3.7 评测体系

| 层 | 现状 | 结论 |
|---|---|---|
| 内部评测 | `run-evaluation.ts`（疑似 legacy 壳，scope 名未解析成 KB UUID）、`quality-gate.ts`（8 项阈值，LLM judge 可选且重算 judge 断言表防幻觉计分——好细节）、`paraphrase-eval.ts`、`feedback-regression.ts`（点踩→回归用例飞轮） | 框架好；金标仅 50 题；judge 默认关闭 |
| 国际基准 | `benchmark_suite.py`（2Wiki/HotpotQA/MuSiQue 各 100 题，recall/MRR/nDCG + Delta 看板）、`standard_ir_eval.py`（官方 qrels，缺查询计 0 不跳过——反注水意识好）、`beir_pipeline.py`（**零实跑产物**）、`ann_recall_eval.py`（当前报告 gate.passes=false）、`load_test.py`、`answer_quality_heuristic_suite.py`（文件头自认 NOT official Ragas/DeepEval，fixture 为合成样本） | **框架一流、实跑不足** |
| CI 接入 | `ci.yml` quality-gate job（self-hosted runner，真实接入）+ `ci-gate.sh`（GATE_STRICT=1 时"跑不了即失败"——防假绿）；**但 `quality-gate.yml` 旧 workflow 阈值 0.80 与新 0.90 并存打架**；paraphrase/feedback 回归/full 基准/压测均未自动化 | 分层接入，双门禁矛盾 |

---

## 四、业界 SOTA 方案调研（2025–2026）

**共识架构**（FutureAGI 2026-08、arXiv 2026-04 基准、Turing Post 等）：混合检索（BM25+向量）+ 神经重排已是 settled baseline（混合+重排实测 Recall@5≈0.816 / MRR@3≈0.605）；Agentic RAG（查询规划、Corrective RAG 自我纠错）是按评测需求叠加的前沿层；**持续评测是一等架构组件**；GraphRAG/多模态/记忆为选配扩展。

| 领域 | 业界代表 | 与本项目的关系 |
|---|---|---|
| 开源全家桶平台 | RAGFlow（DeepDoc 版面解析）、Dify（~114K stars，低代码工作流）、FastGPT、Onyx（40+ 企业连接器）、WeKnora（腾讯，13.7K stars；关键词+向量+GraphRAG 混合；**本项目多处注释明确借鉴其邻块链接等设计**） | 本项目算法深度（自研 BM25/门控/幂等）普遍高于它们，但解析深度与开箱生态不如 RAGFlow/WeKnora |
| 图 RAG 前沿 | MS GraphRAG（Leiden 层级 + LLM 社区摘要 + map-reduce）、LightRAG（低成本 dual-level）、HippoRAG 2（PPR，自称 SOTA；2026-02 基准：本体增强 GraphRAG 69 题答对 59 vs Vector RAG 51-52） | 本项目缺 Leiden / LLM 摘要 / 层级社区 / PPR 四大件，落后一代 |
| 检索技术 | Anthropic Contextual Retrieval（检索失败降 30–40%，prompt caching 降本 90%）、Late Chunking（Jina）、ColBERT/ColPali late-interaction 多向量 | 本项目已实现 contextual retrieval 且滑动窗口有独到优化；无持久缓存、有字段错位 bug；late chunking/多向量完全未做 |
| 嵌入/重排模型 | Qwen3-Embedding/Reranker（MTEB/C-MTEB 开源榜首，32K 上下文，0.6B–8B）；bge-m3（dense+sparse+ColBERT 三合一） | 本项目 bge-m3 三分之二能力闲置；reranker 走外部 API（bge-reranker 类），无 listwise LLM 重排 |
| 文档解析 | MinerU 2.5（公式 LaTeX/多栏/表格）、Marker、Docling（TableFormer）、RAGFlow DeepDoc（LayoutRM）、Mistral OCR/LlamaParse（云） | 本项目无本地版面模型、无公式通道；深度解析依赖默认关闭的云 OCR |
| 云厂商企业方案 | Glean（275+ 连接器、权限感知检索）、AWS Bedrock Knowledge Bases（2026-06 GA）、Azure AI Search、Vertex AI/Google Agent Search | "permission-aware grounding"是共同第一公民——本项目 ACL 三重校验理念对齐，但存在缓存泄漏漏洞 |

---

## 五、逐维度对标评级

| 维度 | 本项目现状 | 业界 SOTA 参照 | 评级 |
|---|---|---|---|
| 混合检索（向量+BM25+RRF） | 自研引擎侧 BM25 + HNSW + RRF + df 预算 + ACL 内联 | settled baseline | **达到**（融合层手工 boost 属魔法数） |
| 重排序 | 交叉编码 API + 结果缓存 | LLM listwise、级联重排 | 接近（多跳托底逻辑在污染重排结果） |
| Agentic 能力 | 查询分解 + HyDE（默认失效）+ 3 hop 充分性裁决 + CRAG 改写 + 桥接级联 | Self-RAG 内联反思、FLARE、完整 CRAG 闭环 | 接近——外挂单层裁决，无"生成不合格→重检索重生成"闭环 |
| Contextual Retrieval | 已实现 + 滑动窗口省 token 创新 | Anthropic 官方 + prompt caching | 达到但带 bug（字段错位、无持久缓存、元文本污染索引） |
| 引用/幻觉防线 | 四层防线 + 逐句门控 + 引用重绑定 | quote-extraction 归因、RAGAS faithfulness | **超出多数开源方案**（归因强度偏弱） |
| 语义缓存 | scope 指纹 + epoch + 命中后逐条 ACL 重验 | — | 设计业界少见地好；**跨用户泄漏 P0** |
| 知识图谱 RAG | BFS 伪社区 + 模板摘要 + 图不进排序通道 | GraphRAG / LightRAG / HippoRAG 2 | **落后一代** |
| RAPTOR | 窗口聚类 + 固定 3 层 + 展平检索 | 论文递归树 + collapse 检索 | 落后（形似神不似） |
| 多向量/late-interaction | 无 | ColBERT/ColPali、late chunking | 落后 |
| 文档解析 | 云 OCR 兜底 + 页分类 + 质量门禁 | MinerU/DeepDoc 本地版面模型 + 公式 | 落后（工程门禁更强） |
| 评测体系 | 金标 50 题 + BEIR/qrels/ANN/load 全链路脚本 + judge 可选 | RAGAS/DeepEval 常态化 + 公开基准实跑 | **框架一流、实跑不足** |
| 工程化（幂等/门禁/隔离） | 版本双栅栏、质量三态、多实例隔离守则 | — | **高于典型开源项目** |
| 部署 | 脚本化扩容/发布 + 预检门禁 | 不可变镜像 + 蓝绿回滚 | 中上（无镜像化、无回滚） |

---

## 六、最终评定

**"流程是否业内超 SOTA？"——不是。** 分三层评定：

1. **架构选型层（8.5 / 10）**：主干管线与 2026 业界共识完全同构；语义缓存 ACL 重验、逐句 grounding 门控、扫描页子集 OCR、中文条款质量门禁等设计有独到超出常规之处。选型无落后项、无炫技项。
2. **算法实现层（5.5–6 / 10）**：GraphRAG/RAPTOR 是"schema 支持但实现未跟上"的半成品；图信号未进排序通道；bge-m3 三分之二能力未用；HyDE 默认失效；多处合成/托底分数污染统一阈值体系（拒答门禁与相关性地板实际失效）——宣称的高级能力在真实链路中的贡献打折。
3. **实证层（4 / 10）**：与"超 SOTA"宣称差距最大的一环。评测框架是创业公司里少见的完备，但无实跑数据支撑任何 SOTA 结论；内部金标仅 50 题；部分检索正则对着 HotpotQA 调参（评测集过拟合）；项目自身 2026-09-19 审计文档已承认不能声称 SOTA——该自我认知是诚实的。

**一句话定位**：这是一个被真实事故驱动迭代出来、工程质量意识极强的单机多租户 RAG 系统；主干对齐 SOTA、若干细节超出主流开源，但图谱/RAPTOR 内核、解析深度、多向量检索与实证闭环四处未达标，当前不构成"超 SOTA"。

---

## 七、若要真正达到/超越 SOTA 的优先级建议（未实施，仅供参考）

1. **P0**：修语义缓存跨用户泄漏——缓存 key 掺入 userId，或含个人记忆/会话上下文时禁写缓存。
2. **P0**：清理合成/托底分数（rerank 多跳托底、RAPTOR 合成分、GBrain 固定分），统一分数语义，使拒答门禁与 0.35 相关性地板真正生效。
3. **P1**：HNSW `ef_search/iterative_scan` 参数写入 migration；修 HyDE 开关矛盾；补 L2 去重表达式索引与删除路径的词法统计修正。
4. **P1**：图谱四大件补齐（Leiden + LLM 社区摘要 + PPR 排序通道 + 实体消解），或降级为纯 local search 并删除伪社区代码；最划算的第一步是把一跳邻居 chunk 并入 RRF 第三通道。
5. **P1**：Docling 或 MinerU 打进生产镜像，按页分类门控启用；补公式通道；解决 PyMuPDF 缺失导致的 VLM 富化静默失效。
6. **P2**：上下文元文本与正文分离索引（Anthropic 式：原文与上下文化文本分别 BM25/嵌入再融合）；contextual retrieval 持久缓存。
7. **P2**：启用 bge-m3 sparse 输出或引入 late chunking/ColBERT 通道；DB 侧加嵌入模型版本标记。
8. **P2**：BEIR/官方 qrels 实跑 + LLM judge 常态化（多 judge 交叉）+ 双 CI 门禁合一 + 100k 压测——用公开数据而非架构清单支撑 SOTA 结论。
9. **P2**：提示词去业务化（删除内嵌公司示例与考勤/差旅规则、benchmark 定制正则收敛到配置层），回归 AGENTS.md 的 corpus-agnostic 铁律。
10. **P3**：镜像化发布 + 回滚机制；parser 子任务级断点；Redis 16 库上限方案重审。

---

## 八、参考来源

- [RAG Architecture in 2026: Patterns + Eval (FutureAGI)](https://futureagi.com)
- [From BM25 to Corrective RAG: Benchmarking Retrieval (arXiv)](https://arxiv.org)
- [20 Advanced RAG Types to Know in 2026 (Turing Post)](https://www.turingpost.com)
- [15 Best Open-Source RAG Frameworks in 2026 (Firecrawl)](https://www.firecrawl.dev)
- [Batteries-included RAG platforms: Dify vs. RAGFlow vs. Onyx (learnwithparam.com)](https://learnwithparam.com)
- [Tencent WeKnora (GitHub)](https://github.com)
- [Best Enterprise RAG Platforms for 2026: A Buyer's Guide (Onyx)](https://onyx.app)
- [The 12 Best Enterprise RAG Platforms and Tools in 2026 (Sphere)](https://www.sphereinc.com)
- [Build enterprise search for agents with Amazon Bedrock (AWS)](https://aws.amazon.com)
- [HippoRAG 2: From RAG to Memory (arXiv)](https://arxiv.org)
- [Graph Database AI Agents: GraphRAG & Memory Guide (FalkorDB)](https://www.falkordb.com)
- [Contextual Retrieval in AI Systems (Anthropic)](https://www.anthropic.com)
- [Enhancing RAG with Contextual Retrieval (Claude Cookbook)](https://platform.claude.com)
- [How Late Chunking Can Enhance RAG (Towards AI)](https://pub.towardsai.net)
- [Late Chunking (Weaviate)](https://weaviate.io)
- [Qwen3 Embedding (QwenLM)](https://qwenlm.github.io)
- [PDF Parsing for RAG 2026: MinerU vs Docling vs Marker](https://builderai.tools)
- [Docling, Marker, and MinerU Production Setup Guide (Spheron)](https://www.spheron.network)
- [MinerU (GitHub)](https://github.com/opendatalab/MinerU)
- [Docling paper (arXiv)](https://arxiv.org)
