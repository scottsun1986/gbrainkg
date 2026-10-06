# 低分排除评审落地验证（2026-10-05）

> 落地对象：`docs/retrieval-low-score-exclusion-review-2026-10-05.md` 全部条目（P0/P1/P2、架构 §3、流程 §4、体验 §5、安全 §6）。
> 方式：逐项实现 + 逐项测试，全部改动仅在本仓库工作区，**未部署、未连接生产**（遵守 AGENTS.md 部署铁律）。
> 回归结论：`pnpm test`（仓库级 turbo，6 任务）全部通过；API 套件 **144 套件 / 1264 用例通过**（5 用例跳过为存量状态），`tsc --noEmit`（api/web）零错误。

## 0. 结论速览

| 评审条目 | 状态 | 落地位置 |
| --- | --- | --- |
| P0-1 自适应模式柔性地板/拒答阈值不生效 | ✅ 已落地 | floorMode 追踪 + 双模式测试（见 §1.1） |
| P0-2 量纲混用 / 合成分占保底名额 | ✅ 已落地 | `retrieval/score-contract.ts` 统一分数契约（见 §1.2） |
| P0 双模式测试 + 对照断言 | ✅ 已落地 | `citation-assembly.spec.ts`（21→36 用例） |
| P1-5 默认值不一致 / 重复键 / 功能开关 | ✅ 已落地 | `RETRIEVAL_SOFT_FLOOR_ENABLED`（默认关）+ `.env.example` 清理（§2.1） |
| P1-2 死代码 MAX_FLOOR_CUTOFF / 平滑无作用 | ✅ 已落地 | 删除上限常量 + 边界对照测试（§2.2） |
| P1-3 预算超限终止整个 MMR 循环 | ✅ 已落地 | 降级 bestMember / 跳过继续（§2.3） |
| P1-1 MMR 固定加分放大噪声 | ✅ 已落地 | 乘性加分 + 噪声注入测试（§2.4） |
| P1-4 语义缓存版本未更新 | ✅ 已落地 | 键版本 v7→v8 + 检索配置哈希入键（§2.5） |
| §4.1 淘汰漏斗追踪 | ✅ 已落地 | `eliminated` / `eliminatedByStage` / `funnel`（§3.1） |
| §6 入选原因标注 | ✅ 已落地 | `selectionReason`（floor/guaranteed/exempt/summary/subquery/hop/synthetic_fill/multi_source） |
| P2 `RETRIEVAL_MIN_FLOOR_GROUPS` 覆盖逻辑 | ✅ 已落地 | 显式设置统一尊重，默认按 hasSubQueries/开关收敛（§3.2） |
| P1-6 重排延迟/超时观测 | ✅ 已落地 | `rerank_call_ms` 直方图 + `rerank_calls_total{kind,outcome,docs}`（§3.3） |
| §3.2 两阶段级联重排 | ✅ 已落地 | `coarseSelectRerankPool`（通道头部保留）+ `RERANK_MAX_DOCS` 100→60（§4.1） |
| §3.3 多来源覆盖约束 + 差异说明 | ✅ 已落地 | bigram 主题亲和的多来源保底 + 提示词覆盖缺口标注（§4.2） |
| §3.4 重排文本格式版本 | ✅ 已落地 | `RERANK_TEXT_FORMAT_VERSION=v2` 入重排缓存键与评测元数据（§4.3） |
| §3.4 入库/重排上下文一致性 | ✅ 核实+文档 | 入库侧跳过已存在（`CONTEXTUAL_RETRIEVAL_SKIP_STRUCTURED`），策略说明见 §4.3 |
| P2 重排文本构建缺陷（snippet 优先级/占位面包屑/条款号重复/headingHierarchy 未用） | ✅ 已落地 | `buildContextualizedRerankText` 重写 + 6 项测试 |
| §6 metadata 整包透传 | ✅ 已落地 | 白名单字段透传（§5.1） |
| §3.5 `toCitation` 收敛 | ✅ 已落地 | `fallbackChunkToCitation` 单一映射（3 处 → 1 处） |
| §3.5 检索配置单一来源 | ✅ 已落地 | `retrieval/retrieval-config.ts` 指纹（缓存键/部署预检/评测元数据共用） |
| §5 拒答原因区分 | ✅ 已落地（2/3） | no_evidence / low_confidence 文案 + `refusalCause` 追踪；ACL 提示按评审要求留待安全评审（§6.3） |
| §5 调用链漏斗数字 | ✅ 已落地 | 后端 summary 文案 + 前端漏斗行（§6.2） |
| §4.5 发布清单 / 部署预检 | ✅ 已落地 | `deploy-prod.sh` 检索配置哈希一致性对比（§7） |
| §4.2 A/B 评测门禁 | ⚠️ 工具就绪、执行受阻 | 门禁本体可运行；缺 `LLMWIKI_TOKEN`/`TEST_PASSWORD` 凭据（§8.1） |
| §4.3 badcase 回归集 | ⚠️ 工具就绪、待样本 | `ingest-bad-case.ts` 可用；考勤 V2 案例入库需要测试环境语料与 trace（§8.2） |
| P0-1（前置）校准文件 | ⚠️ 需用户决策 | 全仓库无 Platt 校准文件与 `RERANK_CALIBRATION_FILE` 配置（§8.3） |

