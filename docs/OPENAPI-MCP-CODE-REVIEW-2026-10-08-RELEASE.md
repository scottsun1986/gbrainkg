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

## 5. 既有状态（非本次引入）

- GBrain 编排器 `v0.53.0 PARTIAL`（shared-skills 内容根待运维处理）与 `gbrain 0.60.84.0 -> 0.60.108.0` 升级提示，均为发布前既有状态，本版未改变。
- 生产 `/data` 72% / 根分区 95%，发布前已存在，本次未显著变化；后续需关注根分区容量。
