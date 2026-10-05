# 缺陷记录：SOTA 优化轮次发现的 Bug 与根因（2026-10-05）

本文件记录本轮（承接 `docs/plans/global-sota-execution-2026-10-05.md`）在核查进度、审阅未提交改动、
本地 3202 实例实测过程中确认的缺陷。分为两类：**已修复**（代码改动 + 回归测试）与
**数据库守卫修复**（在用户授权后实施，并在隔离测试库验证）。

历史性能数字来自本机测试实例（`llmwiki` 库 / `llmwiki_app` 运行角色），新增同 fixture 对比来自隔离库 `gbrain_core_opt_test`。未使用生产数据。

---

## 一、已修复

### BUG-1（阻断级）IngestionModule 依赖注入失败，API 进程崩溃循环

**现象**：本地 `llmwiki-api.service` 持续崩溃重启，重启计数已达 1039 次，
`journalctl` 中每次都是同一条错误：

```
Nest can't resolve dependencies of the ArchivedPersonalCleanupService
(..., BullQueue_ingestion-queue, BullQueue_enrichment-queue, BullQueue_aux-enrichment-queue, ?).
Please make sure that the argument "BullQueue_dirty-compiler-queue" at index [9]
is available in the IngestionModule context.
```

**根因**：新增的 `ArchivedPersonalCleanupService` 构造函数注入
`@InjectQueue('dirty-compiler-queue')`，同时被注册进 `IngestionModule` 的 providers。
但 `dirty-compiler-queue` 只在 `BrainCompilerModule` 内部通过
`BullModule.registerQueue()` 注册，而 `@nestjs/bullmq` 的 `registerQueue()` 返回的是
**普通动态模块**（`bull.module.js` 中只有 `forRoot()` 带 `global: true`），
其导出的 provider 仅在被 `import` 的那个模块上下文内可见。`IngestionModule` 虽然 import 了
`BrainCompilerModule`，但拿不到对方内部 `registerQueue` 导出的 queue token。

我用一个 Nest DI 探针独立复现了这一点（先构造等价的最小模块图，再直接编译真实的
`IngestionModule`），确认这与 `ArchivedPersonalCleanupService` 的业务逻辑无关，是纯粹的
模块接线错误。

**为什么单测没抓到**：该服务的 25 个单测全部是 `new ArchivedPersonalCleanupService(...)`
手工构造，绕过了 Nest 容器；模块图本身从未被编译过。

**修复**：把该服务从 `IngestionModule` 移除。它的设计就是「仅由
`bootstrap/cleanup-archived-personal.ts` 手工构造的内部维护服务」，注释本身也写明
"No HTTP route"。它不需要、也不应该进入 HTTP 请求的依赖图——留在容器里只会让
`ingestion-queue` / `enrichment-queue` / `aux-enrichment-queue` / `dirty-compiler-queue`
四个连接常驻。

**回归防护**：新增 `apps/api/src/ingestion/ingestion.module.spec.ts`，用 `Test.createTestingModule`
按 `AppModule` 的真实拓扑编译模块图（queue 用 stub 覆盖，保持离线）。已验证该测试会在
重新引入注册时失败。

### BUG-2 充分性裁决的保守化把 bridge-seed 补救变成死代码

**现象**：2Wiki 四跳题「完整证据率」仅 2/31。追查发现确定性桥接补救从未在这些题上触发。

**根因**：`chat.service.ts` 的多跳循环里，bridge-seed 补救的触发条件写成了
`judgment.status === 'sufficient' || 'irrelevant'`。但 `judgeRetrievalSufficiency` 中，
「`insufficient` + 没有任何新的 follow-up 建议」这一组合会被本轮刚改成保留 `insufficient`
（不再升级成 `sufficient`）。于是这个最需要补救的场景——裁判明确指出「缺目标事实」却给不出
新查询词——直接落到 `nextProbes.length === 0` 而 `break`，桥接实体虽然就在首跳证据里，
却永远不会被探针命中。

也就是说，本轮对裁决语义的修正（让 trace 如实反映 `insufficient`）与既有的补救触发条件
耦合在一起，前者让后者失效。这是同一轮改动内部的自相矛盾，不是历史遗留。

