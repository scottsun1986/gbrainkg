# SOTA 优化实施源码审计

日期：2026-10-07。审计基线：`574a15a`（含 `72bb00d` 的优化及 `1babe65` 基线）。逐项核对 [原评估](SOTA-ASSESSMENT-2026-10-07.md) §4 与 [原优化报告](SOTA-OPTIMIZATION-REPORT-2026-10-07.md)，模型按用户要求为 `gpt-6.1-sol`；执行测试由 `gpt-6-luna` 负责。未部署生产，未调用付费模型跑基准，未修改历史迁移。

结论：原报告的“预算可配置、开关存在、单元全绿”不能等同于原始差距全部关闭。本轮修复了可定位的隔离、并发缓存、严格输出和配置生效问题；多跳答案质量、主编排拆分、深度事实编译与公开规模评测仍待验收。

## 原评估 §4 全部 12 项

| # | 源码与实证 | 审计判断与本轮处置 | 剩余验收 |
|---|---|---|---|
| 1 多跳答案质量 | 历史 MuSiQue/2Wiki/Hotpot F1；本轮没有生成 F1 重测，IR nDCG 不能替代答案指标 | **未完成**。未无评测盲改生成层 | 可复现答案 F1/full_evidence 配对评测及桥接证据覆盖 |
| 2 Chat 上帝类 | `chat.service.ts` 仍为主编排；fusion/citation/query 等模块已抽出 | **部分完成**。确定性分页未构成主编排模块化 | 分阶段拆分，保留权限/流式/拒答集成证明 |
| 3 indexing 卡死 | `ingestion.service.ts:70` 启动及周期 watchdog；`brain-outbox.service.ts:145` 找不到任务时恢复租约并重投；版本 fencing 避免旧任务发布 | **机制已实现**，不是仅把状态置 failed；现有断点/outbox 回归与版本集成覆盖。未扩大改动 | Redis 丢失/服务重启的实际混沌故障复测仍非本轮成果 |
| 4 检索语料特化 | 旧 `enableLegalStructureBoost` 默认 true，仍有中文标题 +3、计数 +1.2 和排序覆盖 | **本轮修复排名问题**：移除法条排名开关、中文条款高优先特例、法律章名奖金及排序覆盖；结构召回改通用 Markdown；用户写出的章/节/Article 属语言/文档语法，以普通词处理 | 实际融合回归检查中英/API 标题无奖金且保留证据与层级 metadata；跨语料质量提升没有重测。ID/标题/管理员配置 domainTerms 的通用匹配保留 |
| 5 无校准拒答 | `chat.service.ts:4802` 仅 quality-first 才有 verifyUnknownConfidence；score-contract 区分实测与合成分，citation trace 显示 calibrationAvailable | **降级机制已实现，概率校准未完成**。未知置信度进入原文 grounding，不凭合成分宣称概率 | 部署匹配模型的留出集校准；不把所有模式或未校准分数宣传为校准有效 |
| 6 ANN 召回 | 迁移 `20260920120000_hnsw_query_settings` 当前库 ef_search=200/relaxed_order；bootstrap/provision 与 deploy 预检同步；历史 100k fixture 有参数对照 | **配置机制已实现**。本轮未改部署/迁移 | 当前数据/当前 embedding 模型/过滤选择率下运行 ANN≥0.98；历史 fixture 1.000 不是新部署保证 |
| 7 编译深度 | `brain-scope.service.ts:29` 40 chunk/5 source 上限；derivedEvidence 仍前4块片段；`brain-compiler.processor.ts` topic title contains；truthDiff 仍执行 message 摘要 | **部分完成**，扩预算不等于 Compiled Truth/Timeline。修复 0.5 截断为0导致禁用编译的非法配置 | 完整来源覆盖、真实事实变更 diff、语义主题绑定，质量/成本预算评测 |
| 8 Graph 深度 | `graph-rag.service.ts` 参数原为0.6/60；旧 ingestion 与 incremental 仍 take50；全量 flag 被旧 sample/cap 覆盖；artifact identity 不含 GRAPH_LLM_* | **本轮修复配置贯通**：共享 extraction-budget，三个自动路径默认200，full=1强制采样1/最大100000且加载相同预算；指纹包含有效预算和配置 | 仍有安全上限，full是预算内全量；regex+默认采样保留，社区向量质量/全量抽取收益未量化 |
| 9 确定性5000硬顶 | `chat.service.ts:1886` 每页2000、总预算默认20000/最高200000；两个确定性路径先收敛权限、count，完整行数/ACL 校验后作答 | **原硬顶已缓解，仍有显式上限**。本轮修复小数0.5变0 | 大文档实际性能与动态更新期间完整覆盖；超预算路径继续保守回退 |
| 10 多副本权限缓存 | 旧 channel 仅 llmwiki 前缀；Redis pub/sub 跨逻辑DB；失效期间旧异步查询能回填 | **本轮修复** DB频道隔离、订阅ack前注册回调、并发订阅连接复用、缓存revision淘汰在途旧读取，启动等待订阅注册 | Redis断网或掉线仍TTL兜底，不能承诺所有副本网络分区下零窗口；严格输出使用实时事务授权 |
| 11 登录限流测试冲突 | `AppThrottlerGuard` 原正则任意URL包含 /auth/login 可触发，含嵌套路由/查询串 | **本轮修复** exact登录路由（可尾斜杠/查询串）才绕过；IP白名单仍非production，显式主开关按既有行为保留 | 测试编排仍优先单次登录复用，生产默认限流保持；主开关是明确运维配置 |
| 12 评测规模/口径 | scorer有__evaluated；SOTA20仍≤100文档/≤40query；原样本条件不同的表不是同条件Δ | **口径实现，规模未完成**。本轮补零提交的coverage=0，提交空排名仍计0；修正“样本分数天然公平估计全库”描述 | 公布采样计划/失败query，扩大样本；多次配对与置信区间才能证明提升/统计等价 |

