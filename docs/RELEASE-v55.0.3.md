# GBrainKG v55.0.3 — 入库事实保真、共享 Worker 临时盘回收与文档 ACL 修正

发布日期：2026-10-09。基线 `9301d73` / `951c222`，前序 `7efe4a1`（v55.0）。仅修正 v55 入库改造复核中发现的缺陷，不改变发布政策、应用层权限、实例数据库与 Redis 隔离、共享 Parser-Worker 架构。

## 为什么发这个补丁

v55 的全量测试门禁是绿的（API 1,583 / Parser 81），但复核发现**门禁覆盖不到的确定性缺陷**，共 15 项，分事实保真、稳定性、访问控制三类。本补丁逐项修正并补齐回归；所有质量层与隔离集成重新执行并通过。

## 事实保真

| 修正 | 影响 |
| --- | --- |
| `.xls` 合并单元格补齐 `merged_range` | XLS/XLSX 合并契约一致；此前消费方按 `merged_range` 判定继承时，所有 `.xls` 的合并锚点被当作普通单元格 |
| `.xls` 合并继承 `display` 改用锚点格式化值 | 此前同一事实产生 `1234` 与 `1234.0` 两个检索串，`1234.0` 会被索引 |
| 表格区域只上报与自身矩形相交的 merge | 此前无合并的区域声称拥有整表 merge，消费方会误判重复计数或置空 |
| 无缓存公式 `display` 置空 | 公式文本不再作为正文被嵌入和计入 `native_text_chars`；`formula` 字段保留公式文本，新增 `unresolved_formulas` 计数与告警。凡 openpyxl/xlwt 生成的工作簿此前全部命中 |
| 合并表头不再产生 N 个同名 headers | 列名恢复唯一可解析；仅有合并 presentation 且无自身标签的列回退为列字母。Markdown 投影仍用原始标签，视觉一致 |

## 共享 Worker 稳定性

- **孤儿临时文件回收**：`UPLOAD_ROOT` 下全部为瞬时文件，此前没有任何文件系统级回收。一次 OOM/SIGKILL 硬杀会留下 ≤200 MiB 原件、≤200 MiB native 工作目录与 `image-unit-*` 溢出文件，持久卷上永久占用 `PARSER_MAX_TEMP_BYTES`（默认 1 GiB），累计后所有上传 503 且只能人工清理。现启动时强制回收、周期内在预算压力下回收，回收地板为最旧在办任务创建时间（长任务不会被误删），`/resource-metrics` 暴露 `temporaries.owned_bytes` 与 `budget_bytes`。
- `python -m src.main` 恢复可启动，并转发 `--host/--port`（此前硬编码 8100）。
- 图片枚举失败不再以「0 张图片」返回 200。`extract_docx` / `extract_pdf_page_images` 保持宽松以保留 Docling 与 PyMuPDF-less 区域回退，用严格包装器区分「崩溃」与「空文档」。
- `benchmark_structured_excel.py --rows 1` 明确报错；`vlm_extractor` 渲染帧纳入临时盘记账。

## 授权与数据完整性

- QA「同题不同答案」保护改由 `validateQa` 服务端计算 `idProvided`。此前读客户端自报标志位，不带该字段的调用方可跳过保护并覆盖已审核答案。
- `KnowledgeBaseController.getDocument` 追加文档 ACL。此前仅校验 KB 可见性即可取得全部 chunk、原始 Markdown 与完整 `parserMetadata`（现含每张结构化表格的全部单元格）。
- `filterReadableDocuments` 补 `effectiveFrom/effectiveTo/lifecycleStatus` 时间门，与 `readableDocumentSql` 同语料。新增 `documentCurrentlyEffective` 作为 SQL 谓词的唯一 Prisma 镜像；管理面传 `probe: true` 跳过，使已过期候选仍可更新或停用。
- 资产接口未传 `?version=` 时固定到 active published version，不再把重解析中未发布（甚至已中止）的构建当作当前版本返回。
- `QaController` 校验 `kbId` 为 UUID（此前 Prisma 校验错误逃过过滤器变成 500）、清单/预览查询加 `take` 上界、审核读取失败返回 404/400 而非泄漏文件路径。
- `countSchema` 标记 `value_domain_is_sample`，规划器不再把 100 条样例值当作完整值域。

