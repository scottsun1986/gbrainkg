# GBrainKG SOTA 全场景测试方案补充（G–K）

> **文档编号**：GBA-TC-2026-09-10-SOTA
> **版本**：v1.0
> **配套基线**：《LLMWiki（GBrainKG）全格式全场景综合测试用例》(GBA-TC-2026-09-08)
> **目的**：在 A–F 六阶段基础上，补齐 SOTA 检索质量、安全隔离、评测闭环与可移植性测试，并给出可量化的 SOTA 验收门槛。

---

## 一、SOTA 达标定义（量化门槛）

质量门禁 `tests/evaluation/quality-gate.ts` 硬门槛（全部满足才算通过）：

| 指标 | 门槛 | 说明 |
|---|---|---|
| Hit Rate | ≥ 0.90 | 期望文档命中率 |
| Keyword Coverage | ≥ 0.85 | 期望关键词覆盖率 |
| Permission Compliance | = 1.00 | 零越权泄漏 |
| No-Answer Compliance | ≥ 0.95 | 反幻觉拒答合规 |
| Faithfulness | ≥ 0.95 | 无引用不成立陈述 |
| Citation Accuracy | ≥ 0.90 | 引用文档正确性 |
| Context Precision | ≥ 0.85 | 期望证据位于 top-1 |

一键执行：`pnpm gate`（或 `bash tests/evaluation/ci-gate.sh`）。

---

## 二、阶段 G：分块与索引质量（8 用例）

| ID | 用例 | 断言 | 对应实现 |
|---|---|---|---|
| G-01 | 条款编号连续性 | 跳跃/重复触发 `content-v2` 门禁 needs_review | `content-quality.ts` |
| G-02 | 表头跨块传播 | 后续块注入表头，`table_headers` 非空 | `markdown-chunker.ts` |
| G-03 | **跨页表格拼接** | 翻页后数据行自动继承表头，`table_header_injected=true` | 跨页 carry 逻辑 |
| G-04 | 表头不跨章节泄漏 | 无关后文不含前表头 | carry 仅限 page section |
| G-05 | 表格行键值语义注入 | 内容含 `列: 值 | ...` 结构化语义 | `parseTableRowsToKeyValues` |
| G-06 | **RAPTOR 章节/全文摘要节点** | `RaptorNode` level 0/1 生成且可被检索 | `raptor.service.ts` |
| G-07 | RAPTOR 增量更新 | 重编译后旧章节摘要被清理，无残留 | 幂等 upsert + prune |
| G-08 | **OCR BBox 提取** | chunk `metadata.bbox/bboxes` 存在，正文无 `<!-- bbox -->` | parser + chunker |

---

## 三、阶段 H：高级检索（12 用例）

| ID | 用例 | 断言 | 对应实现 |
|---|---|---|---|
| H-01 | 复合问题分解 | trace `query_rewrite.subQueries` ≥ 2 | `AgenticRagService.decomposeQuery` |
| H-02 | 对比类问题双对象召回 | 两个比较对象均被引用 | agentic + 多召回臂 |
| H-03 | HyDE 增益 | `HYDE_ENABLED=true` 时生僻问句召回提升 | `generateHypotheticalDocument` |
| H-04 | HyDE 关闭开关 | `HYDE_ENABLED=false` 时 `hyde=false` 且不额外调用 | env 开关 |
| H-05 | 跨源 RRF 融合 | `diagnostics.fusion='rrf'`，跨源证据混排 | `queryMany` RRF |
| H-06 | 强制交叉编码重排 | `FORCE_PLATFORM_RERANK` 默认生效，`reranked=true` | `applyRerank` |
| H-07 | 重排失败降级 | 重排不可用时保留原排序，不报错 | fail-open |
| H-08 | **时序效力裁决** | 多版本同题时 `version_conflict.latestVersion` 正确，旧版 `superseded=true` | 时序裁决 |
| H-09 | 现行版本优先 | 最新版引用排位高于废止版 | 分数降权 |
| H-10 | 弱证据扩检 | 低分弱语义命中触发一次广覆盖扩检 | `assessWeakEvidence` 调用修复 |
| H-11 | 无引用不幻觉 | 无证据时统一拒答，不复述机密编号 | 回答规范 |
| H-12 | 宏观综述命中 | 「总结/概述/有哪些章」命中 RAPTOR 或章节清单 | RAPTOR arm |

