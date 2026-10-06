# GBrainKG 评估建议实施报告（2026-10-03）

对应 `docs/plans/project-sota-assessment-and-optimization-2026-10-03-v2.md` 的评估结论与优化方案。
本文记录：已落地的代码改动、验证方式与结果；以及明确未做、且不能在本会话内完成的事项与理由。

**未部署生产。未触碰生产服务器、生产数据库或生产域名。** 所有改动限于本地工作区，等待审查与明确的发布指令。

---

## 一、验证总览

| 套件 | 结果 |
| --- | --- |
| API 全量 jest | 128 passed / 1 skipped，**1060 passed / 5 skipped / 0 failed** |
| parser-worker pytest | 47 passed, 4 subtests passed |
| 评测指标单测 `test_faithfulness_metric.py` | 24 passed |
| 门禁有效性自检 `quality-gate-validity.selftest.ts` | 全部检查通过 |
| 门禁认证自检 `quality-gate-auth.selftest.ts` | OK |

改动前该套件有 8 个失败（graph-rag 2、ingestion-quality 6）与 1 个崩溃套件（chat.service，Jest worker OOM）。
根因为**测试依赖开发者本机 `apps/api/.env`**：`src/prisma.ts` 在 import 期把 `.env` 读入 `process.env`，
于是本机的 `CORE_GRAPH_INCREMENTAL_ENABLED=1` / `CORE_VERSIONING_ENABLED=1` 改变了断言所依赖的分支。
已新增 `apps/api/src/jest.setup.ts` 并经 `setupFiles` 在任何测试模块（含 prisma.ts）之前固定这些开关，
套件现在与机器无关；chat.service 的崩溃是并发 worker 内存压力，加 setup 后不再复现。

---

## 二、安全项（P0）

### 1. 会话签名密钥不再静默回退

问题：`auth.service.ts` 与 `oidc.service.ts` 各自实现密钥解析，当 `AUTH_SECRET` 未设时回退到
仓库内可见的字面量 `'llmwiki-local-development-secret'`。原实现只把 `development/dev/test` 之外视为生产，
因此 `NODE_ENV` 未设、拼错（`prod`、`Production `）的场景会**静默用公开常量签发真实用户 token**，
读到源码即可伪造任意身份。OIDC 的 `state`（登录回调的 CSRF 绑定）走同一回退。

改动：

- 新增 `apps/api/src/auth/auth-secret.ts`，作为唯一定义处。规则改为**双重显式**：只有在
  `NODE_ENV` 属 `development/dev/test` **且**显式设置 `LLMWIKI_ALLOW_DEV_SECRET` 时才使用回退值；
  其余情况一律抛错失败关闭。同时新增最短长度校验（32 字符）。
- `auth.service.ts` 与 `oidc.service.ts` 删除各自的 `secret()`，改调 `authSigningSecret()`。
- 顺带修掉同类的第三处：`ingestion/knowledge-base.controller.ts` 的文档预览 token 签名原本以
  `PREVIEW_TOKEN_SECRET || AUTH_SECRET || 'llmwiki-local-development-secret'` 三级回退。预览 token 控制
  已存文件的读取，公开常量意味着可被伪造并访问可猜 id 的文档。现在走 `signingSecretFor('document preview
  tokens', 'PREVIEW_TOKEN_SECRET')`：优先专用密钥，缺失时按同一显式规则回落，绝不落到字面量。
- 新增 `apps/api/src/auth/auth-secret.spec.ts`：11 例，逐一钉住「未设 NODE_ENV 抛错」「NODE_ENV 拼错抛错」
  「开发环境未显式 opt-in 抛错」「生产环境永不使用回退值」「密钥过短拒绝」「专用密钥不静默复用开发字面量」。

### 2. 核心租户表补齐 `FORCE ROW LEVEL SECURITY`