## 1. P0 落地明细

### 1.1 P0-1 自适应模式的可观测降级（floorMode）

**仓库侧核实**（生产需登录确认，本环境无法访问生产服务器）：
- `apps/api/.env:113`、`scripts/config/knowledge-quality-first.env:7`、`scripts/release-functional-gate.sh:20` 均要求 `ADAPTIVE_RETRIEVAL_ENABLED=true`；
- 全仓库无 `RERANK_CALIBRATION_FILE` / `RERANK_DEPLOYMENT_REVISION` 配置、无校准 profile 文件。

即推荐配置下 `calibratedScoreOf` 恒为 null，柔性地板退化为相对比例、0.40→0.35 拒答阈值改动无效——评审判断成立。按评审给出的第二条路径落地：**承认当前地板是相对比例，并在追踪中写明**：

- `evidenceSelection.floorMode: 'calibrated' | 'relative'`（`citation-assembly.ts`）；
- 三条测试分别断言：非自适应（重排分）→ `calibrated`；自适应无校准 → `relative`；自适应有校准概率 → `calibrated`。

### 1.2 P0-2 统一分数契约（§3.1 一并落地）

新模块 `apps/api/src/retrieval/score-contract.ts`：

- `measuredScoreOf(citation)`：`calibratedScoreOf` 的全部规则 **+ `rerankSkipped` 守卫**（超重排容量、从未被交叉编码的候选不再视为实测分）。`calibratedScoreOf` 改为委托该函数（单一事实来源），`decideEvidenceSufficiency` / `evidenceConfidenceScores` / `assessWeakEvidence` / `selectEvidence` 由此共用同一契约；
- 契约三规则：**排序看名次、阈值只作用于实测分、合成分只补位**。

`selectEvidence` 落地：

- 分组打分池拆分：`measuredBest`（组内最高实测分）与合成-only 组（measured 模式下 `best=0`，不参与 MMR 竞争）；
- 地板锚定与比较都在**原始实测分量纲**上进行（`measuredBest >= effectiveFloor`），归一化值不再与原始值比较；
- 保底（guaranteed）只授予实测分组，且 `minViableRelevance` 用**原始重排分**比较（评审原文要求）；
- 合成组按**原始召回名次**补位，受 `RETRIEVAL_SYNTHETIC_FILL_MAX`（软地板开启时默认 2，关闭默认 0）封顶；
- 对照测试：3 个实测候选 + 8 个 `rerankSkipped` 合成候选（0.70–0.95 分）——实测候选全部存活、保底计数只计实测组、合成补位 ≤2 且按名次，`floorMode='calibrated'`。

## 2. P1 落地明细

### 2.1 P1-5 功能开关与配置同步

