# 权限模型与用户选择 UX 优化 — 测试报告

- **日期**：2026-10-06
- **目标**：完成权限模型与“选择用户”交互优化，达到 SOTA；全量测试并给出报告；发现问题即修。
- **测试环境**：本机测试环境（宿主机原生）
  - Web `http://127.0.0.1:3200`（Next.js `.next-live`，systemd `llmwiki-web.service`）
  - API `http://127.0.0.1:3202`（NestJS dist，systemd `llmwiki-api.service`）
  - PostgreSQL `127.0.0.1:5433/llmwiki`，Redis 本机
- **账号**：`zl`（行业库管理员，安全库管理员）、`szq`（组织管理员 + 行业库创建者，安全库 owner）、`admin`（超级管理员）
- **未部署生产**：全程仅在本机测试环境。

---

## 1. 需求落地

1. **需求统一记录**：权限与授权规则集中写入 `llmwiki-项目方案.md` §3.5；访问边界同步到 `docs/RLS-BOUNDARIES.md`。
2. **补两条规则**（已实现）：
   - **规则 6 — 行业库角色的只读全貌视图**：`行业库创建者` / `行业库管理员` 可查看**完整组织树 + 完整用户树**，但不能操作（`canManage/canCreateChild/canSetAdmin` 恒 false；若同时是组织管理员，则仅管辖子树内可操作）。
   - **规则 7 — 用户选择交互（穿梭树）**：所有“选择用户”的授权界面不再使用简单下拉框，统一使用 **双栏 + 组织分组树** 的穿梭多选（搜索、组级全选/半选、批量移动、已选复核、计数），提交时批量签发/替换。

## 2. 变更清单

**后端**
- `apps/api/src/admin.controller.ts`
  - `getAllData`：行业库角色（`kb.industry.read`）返回**全量用户目录**（只读）与**全量组织树**（只读）；组织管理员维持管辖子树收敛；新增 `GET /api/v1/admin/industry-subjects`（全量未停用用户 / 全部角色 / 全量未停用组织，供穿梭树与授权选择）。
  - `validateAssignableRoles`：组织管理员只能授「组织管理员/普通用户」；「行业库创建者」仅超级管理员可授。
- `apps/api/src/permission/permission.service.ts`：新增 `isSuperAdmin`。

**前端**
- 新增 `apps/web/src/components/common/UserTransferTree.tsx`（穿梭树组件，含纯函数 `groupUsersByOrg` / `matchesUserQuery`）。
- 集成到全部用户选择场景：行业库授权·人员 Tab（多选批量签发）、新建行业库管理员、行业库管理员设置、新增组织管理员、组织管理员设置。
- `AdminScreen.tsx`：组织架构/人员管理 Tab 对行业库角色开放（只读）；修正 Tab 分组未识别 `alternativePermission` 的缺陷；默认落地保持「行业库管理」。
- `IndustryKBPanel.tsx` / `OrgPanel.tsx` / `UsersPanel.tsx` / `useAdminBootstrap.ts` / `app-store.ts` / `types`：目录、只读、超管标识、低耦合重构。

**文档**：`llmwiki-项目方案.md`（§3.5 规则 1/4/5/6/7）、`docs/RLS-BOUNDARIES.md`。

## 3. 测试矩阵与结果

| 层 | 命令 | 结果 |
|---|---|---|
| API 单元/集成 | `pnpm --filter api test` | **151 suites 通过 / 1 跳过；1311 通过 / 5 跳过 / 0 失败** |
| Web 单元 | `pnpm --filter web test` | **71 通过 / 0 失败**（含新增穿梭树 7 条） |
| Parser（Python） | `pnpm run test:parser` | **54 通过 + 4 subtests / 0 失败** |
| GBrain 适配器 | `pnpm run test:adapter` | **17 通过 / 0 失败** |
| 静态检查 | `pnpm --filter api lint` / `pnpm --filter web lint` | **0 error**（仅历史 warning） |
| 构建 | `pnpm --filter api build` / web `next build` | **通过** |

### 3.1 浏览器 E2E（Playwright，headless，18/18 通过）

真实登录态（注入会话令牌），对 `zl` / `szq` 实测：

| # | 断言 | 结果 |
|---|---|---|
| 1-4 | `zl` 可见 组织架构 / 人员管理 / 行业库管理 / 权限授权 四个 Tab | PASS |
| 5-6 | 授权页出现穿梭树双栏（可选/已选），人员选择**无原生下拉框** | PASS |
| 7 | 可选人员为**全量**（6 行，非仅本人） | PASS |
| 8 | 勾选分组并点「→」后，已选栏出现该人员 | PASS |
| 9-10 | `zl` 人员管理为只读（无「新增人员」、行内显示「只读」） | PASS |
| 11-13 | `zl` 组织架构只读（无「新增组织」「添加子组织」，树正常渲染） | PASS |
| 14-18 | `szq` 库管理员弹窗使用穿梭树、候选为全量用户（5 行） | PASS |

关键截图：`/tmp/opencode/shots/zl-0{2,3}-grant*.png`、`zl-04-users.png`、`zl-05-org.png`、`szq-03-kbadmin.png`。

### 3.2 API 冒烟（真实令牌）