**修复**：把补救的触发条件从「裁决结论」改为「没有新的探针可用」。语义上这才是对的：
bridge seed 是一个**兜底**，条件应当是「裁判给不出新东西」，而不是「裁判说够了」。
裁决结论仍然如实留在 trace 上，最终答案仍由证据门控制，补救 hop 不会声称充分。

**回归防护**：抽出纯函数 `planNextHopProbes()`（`bridge-rescue.ts`），5 个用例覆盖
「优先用裁判的新 follow-up」「`insufficient` 且无新词时回退桥接」「补救只花一次（首跳）」
「不回退已执行过的种子」「两者皆无则停止」。

### BUG-3 MinIO 严格删除在重试时不自幂

**现象**：`ArchivedPersonalCleanupService.executeBatch` 是按批次、可重入的
（`--offset/--batch-size`）。但 `ObjectStorageService.delete(..., { strictProvider: true })`
在对象已被上一次尝试删除时会因 MinIO 返回 404 而抛错，导致**重试永远无法完成**。

**根因**：`minioRequest()` 对所有非 2xx 一律 reject。删除操作天然是幂等的，
404 应当视为「已删除」而非失败。其余错误（鉴权、传输、桶不对）必须继续上抛。

**修复**：仅在 `strictProvider` 模式下把 404 视作成功。

**回归防护**：`object-storage.service.spec.ts` 新增用例，验证 404 → resolve、403 → reject。

### BUG-4 `verifyBatch` 接受畸形计划文件，且跨 provider 静默降级

两个问题，都在只读的验证路径上（不写数据，但验证结论会被采信）：

1. **计划文件未做形状校验**。`verifyBatch` 直接信任 JSON 里的 `retainedReadyIds`。
   该字段缺失时，`count({ id: { in: undefined } })` 要么抛错，要么退化成「匹配所有行」，
   于是「保留的 published+ready 身份未变」这条检查会在**根本没检查**的情况下报通过。
   `executeBatch` 有形状校验，`verifyBatch` 没有。

2. **跨 provider 静默降级**。`verifyBatch` 把 `doc.storageProvider` 直接 `as 'local' | 'minio'`
   断言后传给 `storage.exists()`。若 provider 是未知值，`exists()` 会走 local 分支去查本地磁盘，
   对一个实际写在 MinIO 的对象返回「不存在」→ 验证通过。`executeBatch` 有白名单校验，
   `verifyBatch` 没有。

**修复**：`verifyBatch` 补上与 `executeBatch` 对齐的计划形状校验（含 owner 比对、
UUID 合法性、去重），并在探测对象前施加与删除路径相同的 provider 白名单。

**回归防护**：2 个新用例——畸形 `retainedReadyIds`（缺失 / 非 UUID）与未知 provider。


### BUG-6 会话回读把检索失败误报为来源失效

**精确复现**：测试环境管理员询问“员工考勤规定上下班的时间要求什么”。数据库保存的 assistant 内容为
`问答处理失败：Query execution deadline exhausted`，`dependencyManifest=NULL`、引用为空；
`request_failure` trace 记录 deadline 失败。但会话读取接口对每一个 assistant 执行来源校验，
空 manifest 校验返回 false，导致 UI 显示“该回答的来源已失效或您已无权访问。”。
这条消息的根因是检索超时，不是文档撤权。

**修复**：服务器明确生成的失败和标准拒答保存 `non_evidence` 状态标记。
失败保存状态文本，丢弃可能已经生成的部分来源答案和引用；该状态的诊断链路只保留保存状态，
避免以无来源标记暴露历史检索摘录。读取此标记仍执行请求授权检查。
历史空 manifest、空引用且包含服务器 `request_failure` trace 的消息只返回固定失败/超时提示，
不返回原始内容。其他没有 manifest 的历史答案继续拒绝读取。

另修复无模型配置的证据直返分支：输出来源文本前完成授权检查与依赖捕获，
避免真实来源答案因遗漏 manifest 在后续回读时被隐藏。