问题：`20260922200000_rls_tenant_isolation` 对 13 张核心租户表只执行了 `ENABLE ROW LEVEL SECURITY`。
仅 ENABLE 时**表 owner 完全绕过所有策略**，因此以 owner 身份连接的会话（迁移角色、`llmwiki`、运维 psql）
可跨租户读写。API 走 NOBYPASSRLS 运行角色，在线路径本就受保护；缺口在 owner 这一类会话。
后续迁移（`dense_generation_snapshots` 等）对新表已用 FORCE，说明写法本身已知，只是核心表未回补。

改动：新增迁移 `packages/database/prisma/migrations/20261003000000_force_rls_core_tenant_tables/`。

- `migration.sql` 幂等且仅对「已启用 RLS 且已有策略」的表执行 FORCE。跳过无策略的表是有意的：对无策略表强制
  RLS 会让 owner 自己也读不到数据（fail-closed 过头会变成故障）。覆盖 24 张表，含核心内容表、
  访问控制表、会话表、连接器表，以及后续迁移启用 RLS 的版本链/产物表。
- `verify.sql` 反映迁移自身契约：扫描全库，任何「已启用 RLS 且有策略但未 FORCE」的表都报 FAIL 并列出表名，
  而不只是给一个计数；另对 13 张核心表做具名 spot check。

**未在本会话执行该迁移。** 迁移需在测试环境按既有流程 apply，且会改变 owner 会话的可见性，
属于必须先在测试库验证的动作。

### 3. 图谱截断补确定性排序

问题（B-8 未修完的部分）：`graph-rag.service.ts` 有 4 处 `take` 无 `orderBy`，截断结果依赖物理行序，
同一次查询在 vacuum 或无关写入后可能返回不同的实体/社区集合，高权重边可能被丢弃。

改动：补齐 5 处排序（比原清单多一处，`searchLocalGraph` 的外层实体匹配也未排序）。

| 位置 | 排序键 | 理由 |
| --- | --- | --- |
| `searchLocalGraph` 实体匹配 | `type asc, updatedAt desc, id asc` | 目录类问题先给 document 类型，再按新鲜度 |
| ARM 种子实体 | `updatedAt desc, id asc` | 种子决定走哪些边，截断必须稳定 |
| 社区列表（全局检索） | `updatedAt desc, id asc` | 同一事务重建的社区 updatedAt 相同，需 id 兜底 |
| 按 id 回填社区 | `updatedAt desc, id asc` | 无序 `IN` 列表上的 take 可能丢最高排名 |
| 按 id 回填实体 | `updatedAt desc, id asc` | 同上 |

验证：`graph-rag.service.spec.ts` 25/25 通过；另新增 spec 的 env 固定，使该断言不再受本机 `.env` 影响。

### 4. 语义缓存写入前的蕴含校验（缓存投毒面）

问题：`semantic-cache.service.ts` 的 `store` 只校验依赖清单（`validateEvidenceDependencies`），
不校验**答案内容是否被证据蕴含**。写入路径上的既有门槛是词面覆盖率代理（`coverageRatio`），
而该代理对「同主题干扰源被当成答案引用」这类句子是失效的。缓存条目会在整个 TTL 内向同范围所有用户重放。

改动：`citation-assembly.ts` 的缓存写入前加入蕴含门。

- 复用已有的 `judgeEntailment`（批量、温度 0、超时 6s、失败自动吞掉返回空集），不新造第二个 judge。
- 证据取自本次实际选中的引用正文（与答案被允许引用的池一致），而非全库。
- 判定为「有任一语句未被蕴含」即**否决写入**，并记 warn 日志说明拒了几条。
- judge 不可达时返回空集（生产实现如此），这里同样视为未通过验证，不会因为模型故障而放行。
- 开关 `CACHE_ENTAILMENT_GATE`，默认开，可置 `0` 关闭（快速模型不可用时降级到词面门槛）。
- 新增 `apps/api/src/chat/cache-entailment-gate.spec.ts`：6 例，覆盖「全部蕴含则写」「拒一条则不写」
  「部分蕴含则不写」「judge 不可达不写」「显式关闭后跳过 judge 仍写」「本就不缓存（private context）时不调 judge」。

