# v57.0.1 · 拒答零引用修复 + 全环境最新构建发布（2026-10-10）

基于 v57.0 之上的两个补丁，本地/演示/生产三环境全量重建部署（前后端）。

## 变更

| 变更 | 提交 | 说明 |
|---|---|---|
| B（Bug 2 修复）拒答零引用 | `8426c66` | 无角标标准拒答不再携带候选引用（原 `引用 20 条` 伴随"未包含相关信息…"）；合成拒答路径传 `answer_kind='refusal'`，controller 持久化 `non_evidence` 清单，拒答日后不因文档吊销被改写为"来源已失效"。带角标的"逐来源核查"式拒答保留引用。新增 `refusal-citation-output.spec.ts`（4 用例）与 `chat.service.spec.ts` 契约用例；修正 2 个借道旧 bug 通过的既有用例 fixture。API 全量 188 套件 / 1647 用例通过；浏览器 E2E 27/27；SOTA 25/25（P50 7.7s / P95 38.0s） |
| W（Web）移除文档级 ACL 面板 | `ad263dd` | 删除 `DocumentAclPanel` 及 LibrariesScreen 入口（含个人库"查看权限"按钮），文档级授权仍由 API 与库级授权 UI 管理。经用户确认一并发布 |

## 部署（2026-10-10 完成，用户明确指令，生产按 --skip-gate 直发）

| 环境 | 方式 | 验证 |
|---|---|---|
| 本地测试 `127.0.0.1:3200/3202` | `pnpm --filter api build` + `NEXT_DIST_DIR=.next-live next build` + 重启 systemd user 单元 | web 200 / api 401；"标准问答"QA 文件导入入口（CSV/XLS/XLSX/JSONL）恢复可见；ACL 按钮移除生效；拒答会话 `citationsSummary=0` |
| 演示 `150.158.137.151:50003` | `bash scripts/deploy-demo.sh`（rsync + 远端 demo-build.sh）+ 手动重启三服务 | 首页 200、登录页正常渲染、0 控制台错误；api `/ready` 200、parser `/health` 200 |
| 生产 `meetings2` inst1 / `knowledge.5gsailor.com:20080` | `bash scripts/deploy-prod.sh --target=inst1 --skip-gate`（快照照常） | api/web/parser 全 active；公网 HTTPS 200、鉴权 401 正常、0 控制台错误；API `apiReleaseFingerprint=af92e518…` 与本地候选构建一致，quality-first profile；web 服务 14:32 新构建（QA 功能在、ACL 面板无）；GBrain 引擎 OK（0.53.0 shared-skills host-work 为既有待办，与本发布无关） |

## 本轮排查结论（用户报告的两个问题）

1. **测试环境无 QA 导入入口、生产反而有**：功能自 v56.0 起两端代码完全一致（`QaPanel`，canWrite 门控）。本地测试环境 systemd 单元以 `NEXT_DIST_DIR=.next-live` 服务 **10-08 17:02** 的旧构建（早于 10-09 的 QA 功能提交），而常规构建只写 `.next`，导致"代码新、服务旧"。已重建 `.next-live` 并重启修复。生产（v56.0）自然有入口。
2. **演示环境首页进不去（报错）**：`demo-build.sh` 构建后不重启服务；远端 `.next` 于 11:55 被重建而 web 服务仍是 10:12 启动，运行清单与磁盘 chunk 错位 → `_next/static/chunks/3j3xeytn48miy.js` 500（text/plain）→ ChunkLoadError → 错误兜底页。已重新部署并重启三服务修复。

## 遗留与建议

- `demo-build.sh` 建议在构建尾部追加三服务重启（避免再次出现构建/服务错位）；本地与演示的"构建目录约定"（`.next-live` vs `.next`）建议统一并写入部署文档。
- 生产发布门禁本次按指令跳过；本地等效验证（单元/E2E/SOTA + 指纹一致）已在发布前完成。
