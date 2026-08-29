# LLMWiki review / 验收报告

日期：2026-08-29

## 结论

当前版本通过“可构建、可启动、基础接口可用”的技术验收，但**不通过生产上线验收**。主要原因不是编译错误，而是关键业务仍是原型或开发期实现：认证授权、知识入库闭环、后台写操作和生产级大脑引擎尚未闭环。

## 已完成的修复

- 修复 Turbo 2 配置：`pipeline` 改为 `tasks`。
- 修复前端迁移原型中的运行时错误、错误 API 路径、重复样式字段、图标属性透传和空数据渲染问题。
- 增加 API 健康检查、受限 CORS、环境变量加载、真实 Bearer 登录、知识库/文档查询接口和上传接口。
- 修复 Chat SSE 控制器：改为标准 POST + 手动 SSE 响应，并补充分片缓冲及末尾事件处理。
- 实现基础权限可见性：个人库、组织树祖先范围、行业库用户/角色/组织授权及过期判断。
- 修复 Brain Compiler 队列等待和权限驱动用户编译逻辑。
- 增加 parser worker 的格式校验、任务状态查询和基础 Markdown/HTML/TXT 解析。
- 将 gbrain adapter 从固定 mock 改为可持久化的 Markdown fallback adapter。
- 增加真实密码哈希、HMAC token、管理员角色校验、会话/消息持久化。
- 打通文本文件上传 → parser worker → Document/Chunk → published → Brain Compiler 队列。
- 修复 seed 数据中的组织父子关系、用户组织关系、个人库归属和 BrainRepo 初始化逻辑。

## 验证结果

| 检查项 | 结果 | 说明 |
|---|---|---|
| Turbo build | PASS | 4 个 workspace 构建成功 |
| Web Next build | PASS | `/`、`/chat`、`/admin` 均生成 |
| API TypeScript build | PASS | NestJS 编译成功 |
| API 单元测试 | PASS | 3 suites / 4 tests |
| Web TypeScript 检查 | PASS | `tsc --noEmit` |
| Parser Python 编译 | PASS | `compileall` 成功 |
| API HTTP smoke | PASS | `/health`、管理数据、路由注册、CORS 基础检查 |
| Parser HTTP smoke | PASS | health、文本解析、错误格式校验 |
| Adapter smoke | PASS | Markdown 写入、查询和引用返回 |
| 真实登录验收 | PASS | 错误密码 401，正确密码 201，`/auth/me` 200 |
| 真实上传验收 | PASS | 上传后 Document 进入 `published`，并进入编译队列 |
| 会话持久化验收 | PASS | SSE 返回 conversation id，历史会话可查询 |
| DeepSeek 实流验收 | PASS | 服务端调用 DeepSeek `deepseek-chat`，返回 6 个流式 delta |
| 浏览器视觉验收 | BLOCKED | 当前 Linux 会话的浏览器窗口未能被 GUI 驱动绑定，未完成点击级视觉回归 |

## 生产上线阻断项

### P0

1. **gbrain 仍不是实际运行时依赖**。当前 adapter 是本地 Markdown fallback；不能把它当成方案文档中承诺的 gbrain 混合检索/整理引擎。
2. **前端管理操作仍有原型占位**。删除用户/角色/行业库/模型、Obsidian 操作和多处表单仍只修改本地状态或空回调，没有对应持久化 API。

### P1

- 引用原文、原始文件下载和完整引用回溯尚未实现。
- `apiKeyEncrypted` 当前按原始字节读取，缺少生产可用的密钥管理和加解密实现。
- Brain Compiler 仍缺少真正的 Git/Gitea 同步、Dream Cycle 和完整失败补偿。
- Docker Compose 只启动基础设施，没有 API、Web、parser-worker、worker、反向代理和迁移任务；镜像使用 `latest`，默认凭据不适合生产。
- 管理接口当前只读且缺少 admin RBAC；审计日志、限流、可观测性、readiness 检查和备份恢复演练未完成。

## 上线前必须补做

1. 接入 OIDC/JWT，并将用户身份从请求头切换为服务端验证的主体；所有管理和写接口增加角色/资源级授权。
2. 完成 MinIO → parser-worker → Markdown/Git → 发布 → Brain Compiler 的异步闭环，补充重试、幂等和失败补偿。
3. 将前端所有写操作接到真实 API，并为上传、删除、授权、模型配置和会话补充端到端测试。
4. 使用真实 gbrain 或明确冻结 fallback 方案的能力边界；补齐引用、会话持久化和权限撤销后的即时回编译验证。
5. 生成生产部署编排：固定镜像版本、密钥注入、数据库迁移、备份、监控、日志、反向代理和 HTTPS。
6. 在可绑定浏览器的环境完成原型逐页面点击回归，特别检查上传、权限切换、引用展开、管理 CRUD、错误态和窄屏布局。

## 开发环境注意事项

- 根项目声明 `pnpm@9.0.0`；当前执行环境没有全局 pnpm，验证时使用了 `npm exec --package=pnpm@9.0.0 -- pnpm ...`。
- `seed-full.ts` 会清空并重建数据，只应在明确的开发/验收数据库执行，不应对现有环境直接运行。
- `apps/api/.env.example` 已补充，生产环境至少需要独立数据库、Redis、对象存储、Brain repo 路径和模型密钥配置。
- DeepSeek 密钥已注入 `/home/scottsun/.config/llmwiki/production.env`（权限 600），未写入项目代码和前端；建议因密钥已在对话中出现而尽快轮换。