---

## 三、评测可信度（P1，本次最高优先级）

### 5. faithfulness 指标改为句级蕴含

问题：`test_retrieval_quality.py` 把 `faithfulness` 定义为答案**逐字包含**金标片段
（`must_contain_snippets`，形如 `["规定了","绩效考核"]`）的子串命中率。中文答案会改写而非照抄，
该指标必然趋零。`latest_results.json` 里 0.1125 与 keyword 0.325 同步低，是同一失败机制的指纹，
不是模型不忠实。既有报告据此判定「生成链路有真实问题」属错误归因。

改动：

- 新增 `EVAL_LLM_JUDGE`（默认关）与句级 entailment 判定。judge 路由按 `llm-client.ts` 的既有解析顺序
  取（env 优先，其次 `apps/api/.env`），未新造端点或密钥；judge 传输复用 Python 树里已有的
  `query_llm_judge`，而非再写一个客户端。
- 句子切分处理中文 `。！？` 与英文 `.!?`，且只在 `.` 后接空白或文本结束时切，避免切坏 `3.5%`、`v1.2.3`、
  `example.com`；先屏蔽代码围栏（含未闭合围栏）；无字母/汉字的碎片剔除，避免列表符号与表格分隔线
  抬高分母。
- **judge 关闭时不再把子串代理报成 faithfulness**：改为 `faithfulness: null` 并附
  `faithfulness_measured: false`。未测量的指标不以指标形式呈现。旧的子串率保留在
  `snippet_match_rate` 名下，历史趋势数据不被破坏。
- summary 增加 `faithfulness_coverage`，只对已测量行聚合。历史结果（无 `faithfulness_measured` 键）
  仍被解释为代理值并计入 `snippet_match_rate`。
- `quality_gate.py` 同步：只对已测量行取均值，未测量时以 `NOT MEASURED … run with EVAL_LLM_JUDGE=true`
  失败退出，而不是把缺失当低分。
- 新增 `tests/evaluation/test_faithfulness_metric.py`：24 例。

### 6. 质量门失败关闭（不再产出无效报告）

问题：`quality-gate-report-2026-09-27T04-02-52-146Z.json` 的 50 行全是
`HTTP 401: {"message":"Invalid or missing credentials."}`，但 summary 仍打印
`overallSuccessRate: 0.40`、逐桶 0.0/0.4/0.8/1.0。机制有两处，都被空答案满足：

- `success = (expected_no_answer ? noAnswer : hitRate) && permission`，而 `expected_document_titles`
  为空时 `hitRate` 恒真 → `document_listing`、`edge_cases` 以空答案「通过」；
- 权限探针把 `status === 401 || status === 403` 都算作「范围已强制」，
  被拒的凭证与真实的范围拒绝不可区分 → `permission_boundary` 8/10「通过」。

于是一次未认证的运行制造出可信的通过率，随后被下游引用为质量测量。这是本次修复的核心。

改动：

- 新增纯模块 `tests/evaluation/quality-gate-validity.ts`：错误分类
  （`auth` / `transport` / `timeout` / `missing-corpus` / `scoring`）、环境错误率
  （分母用 `attempted`，因为环境失败意味着该用例从未被打分）、以及 fail-closed 的有效性判定
  （零打分 → 无效；低于 `GATE_MIN_SCORED_CASES`（默认 10）→ 无效；环境错误率**严格大于**
  `GATE_MAX_ENV_ERROR_RATE`（默认 5%）→ 无效）。边界用 `>`，恰好 5% 通过、6% 失败。
- `quality-gate.ts` 加入**预检探针**：打分前先对已认证端点发一次请求，401/403 立即中止并给出诊断，
  **不写报告**。2026-09-27 那次运行会在第一行之前就终止。