**定向验证**：gpt-6-luna 已验证 controller、manifest 三个相关测试套件，共 36 个测试通过。
无模型配置分支的定向回归和真实检索恢复另行记录。没有运行新的全量测试。
仅修复错误提示并不能证明检索恢复；迁移后同问题仍有一次 60.17 秒检索超时，
需完成责任层修复与同题验证后才能关闭该检索问题。

---

## 二、数据库守卫修复

### ISSUE-5（读取守卫已修复并通过隔离回归；端到端重测待完成）RaptorNode 的 RLS 守卫使向量检索单次耗时 137 秒

这是本轮**最重要的发现**，也是当前所有多跳召回数据不可信的直接原因。

#### 实测证据

同一个查询、同一套数据，只切换 `app.service` 这一个 GUC：

| 表（单库 2232 行 RaptorNode 的 SciFact 库） | `app.service=off`（用户请求路径） | `app.service=on`（服务路径） |
| --- | --- | --- |
| `RaptorNode` | **137.22 s** | 0.09 s |
| `Chunk` | 0.27 s | 0.09 s |
| `GraphEntity` / `GraphRelation` | 0.09 s（该库为空） | 0.08 s |

同样的 A/B 在另一个库复现（130 s vs 0.09 s）。两者返回的行数完全相同（2232），
说明这**不是**权限过滤掉了数据，而是过滤本身慢。

#### 根因

`20260930130000_artifact_dependencies` 迁移给 `RaptorNode` / `GraphEntity` /
`GraphRelation` / `GraphCommunity` 加了一条 RESTRICTIVE 策略：

```sql
artifact_inputs_guard: app_is_service() OR app_artifact_readable(id::text, "kbId")
```

它与原有的 `raptor_rw`（按可见 KB 过滤）是 **AND** 关系（RESTRICTIVE 策略之间取交集）。
在用户路径下 `app_is_service()` 为假，于是**每一行**都要执行 `app_artifact_readable()`，
而该函数内部包含对 `ArtifactDependency`（178 万行，均值 908 条依赖/artifact）的
`NOT EXISTS ... LEFT JOIN Document` 相关子查询。

关键点：`Chunk` 之所以正常，是因为它的守卫是
`app_published_document_readable(documentId, kbId)`——单行、可索引。
而 artifact 守卫是**依赖集大小相关**的，行数 × 依赖数双重放大。

#### 为什么它摧毁了多跳召回

`/api/v1/chat/search` 现在稳定在 **60.1 s**，`stopReason=round_budget`、`rounds=0`、
`probes=0~1`、`rerankPairs=0`。即：**重排从来没有跑过**，多跳探针预算从未被使用。
日志印证：

```
RAPTOR vector search unavailable: Transaction already closed ... 52515 ms passed
RAPTOR search failed: Query execution deadline exhausted
Search path rerank failed, keeping arm order: Query execution deadline exhausted
```

我按 2Wiki hard-multihop 29 题实测：29/29 HTTP 201，p50 60.5 s，0 个空结果——
**结果看起来"正常"，但那是在重排完全缺席、探针预算完全未用的前提下拿到的。**

这一点对已有结论的影响必须写清楚：`docs/plans/global-sota-execution-2026-10-05.md`
记录的 2Wiki `Recall@10=0.7075` / 完整证据率 `0.39`、MuSiQue 完整证据率 `0.37`
等数字，**是在这个 137 秒守卫存在的条件下测得的**。这些数字描述的是「RAPTOR 臂与重排
均未生效」的系统，不是设计意图中的系统。它们不是错的，但**不能被当作当前实现能力的上限**，
也不能用来判断「多跳召回已经到顶」。

#### 修复与安全语义

用户授权后新增 `20261005120000_artifact_set_read_guard` 迁移，保留
`artifact_inputs_guard` 的 RESTRICTIVE 属性。每个策略通过不相关的集合子查询读取
`app_readable_artifacts()`，先计算本语句可读文档，再按 artifact 汇总依赖，避免每一行重复计算共享文档 ACL。

