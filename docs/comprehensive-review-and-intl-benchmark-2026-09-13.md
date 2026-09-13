# GBrainKG 综合代码审查 + 国际基准测评报告(2026-09-13)

- 代码基线:`main@69a0cf7` + 工作区修改(见 §2.3,含本轮发现并修复的入库 415 bug)
- 方法:三路并行代码审计(入库 / 查询 / 权限与评测,file:line 级证据)+ 全量单测复跑 + 国际公开数据集端到端实测(HotpotQA / 2WikiMultiHopQA / MuSiQue)+ 同条件闭卷基线
- 重要前置参考:`docs/rag-core-assessment-and-implementation-plan-2026-09-12.md`(B 报告)、`docs/optimization-plan-fused-2026-09-12.md`(融合方案)
- 测评脚本与原始结果:`tests/evaluation/intl-benchmark/`(可复现,seed=42)

---

## 1. 结论(TL;DR)

1. **功能与工程真实性**:此前(2026-09-12)评估列出的 P0 缺口——embedding 400 上限截断、enrichment 无覆盖校验、版本竞态、角标即 grounded、评测 judge 无证据正文——**经本轮逐项代码核查确认已真实修复**,非占位。commit cb0f050 声称的"BM25 / CRAG / aclEpoch / 审计 / 限流"均有真实代码落地,但其中两项与表述存在程度差异:词法 BM25 是**候选池内近似 BM25**(召回仍是 contains,BM25 只做池内重排),aclEpoch 接线**仅覆盖 user 级权限事件**(KB 级变更不 bump,`bumpScopeEpoch` 仍为死代码)。
2. **国际基准实测**(n=100×3,seed=42,共享去重语料,端到端 SSE):单跳/第一跳检索接近满贯(HotpotQA recall@5=0.99、2Wiki recall@2=1.0、MuSiQue recall@5=0.95),HotpotQA 端到端 judge 准确率 **0.77**(闭卷基线 0.485,+28.5pp,零观察性编造);但 2Wiki(0.24,低于闭卷 0.35)与 MuSiQue(0.29)暴露**多跳证据组装缺陷**:第二跳证据进不了上下文、充分性判断过严导致 56-72% 拒答。三套题均未观察到幻觉性编造(错误模式是拒答或部分合成错误,不是无中生有)。
3. **SOTA 判定**:**不能认定为国际 SOTA**(严格口径见 §6)。定位是:企业级权限知识库 RAG 的**工程完成度达到业内先进(第一梯队腰部)**,技术广度覆盖 2025-2026 主流高级 RAG 方法(Contextual Retrieval / RAPTOR / GraphRAG / CRAG / MMR / 混合检索 / 多跳 agentic),但在**检索数学层、评测证据链、规模与性能计量、生态成熟度**四个方面与 SOTA 存在明确差距。
4. 本轮新发现 ~20 个问题(§4),其中评测侧两项需要重视:最近一次 golden 回归的 nDCG=2.662 为无效值(修复前 DCG 堆叠 bug 产物),faithfulness=0.256 按门禁应判 FAIL;`recall@5 == recall@10` 在 220/220 行完全相等,排名指标口径存疑。

---

## 2. 实现方案全景与真实性核查

### 2.1 入库管道 —— 【真实、完整,策略层有残留缺陷】

链路:上传/文本 → BullMQ → 解析分级路由(native pypdf 快路 → 百度 OCR/Docling → VLM,未配置时诚实降级标记质检而非伪造)→ 内容质量评估 → 结构化分块(1800/200,条款结构、跨页表头继承、中文数字解析)→ Contextual Retrieval(真 LLM,预算采样+滑窗)→ 版本围栏事务写块 → 发布 coreReady 门控 → enrichment(embedding 64/批游标续跑 + 覆盖率校验 → RAPTOR 向量摘要树 → GraphRAG 可选)。

已核实的关键修复:
- embedding 分批续跑与三道闸(enrichment 闸/发布闸/长窗口重试):`chunk-embedding.service.ts:43-87`、`enrichment.processor.ts:58-101`、`brain-compiler.processor.ts:78-90`
- 版本 CAS 双重围栏(队列幂等 jobId + 事务内重读):`ingestion.service.ts:107,329-384`
- RAPTOR 摘要节点向量入 pgvector(HNSW,余弦召回,缺失自愈 backfill):`raptor.service.ts:851-969`、迁移 `20260912120000_add_summary_node_embeddings`

