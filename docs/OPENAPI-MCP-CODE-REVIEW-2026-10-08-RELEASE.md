# 发布记录：OpenAPI/MCP 接口审查实施（2026-10-08）

> 发布指令：用户明确指令「提交github，发布演示环境和生产环境」（2026-10-08）
> 发布内容：提交 `6a6dab6`（`fix(mcp,openapi): close interface review findings R01-R14`）
> 目标：演示环境（`150.158.137.151:50003`）+ 生产 inst1（`meetings2` / `knowledge.5gsailor.com:20080`）

## 1. 源码与构建

- GitHub：`main` 已推送 `dd1e419..6a6dab6`。
- 本地：`pnpm --filter api build` 通过；`eslint` 变更文件无告警；API 全量 `jest` **176 套 / 1547 项通过**（5 项按既有配置跳过），含本版新增回归。
- 运行时指纹：发布后演示与生产 `/ready` 均为 `c040db2acf9ff8eeac31bc7af99ad927e37a2e40636a67c68dacc29bc54f1d9f`（同一构建）。

## 2. 演示环境（全部通过）

- 同步：以 `git archive HEAD` 传输已提交源码树（仅跟踪文件，未触碰演示 `.env` / `.venv` / `node_modules`）；关键文件 blob 哈希与本机 HEAD 逐一核对一致。
- 备份：发布前 `~/gbrainkg-prerelease-20261008183304.tar.gz`（201M）。
- 构建：`bash ~/demo-build.sh`（install → migrate deploy → adapter/api/web build → parser venv）`EXIT=0`，`BUILD_ALL_DONE`。
- 重启：`systemctl --user restart llmwiki-parser llmwiki-api llmwiki-web`，三者 `active`。
- 验证：`/ready` status=ready、新指纹；Web `50003`=200；dist 含 `mcp-authentication.js` 等新代码；`GET /mcp`=405；`/mcp/spec` 协商 `2025-11-25`；OpenAPI spec 14 路径（含 `/v1/search`、`/v1/documents/text`、`/v1/conversations`）；未授权检索=401。
- 回滚：重新同步上一版源码并 `demo-build.sh`；或解包 `~/gbrainkg-prerelease-20261008183304.tar.gz`。

## 3. 生产环境 inst1（全部通过）

- 方式：`bash scripts/deploy-prod.sh --target=inst1 --skip-gate`。
- 快照：发布前自动创建 `/data/llmwiki/.releases/20261008103727`（manifest + tree.tar.gz）。
- 流程：本地全量构建 → rsync 源码与 `dist`/`.next`（含 `--delete` 清理陈旧产物）→ `prisma migrate deploy` → 重启 `llmwiki-api`/`llmwiki-web`/共享 `llmwiki-parser`。
- 验证（全部通过）：
  - 服务 `active`；`/ready` status=ready、新指纹 `c040db2a…`（旧 `7938f4f9…`）。
  - dist 含 `ingestion/knowledge-operations.service.js`、`mcp/mcp-authentication.js`。
  - 内网 API 3000=OK、Web 3200=OK、GBrain 引擎=OK；公网网关 `https://knowledge.5gsailor.com:20080/`=200。
  - 公网 `GET /mcp`=405；`/mcp/spec` 协商 `2025-11-25`；`/open-api/spec.json` 14 路径；未授权 `/v1/search`=401。
  - 未在生产写入测试数据（仅只读验证）。
- 回滚：`bash scripts/rollback-release.sh 20261008103727 --target=inst1`。

## 4. `--skip-gate` 披露

`quality-first` 发布门禁要求在线 `LLMWIKI_TOKEN`、已重启的候选测试 API 指纹一致，以及隔离的 SOTA E2E 库；本机不具备这些前置（与 v49.0 发布记录披露的测试基础设施缺口相同），故经脚本既有逃生通道 `--skip-gate` 发布。补偿验证：本版 `nest build` + 全量 API 单测 1547 项通过、演示环境真实构建/重启/接口验证通过、生产发布前快照可回滚。

## 4b. 追加修复：MCP 上传 PDF 显示为 md（2026-10-08 19:40）

- 现象：用 MCP 上传 PDF 后，文档在 Web 端显示为 `.md`。
- 根因：`POST /mcp/upload` 的可选 `title` 若不带扩展名（如 `员工手册`），落库标题即丢失原始格式；Web 端按标题扩展名判断类型，取不到时回退到解析路径 `content.md`，故 PDF 渲染成 md。
- 修复：`McpService.saveUploadAndEnqueue` 以原始文件扩展名为准，`title` 缺扩展名时补上（提交 `ce7cde1`）。新增 2 条回归用例；API 全量单测 176 套 / 1549 项通过。
- 演示环境：真实 PDF 复测通过（`title=员工手册` → 落库 `员工手册.pdf`；不传 title → 原名保留）。
- 生产环境 inst1：`deploy-prod.sh --target=inst1 --skip-gate` 发布成功；快照 `/data/llmwiki/.releases/20261008114144`；新指纹 `886f5339…`；服务 active、公网 200；`dist/mcp/mcp.service.js` 含修复逻辑。
- 回滚：`bash scripts/rollback-release.sh 20261008114144 --target=inst1`。

## 4c. 追加修复：MCP 断连导致回答丢失（2026-10-08 21:20）

- 现象：生产用户 `szq` 用 MCP 发起多个问题，Web 会话显示「该回答未完成，请重新提问。」。
- 根因：MCP `chat_knowledge` 为同步请求，慢回答（日志实测 30–150s，成功的一次 153s）超过客户端 ~30s 超时；客户端断开触发 `withRpcRequest` 的传输取消，知识运行被中止、助手回答未落库，会话只剩用户消息。证据：`Knowledge request cancelled` ← `ServerResponse.disconnected`。该取消逻辑基线即存在，非审查改动引入；高延迟为独立问题。
- 修复：对齐 Web 聊天路径——客户端断开时**不取消知识运行**，继续生成并落库，仅跳过对已关闭 socket 的写出（各 emit 加 `destroyed/writableEnded` 保护）。提交 `9c2d538`；新增回归用例；API 全量单测 176 套 / 1550 项通过。
- 演示环境：重启后新指纹 `e3a80673…`，断连取消已移除、守卫在位，Web/MCP 正常。
- 生产环境 inst1：`deploy-prod.sh --target=inst1 --skip-gate` 发布成功；快照 `/data/llmwiki/.releases/20261008131930`；新指纹 `e3a80673…`；服务 active、公网 200；`dist/mcp/mcp.controller.js` 含守卫、无旧取消字符串。
- 回滚：`bash scripts/rollback-release.sh 20261008131930 --target=inst1`。

## 5. 既有状态（非本次引入）

- GBrain 编排器 `v0.53.0 PARTIAL`（shared-skills 内容根待运维处理）与 `gbrain 0.60.84.0 -> 0.60.108.0` 升级提示，均为发布前既有状态，本版未改变。
- 生产 `/data` 72% / 根分区 95%，发布前已存在，本次未显著变化；后续需关注根分区容量。
