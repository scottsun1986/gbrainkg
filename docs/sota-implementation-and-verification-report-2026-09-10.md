# GBrainKG SOTA 优化实施与验证报告

> **日期**：2026-09-10
> **范围**：安全与正确性（批次 A）、检索质量（批次 B）、知识组织（批次 C）、评测闭环（批次 D）
> **结论**：四批核心能力已落地并通过全层回归；端到端检索、引用、Agentic 分解与 HyDE 已在线验证。

---

## 一、验证结果总览

| 层 | 命令 | 结果 |
|---|---|---|
| API 单元测试 | `npx jest`（apps/api） | **23 套件 / 136 用例全部通过**（基线 115） |
| Parser 测试 | `PYTHONPATH=src python3 -m pytest tests/ -q` | **11 passed, 4 subtests passed** |
| Adapter 契约 | `node --test packages/gbrain-adapter/run-contract.test.cjs` | **10/10 通过** |
| Adapter 构建 | `pnpm --filter @llmwiki/gbrain-adapter build` | 通过 |
| API 生产构建 | `pnpm --filter api build` | 通过 |
| Web 类型检查 | `npx tsc --noEmit`（apps/web） | 通过 |
| 端到端问答 | 真实语料 `系统测试-解析矩阵库` | 锚点事实正确命中；Trace 全阶段输出 |
| 端到端 CORS | 白名单/陌生来源 | localhost/LAN 放行；陌生域名无 ACAO |

---

## 二、批次 A：安全与正确性

| 项 | 改动 | 文件 |
|---|---|---|
| A-1 | CORS 白名单真正生效（`WEB_ORIGIN`+`CORS_ORIGINS`+localhost/字面 IP 放行，其余返回无 ACAO） | `apps/api/src/main.ts` |
| A-2 | 语义缓存范围隔离：key 注入「所选 Source 子集 + aclEpoch + knowledgeEpoch」；回放前做实时 ACL 复核；写入 `cacheFingerprint` | `chat.service.ts` `semantic-cache.service.ts` |
| A-3 | GBrain 查询全程可取消：每请求 AbortController + 硬超时，竞态超时真正终止子进程释放进程池 | `chat.service.ts` |
| A-4 | 修复弱证据升级调用条件矛盾（`shouldEscalate && citations.length===0` 恒假） | `chat.service.ts` |
| A-5 | `searchChunksFallback` 邻居展开加界（`RETRIEVAL_MAX_EXPAND_DOCS`/`RETRIEVAL_MAX_DOC_CHUNKS`） | `chat.service.ts` |
| A-6 | 密钥脚本环境变量化；新增 CI 工作流；`pnpm test:*` 汇总脚本；Jest `maxWorkers` 稳定化 | `scripts/`、`.github/workflows/ci.yml`、`package.json` |

**安全回归证据**：
- 陌生来源 `http://evil.example.com` → `404` 且无 `Access-Control-Allow-Origin`。
- `http://localhost:3200`、`http://192.168.1.50:3200` → `204` 且带正确 ACAO + credentials。

---

## 三、批次 B：检索质量 SOTA

| 项 | 改动 | 文件 |
|---|---|---|
| B-1/B-2 | 接线 Agentic 查询分解 + 多召回臂；新增 HyDE；`planQuery` 统一产出复杂度/子问题/假设文档 | `agentic-rag.service.ts`、`chat.service.ts` |
| B-3 | 跨源 **RRF 融合**（替代原始分数直排）；默认强制平台交叉编码重排（`FORCE_PLATFORM_RERANK`） | `packages/gbrain-adapter/src/index.ts`、`chat.service.ts` |
| B-4 | 主链路**时序效力裁决**：多版本检测 + 生效日期/生命周期排序 + 现行版优先 + 旧版降权与废止提示 | `chat.service.ts` |

**端到端证据**：复杂问句触发 `多跳路由: comparative，分解 3 个子问题，启用 HyDE`；日志显示 LLM 产出 3 条子问题与 HyDE 段落。
**发现的真实缺陷并修复**：推理模型（deepseek-v4-flash）在非流式响应中把正文放在 `reasoning_content`；已增加回退提取并提高 token 预算。

---

## 四、批次 C：知识组织 SOTA

| 项 | 改动 | 文件 |
|---|---|---|
| C-1 | **RAPTOR 递归摘要树**：章节级 + 文档级摘要节点，幂等重建，检索时作为宏观召回臂；`RaptorNode` 表 | `raptor/raptor.service.ts`、`raptor.module.ts`、`schema.prisma` |
| C-2 | **跨页表格拼接**：表头跨 page section 携带；无关章节不泄漏；`table_header_injected` 标记 | `markdown-chunker.ts` |
| C-3 | **OCR BBox 采集与透传**：解析器输出隐藏 bbox 注释，分块提取并剥离，引用层透传 `bbox` | `main.py`、`markdown-chunker.ts`、`chat.service.ts` |
| C-4 | 发布后自动触发增量 GraphRAG（`AUTO_GRAPH_EXTRACT_ENABLED`，fire-and-forget） | `ingestion.service.ts` |

---

## 五、批次 D：评测闭环与 CI

| 项 | 改动 | 文件 |
|---|---|---|
| D-1 | 质量门禁提标：Hit≥0.90、Keyword≥0.85、无幻觉≥0.95，新增 Faithfulness≥0.95 / Citation≥0.90 / ContextPrecision≥0.85 为硬门槛 | `quality-gate.ts`、`ci-gate.sh`、`.github/workflows/ci.yml` |
| D-2 | Bad Case 一键回流脚本；补充 SOTA 测试方案 G–K | `tests/evaluation/ingest-bad-case.ts`、`docs/test-cases-comprehensive-2026-09-10-sota.md` |