残留缺陷(本轮新发现):**enrichment 版本只查一次**,长跑中途 re-ingest 后旧任务可给新版本误发 ready(N1);**崩溃后 enrichment 任务可能永久丢失**,文档卡死 indexing(N2);contextual 前缀直接拼进 `Chunk.content`,污染检索表示与证据文本(rawText/searchText 未分离);RAPTOR 摘要层仍有三处截断(每窗 6 簇、簇 6000 字、全景 12000 字);GraphRAG 抽取只取头部 50 块;质量门禁未拦截付费富化(needs_review 文档先烧完最多 300 次 LLM 再送审)。

### 2.2 查询管道 —— 【防御纵深真实,两处声称有程度差异】

链路:权限解析 → 可见集指纹+双 epoch 语义缓存(命中前实时 ACL 复核)→ 指代消解/复杂度规划(简单问零 LLM)→ 并发召回(pgvector HNSW + contains/BM25 池 + RAPTOR 向量摘要臂 + GBrain CLI 2500ms 竞速)→ 跨源 RRF → 交叉编码重排(bge-reranker-v2-m3)→ 组级 MMR + token 预算 → 时效/版本裁决 → 流式生成逐句 strict 门控 + NLI 兜底 → 零候选 CRAG 改写 → 诚实拒答。

核查结论:
- **证据核验门控(P0-C)真实修复**:"角标即 grounded"已废,数字字面比对 + 字符重叠(0.5/0.7)+ 流式按句缓冲暂扣 + NLI 蕴含,不支持的句子直接丢弃,覆盖率 <0.8 不入缓存。`chat.service.ts:4242-4253,3131-3257,4344-4351`
- **BM25 为池内近似**:真实 Okapi 公式(k1=1.2,b=0.75,`lexical-bm25.ts:57-72`),但 Postgres 侧无 tsvector/BM25 索引(中文分词缺失是删除 tsv 的官方理由),召回仍是 15 词上限的逐词 contains;BM25 只在拉回的池上重排。文件头注释自认"Pool-level IDF is an approximation"。**与"实现 BM25"的表述有程度差异**;且 `lexical-bm25.ts` 无单测,存在关键词长度重复计入文档长度的偏置(:37-42)。
- **CRAG 纠错真实但窄**:仅在"完全零候选"分支触发 LLM 改写(≤2 措辞);证据弱但非空时只走单次广覆盖扩检。`chat.service.ts:2371-2399,4045-4083`
- **aclEpoch 部分接线**:user 级 perm_grant/revoke/org_change/role_change 会 bump(`brain-compiler.processor.ts:134-141`);KB 级授权变更不 bump,`bumpScopeEpoch` 全仓 0 调用者,安全实际靠可见集指纹变化 + 命中后实时复核兜底。
- 查询瘦身真实:简单问句默认零扩词、全新回合无指代跳过 LLM 改写、缓存先于 embedding;但 EmbeddingService 只有结果缓存,**无 in-flight 去重**(并发同问仍重复打 API)。
- 限流/审计真实:open-api 凭证级滑窗 429 + 全局 600/min;AuditService 有 9+ 真实写入点。**均为进程内实现,多副本下失效/配额翻倍**。
- 否定语义不设防:"不得高于 800 米"改写为"不得低于 800 米"带真实角标时,数字字面+字符重叠均匹配,确定性放行且不触发 NLI(P1)。
- 语义缓存键缺 modelName,跨模型相似问可能串答;调试日志 `[D1DBG]` 遗留在检索主路径。

### 2.3 权限/多租户 —— 【三层防线成立,治理模型缺最后一步】

个人/组织(向上继承)/行业(三类主体+过期自动失效)三库模型真实;越权 scope 请求统一 403;候选入口统一授权过滤(SQL 预过滤 + contains 全部带 published,本轮确认);引用级独立复查;图谱/缓存按可见库构建。AdminGuard 全覆盖,open-api 凭证真验签。

缺口:文档"下架"无 API(`lifecycleStatus` 只读不写,唯一出口是物理删除);KB 归档不清图谱实体(读取侧过滤兜底,数据残留);open-api 凭证无独立 scope(凭证=用户全量身份);外部对话端点缺越权断言(静默收窄,语义与内部 API 不一致)。

### 2.4 评测体系 —— 【harness 已修但**最近一次结果不可信**】

