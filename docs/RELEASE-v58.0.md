# GBrainKG v58.0 — 架构审查缺陷修复大版本

发布日期：2026-10-10。基线 `2c42dd3`（v57.0.1），来源为《知识库架构全面审查与开源产品源码对标-2026-10-10》（docs/知识库架构全面审查与开源产品源码对标-2026-10-10.md）确认的六项缺陷中的五项修复（B01 按用户指令跳过：不做文档级 ACL 逐文档裁决）。

## 为什么发这个版本

2026-10-10 的全面架构审查对照 RAGFlow、Dify、Onyx、WeKnora、FastGPT、Microsoft GraphRAG 六个固定提交的源码，确认了 6 项缺陷：其中 4 项 P1 直接影响权限正确性、知识正确性与同步可信度（版本空窗、失主执行器写业务行、单文件故障阻断权限同步、图谱关系身份错配），1 项 P2 影响运营状态表达（失败显示为新鲜）。本版本修复其中 5 项（B02–B06），每项均按审查文档的最小复现与验收标准补齐回归测试。

## 变更清单

### B02 版本空窗（P1）— `70b9ae4`

| 项 | 变更 | 生效条件 |
| --- | --- | --- |
| 退役时机 | 跨文档升版不再在创建时把旧版置为 superseded；退役移入新版成功发布事务（版本化路径 `DocumentVersionStore.publish`、传统路径 brain-compiler source-sync），`COALESCE` 保留旧版既有的未来 effectiveTo 定时语义 | 自动 |
| 传递式退役 | 新增 `version-chain-retirement.ts`：从失败中间版本恢复创建时，最新版发布会退役整条链（失败中间版 + 原文档），不会出现两个 current 并存 | 自动 |
| 创建守卫 | 旧文档已有构建中的新版（parsing/indexing/needs_review）时 409；旧文档自身未发布（非 failed）时 409。恢复路径：`retryDocument` 或对 failed 文档重新创建 | 自动 |
| 入队失败 | 升版解析入队失败时新文档标记 failed（旧版继续服务，守卫解除可重试），不再留下永恒 building 状态 | 自动 |
| translation 语义 | translation 链接永不退役原版（翻译与原文并存服务），supersedes/revision 才在发布时退役 | 自动 |

### B03 失主执行器写业务行（P1）— `014cc66`

| 项 | 变更 | 生效条件 |
| --- | --- | --- |
| 写入场守卫 | 新增 `withRunOwnership`：快照撤销、文档创建/更新、外部 ACL 同步全部在同一事务内先 `SELECT … FOR UPDATE` 锁定并校验 ConnectorRun 行的 owner+status 再写入；回收方 CAS 与写入方在同一行锁上串行，失主执行器业务行提交数为 0 | 自动 |
| 失主中止 | `RunLeaseLostError` 中止整个运行（而非计为单条失败）；外部 HTTP 与文件写入保持在事务外 | 自动 |

### B04 单文件故障阻断权限同步（P1）— `014cc66`

| 项 | 变更 | 生效条件 |
| --- | --- | --- |
| 继续扫描 | 飞书单文件正文下载失败由 `break` 改为 `continue`，后续文件的 ACL 同步不再被阻断 | 自动 |
| 失败文件自身 | 下载失败但 ACL 可读时下发带真实已验证 ACL 的 aclOnly 变更（权限照常刷新）；ACL 也不可读才走既有拒绝策略 | 自动 |
| 部分失败表达 | `FetchChangesResult.failures` 上报失败项；run 记 failed、游标保留、`lastError` 记录失败对象明细（run detail JSON 同步留存），不再把部分失败记录成全部成功 | 自动 |

### B05 图谱关系身份错配（P1）— `fd95a2c`

| 项 | 变更 | 生效条件 |
| --- | --- | --- |
| 来源上下文内解析 | 关系端点先在该关系所属分片自己的实体身份内解析（规范化标签 → 上下文内唯一 key），再按 `(sourceEntityKey, targetEntityKey, relationType)` 合并关系；跨类型同名的两条边各自保留 provenance，大小写变体不再丢失来源证据 | 自动 |
| 歧义计量 | 标签在来源上下文内缺失或歧义（同名多类型）时跳过并计入 `unresolvedRelations`，不再用排序第一个节点充当实体裁决 | 自动 |
| 归一化共享 | `normalizeEntityName` 与 `entityIdentityKey` 共享同一实现，写读两侧保持同步 | 自动 |

