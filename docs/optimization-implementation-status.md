# 准确性优先与上游复用优化实施台账

更新：2026-09-07。范围为主项目，不包含 `3dbuilding`。本文件记录 P0 至 P3 各阶段详细实施进展与验收结果。

依据：[企业知识问答准确性优先升级方案](accuracy-first-gbrain-weknora-anydoc-optimization-plan.md) 与 [源码复核与优化方案](source-review-weknora-anydoc-2026-09-06.md)。不修改 GBrain、WeKnora、AnyDoc 上游源码。

---

## 1. 核心架构优化状态汇总（P0 - P3）

| 阶段 / 事项 | 实施状态 | 交付文件与改动说明 | 验证结果 |
| --- | --- | --- | --- |
| **P0 评测体系** | ✅ 已交付 | `tests/evaluation/golden-dataset.json` (50题真实基准集)<br>`tests/evaluation/run-evaluation.ts`<br>`tests/evaluation/run.sh` | 覆盖条款精确查询、清单统计、多文档对比、扫描OCR、未授权越权、空文档乱码等。自动化回放运行正常 |
| **P0 条款切分** | ✅ 已交付 | `apps/api/src/ingestion/markdown-chunker.ts`<br>`apps/api/src/ingestion/markdown-chunker.spec.ts` | 中文数字解析、`第X[章节条]`（≥3 条激活条款分块）、保留 `article_no`、`chapter_no`、`page_no` |
| **P0 图谱迁移** | ✅ 已交付 | `packages/database/prisma/migrations/20260907135700_add_graph_tables/migration.sql` | 包含 `GraphEntity`, `GraphRelation`, `GraphCommunity` 及其索引外键，空库 migration 成功 |
| **P0 入口收敛** | ✅ 已交付 | `apps/parser-worker/src/main.py` | 禁用 Worker CLI AnyDoc 调用，收敛至 API 官方 `@firecrawl/anydoc` (0.2.4) |
| **P0 Outbox完整**| ✅ 已交付 | `apps/api/src/auth/auth.service.ts`<br>`apps/api/src/admin.controller.ts` | 用户创建、更新、停用、行业授权等写路径全部纳入 `prisma.$transaction()` |
| **P0 三层权限** | ✅ 已交付 | `apps/api/src/chat/chat.service.ts` | `emitCitationsAndComplete` 发出引用前独立查询数据库复核 `published` 与可见 KB |
| **P1 Adapter单例**| ✅ 已交付 | `apps/api/src/brain-compiler/brain-adapter.provider.ts`<br>`apps/api/src/chat/chat.service.ts` 等 5 处 | 全局 DI 单例注入，共享单进程并发控制、`queryCache`、`sourceSyncLocks` |
| **P1 Token校准** | ✅ 已交付 | `apps/api/src/ingestion/markdown-chunker.ts`<br>`apps/api/src/chat/context-budget.ts` | 废弃 `length / 4`，采用中英混排校准算法 `estimateTokens` |
| **P1 页面分块** | ✅ 已交付 | `apps/api/src/ingestion/markdown-chunker.ts` | 识别 `(?:^\|\n)##\s*第\s*(\d+)\s*页`，支持扫描 PDF / PPTX 页级检索与绑定 |
| **P1 OCR元数据** | ✅ 已交付 | `apps/api/src/ingestion/ingestion.service.ts` | 解析结果结构化持久化 `ocr_original_pages`, `ocr_routed_pages`, `ocr_model`, `parsed_at` |
| **P1 版本冲突** | ✅ 已交付 | `apps/api/src/chat/chat.service.ts` | 新增 `version_conflict_check` 阶段，LLM 上下文注入警示，Citation 标记 `versionConflict` |
| **P1 统一引用** | ✅ 已交付 | `apps/api/src/chat/chat.service.ts` | 引用结构包含 `preview_url`、`version`、`page_no`、`version_conflict` 字段 |
| **P2 高级门禁** | ✅ 已交付 | `apps/api/src/ingestion/content-quality.ts`<br>`apps/api/src/ingestion/content-quality.spec.ts` | 升级为 `content-v2`，新增条款编号连续性、表格完整性、低页面文字覆盖率（<40%）拦截 |
| **P2 语义覆盖率**| ✅ 已交付 | `apps/api/src/chat/chat.service.ts` | 回答实质陈述与引用文本严格比对（`[n]` 或 ≥70% 重叠），<50% 触发 Trace 警示并记录 |
| **P2 图谱边溯源**| ✅ 已交付 | `apps/api/src/graph-rag/graph-rag.service.ts` | 关系边存储 `documentVersion`，按 `documentId + version + chunkId` 累积去重追加 `provenance` |
| **P2 中断级联** | ✅ 已交付 | `apps/api/src/chat/chat.service.ts` | 修复 `handleChatStream` 的 `AbortController` 绑定，向 `rewriteQuery` 与 `gbrain.query` 传递 signal |
| **P3 WeKnora灰度**| ✅ 已交付 | `apps/api/src/retrieval/weknora.provider.ts`<br>`apps/api/src/retrieval/weknora-provider.spec.ts`<br>`apps/api/src/chat/chat.service.ts` | 增加 `weknora_retrieval` 阶段；默认 Shadow 模式评估外部与主源重合率，不污染回答；支持 Hybrid 融合 |
| **P3 Agent/MCP** | ✅ 已交付 | `apps/api/src/chat/chat.controller.ts`<br>`apps/api/src/chat/chat.service.ts` | 开放 `POST /api/v1/chat/search` 与 `searchKnowledgeForAgent`，支持带 ACL 复核的只读结构化查询 |
| **P3 链路诊断** | ✅ 已交付 | `apps/api/src/chat/conversation.controller.ts` | 新增 `GET :conversationId/messages/:messageId/trace` 专用链路诊断查询端点 |

