# 测试与生产发布执行记录（2026-10-01）

用户明确授权部署本机测试环境及生产环境，并只保留 inst1、inst2。权限已恢复，无需重复授权。

## 当前执行状态

- 本机测试 API/Web/共享 Parser 已部署最新代码；70 项数据库迁移已应用；服务健康。
- meetings2 的 inst1/inst2 已完成数据库、配置与发布前备份，最终功能门禁通过后已依次发布成功。
- inst3 已完成备份后退役：停止/禁用并删除其 API/Web 单元，撤销 20082 路由，删除专属数据库和运行角色，清空其 Redis DB 2，删除实例配置及 /data/llmwiki-inst3。未删除共享服务和 inst1/inst2 数据。生产盘点未发现其他实例。
- 生产备份保留在 `/data/backups/gbrain-release-20261001`，含三个实例的数据库、配置及 inst3 目录恢复归档；校验过数据库归档目录及备份摘要。

## 发布范围与门禁

发布完整工作区源代码、构建产物、依赖锁及新增迁移；保留用户资产及现有生产凭据。通过标准 deploy-prod.sh 分别发布 inst1/inst2，使用 baseline 功能门禁，不使用 skip-gate。

默认 full 门禁仍保留。baseline 仅用于实验功能关闭的增量发布，要求完整根测试、真实数据库权限/版本/图谱集成、Parser/适配器/基准工具自检、四种布局浏览器验收和 25 项真实问答场景通过。门禁结果绑定源码、构建产物及测试配置摘要；仅同一产物一小时内可复用。

实验开关 CORE_AUTH_ENFORCE、CORE_VERSIONING_ENABLED、CORE_GRAPH_INCREMENTAL_ENABLED、ADAPTIVE_RETRIEVAL_ENABLED、BGE_M3_HYBRID_ENABLED、BGE_M3_MAXSIM_ENABLED、BGE_M3_LATE_CHUNKING_ENABLED 保持关闭。RLS 保持启用。尚无官方相关性标签、配对成本及 A/B 证据，不能宣称 SOTA 精度/速度/成本达标或实验能力已激活。

本机回归同时修复共享 Parser 包导入、连接池嵌套事务等待、Chunk 发布权限策略查询成本、实验关闭时仍施加自适应超时、标题排版及历史证据版本误写。生产正式结果如下。

## 最终本机门禁

2026-10-01 09:05 通过：API 863 passed / 5 预设 skipped；Web 48 passed；Parser 47 passed / 4 subtests；数据库真实角色安全、版本、图谱集成通过；四种屏幕布局通过；真实场景 25/25，零失败/跳过。P50=32.3 秒、P95/max≈81.2 秒，不构成 SOTA 速度证明。

发布摘要：`3d6be3ceb51acc6dea55460219bb73087a46bcef122339d4062a64f001d315eb`。真实场景报告及截图见 `docs/validation/release-20261001/`；门禁完整日志 `/tmp/gbrain-release-baseline-gate-verified.log`。

## 生产发布结果

| 实例 | 网关 | 数据库 / Redis | 发布前快照 | 结果 |
| --- | --- | --- | --- | --- |
| inst1 | https://knowledge.5gsailor.com:20080 | llmwiki / DB 0 | /data/llmwiki/.releases/20261001010524 | 已发布；API/Web、ready、受保护接口、真实问答与新历史回读通过 |
| inst2 | https://knowledge.5gsailor.com:20081 | llmwiki_inst2 / DB 1 | /data/llmwiki-inst2/code/.releases/20261001010642 | 已发布；API/Web、ready、受保护接口、真实问答与新历史回读通过 |

两实例均采用 `bash scripts/deploy-prod.sh --target=instN --gate-profile=baseline --skip-build`，复用同一已测试构建，未跳过门禁。两个生产库各应用 24 项新增迁移，成功记录共 73 项、失败记录 0；其中 3 项为生产既有独立历史，未删除或伪造迁移记录。本机标准迁移共 70 项。原已发布文档数量保持 inst1=10702、inst2=6。

RLS_ENFORCE=1；llmwiki_app_inst1 / llmwiki_app_inst2 均 NOSUPERUSER / NOBYPASSRLS。实验开关仍 OFF。共享 PostgreSQL/Redis/Parser/Nginx 健康；Parser 的 numpy 2.4.6 已补齐。当前生产沿用已有上传文件目录后端，未配置 MinIO endpoint，未发现 MinIO 系统服务或 9000 监听；不能把 MinIO 计作已验证运行的生产组件，也未新增重复中间件。

公网两个入口 HTTP 200、TLS 校验结果 0；20082 无法连接。无凭据访问返回 401，不存在的知识库范围返回 403。部署后认证冒烟使用现有管理员账号的十分钟签名会话，未修改管理员密码、未测试密码登录。浏览器另验证登录页展示，以及认证后新问答历史加载；两实例 390px 正文均 x=10、width=370，无页面脚本错误。截图与结构报告见 `docs/validation/release-20261001/production-browser.json`。

真实生产问答以各实例已有《企业考勤制度手册V2》所在知识库为范围，核对 09:00、引用、SSE 完成事件和保存后的历史复核。inst1 77.76 秒、2 个引用；inst2 68.47 秒、2 个引用，均通过。这是功能冒烟，并非生产精度或压力/成本基准。

发布过程中，inst1 依赖补装后 Prisma 客户端未及时生成，09:07:24–09:07:59 出现重启错误；已使用锁定版本 Prisma 5.22.0 重新生成并重启，后续 API、真实问答、历史回读和浏览器均通过。inst2 未出现相同重启错误。发布脚本默认 full 质量门禁尚缺官方 qrels / 配对质量成本 / A/B 数据；本次不宣称这些实验优化已启用或完成效果验收。

备份 SHA256SUMS 全部通过，包含 inst3 停服后的最终数据库归档和 Redis DB 2 的原始值/TTL 恢复材料。清理仅针对 inst3 独占资源，保留共享服务、两个运行实例及备份。

详细执行日志：`/tmp/gbrain-release-prod-inst1.log`、`/tmp/gbrain-release-prod-inst2.log`、`/tmp/gbrain-release-production-smoke.log`、`/tmp/gbrain-release-production-qa.log`、`/tmp/gbrain-release-production-final-checks.log`。生产复核报告已另复制到文档验收目录。

最终核对：两个生产实例各 788 个 API/Web/Parser/迁移及锁定构建文件的 SHA256 与本机已验证产物完全一致，零不匹配。恢复后的 API/Web/Parser 均 active，两个 /ready 的数据库和 Redis 检查通过；09:08:10 后无上述服务 ERROR/Traceback。临时生产冒烟令牌文件已删除。