`test_retrieval_quality.py` 已改为用 `/chat/search` 真实排名算 Recall/MRR/nDCG(含同文档去重),API 异常计零分;TS 侧 judge 已收证据正文。但是:
- `golden-set-regression-2026-09-12.json`(runId 0be72497,commit 976753a):**nDCG=2.662(无效值,修复前 DCG 堆叠 bug 产物)、faithfulness=0.256、api_failure_count=1**——按现行 `quality_gate.py` 该文件应判 FAIL,文件名"regression"具有误导性;
- `ranking-ndcg-corrected-2026-09-12.json`:nDCG@10=0.673、recall@5/10=0.693,但**无 runId/commit 溯源**,且 recall@5 与 recall@10 在 220/220 行完全相等(排名信号异常,需核查);
- no_answer 用例排名指标空真值计 1.0(30/220 例),系统性抬高均值。

### 2.5 测试基线

本轮实测:`pnpm --filter api exec jest --runInBand` → **30 套件 / 227 用例全绿**(含本轮新增回归测试)。上一轮"4 套编译失败"的问题已消除。

---

## 3. 与 2026-09-12 两份评估的对照(修复验证矩阵)

| 9-12 报告的指控 | 本轮裁决 | 证据 |
|---|---|---|
| P0 embedding 400 上限截断 | ✅ 真实修复(游标分批续跑+覆盖率门控) | `chunk-embedding.service.ts:43-87` |
| P0 enrichment 不校验覆盖率置 ready | ✅ 真实修复(missing>0 即 throw→degraded 重试) | `enrichment.processor.ts:58-67` |
| P0 版本竞态(按 documentId 全删) | ✅ 以"围栏"方案修复(设计取舍,注释明示);残留 N1 竞态窗口 | `ingestion.service.ts:321-341` |
| P0 角标即 grounded | ✅ 真实修复(确定性比对+NLI+strict 缓冲) | `chat.service.ts:4242-4253` |
| P0 评测 judge 无证据正文 | ✅ 真实修复(TS 侧);Python 侧仍为 snippet 代理 | `quality-gate.ts:170-207` |
| P1 contains 无 published 过滤 | ✅ 已全部补齐 | `chat.service.ts:1019,1107,1153,1328` |
| P1 简单题扩词/重复 embedding | ✅ 默认关闭 + 共享缓存(无 in-flight 去重) | `agentic-rag.service.ts:386-394` |
| P2 late-chunking 死代码 | ⚠️ 未删未接 | `late-chunking.ts` |
| P2 GraphRAG BFS 社区 | ⚠️ 未变(BFS+模板摘要) | `graph-rag.service.ts:562` |
| 审计声称 BM25 落地 | ⚠️ 池内近似,非引擎级 | `lexical-bm25.ts` |
| 审计声称 aclEpoch 接线 | ⚠️ 仅 user 级,KB 级不 bump | `brain-compiler.processor.ts:134-141` |

---

## 4. 本轮新发现问题清单(此前审计未覆盖)

**P1(建议尽快处理)**
1. 陈旧 enrichment 任务可给新版本误发 ready(版本只在 job 开头校验;发布闸信任 ready 跳过覆盖率核查)— `enrichment.processor.ts:44-109`、`brain-compiler.processor.ts:404`
2. 进程崩溃后 enrichment 任务可能永久丢失(启动恢复不补投),文档卡死 indexing — `ingestion.service.ts:72-86`
3. 否定翻转绕过证据门控(数字字面比对无极性/否定校验,且不进 NLI)— `chat.service.ts:55-79`
4. rawText/searchText 未分离:contextual 前缀拼进 `Chunk.content`,污染 BM25 索引与证据文本 — `contextual-retrieval.ts:229-232`
5. KB 级权限变更不 bump aclEpoch + `bumpScopeEpoch` 死代码 — `brain-scope.service.ts:135-145`
6. EmbeddingService 无 in-flight 去重;语义缓存键缺 modelName — `embedding.service.ts:61-105`、`semantic-cache.service.ts:82-92`
7. **标题含句点的文档入库必失败(本轮已修复)**:`extname(title)` 假后缀(如 "Mrs. Washington" → ". washington")被 parser-worker 415 拒绝;修复为按存储文件真实扩展名路由 + parser 文件名白名单化(`ingestion.service.ts:154,213-224`),新增回归测试,30 套件 227 用例全绿
8. golden 回归结果文件不可信(nDCG 无效/faithfulness 0.25/无溯源文件混放),门禁红线形同虚设 — `tests/evaluation/results/*`
9. 限流/语义缓存/限流器均为进程内实现,多副本部署语义错误