- **`RETRIEVAL_SOFT_FLOOR_ENABLED`（默认关）**：27cd327 的宽松参数集（0.22 比例、Top3 平滑基线、6 保底组、合成补位、多来源覆盖）整体受开关控制；关闭时恢复刚性 0.35 地板、零保底、零补位（对照测试覆盖）。分数契约（P0-2）为缺陷修复，**两种模式下都生效**；
- `.env.example` 与 `apps/api/.env.example`：
  - 重复键清理：`RAPTOR_ENABLED`（110/173 冲突 → 保留 1 处 true，与代码默认一致）、`BGE_M3_HYBRID_ENABLED`（198/223 → 保留发布策略块）、`FORCE_PLATFORM_RERANK`（103 true vs 221 false 冲突 → 保留生效值 false）、`RLS_ENFORCE` 重复行；两个文件重复键检测现为 0；
  - `RETRIEVAL_RELEVANCE_FLOOR_RATIO=0.35` 与开关关闭时的代码默认一致；
  - 新增登记：`RETRIEVAL_SOFT_FLOOR_ENABLED`、`RETRIEVAL_MIN_FLOOR_GROUPS`、`RETRIEVAL_MIN_VIABLE_RELEVANCE`、`RETRIEVAL_SYNTHETIC_FILL_MAX`、`RETRIEVAL_MULTISOURCE_COVERAGE_RATIO`、`RETRIEVAL_ELIMINATION_TRACE_MAX`、`RERANK_MAX_DOCS=60`、`RERANK_CASCADE_ENABLED`、`RERANK_CASCADE_CHANNEL_HEADS`。

### 2.2 P1-2 死代码删除与平滑可观测

- 删除 `RETRIEVAL_MAX_FLOOR_CUTOFF` 的 `min()`（在 0.22 比例下永不触界；在 0.35 比例下反而变成操作员未要求的绝对 0.28 封顶——本次测试中实际观测到该行为）；地板公式收敛为 `baselineScore × ratio`；
- 边界对照测试（评审指定的场景）：`rawBest=0.98`（≥5 实测分激活平滑，基线 0.784、地板 0.1725）、真答案 0.15 低于地板、**仅靠保底入池**；对照断言 `RETRIEVAL_MIN_FLOOR_GROUPS=0` 时该答案被淘汰（去掉保底则测试失败）；
- 平滑可观测：`effectiveFloor` 数值断言（0.784×0.22），0.20 候选经平滑地板直接存活（不平滑的 0.2156 会切掉）。

### 2.3 P1-3 预算超限不再终止循环

- 超预算分组先**降级为 bestMember**（`budgetDegraded` 计数），降级也放不下则**跳过继续扫描**（`budgetSkipped` 计数），后续小分组（短事实答案）不再被大邻居连坐淘汰；
- 测试 1：warmup + 超大组 + 短答案 + 4000 预算 → 超大组被跳过、短答案仍入选；
- 测试 2：分组整体放不下但代表成员放得下 → 降级保留代表成员、丢弃尾部成员。

### 2.4 P1-1 乘性加分

- `value = λ·best·(1+boosts) − (1−λ)·redundancy`，boost（新文档 0.15 / 具体证据 0.15 / 表格 0.10 / 汇总模式 0.55+0.25）全部乘性；
- 噪声注入测试（评审指定场景）：0.13 分新文档表格块 vs 0.50 分同文档正文块竞争 8 个名额 → 正文存活、噪声出局（旧加法下噪声 0.49 > 正文 0.36）。

### 2.5 P1-4 语义缓存键

- 模式盐 `v7`→`v8`（检索行为变化：分数契约 + 软地板开关 + 乘性 MMR + 预算跳过）；
- **检索配置指纹入键**：`retrievalConfigFingerprint()`（`retrieval-config.ts` 的 22 个检索行为键的 sha256 前 16 位）参与 `semanticCacheScopeKey`——今后任何检索参数变更（代码默认或实例 env）自动分区缓存，不再依赖人工升版本；
- `.env.example`（两处）`SEMANTIC_CACHE_KEY_VERSION` 升为 `release-2026-10-05`；
- 测试：翻转 `RETRIEVAL_SOFT_FLOOR_ENABLED` 或 `RERANK_MAX_DOCS` → 键变化；无关 env 噪声 → 键稳定。

## 3. 追踪与可观测落地

### 3.1 淘汰漏斗（§4.1）

`evidenceSelection` 新增：

- `funnel: { recalled, rerankScored, eligible, selected }`；
- `eliminatedByStage`：`rerank_cap`（超重排容量）/ `floor` / `mmr_budget` / `max_groups` 全量计数（`acl` 阶段由引用校验节点的 `aclStripped` 单独报告）；
- `eliminated`：前 `RETRIEVAL_ELIMINATION_TRACE_MAX`（默认 12）条记录，**仅含 docId/chunkId/名次/分数来源/淘汰阶段**，无正文（脱敏）。

### 3.2 入选原因（§6）

每个入选候选标注 `selectionReason`：`floor / guaranteed / exempt / summary / subquery / hop / synthetic_fill / multi_source`（首个原因优先，审计可回放）。