## 额外发现：移除 RLS 后严格输出仍调用旧授权函数

Luna 在隔离数据库集成中复现 `ForbiddenException: Source evidence changed; buffered answer discarded`。版本 fixture 未传依赖 manifest，同时生产 `withStrictOutputPermit` 调用的 `app_manifest_documents_readable` 依赖 `app.user_id` 等旧 RLS GUC；当前 Prisma 不再设置它们。即使给出有效来源，应用权限无法通过旧函数得到当前用户裁决。

修复将版本/hash/生效时间及库/文档 ACL 判定统一放入 `validateEvidenceDependenciesInClient`，使用严格输出锁内的同一事务客户端，新鲜计算可见库、角色/组织/授权，绕过短TTL缓存。授权revision/policy/有效期核验与共享输出锁继续保留。缺失或旧 manifest fail-closed，授权/来源验证完成前不发送内容。[访问边界清单](RLS-BOUNDARIES.md) 同步记录新入口。

集成 fixture 提供真实 manifest，检查缺失/hash漂移拒绝和有效输出/撤权提交串行。运行器替换当前已经失效的数据库 RLS 可见性断言为真实 PermissionService/DocumentAclService 应用权限矩阵；旧 SQL 文件保留历史用途，没有重建数据库兜底，也没有冒充覆盖旧2232×908性能与模型配额场景。

下一阶段集成又复现增量图谱撤回后的依赖数 `3 !== 1`。旧依赖替换 trigger 也以 `app_is_service()` GUC 作为替换条件；当前 worker 的应用身份不再注入该 GUC，所以更新追加旧版本依赖而未替换。`reconcileIncrementalGraph` 现由应用在目标库锁及当前来源版本集合核验后，原子替换本次 GraphEntity/GraphRelation 的 ArtifactDependency 与 ArtifactManifest。真实集成保留撤回后仅一个有效来源、expectedCount=1、未改节点时间不变以及并发来源变更拒绝的断言；历史迁移不改。

## 证明与限制

本轮新增/扩展回归：实际fallback融合的语料独立排名与metadata保留；Redis频道DB隔离、订阅ack竞态/连接复用；异步权限缓存失效竞态；显式事务不复用管理员缓存；非法小数预算、Graph full配置；登录端点边界；锁内权限来源验证；零提交评测coverage。

最终命令、通过数、退出码、初始失败及修复后重跑以 [测试记录](TEST-RESULTS-2026-10-07.md) 为准。Luna 确认6个专项spec 33/33、API最终1354 passed/5 skipped（156 passed suites）、Parser54+4subtests、Adapter17/17；离线CI通过（在线层skipped=1）；四个当前隔离库集成均通过，最后graph依赖补丁亦经运行器构建和集成复验。B1–B10取得各自通过证据后已勾选，[修复与优化清单](SOTA-FIX-TODO-2026-10-07.md) 保留原差距与尚未执行的实证验收项。

历史IR宏观 nDCG 0.577→0.585、Recall 0.596→0.573只表示那组运行观察，单次配对没有方差/置信区间，不能由“波动同量级”推出统计等价或无回归。本轮移除默认法条奖金后改变了相关查询的排名，原报告“不改变默认检索行为”也不再成立；没有新的SOTA20重测，所以没有新的检索提升数字或leaderboard成绩。