## 发布过程修复

`scripts/sync-shared-parser-deps.sh` 的 `mktemp -d /data/gbrain-parser-deps.XXXXXX` 在生产机因 `/data` 属 root 而 `Permission denied`，导致部署在 `pnpm install` 与 `prisma migrate deploy` 之间中断，共享 parser venv 未同步（pymupdf 缺失、Pillow 未按锁固定）。退到 `$HOME` 也不可行——该机根盘 96% 已满。改为在部署仓库目录（数据盘、部署已写入、必然可写）内建暂存目录，仅当无数据盘候选可用时退到 `$HOME`。

## 验证

| 层 | 结果 |
| --- | --- |
| `pnpm test` | 182 套件 / 1,588 测试通过（v55 为 1,583）；新增 5 项回归 |
| Parser `pytest` | 98 passed + 11 subtests（v55 为 81）；新增 `test_temp_budget.py` 等 17 项 |
| Parser ruff / mypy | 通过；mypy 覆盖 `src` 全部 20 个模块 |
| API/Web tsc、lint、构建 | 通过；Web lint 120 warning / 0 error（与 v55 一致） |
| adapter 契约 / Web 单测 | 17 / 84，0 fail |
| 隔离集成（`run-core-checks.py` 4 套件 + `--ingestion`） | 全部通过 |
| 发布门禁（quality-first） | API/Web 静态检查、core 检查、parser、benchmark 自测、`git diff --check`、指纹复核、answer-layout 与 SOTA 套件 **25/25 通过，0 跳过** |
| GitHub CI | `9301d73` 与 `951c222` 均 success |

真实环境复验：`.xls` 合并单元格经真实 HTTP 解析，`merged_ranges: ['A2:C2']`，锚点与继承单元格 display 一致；孤儿回收端到端复现（放置 300 KiB 源文件、native 目录与溢出文件后启动，`owned_bytes` 归零）；`/ocr-embedded-images` 从 200「0 张图片」变为 500 可重试。

## 部署

| 环境 | 状态 | 验证 |
| --- | --- | --- |
| 演示 `150.158.137.151:50003` | 已部署 | 服务全 active；Web 200；API ready quality-first；Parser 0.5.0；`temporaries` 指标在线；API 指纹 `829f87e5…` |
| 生产 `meetings2` inst1 / `knowledge.5gsailor.com:20080` | 已部署 | 服务全 active；Parser 0.5.0，venv `numpy 2.4.6 / pymupdf 1.28.2 / pillow 12.1.1`（修复前 pymupdf 缺失）；API 指纹与候选构建一致 `829f87e5…`；公网 HTTPS 200；`temporaries` 指标在线 |

发布前快照：`/data/llmwiki/.releases/20261009115358` 与回滚后的新一轮快照；迁移与 v55 相同（82 条）。回滚命令：`bash scripts/deploy-prod.sh --rollback previous --target=inst1`。

## 仍未覆盖

- OCR/VLM/Docling 真实外部模型质量、准确率、成本与生产并发负载未测量。
- 未执行 PDF/图片/归档组合的单一混合压力作业。
- 端到端嵌入仍为确定性测试向量、队列为测试适配器；未声称真实模型准确率或真实 Redis 吞吐。
- 演示与生产的功能验收使用既有语料；本轮未在演示环境重跑 SOTA 套件。

## 关联

- [入库流程大版本发布跟踪](入库流程大版本发布跟踪-2026-10-09.md)
- [入库优化实施待办清单](入库优化实施待办清单-2026-10-09.md)
- [入库优化实施验收报告](入库优化实施验收报告-2026-10-09.md)
- [入库优化修正轮记录](入库优化修正轮记录-2026-10-09.md)
- [v55.0.2 发布说明](RELEASE-v55.0.2.md)
- [v55.0 发布说明](RELEASE-v55.0.md)
