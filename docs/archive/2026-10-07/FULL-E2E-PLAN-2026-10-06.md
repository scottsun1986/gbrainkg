# GBrainKG 全面有头浏览器 E2E 测试计划（2026-10-06）

## 1. 被测环境

| 项 | 值 |
|---|---|
| Web 前端 | http://localhost:3200（Next.js 16 SPA，llmwiki-web.service） |
| API 后端 | http://localhost:3202（NestJS，llmwiki-api.service） |
| 解析服务 | http://localhost:8100（parser-worker） |
| 中间件 | PostgreSQL 5433 / Redis 6379 / MinIO 9000（docker） |
| 浏览器 | Playwright Chromium **有头模式**（DISPLAY=:0），视口 1440×900 |
| 测试账号 | admin / admin123（超级管理员，super_admin） |
| 构建新鲜度 | web build 11:29 > 最新 web 源码 09:05；api build 14:50 > 最新 api 源码 11:25 ✅ |

## 2. 权限模型（来自 apps/api/src/permission/permissions.ts）

- 权限码：chat.use、kb.read（基础）；org.read、org.user.read、org.user.manage、org.node.create（组织管理）；
  kb.industry.read/create/manage/grant（行业库）；system.settings.read/manage；audit.read；`*`（系统/超管）
- 内置角色：普通用户 / 组织管理员 / 行业库管理员 / 行业库创建者 / 系统管理员 / 超级管理员
- 知识库三级隔离：personal（个人）/ org（组织）/ industry（行业）
- 组织管理：OrgNode 树 + OrgAdmin（子树管理）；文档级 ACL：DocumentAcl

## 3. 界面结构（SPA 单页多屏）

- 屏：chat（智能对话）/ libs（知识库）/ graph（知识图谱）/ personal_settings（个人设置）/ admin（管理）/ settings(模型) / help
- Admin 页签（按权限显隐）：组织架构 org / 人员管理 users / 角色管理 roles / 行业库管理 industry /
  权限授权 grant / 模型配置 model / 全库数据重处理 reprocess / 审计日志 audit / 系统运行监控 status

## 4. 测试矩阵

### M1 认证与登录
- M1-01 未登录访问根路径 → 渲染登录界面
- M1-02 错误密码 → 明确报错、不崩溃、不跳转
- M1-03 空用户名/空密码 → 前端校验或后端拒绝
- M1-04 admin/admin123 登录成功 → 进入工作台（chat 屏），侧边栏完整
- M1-05 登出 → 返回登录界面；受保护界面不再可见
- M1-06 登出后浏览器回退 → 不应进入已登录界面

### M2 组织架构（CRUD，超管视角）
- M2-01 创建根组织 E2E-ORG-<ts>
- M2-02 创建子组织（两级），树上正确展示层级
- M2-03 重命名组织 → 列表/树即时更新
- M2-04 编辑组织（排序/状态等可编辑项）
- M2-05 删除空子组织 → 成功
- M2-06 删除含子组织/含成员组织的防护行为（按设计应阻止或级联，记录实际表现）

### M3 用户管理（CRUD + 生命周期）
- M3-01 创建用户 u_org<ts>（挂 E2E 组织、角色=组织管理员、设密码）
- M3-02 创建用户 u_normal<ts>（角色=普通用户）
- M3-03 创建用户 u_ind<ts>（角色=行业库管理员）、u_creator<ts>（角色=行业库创建者）
- M3-04 用户搜索（按用户名/显示名）
- M3-05 编辑用户（显示名、组织调动、角色变更）
- M3-06 重置密码 → 用新密码可登录
- M3-07 禁用用户 → 该用户登录被拒（401/账号停用提示）；启用后恢复
- M3-08 删除用户 → 列表消失、登录失败

### M4 角色与权限管理
- M4-01 角色列表：6 个预置角色可见
- M4-02 创建自定义角色（勾选 kb.industry.read）
- M4-03 编辑角色权限（增/删权限码）
- M4-04 删除自定义角色
- M4-05 角色权限与 Admin 页签映射抽查（kb.industry.grant ↔ 权限授权页签）

### M5 知识库三级隔离 + 授权
- M5-01 普通用户创建个人库 → 库列表可见、归属正确
- M5-02 组织管理员创建组织库（挂 E2E 子组织）
- M5-03 行业库创建者/admin 创建行业库
- M5-04 编辑知识库（名称/描述）
- M5-05 行业库授权（IndustryGrant：按用户/按组织、含过期时间字段验证）
- M5-06 知识库管理员设置（KbAdmin）
- M5-07 隔离验证：无授权普通用户 → 看不到他人个人库/未授权行业库（库列表 + 管理页签两侧验证）
- M5-08 授权后：被授权用户可见行业库
- M5-09 归档/删除知识库 + 归档库不可检索的界面表现

### M6 文档入库（ingestion 流水线）
- M6-01 上传 Markdown 测试文档（含可检索事实句）
- M6-02 上传 TXT / DOCX（若支持）观察解析差异
- M6-03 解析状态流转（上传→解析→分块→嵌入→就绪），parser-worker 8100 参与验证
- M6-04 文档列表、详情/预览（markdown 渲染）
- M6-05 文档删除
- M6-06 文档级 ACL（DocumentAclPanel，若入口可达）

### M7 智能问答与检索
- M7-01 新建会话提问（针对已入库事实句）→ 流式回答 + 引用角标
- M7-02 引用点击 → 定位来源文档
- M7-03 会话历史保留/切换
- M7-04 权限边界：普通用户问答不引用无权限库内容
- M7-05 点赞/点踩反馈（若存在）
- ⚠ 本机 4100（LiteLLM 网关）未监听，LLM 生成环节可能不可用——如实记录实际表现，不误报为缺陷

### M8 角色差异（不同权限 → 界面/功能差异）
- M8-01 超级管理员 admin：9 个 admin 页签全可见
- M8-02 组织管理员：组织架构/人员管理可见，模型配置/审计/重处理不可见；组织树仅限本组织子树
- M8-03 普通用户：无 admin 入口（或仅空），无组织/角色页签；API /admin/data 差异
- M8-04 行业库管理员：行业库管理/权限授权页签可见，组织/人员不可见
- M8-05 行业库创建者：可见行业库管理（可创建），无 grant（无 kb.industry.grant）时的页签裁剪
- M8-06 直接 URL 访问 /admin（普通用户）→ 前端防护 + 后端 403 双重验证

### M9 辅助功能
- M9-01 帮助页面
- M9-02 知识图谱屏（图谱数据/空态）
- M9-03 个人设置（改名/改密入口）
- M9-04 主题切换（明/暗）
- M9-05 审计日志页签（本次测试操作应产生审计记录）
- M9-06 系统运行监控页签

## 5. 执行与证据

- 脚本：`tests/e2e/full_headed_e2e_20261006.py`（Playwright async，headed，模块化 try/except，单例失败不中断）
- 证据：`tests/e2e/results/full-e2e-20261006/screenshots/*.png` + `results.json`（每步 PASS/FAIL/截图/耗时）
- 角色差异测试通过登出/登入切换身份完成
- 产出：`docs/E2E-REPORT-2026-10-06.md`

## 6. 约束

- 仅测试环境（localhost:3200/3202），不触碰生产
- 测试数据统一 `e2e`/`E2E-` 前缀 + 时间戳，结束后尽量通过被测删除功能清理