- `zl`：`/admin/data` → users=26（可管理 0）、orgs=8（可管理 0）⇒ 用户树/组织树全貌且只读。
- `szq`：users=26（可管理 3）、orgs=8（可管理 5）⇒ 全貌可见，操作仅限管辖子树。
- `/admin/industry-subjects`：`zl`/`szq` 均返回 6 用户 / 6 角色 / 8 组织（全量）。
- 授权闭环：`zl` POST 建授权 200 → DELETE 撤销 200。

## 4. 测试中发现的问题与修复

1. **Tab 分组未识别 `alternativePermission`**：`AdminScreen` 的“组织与人员”分组只用 `permission` 过滤，导致行业库角色看不到“组织架构/人员管理”（只读全貌无法呈现）。→ 分组过滤统一加入 `alternativePermission`；默认落地改为「行业库管理」。
2. **测试库 RLS 漂移（环境级，关键）**：本机 DB 的 **182 张表被重新启用 RLS 且无策略**；运行时连接使用 `llmwiki_app`（无 BYPASSRLS），导致读取被默认拒绝（表现为 401/403），写入触发 `42501` 使 API 启动即崩溃重启。→ 以迁移同义操作对全库执行 `DISABLE/NO FORCE ROW LEVEL SECURITY` 并清理策略，恢复“RLS 已移除”的既定状态；API 正常启动，全部用例复测通过。
   - 建议：排查重新开启 RLS 的来源（疑似 GBrain `apply-migrations`），在实例初始化/巡检脚本加入“RLS 必须全库关闭”的断言，避免再次漂移。
3. **库管理员候选集被裁剪**：`szq` 指定库管理员时看不到全部用户。→ 库管理员/授权/组织管理员选择统一改用全量候选目录（`industry-subjects` 或已加载清单），并按 `userId` 定位现任管理员，避免保存时误移除。

### 4.1 追加修复（规则 2b 回归）

- **现象**：组织管理员 `szq`（软件研发中心）在「新增人员」时角色选择器为空。
- **根因**：角色选择器读取 `appStore.ROLES`，而组织管理员无 `role.read`，后端 `getAllData` 因此返回空角色清单。
- **修复**：
  1. 后端：组织管理员（`org.user.manage`）即使无 `role.read`，也返回其**可授予的两个角色**「组织管理员/普通用户」；其余角色不下发。
  2. 后端加固：`updateUser` 全量替换角色时，非系统管理员不得移除目标用户已有的、其无权授予的角色（如行业库管理员），否则 403。
- **验证**：
  - 单测：`getAllData` 对组织管理员仅返回两个角色（新增用例）。
  - 浏览器 E2E：`szq`「新增人员」角色选择器恰为「普通用户 / 组织管理员」，且无其它角色（5/5 通过）。
  - API 实测：`szq` 带「行业库管理员」角色创建用户 → **403**；带「普通用户」→ **201**；测试用户已停用清理。
  - 全量回归：API `1311 passed`（较修复前 +1 用例），lint 0 error。

### 4.2 追加优化（穿梭框宽度 + 组织层级树）

- **加宽**：授权中枢改为 `grant-layout`（左表单列 `minmax(680px,2fr)`），含穿梭框的弹窗启用 `modal-wide`（max-width 900px）。实测授权页穿梭区宽 **646px**（单栏 293px），弹窗穿梭区宽 **856px**。
- **真实组织层级树**：候选人员改为挂在**真实组织树**的节点下（`industry-subjects` 返回 `orgs.parentId` 与每人的 `orgIds`；前端 `buildOrgTree` 还原层级），组织节点可逐级折叠/展开，节点复选支持子树枝全选与半选；搜索时平铺匹配结果，无组织归属者归入“未分配组织”。组织管理员场景复用 `flattenOrgTreeWithParent` 从 `ORG_TREES` 还原层级。
- **验证**：Web 单测新增层级用例（`buildOrgTree` + 层级渲染），**73 passed**；浏览器 E2E 穿梭树专项 **6/6**（层级头/根组织/子组织/宽度/单栏宽度/折叠隐藏后代），库管理员弹窗 **3/3**，权限 E2E 回归 **18/18**；API **1311 passed**、lint 0 error。

## 5. 交互优化说明（SOTA 参考）

参考 PatternFly / Salesforce Dual Listbox、UX Patterns Guide 的选型结论：**“按组织层级 + 构建待提交集合”场景应使用可展开双栏穿梭选择器**（而非下拉）。本实现：
- 左栏按组织分组、可折叠、组级全选与半选态、支持姓名/账号/组织搜索；
- 右栏为待提交集合，可批量/逐项移除；搜索只过滤当前栏，**不清除已选**；
- 移动按钮在无有效选择时置灰；底部显示“共选择 N 人”；
- 行业库授权·人员提交时逐人批量签发，库管理员为批量替换，均保留审计。

## 6. 结论与残余风险

**结论**：两条新增权限规则与“穿梭树”交互均已实现并在本机测试环境通过全量自动化 + 浏览器 E2E 验证；发现的问题（含关键环境级 RLS 漂移）均已修复，目标达成。

**残余风险 / 后续建议**
- 全量用户目录在万级规模下会增大 `admin/data` 载荷；后续可按需分页/搜索接口化（当前授权选择已独立走 `industry-subjects`，可优先在此加入分页）。
- 只读行业库角色进入“组织架构/人员管理”时，页面副标题仍为“维护…”文案，建议后续按只读态调整文案（纯体验项）。
- 建议将“RLS 全库关闭”纳入部署/巡检门禁，防止 GBrain 迁移再次开启。
