# 核心业务流程 SOTA 评估报告

> 评估日期：2026-10-07 ｜ 对应版本：v50.0（349ce52）+ 文档治理（421c31d）
> 评估性质：基于源码逐行调研 + 实测数据（单元 1311 用例、全场景 E2E 25 场景、SOTA-20 国际基准）的综合评估
> 结论速览：**检索管道、摄入管道、查询编排防御深度、权限体系达到或超过业内主流开源方案；评测工程化业内领先；端到端多跳答案质量与编译深度存在已量化的差距（见 §4）。**

---

## 1. 评估方法

- **源码调研**：对 `apps/api/src` 19 个模块逐文件读源（关键路径标注 文件:行号），比对对象为业内主流开源 RAG 参考实现（RAGFlow、Dify、LlamaIndex/LangChain hybrid 检索、Microsoft GraphRAG、Weaviate/Qdrant hybrid 检索）与 2024-2025 学术前沿实践（late chunking、ColBERT MaxSim、Contextual Retrieval、CRAG、HyDE、Platt 校准）。
- **实测证据**：本报告所有"实测"数据均来自 2026-10-07 当日运行（附录 A 记录命令与产物路径），不引用历史未溯源数字。

## 2. 逐子系统对标

### 2.1 检索管道 —— **领先（通道广度与防御设计）/ 持平（融合算法）**

| 能力 | 本项目实现 | 业内主流 | 判定 |
|---|---|---|---|
| 召回通道 | 9+ 路并行：pgvector 稠密、Late-chunking ColBERT、子查询探针、全库精确 BM25（Okapi k1=1.2/b=0.75，`lexical-index-store.ts:617-770`）、BGE-M3 学习型稀疏、GraphRAG、4 类结构化通道（`retrieval-arms.ts:1284-2100`） | 典型 hybrid = dense+BM25+rerank 三件套 | **领先** |
| 融合 | RRF k=60 六通道加权 + 确定性结构 boost + tie-break 稳定排序（prompt 前缀缓存友好） | RRF/加权求和 | 持平 |
| 重排 | bge-reranker 两级级联（通道保底入池 `fusion-rerank.ts:129-162`）、probe-group 分组交叉编码（:428-478）、指代问句保护、Platt 校准（`evidence-calibration.ts`）、未打分候选保留契约 | 单级 cross-encoder | **领先** |
| 前沿实践 | Verified Late Chunking（provider 契约 `shared-context-pooling-v1`，拒绝伪实现）、Anthropic 式 Contextual Retrieval（`contextual-retrieval.ts`） | 2024-2025 论文级实践，开源产品少有落地 | **领先** |
| 防御性设计 | 分数来源契约（`score-contract.ts`：阈值只作用于实测分）、低分排除淘汰归因漏斗（`citation-assembly.ts:984-998`）、软地板开关 | 业内罕见 | **领先** |

### 2.2 摄入管道 —— **领先**

- 多格式解析矩阵（`parser-worker/src/main.py`）：md/txt/csv/html/doc/docx/pdf/xls/xlsx/pptx/png/jpg/jpeg，Docling 本地解析 + antiword + 百度 OCR + **VLM 视觉抽取**（qwen2-vl，图表/流程图逐页渲染描述）；PDF 按页覆盖率分级 text/mixed/scanned（`quality.py`）。
- 分块：1800/200 父子分块、标题面包屑继承、表格逐行 key-value 语义展开。
- BGE-M3 三重索引：dense + sparse posting + ColBERT multi-vector，指纹门控 + fail-open（`chunk-embedding.service.ts`）。
- 断点续跑的 EnrichmentStage 阶段表；GraphRAG 抽取（regex 全量 + LLM 采样 30%）→ Louvain 社区 → 层级摘要（`graph-rag.service.ts:578-660`、`louvain.ts`）。
- 对比：超过 RAGFlow/Dify/LlamaParse 的默认能力（页级质量分级、VLM 兜底、三重索引、不可变版本链）。

### 2.3 查询编排与反幻觉 —— **功能领先 / 工程结构落后**

- 全链路 trace 漏斗：`runtime_config → permission_scope → source_freshness → semantic_cache → query_rewrite → gbrain/weknora retrieval → rerank → evidence_selection → lazy_compile → crag_rewrite → llm_generation → grounding_gate`，前端对话页实时可视化（本次浏览器 E2E 已验证 ✓）。
- Agentic 规划（`agentic-rag.service.ts`）：四分类路由、子查询分解、HyDE、检索充分性评审、DB 召回与规划投机并行。
- 语义缓存三级（进程内 LRU → PG 精确 → pgvector ≥0.96），键烧入 aclEpoch/knowledgeEpoch/授权修订号，**回放前活体 ACL 重校验**（`chat.service.ts:2178-2200`）。
- 反幻觉机械（业内最重）：快拒答门（校准地板 0.35 / 合成分地板 0.999 构造性防作弊）、拒答原因二分、**流式逐句 LLM 蕴含复核 + 数值主张确定性否决**（`grounding-numeric.ts`）、拒答前聚焦重试。
- 结构债：`chat.service.ts` 单文件 307KB、20+ @Optional 依赖——回归风险高（详见 §4 薄弱点）。