### 3.3 重排观测（P1-6）

`metrics.service.ts` 新增 `observeRerankCall(kind, docCount, durationMs, outcome)`：

- `rerank_call_ms{kind=pool|probe_group}` 直方图（P95 可查）；
- `rerank_calls_total{kind, outcome=ok|timeout|error, docs=le30|31_60|61_100|gt100}`——按容量桶的超时率正是调容决策所需；
- `fusion-rerank.ts` 两个调用点（整池 + 探针组）经 `timedRerankPairs` 计时上报，`TimeoutError/AbortError/超时文案` 归类为 `timeout`。

## 4. 架构建议落地（§3）

### 4.1 两阶段级联重排（§3.2 / P1-6）

- `RERANK_MAX_DOCS` 代码默认与 `.env.example` 统一回调为 **60**（评审建议区间 40–60；容量 100 是 27cd327 引入的超时风险源）；
- 粗排 `coarseSelectRerankPool`（`fusion-rerank.ts`）：
  - 候选带 `maxsimScore`（BGE-M3 迟交互可用时）→ 按 MaxSim 粗排分截取；
  - 否则按合并名次截取，**每个探针通道前 `RERANK_CASCADE_CHANNEL_HEADS`（默认 3）名必定入池**——修复评审"根因 1"（单通道强语义命中被头部切片稀释）；
  - `RERANK_CASCADE_ENABLED=false` 可回退纯头部切片；
- 测试：70 主通道 + 30/20 两探针通道竞争 60 名额 → 两探针通道头部各 3 名保入；MaxSim 分优先；池内直通。

### 4.2 多来源覆盖（§3.3，考勤 V2 场景）

- MMR 之后新增通用约束：未入选文档的最佳分组若 ≥ `RETRIEVAL_MULTISOURCE_COVERAGE_RATIO`（软地板开启时默认 0.35）× 最佳分组分，且与已选证据**字符二元组主题亲和 ≥0.15**（语料无关，无业务硬编码；4 字符贪婪分词对中文重叠严重低估、实测 0.08，故用 bigram），则保底其 bestMember；
- 生成端：中文规则 5 追加【覆盖缺口标注】（"另有《X》对此另有不同/补充规定"/明确未覆盖维度），英文新增规则 8 Coverage Gap Note；
- 测试：紧凑名额下单来源垄断场景（doc-v2 占满 2 个常规名额）→ doc-v1 以 `multi_source` 原因保底入选，无关文档不获得该名额。

### 4.3 重排文本格式版本（§3.4）

- `RERANK_TEXT_FORMAT_VERSION='v2'` 常量：入重排缓存键 `candidateHash`（格式变更后 TTL 内不再回放旧排序）与评测报告元数据（`run-meta.ts` 新增 `retrievalConfig` + `rerankTextFormat`）；
- `buildContextualizedRerankText` 修复四项（P2 杂项）：
  1. 文本优先级 `evidence > context > snippet`（引擎截断预览不再赢过全文）；
  2. 占位面包屑过滤（`文档正文`/`Default`/`body` 等）；
  3. `headingHierarchy`（camel/snake 两种命名统一）作为最优先层级来源，仅拼有意义段落；
  4. 条款号去重（`【第X条】` 已在正文中的不再于层级重复）；
- **入库/重排一致性（核实结论）**：入库侧结构完整文档跳过上下文前缀已存在且默认开启（`contextual-retrieval.ts` `CONTEXTUAL_RETRIEVAL_SKIP_STRUCTURED`，面包屑多级或章+条元数据即跳过 LLM 前缀）。因此对结构化文档，重排阶段的层级拼接（本节修复）是**唯一**的上下文补偿手段，两层策略现已对齐：入库跳过 ⇔ 重排补层级。

## 5. 安全落地（§6）

### 5.1 metadata 白名单

`retrieval-arms.ts` 回退臂候选不再整包挂 `metadata`，仅透传白名单字段：`page_no/pageNumber/bbox/blockId/span/contentHash/chunk_order/section/breadcrumb/article_no/chapter_no/heading_hierarchy/tableRole/title`。`contextual_prefix` 与表头长文本不再进入候选对象（追踪/语义缓存/日志体积与过度暴露面收敛）。权限链路（授权过滤→重排前授权→引用 ACL 三层）未改动。

## 6. 体验落地（§5）

### 6.1 拒答原因区分