### B06 失败后新鲜度误报（P2）— `014cc66`

| 项 | 变更 | 生效条件 |
| --- | --- | --- |
| 成功时间语义 | `lastSyncAt` 只在完整成功的同步写入（失败/部分失败只写 `lastError`），新鲜度不再把失败时间解释为知识已更新 | 自动 |
| 状态优先级 | 有 `lastError` 时优先显示 `last_run_failed`（即使最近成功在阈值内）；从未成功同步的源一律显示 `never_synced`（超阈值才同时标 stale），不再显示 fresh | 自动 |

### 未修复（记录）

- **B01 版本链相邻文档元数据**：按用户明确指令跳过——当前部署不做文档级 ACL 逐文档授权，链读取继续返回完整相邻文档信息。若日后启用文档级授权，须按审查文档 B01 验收标准补齐关联端裁决。

## 验证

| 层 | 结果 |
| --- | --- |
| API Jest | 189 套件通过、1 套件跳过；**1668 通过**、5 skipped、0 失败（基线 1647，新增 21 条缺陷回归用例） |
| Web 单测 | 全部通过（`pnpm test` 6 任务全成功） |
| 解析器 | 114 通过 + 20 subtests，无失败 |
| 推荐（三开关）组合集成 | `run-core-checks.py --recommended` 通过：版本发布/回滚/旧版可用性/过期围栏、图谱增量/撤回/依赖替换/并发版本围栏、应用 ACL 全链路——本轮为该检查首次纳入发布前验证（v57 未覆盖） |
| 类型/静态 | api tsc 0 错误、web tsc 0 错误、eslint 0 错误（120 条既有警告）、benchmark selftest OK、adapter 契约测试通过 |
| 构建指纹 | 本地候选构建 = 生产 = 演示 = `9b93475d364bcc74`（`apiReleaseFingerprint`） |

## 部署（2026-10-10 完成，用户明确指令，生产与演示全部全新构建）

| 环境 | 方式 | 验证 |
|---|---|---|
| 生产 `meetings2` inst1 / `knowledge.5gsailor.com:20080` | `bash scripts/deploy-prod.sh --target=inst1 --skip-gate`（本地 turbo 全新构建；快照 `20261010083727` 照常，迁移执行） | api/web/parser 全 active；公网网关 20080 HTTP 200；API ready=quality-first（auth/immutable/graph/adaptive 全开）；parser 鉴权探测 OK；GBrain 引擎 OK；重启后 API journal 0 error；指纹与本地候选一致 |
| 演示 `150.158.137.151:50003` | `bash scripts/deploy-demo.sh`（远端 demo-build.sh 全新构建：install/prisma migrate/api/web/parser venv）+ 手动重启三服务（v57.0.1 遗留：demo-build.sh 构建后不重启） | 首页 200（本机与公网 50003）；api `/ready` 200、quality-first、指纹与生产一致；parser `/health` 200；磁盘 80%（余 7.7G） |

### 门禁说明

发布门禁默认 profile（quality-first）因环境中无测试 API 登录凭据（`LLMWIKI_TOKEN`，与 v57.0.1 相同缺口）在 E2E 两层前中止，按用户明确发布指令以 `--skip-gate` 直发。门禁中**所有无需凭据的层次均已在发布前手动逐项执行并通过**：adapter 契约、api/web tsc、lint、全量单测、解析器、benchmark selftest、`git diff --check`，并在 v57 基础上**额外补跑了推荐组合集成检查**（真实 PostgreSQL、CORE_AUTH_ENFORCE=1 + CORE_VERSIONING_ENABLED=1 + CORE_GRAPH_INCREMENTAL_ENABLED=1）。未运行的仅剩两层浏览器 E2E（chat_answer_layout、sota_knowledge_base_suite）。

## 遗留与建议

- `demo-build.sh` 构建尾部追加三服务重启仍未落地（本轮继续手动重启规避）；建议按 v57.0.1 建议修复，消除构建/服务错位风险。
- 测试 API 登录凭据缺失持续阻塞完整门禁；建议为发布流程提供专用测试账号或长期 token。
- 审查文档第 6 节的优化项（生命周期统一、授权表达统一、配对消融、混合负载容量验证）与 6.2 节条件风险（ChatRun 多进程拓扑、授权修订影响范围、图谱删除收敛）未在本轮范围内，建议按第 8 节阶段三/四推进。
- 回滚命令：`bash scripts/deploy-prod.sh --rollback previous --target=inst1`（快照 `20261010083727`）。
