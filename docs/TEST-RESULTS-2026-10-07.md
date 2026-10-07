# 2026-10-07 项目测试结果

## 范围与安全边界

本轮执行本地单元测试、构建、静态检查、评测脚本自测和指定本地集成检查。没有访问生产域名、生产服务器或生产数据库。集成检查只指向本机 Docker PostgreSQL 中明确存在的 `gbrain_core_opt_test` 测试库；E2E 和在线质量评测没有运行。

项目测试技能：`/home/scottsun/.codex/skills/@user_3c6cb52e/testing/SKILL.md`。命令输出保存在 `docs/validation/2026-10-07/`。

## 自动化结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm test` | 通过。Turbo 6/6 任务成功，29.909 秒。API Jest 156 个套件通过、1 个跳过；1,354 个测试通过、5 个跳过（1,359 总计）；Web 73/73 通过。Next.js 生产构建包含 TypeScript 检查和静态页面生成并成功。 | [pnpm-test-final.log](validation/2026-10-07/pnpm-test-final.log) |
| `pnpm run test:all` | 通过。API 同为 156 个套件、1,354 个测试通过，5 个跳过；Parser Worker 54 项通过、4 个子测试通过（1.56 秒）；Adapter 构建成功，契约测试 17/17 通过（0.970 秒）。 | [test-all-final.log](validation/2026-10-07/test-all-final.log) |
| `pnpm --filter api test:cov` | 通过。156 个套件通过、1 个跳过；1,354 个测试通过、5 个跳过；38.337 秒。语句覆盖率 63.15%，分支 49.92%，函数 58.60%，行 65.86%。 | [api-coverage-final.log](validation/2026-10-07/api-coverage-final.log) |
| `pnpm run ci` | 所有离线层通过：Prisma Client 生成、API 类型检查和 lint、API/Parser/Adapter/Web 单测、Parser Ruff 和 mypy、Web 类型检查和 lint、评测工具自测。API 为 156 个套件通过、1 个跳过；1,354 个测试通过、5 个跳过。最后明确报告 `skipped=1`：在线质量层未启用，因此不代表在线检索质量通过。 | [ci-final.log](validation/2026-10-07/ci-final.log) |
| 聚焦回归（6 个 API spec） | 通过：6 个套件、33 个测试，5.412 秒。覆盖 Redis Pub/Sub 隔离、权限缓存失效、结构检索、严格输出、图路由和 scope 深度。 | [focused-regressions-final.log](validation/2026-10-07/focused-regressions-final.log) |
| 隔离数据库集成 | 通过：版本/严格输出撤权、图增量和撤回/依赖替换/并发栅栏、真实替换摄入、应用层 ACL 矩阵共 4 个 CJS 场景；命令退出码 0。只访问本地 `gbrain_core_opt_test`。 | [integration-core-final.log](validation/2026-10-07/integration-core-final.log) |

API Jest 的普通并行运行均提示一个 worker 未及时退出并被强制结束，但断言通过。诊断运行 `pnpm --filter api exec jest --detectOpenHandles --runInBand` 完成断言（154 套件通过、1 个跳过；1,340 个测试通过、5 个跳过；43.506 秒），之后进程仍等待超过 20 秒，且没有输出可归因的 open-handle 堆栈。本轮停止了该诊断；目前将其记录为未定位的测试进程清理问题，不作为已证实的产品缺陷。

## 集成与在线检查

首次集成运行复现 strict-output-permit 访问控制缺陷：数据库函数仍依赖已移除的 `app.user_id` GUC。修复后版本与真实撤权串行化检查通过。原 runner 中依赖已移除 RLS 兜底的 SQL 检查已从本轮 runner 替换为应用层权限测试；历史 SQL 文件保留原样，并限定给仍有对应 RLS 环境的用途。新 ACL fixture 首次尝试更新不可变 KB 身份字段而被数据库触发器拒绝，随后改为创建时设置这些字段并通过。图谱投影集成最初发现撤回来源后仍有多余依赖，修复后依赖替换、manifest 计数和并发版本栅栏通过。最终集成结果见上表。

