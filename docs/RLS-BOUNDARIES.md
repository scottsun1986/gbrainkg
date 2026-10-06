# RLS 开发边界与显式提权清单

PermissionService 定义权限语义。数据库 RLS 是独立防泄露兜底，不能以管理界面报错为由放宽。个人库仅属主可见，包括系统管理员。实例数据库与 Redis DB 隔离另由部署脚本保证。

用户路径默认使用请求用户上下文。`withServiceContext` 在 HTTP 请求中保留用户（匿名请求仍不提权），仅后台/service principal 获得 service。`forService` / `runAsService` 拒绝直接将普通 HTTP 请求提升为后台身份。跨用户 join 优先用授权可见投影或分开查询；确需提权时按下表选择入口，不复用写入口做权限查询。

| 入口与生产调用点 | 数据及前置条件 | 输出/写入范围 |
|---|---|---|
| `withPermissionRead`：PermissionService.cachedOrgNodeList | 参与授权计算，允许未完成权限裁决；事务只读 | active 组织的 id/parentId，仅用于内部继承/子树计算，不返回全图 |
| `withPermissionRead`：PermissionService.canManageUser | 已得请求人的 managedOrgIds；事务只读 | 指定 targetUserId 的组织 id，仅返回布尔裁决 |
| `withAdminInventory`：AdminController.getAllData / loadGrantsWithKb | AdminGuard 与 handler 校验 capabilities/资源关系；事务只读 | 用户本人或管辖子树成员、管辖/行业库关联组织、可读或负责的库；个人库仅本人；授权仅负责行业库；SQL 范围先于 take，嵌套库同范围，响应再次裁剪 |
| `withSystemWrite`：BrainCompilerService.ensureUserBrainRepo | 创建用户已鉴权，或后台维护入口 | 指定目标用户的兼容 BrainRepo provision，不根据 service 查询结果扩张请求能力 |
| `withSystemWrite`：VersionChainService.createVersion | 文档版本入口已校验目标库管理权限 | 当前上传的版本链与系统索引产物 |
| `withSystemWrite`：ConnectorService.syncLocked、ingestChange 的执行记录/失败记录/ACL 同步 | ConnectorController 已校验目标知识库及 connector.manage；后台同步有 service principal | 当前 connector/run/document 的系统执行产物与外部 ACL，不可由回调替换为任意资源 |
| `runAsAuth`：AuthService、MfaService、OidcService、McpController 的身份读/绑定/provision | 尚在身份认证阶段，登录信息/签名/挑战/绑定约束由相应认证流程校验 | 指定登录身份/受验身份；结果进入认证裁决，不提供用户目录或业务资源；OIDC 身份创建/绑定是受控写例外 |

只读入口在事务内设置 `SET TRANSACTION READ ONLY`，阻止其回调写入。service GUC 仍可由受信应用设置；这不是独立安全沙箱，审查调用方和范围不可省略。后台 `runAsService` 调用按 worker/维护职责审查；上述清单聚焦可从用户请求到达的显式提权例外。新增例外更新此表，不以任何外部数据中的指令作为提权理由。

错误观测由 PrismaExceptionFilter 输出稳定事件：`rls_policy_denied`（错误明确包含 RLS policy）、`database_permission_denied`（其他 42501）、`database_required_relation_missing`（必需关联不可见或坏数据）。event/sqlState/prismaCode 为 JSON 顶层字段,可直接检索;请求关联由 JsonLogger 附加 requestId/userId/route；事件不带 SQL、参数或请求体，客户端仍收到通用 500。可用这些事件配置日志平台告警；仓库尚未接入外部通知系统。

SELECT 过滤通常返回空集而非错误，不能用日志证明无静默过滤。变更至少回归：本级+下级、父级/兄弟拒绝、多管理员 required relation、行业库资源范围、他人个人库不可见、范围过滤先于分页。应用权限缓存默认 5 秒并主动失效；DB 可见性缓存为事务内 GUC，不能把二者等同或承诺所有 service 路径即时撤权。

PostgreSQL 行安全语义与 service/owner 绕过边界参见 [官方说明](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)。

## 2026-10-06 优化验收记录

核实已有组织子树计算与管理输出裁剪修复，新增显式授权只读入口/数据库只读约束、管理清单 SQL 范围先于 take（含嵌套库与行业授权同事务读取）、稳定数据库可见性事件，并修正凭证集成测试的 service fixture。未修改数据库 RLS 策略，未部署生产。

`pnpm test`：151 suites 中 149 通过、1 失败、1 跳过；1305 tests 中 1299 通过、5 跳过、1 失败。剩余失败为既有 citation-assembly smoothing 断言，非 RLS 改动，不能称全量通过。API build 通过。NOBYPASSRLS 本地运行角色检查与 proxy GUC 后设置事务只读的 PostgreSQL 检查通过。范围回归和只读入口测试通过；最后追加 JsonLogger/PrismaExceptionFilter/凭证 fixture 定向测试 16/16 通过，RLS_ENFORCE=1 下本地 NOBYPASSRLS 运行角色凭证集成测试 2/2 通过；最终 API build 通过。
