# 核心知识流程：隔离数据库集成验证

这些检查会创建测试用户、知识库、版本和索引，只可指向专门的本地测试库。不能在开发业务库或生产库直接运行。不会创建数据库、启动中间件、应用迁移或调用模型供应商。

## 主检查

前置条件：已有共享本地 PostgreSQL 容器 llmwiki-postgres（127.0.0.1:5433）；测试库名以 gbrain_core_opt_test 开头；schema 已包含全部迁移并生成 Prisma client；测试库迁移账户可创建 fixture。运行器只读取 DATABASE_URL 的连接凭据，重写目标为本地测试库，不打印密码。

```bash
python3 tests/integration/run-core-checks.py
python3 tests/integration/run-core-checks.py --database gbrain_core_opt_test --unit
```

`--unit` 最后运行 `pnpm run test --env-mode=loose --force`，使测试数据库环境变量传给 Turbo 子进程。现有 UserCredential.spec.ts 需要至少一名 active 测试用户；首次空库单测可在这个测试库创建固定 fixture（用户名 core_test_user，邮箱 core_test@invalid.test），不能复制生产用户或凭据。版本/图谱 fixture 独立创建并清理自己的用户和 KB，不依赖固定用户。

| 文件 | 实际检查 |
| --- | --- |
| core-knowledge-versions.cjs | 核心索引覆盖回滚、旧版保持在线、乱序与幂等、generation build/switch/rollback、严格输出与撤权并发 |
| core-graph-projection.cjs | 文档分片复用、差量节点/边、依赖最小来源、撤回及并发发布栅栏 |
| core-ingestion-replacement.cjs | 替换上传/原版本保留、并发构建和发布栅栏 |
| core-application-permissions.cjs | 实际 PermissionService/DocumentAclService：个人库隔离（含系统管理员）、组织继承/兄弟拒绝、角色/组织/过期授权、restricted 空 ACL、全部来源合取、版本/hash/生效时间漂移、撤权 |

Node 构建检查使用显式后台上下文；应用权限检查显式传入用户与新鲜事务客户端。`core-knowledge-versions.cjs` 同时验证严格输出的真实事务共享锁：有效 manifest 可输出、缺失/过时 manifest 拒绝，撤权提交须等待输出完成。

2026-10-07 已移除 RLS，默认运行器不再执行 `core-knowledge-security.sql` / `artifact-read-guard.sql` 的旧数据库行可见性断言。这两个文件保留历史回归记录，要求旧 RLS schema，不能描述为当前应用 ACL 证明。当前 `--reliability` 另运行真实服务丢失和迁移后的2232×908派生读取/模型配额场景，不依赖旧RLS函数。

```bash
python3 tests/integration/run-core-checks.py --database gbrain_core_opt_test --reliability
node tests/integration/redis-reconnect.cjs
```

`core-service-loss.cjs` 只删除随机UUID队列前缀下的Redis任务，在实际BullMQ worker已领取版本索引任务后SIGKILL，并由新建真实outbox服务恢复数据库事件；验证原子发布一次，以及启动/周期恢复体重新排入丢失的解析任务。Redis故障使用本地共享6379的DB15，绝不FLUSHDB。

`core-artifact-quota.cjs` 实际写入2232个派生节点、908个来源、2026656条依赖，按256节点分批记录进度。真实应用权限守卫检查restricted ACL、hash漂移、来源过期、缺失manifest/依赖、匿名与库撤权，并验证跨用户/模型共享的原子RPM与TPM。每批SQL限时120秒，守卫事务限时60秒；脚本清理自身UUID范围的fixture。2026-10-07 Luna批次8全部通过，批量守卫耗时8041–9120毫秒；这不是性能目标已达成的声明。

`redis-reconnect.cjs` 使用三个独立OS进程和一次性Redis：优先本地redis-server，否则使用已经存在的redis:7-alpine镜像、随机loopback端口、64MB内存限制，不下载镜像。验证同库广播、跨Redis DB频道隔离、断线漏消息后缓存重置，以及真实Redis重启后的重订阅。

以下为移除 RLS 前的历史派生读取检查命令，要求专用旧 RLS schema（不能在当前完整迁移的库上作为验收命令）：

```bash
docker exec -i llmwiki-postgres psql -U llmwiki -d gbrain_core_opt_test \
  -v ON_ERROR_STOP=1 < tests/integration/artifact-read-guard.sql
```

该检查临时插入 2026656 条依赖，并输出真实用户策略的 `EXPLAIN (ANALYZE,BUFFERS)`。测试角色与 fixture 随事务回滚；应预留测试库空间。性能记录与边界见 `docs/archive/2026-10-07/validation/sota-20261005/artifact-read-guard-fix.md`。

## 空库迁移与运行角色权限

core-runtime-grants.sql 只允许 llmwiki_inst99999，检查角色 llmwiki_app_inst99999 的安全属性与权限；fixture 事务最后回滚。此库是专用本地迁移测试对象，不是 provision 的应用实例，也没有相应 Redis/应用进程。

2026-10-01 已执行从空库开始的 69 项迁移；再按 provision 的基础表 grants 设置 NOLOGIN 测试角色，并验证新增表/函数权限。

```bash
docker exec -i llmwiki-postgres psql -U llmwiki -d llmwiki_inst99999 \
  -v ON_ERROR_STOP=1 < tests/integration/core-runtime-grants.sql
```

历史迁移含实例命名门禁，不能随意改数据库名字再绕过它。另有历史迁移会修改同服务器旧应用角色的 GUC 默认值：重复空库迁移应在专用测试 PostgreSQL 中开展，不能在共享业务 PostgreSQL 上盲跑所有历史迁移。新增 runtime grants 迁移只处理当前数据库映射的运行角色。生产迁移按项目发布门禁执行。

## 本次证据

完整回归：/tmp/gbrain-core-integrated-final13.log；空库迁移：/tmp/gbrain-core-fresh-migrations-valid2.log；Parser：/tmp/gbrain-core-parser-final2.log；adapter：/tmp/gbrain-core-adapter-final.log。这些本地日志不是可跨环境重放的基准数据。

精度、延迟、成本与十实例容量由 tests/evaluation/core-flow 的真实隔离评测验收；以上 fixture 不提供性能收益结论。