在线 E2E 和质量门禁未运行。其前置条件包括明确的测试 API 地址（`API_BASE`，默认 `http://127.0.0.1:3202`，且不得是生产端点）、`LLMWIKI_TOKEN` 或 `LLMWIKI_USER` 与 `LLMWIKI_PASS`、预置测试知识库；国际检索门禁还需要测试 API 的服务状态和可用语料。过滤 HNSW 召回需要 `ANN_EVAL_DATABASE_URL` 或 `DATABASE_URL` 指向测试数据库；BEIR 官方 qrels 门禁需要 `BEIR_QRELS` 与 `BEIR_RUN`。环境中没有提供在线测试凭据，本轮没有触发会访问外部模型或在线服务的评测。

覆盖率命令第一次误写成 `pnpm --filter api test:cov -- --runInBand`，导致额外的 `--` 被 Jest 当作测试路径，报告未找到测试并退出 1；随后使用无额外参数的 `pnpm --filter api test:cov` 重跑并通过。该错误属于命令转发问题，不是代码测试失败。

## 已发现的问题与修复跟踪

以下问题由代码审查和回归检查确认，修复已由本轮测试验证。剩余的质量配对、性能实测和故障注入事项列在 [SOTA 修复与优化 TODO](SOTA-FIX-TODO-2026-10-07.md)：

| 问题 | 当前判断 | 最终验证 |
| --- | --- | --- |
| strict-output-permit 仍通过旧 `app.user_id` GUC 调用数据库 ACL 函数 | 权限/证据校验缺陷 | 已修复；真实版本集成验证有效输出与撤权事务串行化通过 |
| Redis Pub/Sub channel 没有纳入 `REDIS_DB` 实例隔离 | 多实例可能互收失效通知 | 已修复；Redis 专项 spec 和全量 API 单测通过 |
| 权限缓存失效并发中可能重新写入旧结果 | 缓存一致性竞态 | 已修复；专项失效 spec 和全量 API 单测通过 |
| 法条排名包含专用开关和章条特化 bonus | 检索行为偏离通用语料原则 | 已移除特化分支；corpus-agnostic config/policy spec 和全量 API 单测通过。跨语料质量收益仍待配对评测 |
| Graph 全量模式受抽样和数量上限配置影响，产物身份未覆盖配置 | 全量配置语义及产物复用不完整 | 已修复并通过图预算/图路由相关 API 测试；全量 LLM 成本和质量仍待配对评测 |
| 小数预算可能截断为零 | 边界输入处理缺陷 | 已修复；scope 深度 spec 与全量 API 单测通过 |
| 登录白名单匹配范围过宽 | 嵌套路径可能绕过其他路由的保护 | 已修复；节流守卫 spec 与全量 API 单测通过 |
| IR 零提交 coverage 和空排名计数口径不清 | 评测边界报告缺陷 | 已修复；`standard_ir_eval.py` 自测由 `pnpm run ci` 执行并通过 |
| 集成检查断言依赖已移除的 RLS 策略 | 测试验证边界已过期 | 已修复；改为应用层 ACL 与来源/版本/时点合取的本地数据库集成，4 个场景通过 |
| 撤回/更新图谱来源后保留多余 ArtifactDependency | 来源依赖和 manifest 计数可能不一致 | 已修复；图谱撤回、依赖替换、manifest 和并发版本栅栏集成通过 |
| 普通 API Jest worker 未及时退出 | 仅观察到 worker 被强制结束；open-handles 诊断未定位 | 仍未定位；测试断言通过，不据此认定产品 bug |

## 最终复验

`pnpm test`、`pnpm run test:all`、`pnpm --filter api test:cov`、`pnpm run ci` 和隔离数据库集成均在最终生产代码及 fixture 稳定后执行。API Jest 的普通并行运行仍提示 worker 未及时退出；这不影响断言结果，且暂未定位具体句柄来源。

缺陷修复和待补证据的归属、优先级见 [SOTA 修复与优化 TODO](SOTA-FIX-TODO-2026-10-07.md) 与 [实施审计](SOTA-IMPLEMENTATION-AUDIT-2026-10-07.md)。
