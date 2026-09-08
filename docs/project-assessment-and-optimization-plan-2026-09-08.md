# GBrainKG（LLMWiki）项目综合评估与优化方案

> **文档编号**：GBA-OPT-2026-09-08
> **版本**：v1.0
> **评估周期**：2026-09-08
> **评估对象**：`/home/scottsun/gbrainkg` 代码库（apps/api · apps/web · apps/parser-worker · packages/* · infra · deploy）
> **对标系统**：Tencent WeKnora v0.8.0（21.8k★，MIT）、RAGFlow、Dify、FastGPT、Onyx、Glean
> **配套文档**：《全格式全场景测试用例》（test-cases-comprehensive-2026-09-08.md）、《综合测试报告》（test-reports/comprehensive-system-test-report-2026-09-08.md）

---

## 一、评估范围与结论总览

### 1.1 项目定位回顾

本项目立项方案（`llmwiki-项目方案.md` v1.2）核心理念为**编译式个人大脑（Compile-then-Query）**：知识不是被检索的碎片，而是面向每个人持续编译的 Compiled Truth + Timeline 证据链；权限即编译视图边界；夜间 Dream Cycle 持续整理。当前实现已从"纯编译式"演化为 **"GBrain CLI 编译大脑 + PG chunk 双引擎容灾检索"** 的混合架构（见 `docs/accuracy-first-gbrain-weknora-anydoc-optimization-plan.md`）。

### 1.2 总体评分

| 评估维度 | 得分 | 权重 | 加权 | 一句话结论 |
|---|---|---|---|---|
| 文档解析与摄入管道 | 82/100 | 15% | 12.3 | 双质量门+多级回退链业界领先；队头阻塞与大文件内存是短板 |
| 检索与问答质量 | 72/100 | 20% | 14.4 | 三层 ACL+21 阶段 trace 优秀；端到端准确率(38%)与门禁(80%)差距大；operation 硬编码回归 |
| 权限与多租户安全 | 91/100 | 15% | 13.65 | 组织树继承+双 epoch+引用级第三层 ACL 属业界罕见水平；会话无吊销、审计死代码 |
| 架构先进性（编译大脑） | 88/100 | 10% | 8.8 | Source/Scope 双模型+outbox+懒编译完整落地；备份/分布式配额未闭环 |
| 工程质量与可维护性 | 62/100 | 15% | 9.3 | 单测 114/115；但 chat.service 2368 行/admin 2071 行巨石、6 处死代码、验收驱动硬编码 |
| 前端工程质量 | 55/100 | 5% | 2.75 | 功能完成度 85-90%，但 6327 行单文件 SPA、全量 eslint-disable、零组件测试 |
| 部署与运维 | 70/100 | 10% | 7.0 | 三形态部署+三层健康检查好；**无数据库级备份**、双 env 模板漂移、nginx 端口漂移 |
| 可观测性 | 78/100 | 5% | 3.9 | 21 阶段 trace + BrainOperationLog 全链路；无 Langfuse/指标看板接线 |
| 测试体系 | 75/100 | 5% | 3.75 | 单测/评测框架完备；E2E 硬编码凭据、PDF/OCR 主路径无测试、评测未达标 |
| **综合** | | **100%** | **75.9/100** | **功能完成度约 85% 的先进系统，核心风险在"检索质量未达门禁"与"工程质量债务"** |

### 1.3 关键结论

1. **差异化定位成立且已落地**：编译式大脑（Git-backed Compiled Truth）+ 条款级分块 + 组织树 Pre-filter ACL 三大壁垒在开源社区无直接等价物，WeKnora Wiki Mode（v0.5+）方向趋同但机制不同（其 Wiki 为 Agent 生成页面，本项目为权限驱动的持续编译）。
2. **当前最大风险不是功能，而是质量与债务**：内置评测 50 题仅 38% 通过（2026-09-07 基线，`tests/evaluation/results/`），远低于自设门禁 80%；同时存在 1 个失败单测揭示的检索 operation 回归（`chat.service.ts:950`）。
3. **工程债务正在拖慢迭代**：6 处"已写未接线"组件（Agentic 循环、late-chunking、context-budget、AuditService、casbin、GraphRAG global search）+ 2 个巨型文件 + 双 env 模板/端口漂移，均为最佳实践偏离项。

---

## 二、对照业界最佳实践的逐项评估

### 2.1 文档解析管道 —— 评级 A-（82 分）

**符合最佳实践的部分**：

| 实践 | 本项目实现 | 业界参照 |
|---|---|---|
| 多级解析回退链 | L1 plaintext 快路径 → L2 AnyDoc（加密/资源错误安全拒绝）→ L3 parser-worker（PDF 三分类路由 text/scanned/mixed，百度 OCR→Docling→pypdf 兜底） | RAGFlow DeepDoc 单级；WeKnora anydoc 单级 |
| 双层质量门 | Python 侧首道门（`quality.py`）+ TS 侧权威门 content-v2（条款连续性/表格完整性/页覆盖率，且"引擎警告只能加严"） | WeKnora/Dify 仅有解析成败，无结构化质量门 |
| 版本围栏与幂等 | jobId 含版本号 + expectedVersion 围栏 + 重启恢复（indexing 且有 chunk 的文档跳过重解析续编译） | 超出多数开源方案 |
| 上传安全 | 文件名 mojibake 修复、扩展名白名单、200MiB 双重校验、CSP 沙箱预览 | 符合 |

**偏离最佳实践的部分**（本次实测证实）：

1. **【P0】摄入队列队头阻塞**：`INGESTION_CONCURRENCY=2` + 逐 chunk LLM 上下文富化（实测 ~1.7 chunk/s），两个大文件可阻塞空文件/损坏文件等负例 30 分钟以上仍停留 `parsing`。WeKnora 的做法是**分阶段 worker pool（core/post-process/enrichment/maintenance + 弹性共享池）+ 按模型并发治理 + 运行时队列看板**，负例与小文件永不被大文件阻塞。
2. **【P1】200MiB 文件 `readFile` 一次性进内存**（`ingestion.service.ts:122`）：并发 2 时峰值 Node 堆 ~400MB+，无流式处理；WeKnora docreader 为独立 gRPC 进程隔离解析内存。
3. **【P1】Contextual Retrieval 成本 O(N²)**：每 chunk 携带 60KB 全文 system prompt（`contextual-retrieval.ts:16`），Anthropic 原始实践是"整篇摘要一次 + chunk 局部上下文"，成本可降一个数量级。
4. **【P2】VLM 图片富化定位缺陷**：`vlm_extractor.py:236` 将容器文件（PDF/DOCX 二进制）当图片路径传给 VLM，仅靠 20MB 越界拦截兜底。
5. **【P2】`UPLOAD_DIR`/`UPLOAD_ROOT` 变量名分裂**（`knowledge-base.controller.ts:284` vs `ingestion.controller.ts:59`），读取失败静默回退 chunk 拼接——配置漂移隐患。
6. **【P2】无页数上限**：2000 页 PDF 仅靠 240s Docling 超时兜底；百度 OCR 受 50MiB 限制但本地 Docling 无页数预拒。

### 2.2 分块与索引 —— 评级 A（86 分）

- **条款级分块（ClauseSplitter）是独有优势**：章/节/条/款/项识别 + 中文数字解析 + `parentContext`(≤4000 字符) + 邻居链 + 表头跨 chunk 传播 + 行级键值语义注入（HTML 注释供 BM25 不渲染），实测近 2 万字文档首/中/尾联合召回 100%（`docs/test-reports/org-management-...md`）。WeKnora v0.7.2 的 chunk 编辑/版本历史、RAGFlow 的模板分块均未做到条款语义级。
- **偏离项**：late-chunking（Jina v3 风格）已实现但零接线；无 RAPTOR 式多级摘要层（宏观问题依赖 scope 综述页近似解决）；无 HNSW 显式调优（WeKnora v0.6.2 已对 1024 维 pgvector 启用 HNSW）。

### 2.3 检索与生成 —— 评级 B（72 分）

**符合最佳实践**：混合检索（GBrain 向量+BM25+RRF+图谱信号+rerank）+ PG chunk 关键词容灾臂 + 语义缓存（权限指纹+知识代次双失效）+ 查询前 Source 新鲜度对账 + 引用角标三层 ACL 复核——这套"多级瀑布 + 全程 trace"结构比 WeKnora/Dify 的单级管线更可信。

**偏离项（按严重度）**：

1. **【P0·代码回归】检索 operation 被硬编码**：`chat.service.ts:950` `const effectiveOp = "search"` 覆盖了 LLM 改写正确产出的 `operation`（`chat.service.ts:1848-1856` 精确判定 query/search），导致语义型问题全部走 `search` 而非 `query`（含查询扩展/图谱信号）。单测 `chat.service.spec.ts:252` 已捕获该回归（期望 query 实收 search）——**这是评测 38% 通过率的首要嫌疑**。
2. **【P0】验收驱动的检索过拟合**：`domainTerms` 写死"无人机偏航事故/黑狐匣/量子抗性/考勤旷工"等验收语料专有词（`chat.service.ts:453-460`），`isInventoryQuery` 正则两处重复（161-163/887-889）。换一个企业部署即失效，违背"平台无应用侧关键词"的自述原则。
3. **【P1】Agentic 多跳未闭环**：`agentic-rag.service.ts` 的 decomposeQuery/judgeRetrievalSufficiency 实现完整但主链路只接了正则版 classifyQuery；WeKnora 已是完整 ReAct Agent（自主编排检索/MCP/沙箱/网页搜索）。
4. **【P1】上下文预算函数未接线**：`context-budget.ts#fitEvidenceContext` 存在但主链路手拼上下文；token 统计把 chunk 数当 token 数累加（`chat.service.ts:1671`），成本观测失真。
5. **【P2】GraphRAG global search、HyDE、时序冲突裁决均未实现**（蓝图文档已规划）。

### 2.4 权限与多租户 —— 评级 A+（91 分）

- **三层防线（scope 过滤 → 检索结果复核 → 引用输出前独立 ACL）+ 双 epoch（aclEpoch/knowledgeEpoch）+ 个人库物理隔离**：超出 WeKnora v0.6 的 4 级角色矩阵（Owner/Admin/Contributor/Viewer + per-KB ownership），更接近 Glean 的 enterprise permission-aware 形态。本项目"组织树继承 + 行业库三主体授权（user/role/org + 有效期）+ 撤销即时失效"为独有组合。
- **偏离项**：
  1. **【P1】会话 Token 无吊销机制**：8h 无状态 HMAC token，禁用用户靠每请求查 DB user.status 兜底（有效），但已签发 token 无法主动作废、无 refresh token 轮换。WeKnora v0.7.0 有 admin password reset + session revocation。
  2. **【P1】AuditService 死代码**：@Global 注入但全库零调用；实际审计靠 BrainOperationLog + admin 聚合视图顶替。登录/查询/上传/OpenAPI 调用未进独立审计表（WeKnora 有 per-workspace audit log）。
  3. **【P2】casbin 声明依赖零使用**（`package.json:33`），方案文档声称 Casbin 而实现为自研——文档与实现漂移。
  4. **【P2】`revokeAccess` 删 grant 后未主动发 permission.changed 事件**，依赖 15min access-reconcile 或下次查询重算，与方案"撤销<5min 全量重编译"的 SLA 存在窗口。

### 2.5 编译大脑（核心差异化）—— 评级 A-（88 分）

已落地：Source 内容寻址（`llmwiki-kb-<sha256[:16]>`，ACL 变更不重建索引——符合 gbrain 官方最佳实践）、dirty 队列 6 类 job + 5 级优先级、outbox 事件（撤销优先级 1）、两级 Dream Cycle（Source Dream + Scope 派生综述）、查询前新鲜度对账 + 懒编译、Gitea 备份推送、BrainMaintenanceRun 全程审计。

未闭环：`BrainBackupService.schedulePeriodicBackup` 空壳（cron 未接）；GBrain 子进程配额是进程级的（多副本部署需分布式预算，代码注释自认）；旧版 per-user BrainTopic 兼容路径残留。

### 2.6 工程质量 —— 评级 C+（62 分）

| 问题 | 证据 | 业界对照 |
|---|---|---|
| 巨型文件 | `chat.service.ts` 2368 行（processChat 单函数 ~1100 行）、`admin.controller.ts` 2071 行 God Controller、前端 `page.tsx` 6327 行 | WeKnora 大规模 router refactor（v0.7.2）保持模块粒度 |
| 死代码清单 | AuditService、casbin、late-chunking、fitEvidenceContext、AgenticRagService.decompose/judge、SemanticCache.cleanup、GraphRagService.searchGlobalCommunities、sourceIdForUser、initializeRepo | — |
| `(this.prisma as any)` 40+ 处 | schema 演进快于类型 | Prisma client 类型本可生成 |
| DTO 缺失 | ValidationPipe whitelist 开启但 body 全 `any` 内联校验 | WeKnora 全量 typed request |
| 前端零测试 + 全文件 eslint-disable | `apps/web/src/app/page.tsx` 头部 | WeKnora 前端有 type-check + 组件测试 |
| 仓库卫生 | `dist.stale-*` 7 份历史快照、`__pycache__` 入库、`patch_*.js` 根目录遗留、`packages/ui` 空目录 | — |
| 日志不统一 | console.log/error 与 Nest Logger 混用（`contextual-retrieval.ts:30,47`） | — |

### 2.7 部署与运维 —— 评级 B-（70 分）

- **优点**：三形态部署（systemd 原生/Compose 7 服务/bootstrap 一次性初始化门控）、三层健康检查、install/upgrade 脚本、Gitea 应用层知识备份。
- **偏离项**：
  1. **【P0】无数据库/MinIO 级备份**：全仓库无 pg_dump 定时任务与恢复演练脚本，仅 GBrain source 推 Gitea。PG 中的 Chunk/BrainScope/Citation/SemanticCache 等丢失后需全量重编译重建（可恢复但耗时），**WeKnora/Onyx 均有标准备份方案**。方案文档自定的"RPO≤24h"无落地。
  2. **【P1】双 env 模板命名漂移**（`JWT_SECRET/PARSER_URL` vs `AUTH_SECRET/PARSER_AUTH_TOKEN`，DATABASE_URL 端口不同）。
  3. **【P1】native nginx 与 systemd 端口漂移**（proxy_pass 3000 vs 实际 3202）。
  4. **【P2】单副本假设**：parser-worker 任务表进程内存态、GBrain 配额进程级、无 K8s/Helm（方案 M3 承诺）。WeKnora 提供官方 Helm chart。

### 2.8 可观测性 —— 评级 B+（78 分）

21 阶段流式 trace（前端可折叠展示）+ BrainOperationLog/BrainMaintenanceRun/CompileJob truthDiff + trace 敏感字段脱敏，好于多数开源。偏离：方案承诺的 Langfuse 未接线（无编译 token 成本看板）；Prometheus/Grafana 缺失（parser `/metrics` 存在但无采集）；token 统计失真（见 2.3）。

---

## 三、对标腾讯 WeKnora 与主流方案

### 3.1 能力对比矩阵（2026-09 时点）

| 维度 | **GBrainKG（本项目）** | **Tencent WeKnora v0.8** | RAGFlow | Dify | Onyx | Glean |
|---|---|---|---|---|---|---|
| 核心范式 | **编译式大脑**（权限驱动持续编译 Compiled Truth） | 检索式 RAG + ReAct Agent + **Agent 生成 Wiki**（v0.5 GA） | 深度文档理解 RAG | LLM 应用编排 | Agentic 检索 + 50+ 连接器 | 商业 AI 搜索 |
| 文档解析 | AnyDoc+百度OCR+Docling 回退链，**双层结构化质量门** | anydoc 进程内解析 + OpenDataLoader/PaddleOCR-VL，**解析 trace 时间线（v0.6.1）** | **DeepDoc 版面理解（最强）** | Unstructured 基础 | 基本 | 强（闭源） |
| 分块策略 | **条款级语义 + parentContext + 表头传播** | 自适应三级分块+预览（v0.5.2）、parent-child（v0.3.3）、**chunk 可编辑+版本回滚（v0.7.2）** | 模板化可视化分块 | 定长/父子 | 定长 | 闭源 |
| 知识状态 | **Git 版本化 + 双 epoch + Timeline**（最强） | Wiki 页面版本历史+行级 diff+回滚 | 无 | 无 | 无 | 无 |
| 权限模型 | **组织树继承 + 三主体 ACL + 有效期 + 三层检索防线**（最强之一） | 4 级角色矩阵 + per-KB ownership + per-workspace 审计 + **scoped API key（能力级授权）** | 租户级 | 工作区级 | 文档级 ACL（企业版） | 深度 ACL 同步 |
| Agent 能力 | Agentic 骨架（分类已接，多跳未闭环） | **ReAct 全量**（MCP/技能沙箱/网页搜索/@提及） | 无 | 工作流编排强 | Deep Research | Agent 平台 |
| 数据源连接器 | 无（仅上传/文本/URL 缺失） | **飞书 wiki/Drive、GitLab、IMA、Notion、语雀、RSS** + IM 10 渠道 | 少量 | 30+ | 50+ | 100+ |
| 开放生态 | OpenAPI 8 端点 + 用户凭证 | **MCP Server 29 工具 + CLI + Chrome 扩展 + 小程序 + Embed 组件** | API | API+DSL | API | 闭源 |
| 向量/存储 | PG+pgvector（ivfflat），存储 MinIO | pgvector(HNSW)/**ES/OpenSearch/Milvus/Weaviate/Qdrant/Doris/腾讯VDB** + 多存储实例绑定 | ES/Infinity | 多向量库 | Vespa | 闭源 |
| 运维治理 | systemd/Compose，无 Helm，队列无看板 | **Docker/Helm、分阶段 worker pool + 队列看板 + 失败任务重试 UI** | Compose | Compose/K8s | K8s 成熟 | SaaS |
| 观测 | 21 阶段自研 trace | **Langfuse 全量接入（OTel）+ 任务队列看板** | 基础 | Langfuse 可选 | 基础 | 强 |

### 3.2 WeKnora 最值得借鉴的六项实践（结合本项目差距）

1. **分阶段任务池与队列治理**（v0.7.0）：core / post-process / enrichment / maintenance 分池 + 按模型并发上限 + 失败任务检查/重试看板——直接解决本次实测发现的"大文件富化阻塞负例"问题。
2. **Chunk 编辑 + 版本历史**（v0.7.2）：检索块可在 UI 编辑、diff、回滚并自动重索引——本项目 Canonical Page 有 Git 版本但无 chunk 级人工干预入口，坏例修复只能重传文档。
3. **Scoped API Key 与 principal 模型**（v0.7.0）：能力级授权 + per-KB 限制 + 限流——本项目 UserCredential 为全权限 AppSecret，粒度粗一档。
4. **数据源连接器生态**：飞书/GitLab/Notion/语雀/RSS 自动同步——本项目零连接器，企业落地时知识获取全靠人工上传，是采用率的第一瓶颈。
5. **MCP Server + CLI**：29 个 MCP 工具让其它 AI 应用/Agent 直接消费知识库——契合本项目 P2 规划（open API / MCP Server），建议提前。
6. **文档解析 trace 时间线**（v0.6.1）：Langfuse 风格 span 树 + 分阶段进度 + 可中止——本项目的 21 阶段查询 trace 已具备同等形态，补齐解析侧即可对齐。

### 3.3 本项目相对 WeKnora 的护城河（应保持并强化）

1. **权限即编译边界**：WeKnora 权限只作用于检索过滤；本项目权限变更驱动大脑重编译（撤销即时移出 + 懒编译 + 双保险），合规审计价值高一档。
2. **条款级分块 + 结构化质量门**：法规/规章场景召回与拒答能力（评测集中条款查询/权限边界两类）显著优于自适应分块。
3. **编译产物的完全可审计**：Git commit 级 Truth diff + 证据链三级回溯（答案→知识页→Timeline→原始文档），WeKnora Wiki 页面无此对账能力。

**结论**：本项目与 WeKnora 不是替代关系而是**范式差异**——WeKnora 是"文档→检索→Agent"的通用平台（生态、连接器、运维成熟度全面领先），本项目是"权限合规 + 编译大脑"的纵深系统（检索可信性与知识演进独占优势）。优化方向应为**吸收 WeKnora 的工程化治理，而非模仿其平台广度**。

---

## 四、优化方案（P0/P1/P2）

> 每项含：问题编号、证据、方案、验收标准、预估工作量（人日）。

### P0 —— 发布阻断项（建议 2 周内完成）

#### OPT-1 修复检索 operation 硬编码回归
- **证据**：`chat.service.ts:950` `const effectiveOp = "search"`；单测 `chat.service.spec.ts:252` 失败（期望 `query` 实收 `search`）；LLM 改写在 `chat.service.ts:1848-1856` 正确产出 operation。
- **方案**：`effectiveOp = retrieval.operation`（信任改写结果），保留 exact-clause 场景强制 `search`；修复后跑全量评测对比 38% 基线。
- **验收**：单测 115/115 绿；golden-dataset hitRate 对比报告（预期显著提升）。
- **工作量**：0.5 人日（修复）+ 1 人日（评测回归）。

#### OPT-2 摄入任务分池，消除队头阻塞
- **证据**：本次实测空文件/损坏文件在两个大文件后排队 30+ 分钟仍 `parsing`；`INGESTION_CONCURRENCY=2` 全局串行。
- **方案**（对齐 WeKnora v0.7.0 实践）：
  1. BullMQ 拆双队列：`ingestion-parse`（解析+质检，并发 4，负例秒级失败）与 `ingestion-enrich`（LLM 富化，并发独立、可暂停）；
  2. 快速预检前置：空文件/纯空白/扩展名黑名单在 controller 层同步拒绝，不入队；
  3. 大文档（chunk>500）富化任务分片（每 100 chunk 一个子 job），支持断点；
  4. 富化开关分级：`CONTEXTUAL_RETRIEVAL_MODE=off|headline|full`（headline=仅 section 级摘要，成本降 ~90%）。
- **验收**：空文件上传 ≤10s 进入 failed/needs_review；200MB 队列中时小文件解析不被阻塞（吞吐测试）。
- **工作量**：3 人日。

#### OPT-3 检索去验收化（消除过拟合）
- **证据**：`chat.service.ts:453-460` domainTerms 硬编码验收集词汇；`isInventoryQuery` 双处重复。
- **方案**：领域词表迁入 KB 级配置表（`KnowledgeBase.domainTerms jsonb`，管理后台可维护，默认空）；inventory 正则收敛为单处并加特性开关；为验收集词表建立独立 seed 脚本（仅测试环境加载）。
- **验收**：生产模式默认配置下 grep 无验收专有词；评测用 seed 后结果不回退。
- **工作量**：2 人日。

#### OPT-4 数据库与对象存储定时备份 + 恢复演练
- **证据**：全仓库无 pg_dump/MC mirror 脚本；方案 §10 承诺 RPO≤24h 未落地。
- **方案**：deploy 新增 `backup.sh`（pg_dump 自定义格式 + MinIO `mc mirror` 到备份桶/异地）+ systemd timer 每日执行 + `restore-drill.md` 演练手册（含 BrainScope epoch 一致性校验步骤）；healthcheck 增加 Gitea 备份最近成功时间检查。
- **验收**：演练文档化恢复一次全库 + 恢复后冷启动查询通过；备份失败告警可见。
- **工作量**：2 人日。

#### OPT-5 修复失败单测与死依赖清理（CI 红线）
- **证据**：`chat.service.spec.ts` 1 失败（见 OPT-1）；`casbin` 零 import 依赖；`__pycache__`/`dist.stale-*`/`patch_*.js` 入库。
- **方案**：修 OPT-1 后单测全绿；移除 casbin 依赖或落地使用；`.gitignore` 补 `__pycache__/`、删除 stale 目录与根目录 patch 脚本（已被 workspace 机制替代）；CI（可先 GitHub Actions self-hosted）固化 test+lint 门禁。
- **验收**：`pnpm test` 全绿且仓库无 stale 产物。
- **工作量**：1 人日。

### P1 —— 质量与运维提升（1-2 月）

#### OPT-6 Agentic 检索闭环 + 上下文预算接线
- **方案**：将 `AgenticRagService.decomposeQuery/judgeRetrievalSufficiency` 接入主链路（复杂问句 → 分解 → 并行检索 → 充分性判定 → 最多 2 跳）；生成上下文改用 `fitEvidenceContext` 统一预算；修 token 统计（chunk 数→真实 token 估算）。
- **验收**：golden-dataset 跨文档综合/多跳类目通过率提升；trace 中出现 decompose/hop 节点。
- **工作量**：4 人日。

#### OPT-7 会话安全升级
- **方案**：token 增加 `jti` + Redis 吊销名单（禁用用户/改密/登出即时失效）；登录限流从 IP 级升级账号级锁定；OpenAPI 凭证升级 scoped 模型（借鉴 WeKnora：能力级授权 + per-KB 限制 + 限流）。
- **验收**：禁用用户 60s 内既有会话全失效；凭证最小权限演示通过。
- **工作量**：4 人日。

#### OPT-8 审计体系落地
- **方案**：AuditService 接线到登录/上传/删除/查询/OpenAPI/权限变更六类事件（异步批量写）；增加审计员只读角色查询端点；admin 聚合视图与 AuditLog 合并。
- **验收**：六类事件各产生一条审计记录含操作者/对象/结果/IP；越权尝试（403）入审计。
- **工作量**：3 人日。

#### OPT-9 队列与解析可观测看板
- **方案**：BullMQ 队列深度/失败率/处理时长暴露为 `/metrics`（prom-client）；parser-worker 解析阶段 trace（对齐 WeKnora v0.6.1 解析时间线：接收→引擎选择→解析→质检→返回，随文档详情返回并前端展示）；接入 Langfuse（编译与查询两链路 gen）。
- **验收**：Grafana（或简化为 admin 状态页）可见队列积压与失败任务重试入口；单文档解析 5+ 阶段进度可视化。
- **工作量**：4 人日。

#### OPT-10 巨石拆分（chat.service / admin.controller / page.tsx）
- **方案**：
  - `chat.service.ts` 按阶段拆为 `query-rewrite / retrieval / evidence-gate / generation / citation` 五个协作服务（保持对外接口不变，spec 同步搬迁）；
  - `admin.controller.ts` 拆 org/user/role/kb/grant/model 六控制器；
  - 前端 `page.tsx` 按 6 屏拆分目录 `screens/*` + 共享 `lib/api-client`（一次性机械拆分，不做重构）。
- **验收**：单文件 ≤800 行；拆分前后单测与 E2E 全绿。
- **工作量**：6 人日。

#### OPT-11 大文件内存与解析健壮性
- **方案**：上传落盘后流式读取（`createReadStream` + 累积哈希）替代 `readFile` 全量；PDF 增加页数上限（默认 1500 页，可配）预拒；VLM 富化改为提取媒体文件真实路径（docx/pptx 解包 `word/media/*`）；统一 `UPLOAD_ROOT` 变量并加启动一致性断言。
- **验收**：200MiB 文件上传解析期间 Node RSS 增幅 <150MB；双变量漂移在启动日志告警。
- **工作量**：3 人日。

#### OPT-12 部署配置收敛
- **方案**：合并双 env 模板为单一 `production.env.example`（旧名 alias 注释）；修正 native nginx 端口；`.env.example` 与 systemd/compose 三方一致化校验脚本（`deploy/validate-env.sh`，比对键集合）。
- **验收**：`validate-env.sh` 通过；文档与实际端口一致。
- **工作量**：1 人日。

### P2 —— 竞争力扩展（3-6 月，按优先级）

| 编号 | 项 | 要点 | 工作量 |
|---|---|---|---|
| OPT-13 | **MCP Server + CLI** | OpenAPI 之上发布 MCP 工具面（search/ask/read_document/list_kbs），先于方案 P2 提前——WeKnora 29 工具已被生态消费验证 | 5 人日 |
| OPT-14 | **数据源连接器框架** | 先做 Git 仓库（Gitea webhook 已有基础）+ 飞书 wiki + RSS 三连接器；增量同步复用 version 围栏机制 | 10 人日 |
| OPT-15 | **Chunk 级人工干预** | 知识切片 Tab 增加"编辑重索引"（写回 canonical content.md + 自动重编译，Git 版本天然支持回滚） | 4 人日 |
| OPT-16 | **时序冲突裁决** | 文档生效日期/效力等级元数据 + 检索后冲突检测算子（蓝图 OPT-3 落地） | 6 人日 |
| OPT-17 | **RAPTOR 双螺旋索引** | 章节聚类摘要层（Layer1）+ 全文综述层（Layer2），宏观问题走摘要层 | 8 人日 |
| OPT-18 | **PDF 像素级溯源** | chunk 保留 pageNo/坐标框，前端 PDF.js 双屏对照高亮（蓝图 OPT-5） | 6 人日 |
| OPT-19 | **K8s/Helm 与多副本** | GBrain 配额 Redis 化、parser 无状态化、Helm chart（对齐 WeKnora/helm） | 10 人日 |
| OPT-20 | **HNSW 与检索性能** | pgvector HNSW 索引 + 检索 P95 压测（目标 <800ms 达标验证） | 3 人日 |

### 实施路线图

```
第 1-2 周   P0 全部（OPT-1~5）              → 发布门禁恢复绿色，评测基线重测
第 3-6 周   OPT-6/7/8/12                    → 安全与审计达标，检索质量第二轮评测
第 7-10 周  OPT-9/10/11                     → 可观测看板 + 债务清偿（拆分）
第 11 周起  P2 按业务优先级排序投入           → 生态扩展（MCP→连接器→Chunk 干预→...）
```

### 度量与门禁（优化后应达成的量化指标）

| 指标 | 当前 | 目标 | 度量方式 |
|---|---|---|---|
| golden-dataset 通过率 | 38%（50 题 19 过） | ≥80%（门禁阈值） | tests/evaluation/quality-gate.ts |
| 单元测试 | 114/115 | 115/115 且行覆盖 ≥60%（核心模块） | jest --coverage |
| 负例摄入终态时延 | >30 分钟（队头阻塞） | ≤30s | 队列压测 |
| 权限撤销可见性 | 依赖 15min reconcile | 撤销事件驱动 ≤60s | PM 用例集 |
| 数据库 RPO | ∞（无备份） | ≤24h | 备份日志+恢复演练 |
| 检索 P95 | 未测 | <800ms（方案 §10） | 压测脚本 |

---

## 五、结语

本项目在**编译式知识范式、权限纵深、条款级语义处理**三个维度上已建立开源社区罕见的领先性，架构决策（Source 内容寻址、outbox、双 epoch、三层 ACL）经源码与实测双重验证是诚实且落地的。当前的主要矛盾是**"先进的架构"与"未达标的质量门禁/工程债务"之间的落差**——P0 五项（合计约 8.5 人日）完成后即可恢复可发布状态；对 WeKnora 的正确姿势是吸收其任务治理/连接器/MCP 生态的工程化经验，而非在平台广度上正面追赶。

> 本文档基于 2026-09-08 代码库（HEAD）与同日系统实测编写；对标数据来源：WeKnora GitHub/CHANGELOG v0.5.0-v0.8.0、本项目 `docs/industry-rag-benchmark-*.md` 及本次独立核实。
