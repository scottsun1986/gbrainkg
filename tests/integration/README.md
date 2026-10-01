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
| core-knowledge-security.sql | 真实 NOBYPASSRLS 身份、权限矩阵、派生来源合取、更新依赖保护、时点和模型配额；事务回滚 |

Node 检查使用显式后台上下文验证后台构建；用户身份/RLS 的真实性由 SQL 检查验证。禁止把后台构建测试通过描述为请求角色隔离证明。

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