**修正此前判断**：`raptor_rw` 只检查 KB 可见性，不检查派生摘要的所有源文档 ACL。
源文档撤权后摘要的拒绝行为依赖 `artifact_inputs_guard`；manifest 捕获触发器也不能代替
读取时的当前 ACL、发布状态、时点与版本/hash 漂移检查。因此本次保留全部读取约束，
不改成 PERMISSIVE，不改用 service 身份，不把动态授权移到写入期。

新集合要求 manifest 存在、实际依赖数量等于 `expectedCount`，且每一个来源都满足：
当前用户可见同一个 KB、文档 ACL 可读、已发布、当前版本与 hash 匹配、当前时点有效。
任一来源缺失、跨 KB 或不可读，整个 artifact 不可读。service 路径保留原有策略，函数提前返回空集。
函数结果只在本语句快照有效，不跨请求缓存。回滚脚本恢复旧策略而不修改数据。

隔离库 2232 节点 × 908 依赖（2026656 条）的同 fixture 初次对比：
旧函数全量判断 **45.723 s**；新守卫下真实 NOBYPASSRLS 角色读取 **2.665 s**，集合函数执行一次。
该结果与上文历史真实检索的 **137.22 s** 分属不同测量，不能拼接计算加速倍数。
最终 SQL 回归（含 activeVersionId）、核心安全回归和迁移回滚/重应用验证均通过。结果见
[修复验证记录](artifact-read-guard-fix.md)。

#### 历史评测与后续验收

此前三套各 100 题记录均标注 **RAPTOR/重排未生效**。这些历史结果继续保留，
不能与修复后的检索混用，也不能宣称是完整混合架构的能力上限。
隔离 fixture 的读取性能证明不等于端到端搜索收益。应用到本地测试实例后，
用户随后明确要求不做全量测试，因此本次改为定向验证，未继续三套各 100 题重测。后续若评估整体精度，仍须另行记录 RAPTOR、重排与多跳是否实际执行；本次单题结果见修复验证记录。
生产发布仍须依照 `AGENTS.md` 获得明确发布指令。

---

## 三、本轮验证

| 项目 | 结果 |
| --- | --- |
| `pnpm --filter api exec tsc --noEmit` | 通过 |
| `pnpm --filter api run lint` | 通过，零告警 |
| `pnpm --filter api test -- --runInBand` | 140 套件通过 / 1 跳过，1206 通过 / 5 跳过 |
| `pnpm benchmark:selftest` | 全部子自检通过 |
| `pnpm --filter api run build` + 重启 3202 | 服务 active；`/kbs` 200、`/chat/search` limit=10 与 100 均 201、limit=0 正确 400 |
| 2Wiki hard-multihop 29 题检索 | 29/29 HTTP 201（但见 ISSUE-5：延迟与重排缺席） |

新增回归测试：`ingestion.module.spec.ts`（1）、`bridge-rescue.spec.ts`（+5）、
`object-storage.service.spec.ts`（+1）、`archived-personal-cleanup.service.spec.ts`（+2）。

## 四、后续架构修正与定向验收

详见 [知识问答架构审查](../../plans/knowledge-query-architecture-2026-10-05.md) 与 [并发问答交互修正](concurrent-chat-ux-fix.md)。按表派生读取策略已在本地测试库应用并登记迁移，真实 RLS、撤权、版本漂移、时序及依赖完整性回归通过。错误状态不再被解释为来源撤权；后台完成结果增加读取时的来源权限校验；跨文档版本不再按数字大小自动废止。

最新原问题成功返回 4 条引用，耗时约 99 秒。已有 20 秒引擎中止信号实际生效，但等待数据库兜底的总检索阶段仍约 44 秒；整体性能尚不能称为最优。本次按用户要求只做定向验证，没有完成新的 300 题精度评测，该验证阶段尚未发布生产。

## 后续发布

2026-10-05 用户明确授权后，代码提交 `9876e78` 已发布生产（实例 1）和演示（实例 2）。发布使用已有验证产物，未重复全量测试；迁移、隔离、快照与健康检查已执行。详见[发布记录](release-2026-10-05.md)。