---

## 四、阶段 I：缓存与并发安全（8 用例）

| ID | 用例 | 断言 | 对应实现 |
|---|---|---|---|
| I-01 | **缓存范围隔离** | 缩小 KB 子集查询不得命中全范围缓存 | `semanticCacheScopeKey` |
| I-02 | **缓存 ACL 世代失效** | ACL Epoch 变化后旧缓存不命中 | key 含 aclEpoch |
| I-03 | **缓存回放权限复核** | 文档取消发布后缓存引用被拦截并回源检索 | 回放前 ACL 复核 |
| I-04 | 缓存 TTL 清理 | 过期行被定期清理 | `cleanup()` |
| I-05 | **GBrain 超时取消** | 竞态超时后子进程被终止，进程池槽释放 | `AbortController` |
| I-06 | 请求取消级联 | 客户端断开终止在途 GBrain 调用 | request signal 链接 |
| I-07 | 大文档回退有界 | `searchChunksFallback` 受 `RETRIEVAL_MAX_DOC_CHUNKS` 限制 | 加界查询 |
| I-08 | 并发问答稳定 | 10 并发问答无 5xx，`/health` 保持 200 | 进程池 + 限流 |

---

## 五、阶段 J：评测闭环与 CI（6 用例）

| ID | 用例 | 断言 | 对应实现 |
|---|---|---|---|
| J-01 | 门禁脚本可执行 | `pnpm gate` 产出 `quality-gate-report-*.json` | `quality-gate.ts` |
| J-02 | 门禁严格生效 | 任一指标低于 SOTA 门槛时退出码 1 | `allPassed` |
| J-03 | CI 单测层 | `pnpm test:api` 全绿 | `.github/workflows/ci.yml` |
| J-04 | CI 解析器层 | `pnpm test:parser` 全绿 | workflow `parser` |
| J-05 | CI 适配器契约 | `pnpm test:adapter` 全绿 | workflow `adapter` |
| J-06 | **Bad Case 回流** | `ingest-bad-case.ts` 追加回归题且拒绝重复 | 数据飞轮脚本 |

---

## 六、阶段 K：安全与可移植性（8 用例）

| ID | 用例 | 断言 | 对应实现 |
|---|---|---|---|
| K-01 | **CORS 白名单** | 未列域名预检被拒，LAN/localhost 放行 | `main.ts` |
| K-02 | 危险方法/来源 | 陌生 Origin + credentials 不返回 `Access-Control-Allow-Origin` | CORS |
| K-03 | 硬编码密钥扫描 | 仓库与脚本无明文 provider key | 脚本环境变量化 |
| K-04 | 生产密钥不入库 | `.env`、`*.from-prod`、`sync-*.sql` 被 git 忽略 | `.gitignore` |
| K-05 | 容器非 root | Web/Parser 镜像声明非 root 运行（见运维注记） | Dockerfile |
| K-06 | 可移植路径 | 测试脚本不硬编码 `/home/scottsun` | 用环境变量 |
| K-07 | 认证边界 | 无/伪造/篡改 Token 一律 401 | `auth.guard.ts` |
| K-08 | 限流 | 连续失败登录触发 429 | throttler |

---

## 七、执行矩阵（一键）

```bash
pnpm install
pnpm --filter database exec prisma generate --schema=prisma/schema.prisma
pnpm test:all          # API + Parser + Adapter
pnpm gate              # SOTA 质量门禁（需在线的 API 与已初始化语料）
# bad case 回流示例：
npx tsx tests/evaluation/ingest-bad-case.ts --question "…" --keywords "a,b" --doc "x.md"
```

## 八、当前已知差距（诚实记录）

- CORS 已改为白名单；生产部署需通过 `WEB_ORIGIN` 显式登记域名，否则仅 localhost/局域网 IP 放行。
- RAPTOR 需 `RAPTOR_ENABLED=true` 且已有摘要节点后参与检索；默认关闭以避免额外的 LLM 成本。
- 自动 GraphRAG 需 `AUTO_GRAPH_EXTRACT_ENABLED=true`；默认由夜间增量任务处理。
- BBox 视觉高亮已完成解析→分块→引用链路与字段透传；前端 PDF 像素级高亮渲染为后续增强项。
- 质量门禁已提标至 SOTA 阈值；首次跑测预计不达标，需按报告逐项回补语料/修复后再纳入 CI 强制。