### 2.4 编译式大脑 —— **概念领先 / 实现深度落后于自身概念**

- 真实实现：BrainRepo/BrainTopic（compileStatus dirty/clean）+ outbox 双租约消费 + 知识发布合并批（O(N) 化，`brain-compiler.service.ts:1056-1153`）+ Dream Cron（0 2 * * * 双层级）+ **懒编译**（查询命中 dirty 先整理再答，`chat.service.ts:4184-4190`，本次 E2E 验证 trace 节点存在）。
- 落差：`compileScopeDerived` 综合只读每文档前 10 chunk、≤3 source（`brain-scope.service.ts:175-290`）；CompileJob.truthDiff 无真实 diff；主题匹配靠 title contains。
- 对照：业内无直接同类物（最接近 GraphRAG community 预计算 + 缓存 epoch 失效）；机制工程成熟，但"Compiled Truth/Timeline 深度编译"仍是路线图而非现状。

### 2.5 权限体系 —— **领先**

- 应用层唯一鉴权（RLS 已移除，边界清单 `docs/RLS-BOUNDARIES.md` 维护）：个人库硬隔离、组织库祖先链可见、行业库三主体 ACL 带 **expiresAt 有效期**（`permission.service.ts:599-612`）、组织管理员明确"绝不外溢同级库"（:532-534）。
- 文档级 deny-by-default ACL（`document-acl.service.ts`），批量查询禁止 N+1。
- 缓存失效：进程内 TTL + 全入口 `invalidatePermissionCaches` + epoch 烧入缓存键；已知残余风险：多副本下 KB 列表缓存存在 TTL 级撤销窗口（5s，本次实测 `PERMISSION_CACHE_TTL_MS=5000`）。
- 本次浏览器 E2E 验证：行业库创建者/管理员只读全貌（组织树/用户树可见、操作关闭）、穿梭树选人（双栏+组织分组+半选+计数+按钮置灰）均已落地。

### 2.6 评测基建 —— **工程化领先 / 覆盖广度中等**

- 金标 220 例 9 类分布 + 企业 190 例 + 三大多跳各 100 题 + SOTA-20（本报告新增）。
- 门禁（`gate-thresholds.json`）：hit_rate≥0.90 / permission_rate=1.0 / no_hallucination≥0.95 / ANN recall≥0.98；GATE_STRICT=1 凭证缺失即失败；独立 LLM 蕴含评委 3 采样。
- 防退化：BEIR 管道 + baseline 配对 delta + 语料 SHA-256 manifest。
- 诚实性工程：明确标注"启发式数字不可外报为 Ragas/官方成绩"。

## 3. 实测结果（2026-10-07）

| 测试 | 结果 | 证据 |
|---|---|---|
| API 单元/契约（jest+pytest+node --test） | **1311 passed / 0 failed**（151 套件） | `pnpm test:all` EXIT=0 |
| SOTA 全场景 E2E（P0-P8，含检索/多源冲突/拒答/越权/注入/性能） | **25/25 全绿** | `tests/e2e/results/sota-suite-20261007-*.json`（最后一轮） |
| Web UI 浏览器 E2E（ZCode 内置浏览器） | **6/6 通过**：登录态、知识库 Tab 过滤、锚点问答（答案正确+引用面板+Truth/Timeline 溯源）、知识图谱（270 文档/2104 主题/19221 关系）、管理台组织树、行业库穿梭树 | 本报告 §附录 A |
| SOTA-20 国际数据集基准（每集 ≤100 篇知识） | 见《SOTA20-BENCHMARK-REPORT-2026-10-07.md》 | `tests/evaluation/intl-benchmark/results/sota20/` |
| 问答延迟 | P50≈42-47s / P95≈72s（受上游 LLM 网关制约） | E2E P8-01 |

## 4. SOTA 差距清单（按严重度排序，均有量化证据）