**P2**
10. RAPTOR 摘要层三处截断(每窗 6 簇/6000 字/全景 12000 字),长文档"全景"仍可能缺尾部 — `raptor.service.ts:111-130,553,747`
11. GraphRAG 抽取只取头部 50 块 — `enrichment.processor.ts:120`
12. 质量门禁不拦截付费富化(needs_review 先烧 300 次 LLM 再送审);富化重试重复付费无中间缓存
13. 暂扣句超 6 条静默丢弃且统计失真 — `chat.service.ts:3240`
14. Chunk 表 contains 无 trigram 索引,规模化后为检索延迟瓶颈;词法通道 15 词上限仍在
15. 文档"下架"无 API(lifecycle 只读);KB 归档不清图谱;图谱 reindex 只增不删
16. VLM 富化对每个占位符重复描述整个源文件(把 PDF 字节当图片)— `vlm_extractor.py:234-243`
17. open-api 凭证无 scope;外部端点无越权断言(静默收窄)
18. CI 门禁阈值不一致(0.80/0.85 vs 0.90/0.85),quality-gate.yml 疑似不可用配置;TS faithfulness 门禁在无 judge 时名不副实
19. 上传不写时间态字段,同名重传无新旧替代语义
20. `lexical-bm25.ts` 零单测;关键词长度双计偏置 — `lexical-bm25.ts:37-42`

---

## 5. 国际公开基准实测(2026-09-13)

### 5.1 设定

- 数据集:HotpotQA dev(distractor)100 题、2WikiMultiHopQA dev 100 题、MuSiQue(ans,v1.0)dev 100 题,seed=42 固定抽样
- 语料:每题的全部 context 段落(MuSiQue 为金标+7 干扰)合并去重为共享库(1000/770/830 段),模拟开放域检索而非逐题 10 选 2;金标覆盖率 100%
- 链路:全部题目经系统公开 API 真实端到端(检索排名走 `/chat/search` limit=50;问答走 `/chat/completions` SSE)
- 模型:embedding BAAI/bge-m3(1024d)、rerank BAAI/bge-reranker-v2-m3、生成 mygpt/gpt-5-6(系统默认)
- 指标:检索 Recall@2/5/10、Full-Evidence(全部金标命中)、MRR@10、nDCG@10;问答 EM、token-F1(SQuAD/HotpotQA 官方口径)、Containment、引用命中率、拒答率、TTFT
- 基线:闭卷 LLM(无检索,deepseek-chat 直答同题)

### 5.2 结果

**检索排名**(`/chat/search`,limit=50,共享语料 2.6k 段):

| 数据集 | Recall@2 | Recall@5 | Recall@10 | Full-Evidence | MRR@10 | nDCG@10 |
|---|---|---|---|---|---|---|
| HotpotQA(2跳,85% bridge) | 0.84 | 0.99 | 1.00 | **0.97** | 0.849 | 0.779 |
| 2WikiMultiHopQA(2跳组合) | 1.00 | 1.00 | 1.00 | **0.54** | 0.995 | 0.728 |
| MuSiQue(2-4跳) | 0.87 | 0.95 | 0.98 | **0.69** | 0.868 | 0.647 |

**端到端问答**(SSE 真实链路,n=100/集,生成=deepseek-chat,TTFT 均值 6.2-6.8s):

| 数据集 | EM | token-F1 | Containment | 引用命中 | 拒答率 | **LLM-judge 准确率**(correct/partial/incorrect/refusal) | 闭卷 judge 准确率 | RAG 增益 |
|---|---|---|---|---|---|---|---|---|
| HotpotQA | 0.00 | 0.090 | 0.70 | 0.97 | 0.17 | **0.77**(77/0/7/16) | 0.485 | **+28.5pp** |
| 2WikiMultiHopQA | 0.00 | 0.086 | 0.42 | 1.00 | 0.68 | **0.24**(23/2/3/72) | 0.35 | **−11pp** |
| MuSiQue | 0.00 | 0.045 | 0.25 | 0.99 | 0.57 | **0.29**(26/6/12/56) | 0.18 | +11pp |

