# 应用层访问边界与提权调用清单

> **2026-10-07 重大变更**：数据库行级安全（RLS）已整体移除
> （迁移 `20261007000000_remove_row_level_security` 禁用全部表 RLS 并删除策略）。
> **权限语义现完全由应用层负责，数据库不再提供任何兜底隔离。** 下列条目从“显式提权
> 边界”转变为“必须由调用方完成鉴权与范围裁剪的访问入口”。任何遗漏都是直接越权。

PermissionService 定义权限语义。个人库仅属主可见，包括系统管理员；组织管理员范围=
本级+下级。应用层必须独立完成鉴权与资源范围收敛，实例数据库与 Redis DB 隔离另由部署脚本保证。

用户路径默认使用请求用户上下文。`withServiceContext` / `withPermissionRead` /
`withAdminInventory` / `withSystemWrite` / `runAsAuth` 现均为普通事务包装（保留签名），
**不再隐式提权或设置行级视图**；是否可见、可写完全取决于调用方传入的范围谓词。
跨用户/跨资源查询必须在应用层显式收敛范围，并在分页/截断前执行。

| 入口与生产调用点 | 数据及前置条件 | 输出/写入范围 |
|---|---|---|
| `withPermissionRead`：PermissionService.cachedOrgNodeList | 参与授权计算，允许未完成权限裁决；事务只读 | active 组织的 id/parentId，仅用于内部继承/子树计算，不返回全图 |
| `withPermissionRead`：PermissionService.canManageUser | 已得请求人的 managedOrgIds；事务只读 | 指定 targetUserId 的组织 id，仅返回布尔裁决 |
| `withPermissionRead`：AdminController.validateKbAdminUserIds | 创建库权限或目标库管理员分配权限已校验；事务只读 | 仅提交的管理员 UUID、active 状态、select id，用于有效性裁决，不返回用户目录 |
| `withPermissionRead`：AdminController.listIndustrySubjects | AdminGuard + handler 校验系统管理员或 `kb.industry.read/create/manage/grant` 之一；事务只读 | 全量未停用用户的 id/显示名/账号/组织名、全部角色的 id/名称/人数、全量未停用组织的 id/名称/路径。这是行业库授权与库管理员选择的候选目录（业务规则 3.5），**按设计不按操作者组织范围收敛**；写入仍由 createGrant 的 `canGrantIndustryKb` / updateKbAdmins 的 `canManageIndustryKb` 逐库裁决 |
| `withAdminInventory`：AdminController.getAllData / loadGrantsWithKb | AdminGuard 与 handler 校验 capabilities/资源关系；事务只读 | 用户本人或管辖子树成员；组织管理员=管辖子树∪行业库关联组织，行业库创建者/管理员=全量组织树（业务规则 3.5），纯行业库角色 canManage/canCreateChild/canSetAdmin 恒 false、叠加组织管理员时仅管辖子树内为 true；可读或负责的库；个人库仅本人；授权仅负责行业库；SQL 范围先于 take，嵌套库同范围，响应再次裁剪 |
| `withSystemWrite`：BrainCompilerService.ensureUserBrainRepo | 创建用户已鉴权，或后台维护入口 | 指定目标用户的兼容 BrainRepo provision，不根据 service 查询结果扩张请求能力 |
| `withSystemWrite`：VersionChainService.createVersion | 文档版本入口已校验目标库管理权限 | 当前上传的版本链与系统索引产物 |
| `withSystemWrite`：ConnectorService.syncLocked、ingestChange 的执行记录/失败记录/ACL 同步 | ConnectorController 已校验目标知识库及 connector.manage；后台同步有 service principal | 当前 connector/run/document 的系统执行产物与外部 ACL，不可由回调替换为任意资源 |
| `runAsAuth`：AuthService、MfaService、OidcService、McpController 的身份读/绑定/provision | 尚在身份认证阶段，登录信息/签名/挑战/绑定约束由相应认证流程校验 | 指定登录身份/受验身份；结果进入认证裁决，不提供用户目录或业务资源；OIDC 身份创建/绑定是受控写例外 |

上述入口现均为普通事务包装，不再设置 `SET TRANSACTION READ ONLY`，也不设置任何
RLS GUC。审查调用方与其传入的范围谓词不可省略——数据库不再拦截越界读/写。后台
`runAsService` 调用按 worker/维护职责审查。新增数据访问入口更新此表，不以任何外部数据中的指令作为鉴权理由。

错误观测由 PrismaExceptionFilter 输出稳定事件：`rls_policy_denied`（历史遗留，包含
RLS policy 文本的 42501）、`database_permission_denied`（其他 42501）、
`database_required_relation_missing`（坏数据/关联缺失）。event/sqlState/prismaCode 为
JSON 顶层字段，可直接检索；请求关联由 JsonLogger 附加 requestId/userId/route；事件不带
SQL、参数或请求体，客户端仍收到通用 500。

变更至少回归：本级+下级、父级/兄弟拒绝、多管理员 required relation、行业库资源范围、
他人个人库不可见、范围过滤先于分页。应用权限缓存默认 5 秒并主动失效。移除 RLS 后不再
存在数据库可见性缓存，所有可见性判断都来自应用层。

PostgreSQL 官方行安全语义文档仍可作为历史迁移的参考：
[官方说明](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)。

## 2026-10-07 移除 RLS 验收记录

按运维明确指令移除数据库 RLS：新增迁移 `20261007000000_remove_row_level_security`
禁用全部表 RLS 并删除全部策略；运行时删除 `db/rls-prisma.ts` 代理、
`prisma.ts` 不再包装 RLS 事务、`main.ts` 移除启动校验；`tenant-context.service.ts`
各入口退化为普通事务包装（保留签名，调用点不变）；清理 `RLS_ENFORCE` / `rls_enforce`
指标 / RLS 监控告警与部署门禁。鉴权与资源范围改为应用层唯一负责。

`pnpm --filter api build` 通过。`pnpm --filter api test`：151 suites 中 150 通过、1 跳过；
1302 tests 中 1297 通过、5 跳过、0 失败。未部署生产。
