# LLMWiki（百纳知识库）文档索引

> 最后更新：2026-10-10

## 根目录长期文档

| 文档 | 内容 |
|---|---|
| [`../README.md`](../README.md) | 项目概览、架构速览、快速上手 |
| [`../AGENTS.md`](../AGENTS.md) | 开发与部署守则（发布管控铁律、检索架构原则、多实例隔离、权限边界） |
| [`../llmwiki-项目方案.md`](../llmwiki-项目方案.md) | 立项方案 v1.2：市场调研、产品设计、架构设计、**§3.5 角色授予与用户管理硬约束**、实施计划 |

## 持续维护的规范

| 文档 | 内容 |
|---|---|
| [`RLS-BOUNDARIES.md`](RLS-BOUNDARIES.md) | 应用层访问边界清单（数据库 RLS 已移除，权限语义全部由应用层负责；新增数据访问入口必须更新此清单） |
| [`知识库架构全面审查与开源产品源码对标-2026-10-10.md`](知识库架构全面审查与开源产品源码对标-2026-10-10.md) | 当前架构与核心流程、六个开源项目固定提交源码对照、六项缺陷证据、优化方案及验收顺序 |
| [`SOTA-ASSESSMENT-2026-10-07.md`](SOTA-ASSESSMENT-2026-10-07.md) | 核心业务流程 SOTA 评估（六子系统对标 + 差距清单） |
| [`SOTA20-BENCHMARK-REPORT-2026-10-07.md`](SOTA20-BENCHMARK-REPORT-2026-10-07.md) | 20 个主流公开数据集基准得分（每集 ≤100 篇知识，nDCG/MRR/Recall） |
| [`COMPREHENSIVE-TEST-REPORT-2026-10-07.md`](COMPREHENSIVE-TEST-REPORT-2026-10-07.md) | 全面测试报告（单元/E2E/GUI/基准四层 + 问题处置清单） |

## 手册

| 文档 | 内容 |
|---|---|
| [`manual/USER_MANUAL.md`](manual/USER_MANUAL.md) | 用户手册（登录、三级知识库、对话查询、管理后台） |

## 部署与运维

见 [`../deploy/README.md`](../deploy/README.md)、`deploy/MULTI_INSTANCE_GUIDE.md`、`deploy/NEW_SERVER_DEPLOY_GUIDE.md`。

核心脚本：`scripts/bootstrap-new-server.sh`（新服务器初始化）→ `scripts/deploy-prod.sh --target=all|instN`（发布）→ `scripts/provision-instance.sh <N>`（扩容实例）。

## 测试与评测

| 入口 | 内容 |
|---|---|
| `pnpm test:all` | API 单测（Jest）+ 解析服务（pytest）+ gbrain 适配层契约测试 |
| `pnpm test:kb` | 知识库 SOTA 端到端套件（tests/e2e/） |
| `pnpm evaluate` / `pnpm gate` | 220+ 金标问题评测与质量门禁（tests/evaluation/） |
| `pnpm benchmark:intl` | 国际基准套件（BEIR/SciFact/2Wiki 等，tests/evaluation/intl-benchmark/） |
| `pnpm benchmark:selftest` | 评测基础设施自检 |
| `pnpm ci` | CI 全流程（scripts/ci.sh） |

历史测试报告、修复台账与优化计划（已完结）归档于 [`archive/`](archive/)，按日期组织，每个归档目录内有 README 说明归档原因与当前有效文档指引。