**跨数据集结论**:①第一跳检索三套全接近满贯,但完整证据召回(0.97/0.54/0.69)与端到端准确率(0.77/0.24/0.29)断崖式下跌——**缺口的根因一致:多跳证据组装**。2wiki 聊天引用同时含两跳金标的仅 20/100;musique 仅 18/100;②musique 按 2/3/4 跳分层的 judge 准确率几乎持平(0.30/0.27/0.30),证明瓶颈是"缺一跳证据即拒答"而非跳数累积;③2wiki 上 RAG 反而比闭卷差 11pp:对该题型,系统的过度保守使检索组件成为负资产——这是比"分数低"更重要的产品信号;④EM 全 0 与 F1<0.1 是短金标 vs 长解释句的口径现象(Containment 0.70/0.42/0.25 与 judge 更代表真实答对率)。

**错误归因**(逐题人工核查 judge 标签):
1. **HotpotQA 的 16 个拒答 100% 是"已引用到金标文档仍拒答"**——充分性校验对多跳合成过严,是最大的准确率泄漏点(16pp);
2. **2wiki 的失败模式是"第二跳缺失"**:聊天引用同时含两跳金标文档的仅 20/100,80 题只引到第一跳;其中 18 题在 /chat/search 排名里其实两跳都在前 10(说明是聊天管道的证据选择/探针没有把第二跳带进上下文,而非检索器能力不足)。根因:系统的多跳是"一轮改写/扩检",缺少 IRCoT/ReAct 式"读到桥接实体→以其为新查询→再检索"的迭代闭环(CRAG 改写只在零候选时触发);
3. 7 个 HotpotQA 错答中 5 个为有证据合成错误(典型桥接错误:把中间人名当答案);
4. 英文题偶发中文作答(系统提示词为中文),影响 EM/F1 与可读性,不影响 judge 判定。

### 5.3 与公开参照对比

| 系统(口径) | HotpotQA F1 | 2Wiki F1 | MuSiQue F1 |
|---|---|---|---|
| 本系统(共享语料 2.6k 段,deepseek-chat 生成) | 0.090(judge 准确率 0.77) | 0.086(judge 0.24) | 0.045(judge 0.29) |
| 闭卷 LLM(deepseek-chat,无检索,同题) | 0.456(judge 0.485) | 0.340(judge 0.35) | 0.162(judge 0.18) |
| IRCoT(GPT-3,开放域全 Wikipedia 检索) | 60.7(judge 口径无) | 68.0 | 36.5 |
| OneR 单次检索(GPT-3,开放域) | 53.6 | 54.8 | 29.4 |
| 2Wiki 原论文基线(distractor,给定 10 段) | — | ~36.5 | — |
| MuSiQue 原论文基线(ans) | — | — | ~20-30 |

**口径警告**:①IRCoT/OneR 为开放域全 Wikipedia 检索(检索更难、语料更大),本测试为 2.6k 段共享语料;②闭卷基线与系统生成同为 deepseek-chat,judge 增益对比同条件;③F1 与 judge 准确率不可互换,表中 F1 仅为官方口径呈现。以上数字只能判断量级,不能逐点比较。

---

## 6. SOTA 判定(条件化)

沿用 9-12 评估的原则:**SOTA 必须限定任务、数据、模型、资源及指标,并经同条件比较**。按四个维度分别判定:

| 维度 | 判定 | 依据 |
|---|---|---|
| 功能广度 / 工程真实性 | **业内先进(第一梯队腰部)** | Contextual Retrieval、RAPTOR(向量化)、GraphRAG(局部)、CRAG、混合检索+交叉编码重排+MMR、多跳 agentic、语义缓存+ACL 复核、三层权限防线全部真实落地;30 套件 227 用例全绿;本轮审计未再发现"占位式虚假实现"(除已注明的程度差异) |
| 检索质量 | **达到可用工业线,未达 SOTA** | 单跳/桥接第一跳检索接近满贯(hotpot recall@5=0.99、2wiki recall@2=1.0);但完整证据召回是短板(2wiki 0.54),且真实多跳的"读-再检索"迭代缺失——与 IRCoT/ReAct 类系统在多跳任务上的已发表行为存在代差 |
| 生成正确性 | **中文垂直域可信,英文多跳未达 SOTA** | HotpotQA judge 准确率 0.77(其中拒答吃掉 16pp;错误仅 7%,零观察性幻觉);CMRC 2018 中文域此前实测 98.9% 检索命中。SOTA 系统在 HotpotQA 上 distractor 口径 F1>90、开放域 agent 类 judge 准确率普遍>80%,本系统 2wiki/多跳域明显落后 |
| 评测证据链 | **不达 SOTA 要求** | 业务集 220 题规模偏小且最近一次回归结果无效(nDCG>1);公开轨(本轮)首次建立,但 judge 校准、统计置信区间、成本/延迟计量均未制度化 |