1. **端到端多跳答案质量**（历史实测：MuSiQue F1 0.104 / 2Wiki F1 0.164 / HotpotQA F1 0.197，full_evidence@10 0.37-0.39）——检索强（recall@10 0.70-0.95）但抽取/生成弱，公开 SOTA 系统在 MuSiQue F1 0.4-0.6 档。**这是与"答案 SOTA"最硬的差距。**
2. **`chat.service.ts` 307KB 上帝类**：20+ @Optional 依赖，任何改动回归面巨大（模块化已开始：fusion/citation-assembly/query-rewriter 已拆分，主编排未拆）。
3. **任务丢失后文档永久卡死 indexing**（本次实测发现）：服务重启丢失 BullMQ 任务后，文档滞留 `indexing` 且 `/retry` 仅接受 failed/review-held/stale 状态——无自动对账、无人工恢复路径（本次以 DB 置 failed 后重试解除）。**建议：启动时扫描超时 indexing 文档自动置 failed+重入队。**
4. **中文制度语料特化常量泄漏进通用检索**：结构 boost +0.8~+3.0、"第X条/章节"正则硬编码于 `retrieval-arms.ts`——跨语料泛化断崖（历史实测 NFCorpus recall@10 0.41 vs 其余 0.93-1.0；本次 SOTA-20 nfcorpus 分数可交叉验证）。
5. **无 reranker 校准文件时拒答门实质退化**：合成分地板 0.999 使未校准部署的拒答退化为"有无证据"。
6. **ANN 召回未达自家门禁**：100k chunk 规模 ef_search=40 实测 0.9533 < 门禁 0.98（可调参修复）。
7. **编译深度不足**（§2.4）：编译产物为浅层摘要，非完整 Compiled Truth/Timeline 体系。
8. **GraphRAG 抽取规则化**：regex 词典为主、LLM 仅采样 ≤20 块，弱于 Microsoft GraphRAG 全量抽取+社区向量索引。
9. **确定性路径 5000 chunk 硬顶**：table_count/outline 精确路径超限即放弃。
10. **多副本权限缓存撤销窗口**：TTL 5s（单机部署无影响；水平扩展需失效广播）。
11. **登录限流 10/min 与测试编排冲突**：E2E 编排必须单次登录复用 token（本次已实测触发 429）；建议提供测试环境限流白名单。
12. **评测样本规模**：金标绝对量（220+190+20×≤100）中等；无官方 leaderboard 对标成绩。

## 5. 结论

- **架构 SOTA 达成度：约 80%**。混合检索通道广度、摄入解析矩阵、反幻觉防御深度、权限细粒度与有效期授权、评测门禁工程化——五项达到或超过业内主流开源方案；其中分数契约、淘汰归因漏斗、verified late chunking、缓存键烧入授权修订号等设计在开源产品中罕见。
- **结果 SOTA 达成度：检索层接近，答案层未达**。检索指标（单跳 recall@10 普遍 ≥0.87）达到主流 rerank 系统水准；多跳端到端 F1 与拒答校准是明确的下一个 SOTA 攻坚点。
- **判定**：以"企业知识库平台"业态衡量，核心业务流程**已处于开源方案第一梯队**；以"公开基准 leaderboard SOTA"衡量，答案生成层尚有已量化差距（§4.1）。

---

## 附录 A：本次实测命令与产物

| 项 | 命令 | 产物 |
|---|---|---|
| 单元/契约 | `pnpm test:all` | `/tmp` 终端日志（EXIT=0，1311 passed） |
| 全场景 E2E | `LLMWIKI_USER=admin pnpm test:kb` | `tests/e2e/results/sota-suite-20261007-*.json` |
| 锚点语料 | `python3 tests/e2e/bootstrap_anchor_corpus.py`（新增工具，11 篇锚点文档 + 多 Sheet xlsx） | KB `系统测试-解析矩阵库` |
| SOTA-20 | `python3 tests/evaluation/intl-benchmark/sota20_benchmark.py`（新增编排器） | `tests/evaluation/intl-benchmark/results/sota20/`（run/metrics/report.json） |
| Web UI | ZCode 内置浏览器（iab）逐页交互 | 本报告 §3 截录 |

## 附录 B：评估限制

- SOTA-20 基准在**每集 ≤100 篇知识**的约束下运行（用户指定），与官方全语料成绩不可直接对比；trec-covid/dbpedia-entity 因官方 qrels 密度（单 query 金标数百篇）与该约束不相容，以 CMRC2018/TAT-QA 替代。
- 问答延迟受上游 LLM 网关（DeepSeek）与网络环境影响，非本系统单侧指标。
- 多跳历史 F1 数字源自 2026-10-05 profile-300 运行（`results/luna-fresh-20261005-161918/`），环境与本轮一致但非当日复测；本轮 SOTA-20 的 hotpotqa/2wiki/musique 检索分数可作为交叉参照。