---

## 2. 自动化测试与质量验证全景

- **API 单元测试 (NestJS Jest)**:
  - **19 个测试套件 / 108 个测试用例全部通过** (`npm test` in `apps/api`)
  - 覆盖范围：
    - `ingestion-quality.spec.ts` (质量门禁 v2)
    - `chat.service.spec.ts` (问答全流程 21 阶段、条款引用、语义覆盖率、版本冲突、WeKnora 灰度、Agent 只读检索)
    - `weknora-provider.spec.ts` & `weknora-client.spec.ts` (WeKnora DI 提供者及只读契约)
    - `admin-outbox.spec.ts` (Outbox 事务边界与补投)
    - `brain-adapter.provider.ts` & `brain-compiler.*.spec.ts` (Adapter DI 单例、编译器与队列处理器)
    - `markdown-chunker.spec.ts` (条款级分块、页面识别与 Token 估算)
    - `graph-rag.service.spec.ts` (图谱抽取与多 Chunk 溯源累积)
    - `permission.service.spec.ts` (ACL 过滤)
    - `model-config.service.spec.ts` & `model-credential.spec.ts` (模型配置热缓存与加密)
- **Parser Worker 测试 (Python Pytest)**:
  - **9 passed, 4 subtests passed** (`python3 -m pytest tests/ -q` in `apps/parser-worker`)
  - 覆盖范围：鉴权、容量限制、文件生命周期清理、四分类与百度 OCR 调度。
- **GBrain Adapter 契约测试 (Node.js)**:
  - **10 项真实子进程契约测试全部通过** (`node run-contract.test.cjs` in `packages/gbrain-adapter`)
  - 覆盖并发额度共享、真实取消终止、输出 8 MiB 截断、去重与参数隔离。
- **前端 Web (Next.js)**:
  - `npx tsc --noEmit` 0 错误通过。
  - DOMPurify 净化 Markdown 渲染，生产 CSP 移除 `unsafe-eval`。
  - 前端具备 21 阶段可折叠执行链路展示（状态、耗时、详细诊断参数）。
- **后端 API (TypeScript)**:
  - `npx tsc --noEmit` 0 错误通过。

---

## 3. 本地运行环境基线

- **Web 前端**: `http://127.0.0.1:3300` (运行正常)
- **API 后端**: `http://127.0.0.1:3302/health` (运行正常)
- **Parser 服务**: `http://127.0.0.1:3210/health` (运行正常)
- **数据库与向量存储**: PostgreSQL 16 + pgvector (1024 维向量平面)
- **基准评测报告**: `tests/evaluation/results/eval-report-*.json`