**总判定:不能认定达到国际 SOTA。** 准确表述是:**面向中文企业知识库的权限型 RAG 系统,工程完成度与功能广度达到业内先进水平(与 WeKnora/RAGFlow 同档,具备多数高级 RAG 能力的真实实现);在英文公开多跳基准上,单跳检索达到一线水平,但多跳迭代检索与过度拒答两大缺陷使端到端准确率显著低于该任务上的已发表系统;距离 SOTA 的差距是可定位、可修复的(见 §8),而非架构性落后。**

## 7. 与业内主流项目对比

### 7.1 产品/框架横向对比

| 维度 | **GBrainKG(本项目)** | RAGFlow | WeKnora(腾讯) | Dify | MS GraphRAG / LightRAG |
|---|---|---|---|---|---|
| 定位 | 权限型企业知识库 RAG(自研一体化) | 深度文档理解 RAG 引擎 | 企业知识中台 | LLMOps 平台(RAG 为一环) | 研究性图 RAG |
| 文档解析 | pypdf 快路+百度OCR+Docling+VLM 路由(未配置诚实降级) | **最强**:DeepDoc 版面/表格解析 | 企业级解析+多模态 | 基础+生态插件 | 无产品级解析 |
| 分块 | 结构分块+条款工程+跨页表头继承+Contextual Retrieval | 模板化分块(丰富) | 混合 | 基础分块 | 固定 |
| 检索 | 向量+池内BM25+RRF+重排+MMR+多跳;**缺引擎级BM25/中文分词** | 混合+重排 | 混合+GraphRAG | 混合+重排 | 图局部/全局 |
| 高级能力 | RAPTOR+GraphRAG+CRAG+语义缓存+时效裁决 | agentic 编排(v0.8+) | MCP/IM/Wiki | 工作流/插件市场 | 层次社区摘要(Leiden) |
| 权限/多租户 | **最强档**:个人/组织/行业三库+继承+时效+审计+缓存复核 | 弱(团队可见性已知问题) | 强(多租户+IM) | 开源基础版弱,企业版付费 | 无 |
| 证据可信度 | 句级核验门控+NLI+拒答+引用到页/bbox | 引用 | 引用 | 引用 | 引用 |
| 评测 | 黄金集+公开基准(本轮建立),弱制度化 | 无公开 | 无公开 | 无公开 | 论文评测 |
| 生产化 | 单机 systemd 部署,Docker 组件;多副本有状态缺陷 | 成熟 Docker/Helm | 成熟 | 成熟/巨大装机 | 非产品 |

结论:**没有单点全面领先**。本项目的差异化优势在权限模型纵深、证据核验门控、版本/时效治理——这三项恰好是 RAGFlow/Dify 开源版的短板;劣势在解析器生态(RAGFlow 的版面解析)、检索基础设施(引擎级 BM25/中文分词)、生态成熟度与规模化验证。

### 7.2 与研究前沿的方法层差距

2025-2026 公开 SOTA 普遍采用而本项目缺失:①**迭代式检索增强生成**(IRCoT/ReAct/Self-Ask 式"读-再检索",多跳任务的决定性能力);②**引擎级词法检索**(OpenSearch/ES BM25+中文分词,当前为池内近似);③**late-interaction**(ColBERT/ColPali 类);④**学习型查询路由**(当前为启发式);⑤**Leiden 层次社区**(当前 BFS);⑥视觉多向量索引(图表页)。已对齐的:Contextual Retrieval(Anthropic)、RAPTOR、CRAG 式纠错(窄)、语义缓存、混合检索+重排+RRF、MMR。

## 8. 优化建议(按投入产出排序)