- 逐用例分类：认证/传输/超时失败记录为环境错误并从所有指标中排除，不再落到「空答案恒真」的规则上。
- 权限探针**只有 403 算通过**，401 记为环境失败。这是原误报的另一半。
- 报告 summary 增加 `valid` / `invalidReason` / `envErrorRate` / `scored` / `envErrors` / `attempted`
  与完整 `validity` 对象；无效时打印 `INVALID RUN - NOT A QUALITY RESULT` 横幅、退出码非零，
  且不把通过率当作结果呈现。
- 所有比率的分母改为**已打分用例数**，而非数据集长度。
- 新增 `quality-gate-validity.selftest.ts`：全 401 → 无效、6% → 无效、4% → 有效、恰好 5% → 有效、
  低于最小打分用例数 → 无效、干净全量 → 有效，并逐类断言分类函数。已接入 `pnpm benchmark:selftest`
  （与既有 `quality-gate-auth.selftest.ts` 并列），因此 `scripts/ci.sh` 的评测自检层自动纳入。

### 7. CI 门禁接线修正

问题：`.github/workflows/quality-gate.yml` 的 `retrieval-quality` 任务**不可能通过**：
它读取本仓库任何地方都未定义的 `TEST_HOST`/`TEST_PORT` 密钥，指向 GitHub 托管 runner 上无监听的
`127.0.0.1:3202`，并把结果喂给 `quality_gate.py` —— 一个读取该任务从未生成的 `latest_results.json`
的检查器。

改动：

- 新增 `harness-selftests` 任务，每个 PR 运行 `pnpm benchmark:selftest`（无需凭证与 API）。
  这正是能抓出「指标与门禁已悄悄停止测量」的层。
- `retrieval-quality` 改为 self-hosted runner（与 `ci.yml` 的同名任务一致），使用仓库已用的
  `LLMWIKI_API_URL` / `LLMWIKI_TOKEN`，且仅在该密钥存在时运行；缺失时表现为跳过而非假通过或莫名失败。
  阈值与预检统一由 `ci-gate.sh` 提供。未发明任何新的密钥名。

---

## 四、核心模块单测（P1）

原状：`retrieval-arms.ts`、`fusion-rerank.ts`、`hybrid-retrieval.service.ts`、`ingestion.service.ts`
四个决定答案质量的核心模块**零单测**。「992 passed」覆盖的是有测试的模块，恰恰漏掉召回与融合。

新增三个 spec（`ingestion.service.ts` 已有 17 个 spec 文件覆盖，故未新增）：

| 文件 | 例数 | 钉住的性质 |
| --- | --- | --- |
| `chat/fusion-rerank.spec.ts` | 11 | RRF 分母 `k=60`、按融合分排序、跨臂同段落去重（含空白规范化）、同文档不同段落不合并、文档级佐证奖励只给一次且只给最强段落、`WEKNORA_RRF_WEIGHT` 生效、标题归一化、unicode 人名不截断 |
| `chat/retrieval-arms.spec.ts` | 30 | 越界/零角标剔除、数字断言忽略角标索引、上下文前缀与结构注释剥离、极性冲突（中文下界对上界、区间不被误判、许可对禁止、英文同型）、`statementSupportedBy` 接受改写/拒绝伪造数字/拒绝仅复用常用字的编造/空证据拒绝、缓存范围键（源序无关、源集变化、epoch 变化、同范围不同用户分离）、`calibratedScoreOf` 忽略 synthetic、拒答识别（中英/空/实质答案）、时效性（已废止/未生效/已过期/无元数据保留） |
| `retrieval/hybrid-retrieval.service.spec.ts` | 9 | MaxSim 数值（空侧为 0、完全匹配为 1、按查询 token 取均值而非求和、幅度不变、零向量不除零）、稀疏臂在关闭/空范围时不下发请求、无稀疏向量时 fail-open 并记录降级、同查询只嵌入一次 |

共 50 例新单测，全部通过。

---

## 五、阶段耗时埋点（P1，为 TTFT 拆解提供数据）

TTFT 均值 17.2s 已由既有数据确认，但**17s 花在哪一段无法从代码判断**。本次不猜测，先补测量。