---

## 六、重要环境发现（需团队知悉）

本地数据库的迁移历史**领先于当前仓库 working tree**：

```
20260910090000_add_semantic_cache_fingerprint
20260910093000_add_document_temporal_fields
20260910100000_add_raptor_nodes
20260910103000_add_feedback_cases
20260910104500_add_graph_community_hierarchy
20260910110000_add_graph_community_parent_fk
```

这些迁移文件并不在仓库的 `packages/database/prisma/migrations` 中，但已应用到数据库。因此：

1. 已将 `schema.prisma` 对齐真实数据库：`Document.effectiveFrom/effectiveTo/lifecycleStatus/supersedesDocumentId`、`SemanticCache.cacheFingerprint`、`GraphCommunity.fingerprint/parentCommunityId`、`RaptorNode(parentNodeId/metadata, documentId NOT NULL)`。
2. 时序裁决已改为优先使用真实生命周期字段。
3. 由于 `RaptorNode` 已存在，新增迁移改为幂等 `CREATE TABLE IF NOT EXISTS`，避免重复建表冲突。
4. 建议：从部署源补齐上述迁移文件，使仓库迁移历史与生产数据库一致；否则 `prisma migrate deploy` 在不一致环境会告警。

---

## 七、复现与验收命令

```bash
# 1) 依赖与客户端
pnpm install
pnpm --filter database exec prisma generate --schema=prisma/schema.prisma

# 2) 全层回归
pnpm test:api        # 23 suites / 136 tests
pnpm test:parser     # 11 + 4 subtests
pnpm test:adapter    # 10 contract tests

# 3) SOTA 质量门禁（需在线 API + 已初始化语料与鉴权）
pnpm gate            # 阈值见 .env.example

# 4) Bad Case 回流
npx tsx tests/evaluation/ingest-bad-case.ts --question "…" --keywords "a,b" --doc "x.md"
```

---

## 八、遗留与后续增强

1. **前端 BBox 像素级高亮**：后端已贯通 `bbox` 字段，前端 PDF 高亮渲染（PDF.js）为后续项。
2. **评测语料对齐**：`golden-dataset.json` 仍引用占位 KB（`kb-company-policy` 等），与真实语料（`系统测试-解析矩阵库`）不一致，需重基线化后再纳入 CI 强制门禁。
3. **RAPTOR/自动图谱默认关闭**：因涉及 LLM 成本；生产按需开启并观察成本。
4. **容器非 root**：Web/Parser 镜像非 root 化需同步调整卷权限，建议在部署窗口验证后合入。
5. **迁移历史补齐**：见第六节。

---

## 九、补充（同日迭代）：分块级向量语义检索

### 9.1 背景
多库大范围检索时，口语问句（如「员工夏天几点上班」）与制度文本（「夏令时」）存在用词鸿沟；此前仅靠关键词与外部 GBrain 语义，容易漏召回。本次落地**分块级向量嵌入**作为库内语义召回臂。

### 9.2 实现
| 组件 | 说明 | 文件 |
|---|---|---|
| EmbeddingService | OpenAI 兼容 `/embeddings` 客户端，批量/超时/重试/维度校验，全程 fail-open | `embedding/embedding.service.ts` |
| ChunkEmbeddingService | 分块嵌入落库（`Chunk.embedding`，raw SQL），文档级增量 + 全量回填 + 覆盖率 | `embedding/chunk-embedding.service.ts` |
| 摄入自动嵌入 | 发布后 fire-and-forget 嵌入该文档分块 | `ingestion/ingestion.service.ts` |
| 向量检索臂 | `searchChunksByVector`：pgvector `<=>` 余弦近邻，SQL 层按 `kbId` ACL + `published` 前置过滤；与关键词/标题亲和统一打分融合 | `chat/chat.service.ts` |
| 运维接口 | `GET /api/v1/admin/embeddings/coverage`、`POST /api/v1/admin/embeddings/backfill` | `admin.controller.ts` |

开关：`CHUNK_EMBEDDINGS_ENABLED`、`VECTOR_MIN_SCORE`、`VECTOR_SCORE_WEIGHT` 等（见 `.env.example`）。

### 9.3 回填与验证
- 回填结果：**7274 / 7875**（92.4%）；剩余 601 属未发布文档（`needs_review` 599、`indexing` 2），按设计不嵌入，发布后自动补。
- **纯向量验证**：临时 `QUERY_EXPANSION_ENABLED=false`，问「员工夏天几点上班」仍正确答出「夏令时 08:30」，证明语义鸿沟由嵌入直接弥合，无需任何硬编码同义词。
- 最终双臂（LLM 扩展 + 向量）复测三条问题全部正确：夏季作息、考勤第十条（旷工）、EQ-0077 巡检周期。

### 9.4 与硬编码同义词的关系
已废弃此前的 `夏天→夏令时` 映射表，改为**通用 LLM 查询扩展**（`AgenticRagService.expandQuery`，进程内缓存、可开关）；向量嵌入进一步提供不依赖任何词表的语义召回。

### 9.5 附加修复
- 引用校验：标准拒答豁免「语义覆盖率偏低」误报（`refusalExempt`）。
- 语义缓存：key 增加版本盐 `SEMANTIC_CACHE_KEY_VERSION`，检索逻辑升级后旧缓存自动失效。
- 标题亲和召回：命名文档在宽范围多库中不被泛化重复文档挤出。