**第一优先:修复多跳"读-再检索"闭环(直接对症 2wiki/多跳域 −40pp 的缺口)**
1. 把 agentic 多跳从"一轮扩检"升级为受预算约束的迭代循环:每轮从已选证据抽取未覆盖实体/关系生成 follow-up 查询(先查询库内精确标题/别名,再向量召回),直到充分性达标或预算耗尽;CRAG 改写触发条件从"零候选"放宽到"充分性不足"。
2. 证据选择保留"覆盖优先":按子问题/实体覆盖分配配额(已有机制),增加"每跳至少一篇"约束,避免 MMR/重排把第二跳挤出。
预期:2wiki judge 准确率 0.24→0.55+(第二跳 80 题缺失中,18 题检索器本已召回),是单项收益最大的改动。

**第二优先:治理过度拒答(HotpotQA 直接 +16pp)**
3. 充分性/核验分层:多跳合成题的拒答阈值与单跳事实题分开;已有两跳证据时,先触发补检循环(第 1 条)再考虑拒答;拒答前给一次"基于现有证据给出最佳已知部分+明示缺口"的降级回答(可配置)。
4. 否定/极性比对加入确定性核验(同时修复 §4-3 的绕过缺陷)。

**第三优先:检索基础设施(规模化前必须)**
5. 词法通道落地引擎级 BM25:按 9-12 融合方案两步走(先 trigram+published 修 contains,后 OpenSearch/中文分词),消融门禁切换;移除 15 词上限。
6. rawText/searchText 分离,contextual 前缀只进检索表示。
7. EmbeddingService in-flight 去重;语义缓存键补模型版本;限流/缓存迁 Redis 以支持多副本。

**第四优先:评测制度化(让"是否 SOTA"从此可度量化回答)**
8. 把本轮 intl-benchmark 纳入回归(seed=42 可复现):检索排名+nDCG+judge 准确率三线,阈值建议 HotpotQA judge≥0.85、2wiki full-evidence≥0.75;判定模型与生成模型解耦(用更强 judge 或人工抽检 50 题校准)。
9. 修复 golden 集门禁:重跑并作废 nDCG>1 的历史结果;recall@5==recall@10 异常核查;no_answer 空真值不计入排名均值。
10. 按 9-12 §5 公式接入成本/延迟计量,补齐 p95/单位有效回答成本。

**第五优先:按坏例投资(P2,单项消融通过才上)**
11. Leiden 层次社区+LLM 社区摘要(替换 BFS);12. 视觉多向量(先统计图表失败占比);13. late-chunking 决策(删或实验);14. 学习型路由(以查询日志训练)。

**工程修缮**(P1 清单见 §4,建议两周内):N1 enrichment 版本围栏、N2 启动补投、415 修复提交、审计/限流多副本化、`[D1DBG]` 清理、lexical-bm25 单测。

## 9. 附:本轮变更与产物

- **代码修复(工作区,未提交)**:`apps/api/src/ingestion/ingestion.service.ts`(标题句点 415 入库 bug:ext 改取存储文件真实扩展名 + parser 文件名白名单兜底);`ingestion-version.spec.ts`/`ingestion-quality.spec.ts` 夹具对齐 + 新增 "Mrs. Washington" 回归测试(30 套件/227 用例全绿)
- **新增**:`tests/evaluation/intl-benchmark/`(prep_data.py / ingest_corpus.py / run_eval.py / judge_eval.py / closed_book_baseline.py + 语料、评测集、结果与判定 JSON,全部 seed=42 可复现)
- **新建知识库**:公开基准-HotpotQA-EN(1001 段)、公开基准-2WikiMultiHopQA-EN(770 段)、公开基准-MuSiQue-EN(830 段)
- **评测期间事故与应急**:
  - 发现并修复"标题含句点文档 100% 入库失败"产品 bug(见上);
  - 系统默认生成模型 mygpt/gpt-5-6 在评测期间持续 502 Bad Gateway(测评后复测仍故障,系统聊天处于不可用状态),因此**保留 DeepSeek/deepseek-chat 为默认 LLM**(新增的 ModelConfig 行,testStatus=passed)。**mygpt 恢复后如需切回**:`UPDATE "ModelConfig" SET "isDefault"=false WHERE kind='llm'; UPDATE "ModelConfig" SET "isDefault"=true WHERE "modelName"='gpt-5-6';`(本次全部问答指标均在 deepseek-chat 下测得,与闭卷基线同模型,恰为同条件对比)
  - 入库端 RAPTOR 摘要 LLM 多次超时走提取式兜底(DeepSeek 在并发入库负载下的稳定性值得单独关注)。
- **HotpotQA 库中存在 1 篇重复文档**(首轮脚本竞态),对标题级排名指标无影响,可忽略。