快速拒答按 `orderedCitations.length` 区分两种文案并记录 `refusalCause`：

- `no_evidence`："已知知识库资料中未包含与该问题直接相关的信息……"（原文案，测试已固定）；
- `low_confidence`："知识库中检索到了与该问题主题相关的资料，但其相关度置信度不足，为避免误导，本次无法回答。"（含 `无法回答` 标记，`isRefusalAnswerText` 可识别，缓存/追踪分类不受影响；英文对应 `unable to answer`）；
- **ACL 提示未上线**：按评审要求"经过安全评审确认后再上线"，且需要先把 ACL 前候选计数接入快速拒答门禁——两项均已记录为后续项。

### 6.2 调用链漏斗

- 后端：`evidence_selection` 节点摘要文案直接带"召回 N → 重排 M → 入选 K"；引用数在既有 `citation_validation` 节点；
- 前端：`TraceDetails` 展开 `evidence_selection` 节点时渲染单行漏斗（召回→重排实测→入池→入选），普通用户看数字即可，管理员可再展开 JSON 与淘汰明细。

## 7. 部署预检（§4.5）

`scripts/deploy-prod.sh`：

- 新增 `check_retrieval_config_consistency`：`--target=all` 时逐实例计算 23 个检索行为键的 sha256 指纹并对比——分歧默认**告警**，`DEPLOY_REQUIRE_CFG_CONSISTENCY=1` 时**阻断**；单实例发布也打印指纹便于事后归因；
- `bash -n` 语法校验通过。发布清单（评审 §4.5）其余各项本次均已执行：缓存版本已升、`.env.example` 已同步、配置一致性可校验。

## 8. 未尽事项与阻塞（需用户决策/环境）

### 8.1 A/B 评测（§4.2）

- 门禁本体可运行：`ab-gate-runner.ts` 无凭据时报告模式跳过（exit 0）；`quality-gate.ts` 启动后明确要求 `LLMWIKI_TOKEN/AUTH_TOKEN` 或 `LLMWIKI_USER+LLMWIKI_PASS`；
- `pytest tests/evaluation/test_retrieval_quality.py --golden-file=...` 的 `--golden-file` 参数**已确认存在且受支持**（`test_retrieval_quality.py:81` `metafunc.config.getoption("golden_file")`）；
- **执行命令（凭据就绪后）**：
  ```
  # 旧参数组（软地板关）
  RETRIEVAL_SOFT_FLOOR_ENABLED=false npx tsx tests/evaluation/quality-gate.ts
  # 新参数组（软地板开）
  RETRIEVAL_SOFT_FLOOR_ENABLED=true npx tsx tests/evaluation/quality-gate.ts
  ```
  结果写入本目录；评测报告现已携带 `retrievalConfig` 指纹与 `rerankTextFormat`，可直接归因。

### 8.2 badcase 回归集（§4.3）

`ingest-bad-case.ts` 就绪；考勤 V2 漏引案例的入库需要该案例在测试环境的语料与去标识化 trace，属测试环境操作，未在本工作区执行。

### 8.3 Platt 校准文件（P0-1 前置决策）

评审给出的两条路线：补留出集校准文件，或承认相对地板（本次已按后者落地 `floorMode` 可观测）。若选前者，需要生产重排端点 + ≥200 样本验证集生成 `rerank-platt-v1` profile 并配置 `RERANK_DEPLOYMENT_REVISION`/`RERANK_CALIBRATION_FILE`——属生产侧数据工作。**同时建议在生产实例确认 `ADAPTIVE_RETRIEVAL_ENABLED` 实际取值**（仓库侧证据均指向 true）。

### 8.4 前端漏斗仅为最小实现

普通用户汇总数字已上线；管理员"展开查看被淘汰候选"依赖按需拉取的 trace（`eliminated` 明细已在 details JSON 中），如需专属 UI 再迭代。

## 9. 发布提示（按 AGENTS.md）

以上改动已全部通过本地构建与全量测试，**未部署生产**。建议发布顺序：

1. 用户审查本报告与 diff；
2. 测试环境跑 §8.1 的 A/B 两组配置；
3. 指令确认后 `bash scripts/deploy-prod.sh --target=<inst>` 灰度（建议先单实例开启 `RETRIEVAL_SOFT_FLOOR_ENABLED=true` 对比）；
4. 生产发布前 `DEPLOY_REQUIRE_CFG_CONSISTENCY=1` 阻断配置分歧。