- `metrics.service.ts` 新增 `observeChatStage(stage, durationMs)`，输出直方图 `chat_stage_ms{stage}`。
  stage 名是有限词表而非用户输入，标签基数固定。
- `answer-stream.ts` 的 `StageReporter.emit` 在**首次**到达每个阶段时记录累计耗时，
  重试路径的重复转移只计一次。
- 现有 `chat_first_text_ms` / `chat_total_ms` 保留，新增的三段（retrieving / reranking / generating /
  verifying 之间的差值）即可把首字延迟拆成检索、重排、生成、核验四部分。

顺带核实（原评估列为疑点，结论是**不是** TTFT 主因）：路径上的两次「穷举式预扫描」都有确定性窄门控——
表格计数仅在 `countDocumentNeedle(question)` 命中计数类正则且题中给出文档名时执行
（`table-count.ts:6`），章节列举仅在 `outlineDocumentTitle(question)` 命中明确文档名时执行。
两者都不在每条查询上跑。

---

## 六、未做事项与理由

以下三项**本会话不闭环**，不属遗漏，是范围与安全边界：

1. **执行 RLS 迁移**。`20261003000000_force_rls_core_tenant_tables` 会改变 owner 会话的可见性，
   必须先在有数据副本的测试库上 apply 并跑 `verify.sql`，再由你决定是否进入生产流程。
   按 AGENTS.md 铁律，生产迁移需你的明确书面指令。
2. **身份表（User/Role/OrgNode/UserOrg/UserRole）仍关闭 RLS**。这些表的 `app_visible_kb_ids()`
   是 `SECURITY DEFINER` 且明确依赖读它们，直接启用 RLS 会改变权限计算本身的可见性，
   属于需要单独设计与回归的高风险改动，不宜与本次行为变更混发。建议单独立项：
   先补应用层强制过滤的用例，再评估启用策略。
3. **TTFT 优化本身**。指标已就位，但「首字 ≤3s」需要先取到阶段分布再定改法。
   在拿到分布前改动检索或生成链路，等于按猜测优化——这正是本次评估批评既有报告的地方。

另外两项需外部资源，与前次报告一致：10 万/100 万 chunk 容量压测与 10 实例混合负载；
金标扩到 1000+ 题与月度人工盲评。Web 115 个 lint 存量仍建议单独 PR。

---

## 七、改动文件清单

新增：

- `apps/api/src/auth/auth-secret.ts`、`apps/api/src/auth/auth-secret.spec.ts`
- `apps/api/src/jest.setup.ts`（测试环境确定性）
- `apps/api/src/chat/cache-entailment-gate.spec.ts`
- `apps/api/src/chat/fusion-rerank.spec.ts`
- `apps/api/src/chat/retrieval-arms.spec.ts`
- `apps/api/src/retrieval/hybrid-retrieval.service.spec.ts`
- `packages/database/prisma/migrations/20261003000000_force_rls_core_tenant_tables/{migration.sql,verify.sql}`
- `tests/evaluation/quality-gate-validity.ts`、`tests/evaluation/quality-gate-validity.selftest.ts`
- `tests/evaluation/test_faithfulness_metric.py`

修改（本次相关）：

- `apps/api/src/auth/{auth.service.ts,oidc.service.ts,mfa.spec.ts,oidc.spec.ts}`
- `apps/api/src/ingestion/knowledge-base.controller.ts`
- `apps/api/src/chat/{citation-assembly.ts,answer-stream.ts}`
- `apps/api/src/graph-rag/graph-rag.service.ts`（排序）、`graph-rag.service.spec.ts`（env 固定）
- `apps/api/src/observability/metrics.service.ts`
- `apps/api/{package.json,src/jest.setup.ts}`
- `tests/evaluation/{test_retrieval_quality.py,quality_gate.py,quality-gate.ts}`
- `.github/workflows/quality-gate.yml`、`package.json`、`apps/web/package.json`

注：工作区内另有本次会话之前就存在的 252 个文件修改与 1.9 万行删除，与本文无关，未触碰。
