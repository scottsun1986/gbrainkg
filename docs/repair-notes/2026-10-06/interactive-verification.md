# 交互式验收（2026-10-06）

本轮在隔离库上真实启动 API，用真实 HTTP 请求验证修复。不干扰用户现有实例（3202/3200 一直在跑，未重启、未改动）。

## 环境

- 运行时：本机已装好的 API（`apps/api/dist/main.js`，本轮改动后重新构建）另起一实例于 **端口 3299**。
- 数据库：隔离库 `llmwiki_inst99998`（按仓库链全量迁移），
  - `DATABASE_URL` = 迁移角色、`DATABASE_URL_APP` = NOBYPASSRLS 运行时角色 `llmwiki_app_inst99998`，
  - `RLS_ENFORCE=1`，即所有查询都在事务级用户/服务上下文中执行。
- 种子：`production-bootstrap` 建 `admin`（超级管理员）；另建一个只有 `普通用户` 角色的 `smokeuser`。

## 结果

| # | 场景 | 期望 | 实际 |
|---|---|---|---|
| A | 无管理能力用户创建个人知识库（无尾斜杠） | 允许 | **201** |
| B | 同上但走 `/api/v1/admin/kbs/`（尾斜杠） | 允许（C-01 修复点） | **201** |
| C | 管理员把 `["*"]` 授给 `普通用户` 角色 | 拒绝（H-16 修复点） | **400** `通配权限仅限内置的系统管理员/超级管理员角色。` |
| D | 无管理能力用户请求知识图谱（H-07 ACL 路径） | 200 且空结果 | **200** `{"nodes":[],"edges":[],...}` |
| E | 管理员数据面 `GET /api/v1/admin/data` | 200 | **200** |
| F | 无管理能力用户创建**行业**知识库 | 拒绝 | **403** |
| G | 同上，走尾斜杠路径创建**组织**知识库 | 拒绝 | **403** |

F/G 说明 C-01 的修复只放行了"个人库创建"这一条精确路由，没有把豁免放大成通配。

## 本轮因真实运行才发现的两个缺陷（均已修复）

启动时立刻暴露出两个只在真实运行下才可见的权限问题——它们不会出现在任何单测或迁移 fixture 里，因为 fixture 用的是自己创建的角色与授权。

### DB-03：新迁移的策略调用了运行角色无权执行的函数

`20261006160000_security_and_authority_repairs` 里的 `model_provider_write` 策略直接引用
`app_kb_has_permission(app_current_user_id(),'system.settings.manage')`。

但 `app_kb_has_permission` 在 `20260927100000` 中已 `REVOKE ... FROM PUBLIC`，且只把
`app_kb_can_manage`/`app_kb_can_create` 两个包装函数授给了运行角色。**策略表达式是以调用者身份求值的**，
所以 NOBYPASSRLS 运行角色访问 `ModelProvider` 时直接 `42501 permission denied for function app_kb_has_permission`，
应用在启动阶段就失败（模型配置解析要读该表）。

处置：在同一迁移内改为经过一个已授权的、无参数 SECURITY DEFINER 包装函数
`app_current_user_has_permission(text)`（策略里不再出现可被用来探测"某用户是否有某权限"的人工参数），
并用与 `20260927100000` 相同的"库名→运行角色"映射把 EXECUTE 授给运行角色；库名不认识时跳过授权而不是报错，
以免再次出现"任意测试库名跑不了迁移链"的问题。

### DB-04：运行角色对 ModelQuotaBucket 只有 DELETE，而清理任务需要 SELECT

`ingestion.service.ts` 的恢复清理（M-22 修复后**无条件**执行）里有：

```sql
DELETE FROM "ModelQuotaBucket" WHERE period < floor(extract(epoch FROM now())/60) - 120
```

带 WHERE 的 DELETE 需要 `SELECT` 权限，而 `reconcile-runtime-db-role.sh` 此前只授了 `DELETE`（出于"配额变更只走
`app_admit_model_call`"的最小权限考虑）。在**新供给**的环境上，每个 watchdog 周期都会 `42501 permission denied for table ModelQuotaBucket`。

现有开发库之所以没暴露，是因为它的角色早先版本已带 SELECT（`llmwiki_app` 实测 SELECT=true），把问题掩盖了。
M-22 把清理从 `CORE_VERSIONING_ENABLED` 分支里移出来后，这个组合才成为必然失败。

处置：`reconcile-runtime-db-role.sh` 改为 `GRANT SELECT,DELETE ON public."ModelQuotaBucket"`。授予 SELECT 是安全的——
该表唯一的策略是 `app_is_service()`，RLS 依然会把行挡在服务上下文之外（实测策略为 `model_quota_service [*] app_is_service()`）。

两者都在修复后重新建库、重跑全量迁移 + 安全 fixture + 运行时 RLS 校验，再重新启动 API 验证通过。

## 复现命令

```bash
# 1. 全新迁移与授权（见 db-environment.md 的隔离库流程）
# 2. 种子管理员
cd apps/api
DATABASE_URL="…/llmwiki_inst99998" ADMIN_INITIAL_PASSWORD='FixtureAdmin123' \
  LLMWIKI_FORCE_MIGRATOR_URL=1 RLS_ENFORCE=0 node dist/bootstrap/production-bootstrap.js
# 3. 另起实例（不碰现有 3202）
PORT=3299 DATABASE_URL="…llmwiki:…" DATABASE_URL_APP="…llmwiki_app_inst99998…" RLS_ENFORCE=1 node dist/main.js
# 4. 断言 A–G，见上表
```

## 未覆盖

- 未跑检索语义相关套件（SOTA/多跳/拒答）：隔离库为空语料，且这类断言需要真实模型与付费凭据（用户决定不执行）。
- 未跑浏览器端交互（web 于 3200 在跑，但本轮未做 UI 驱动）。
