# LLMWiki（百纳知识库）

企业级 LLM 知识库平台：**编译式个人大脑**（Compile-then-Query）——知识不是被检索的碎片，而是面向每个人持续编译的"大脑"。查询 = 问大脑，回答来自整理好的 Compiled Truth 结论与可三级回溯的证据链（知识页 → Timeline 证据 → 原始文档）。

> 详细方案见 [llmwiki-项目方案.md](llmwiki-项目方案.md)；开发守则见 [AGENTS.md](AGENTS.md)；文档索引见 [docs/README.md](docs/README.md)。

## 核心能力

- **对话式知识查询**：多轮会话、SSE 流式输出、内联引用 `[n]` 溯源到知识页与原始文档
- **三级知识库**：个人库（独享）/ 组织库（绑定组织树，同层及下层可见）/ 行业库（显式 ACL 授权：人员/角色/组织，支持有效期）
- **编译式大脑**：知识发布 / 权限变更 / 夜间 Dream Cycle 触发面向每人的 Brain Compiler 增量编译；权限撤销最高优先级，查询侧权限过滤始终兜底（双保险）
- **混合检索加速层**：pgvector（BAAI/bge-m3）+ 全文检索（BM25/pg_trgm）+ GraphRAG + Reranker，Corpus-Agnostic，拒绝业务硬编码
- **RBAC 权限中心**：组织树 + 行业库 ACL + 管理员关系；**数据库 RLS 已移除，权限语义全部由应用层（PermissionService）负责**，边界清单见 [docs/RLS-BOUNDARIES.md](docs/RLS-BOUNDARIES.md)
- **模型后台可配**：LLM / Embedding / Reranker 三类独立配置，多供应商切换

## 仓库结构

```
apps/
  api/            NestJS 后端（Chat、权限中心、Brain Compiler 编排、管理 API、MCP/OpenAPI）
  web/            Next.js + React 前端（对话端 + 管理后台）
  parser-worker/  Python 文档解析服务（多格式 → Markdown）
packages/
  database/       Prisma schema 与迁移
  gbrain-adapter/ gbrain 单人脑引擎适配层
  shared-types/   共享类型
tests/
  e2e/            Playwright 端到端套件
  evaluation/     220+ 金标问题评测、质量门禁、国际基准（BEIR 等）
  functional/ integration/
deploy/           Docker Compose、监控、备份恢复
scripts/          部署与多实例编排（bootstrap-new-server / deploy-prod / provision-instance）
```

## 快速上手

```bash
pnpm install
pnpm build          # 全量构建
pnpm test:all       # API 单测 + parser 契约测试
pnpm test:kb        # 知识库端到端套件
pnpm evaluate       # 金标问题评测
```

本地开发：`pnpm dev`（turbo 聚合，需先配置 `.env`，参考 `.env.example`）。

## 部署

仅支持脚本化发布（内置隔离性、数据库权限与迁移预检门禁），**严禁未经用户明确指令直接发生产**（见 [AGENTS.md](AGENTS.md) §1）：

```bash
bash scripts/bootstrap-new-server.sh          # 新服务器初始化底座 + 共享中间件
bash scripts/deploy-prod.sh --target=inst1    # 首次发布实例 1
bash scripts/provision-instance.sh 2          # 扩容实例 N（专属 DB + Redis DB）
bash scripts/deploy-prod.sh --target=all       # 全实例发布
```

多实例共享全局 PostgreSQL / Redis / Parser-Worker / MinIO / Nginx；实例 N 使用专属数据库 `llmwiki_instN` 与 `REDIS_DB=N-1` 物理隔离。详见 [deploy/MULTI_INSTANCE_GUIDE.md](deploy/MULTI_INSTANCE_GUIDE.md)。

## 测试与质量门禁

- 单测/契约：`pnpm test:all`；E2E：`pnpm test:kb`（Playwright）
- 评测：`pnpm evaluate`（220+ 金标问题）→ `pnpm gate`（质量门禁）→ `pnpm ci`
- 国际基准：`pnpm benchmark:intl`（BEIR/SciFact/2Wiki 等，每数据集抽样 ≤100 条）
- 越权回归：权限逻辑改动必须保持越权测试矩阵全绿（应用层边界见 docs/RLS-BOUNDARIES.md）

## 版本

当前版本 v50.0（权限治理与授权体验大版本：RLS 移除、行业库角色只读全貌视图、穿梭树用户选择）。历史发布记录见 [docs/archive/](docs/archive/)。
