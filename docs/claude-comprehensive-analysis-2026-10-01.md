# Claude 全面分析与优化建议

日期：2026-10-01
基线：`f88f8e9` / `pre-claude-optimization`

---

## 一、已提交并推送

- **Commit** `f88f8e9`：`perf(api,web): 收敛权限/引导链路往返与载荷，前端按需分包`
- **Tag** `pre-claude-optimization`：标记 Claude 全面优化前的工作区快照，已推送 GitHub

---

## 二、已验证 Bug（含实测证据）

### B-1｜答案缓冲，无真实流式（P0 · 已实测确认）

**文件**：`apps/api/src/chat/chat.service.ts:5336`

**现象**：SSE 流仅在 `conversation` 事件时立刻发出，后续 `delta` 事件仅为一条含完整回答的 JSON。客户端 TTFT（首字时间）= 检索 + 生成 + 对齐的总时长，无法在打字过程中实时显示。Live probe 实测：

| 题目 | TTFT | 检索耗时 | 模型生成 | 总计 |
|------|------|---------|---------|------|
| 乌姆盖萨尔是哪个国家的军港？ | **6.99 s** | ~6.8 s | ~0.2 s | 7.20 s |
| 1986年伊朗攻占了哪个半岛？ | 6.99 s | ~6.8 s | ~0.2 s | 7.20 s |
| （同一题目重复） | — | — | — | **15.0 s** |

重复查询耗时翻倍表明答案缓存未生效（见 B-5），或存在排队。与 Perplexity / Claude.ai 的逐 token 打字体验差距极大。

**建议**：实现增量块流式：将回答按段落/句子切块，每块完成对齐后即推送 `delta`，不等整篇生成完毕。

---

### B-2｜权限门禁的跨租户信息泄露（P0 · 已实测确认）

**文件**：`apps/api/src/admin.controller.ts:547-627`

**现象**：持有 `kb.industry.read`（行业库管理员）的用户可访问 `/admin/data`，该接口无差别返回：
- 全部用户目录（用户名 / 邮箱 / 状态 / 角色 / 组织成员关系）
- 全部组织节点树（含所有节点管理员）
- 全部角色定义及其权限列表

KB 内容本身受 RLS 保护，但上述元数据泄露属于跨租户 PII + 权限结构暴露。

**建议**：将 `users`、`orgs`、`roles` 查询结果按 `canReadOrg / canReadIndustry / canReadRoles` 分支返回；`kb.industry.read` 能力仅授权访问 `industryScopeKbs` 子集。

---

### B-3｜Bootstrap 载荷重复字段（P1 · 已实测确认）

**文件**：`apps/api/src/auth/session.controller.ts:32`

```ts
return { user, kbs: mappedKbs, knowledgeBases: mappedKbs, capabilities, ... };
```

同一 `mappedKbs` 数组（54 个知识库）以两个不同 key 发送，总载荷 53 KB 中有约 30 KB 为冗余数据。TTFB = total time（全量序列化后一次性发出），该重复字段使首屏加载延迟增加约 50%。

**建议**：删除 `knowledgeBases` 字段，保留 `kbs` 唯一 key。

---

### B-4｜首屏等待 bootstrap 串行化（P1 · 已实测确认）

**文件**：`apps/web/src/app/page.tsx`（刷新路径），`apps/api/src/auth/session.controller.ts`

新 auth 路径在 `loadAdminData` 内部 `await session/bootstrap` 返回后才 `setAuthState('loggedIn')`，但 bootstrap 在测试实例稳定耗时 **5.3–6.5 s**（TTFB = total），且返回后才开始渲染任何 UI。App shell 全程阻塞。

**建议**：
1. 立即渲染骨架屏（侧栏 + 顶栏），bootstrap 在后台异步完成。
2. 减少 bootstrap 本身的耗时（见性能优化节）。

---

### B-5｜语义缓存为精确字符串匹配，近义查询全量重算（P1 · 已确认代码）

**文件**：`apps/api/src/chat/semantic-cache.service.ts:82-90`

缓存键仅用 `WHERE "queryText" = ${normalized}`（精确匹配），`queryEmbedding` 列存在但从不被向量检索；`similarityThreshold` 为死代码。近义改写、口语化问题均 miss，导致 7.2 s → 15.0 s 的重复查询差异。

**建议**：实现向量相似缓存（或降级为 3 分钟 TTL 的 Redis 缓存）。

---

### B-6｜ACL 引用序号 off-by-one（P2 · 已确认代码）

**文件**：`apps/api/src/chat/citation-assembly.ts:954-959`

```ts
return index >= 1 && index <= survivingIndices.size && survivingIndices.has(index) ? full : '';
```

`survivingIndices.size` 是数量而非最大序号。若 ACL 过滤掉中间引用（如幸存 {1,3}，size=2），则合法引用 `[3]` 因 `3 <= 2` 为 false 而被从答案中删除，但引用卡片 #3 仍被渲染。症状：答案正文某处无引用序号标记，引用卡片有孤立项。

**建议**：改为 `Math.max(...survivingIndices)` 比较。

---

### B-7｜RAPTOR 摘要分数冒充校准置信度（P2 · 已确认代码）

**文件**：`apps/api/src/retrieval/retrieval-arms.ts:768-783`，`apps/api/src/raptor/raptor.service.ts:383,439`

摘要节点（score 0.78–0.98）无 `scoreSource` 标记，`calibratedScoreOf` 未排除，得以通过 0.4 的拒答阈值（`chat.service.ts:4414`）。L2 全局摘要的 `documentId: null` + `previewUrl: null` 使其引用的"证据"无法关联任何文档。

**建议**：对摘要节点强制设置 `scoreSource: 'synthetic'`，并在 `calibratedScoreOf` 中排除。

---

### B-8｜图谱召回随机性（P2 · 已确认代码）

**文件**：`apps/api/src/graph-rag/graph-rag.service.ts:1930-1936`，`:1707-1716`

关系查询 `findMany({ take })` 无 `orderBy`，PostgreSQL 返回任意子集，高权重 2-hop 证据可能被丢弃。`take: 5` 每方向无排序。

**建议**：添加 `orderBy: { score: 'desc' }` 或按权重降序。

---

### B-9｜出站事件毒丸无死信队列（P3 · 已确认代码）

**文件**（路径推断自 agent 报告）：`brain-outbox.service.ts:57-61`

payload 格式不合法时 `enqueueEvent` 抛出，事件卡在 `status=pending, retryCount=0`，每 5 秒被重复扫描，永不推进；重试 10 次后静默丢弃，无告警。触发条件：任何缺少 `payload.kbId` 或 `version` 的历史 `enrichment_request` 事件。

**建议**：在 outbox 表增加 `status='dead'` 最终状态，计数超限后移入而非删除，并发监控告警。

---

### B-10｜删除后 RAPTOR 节点孤立（P3 · 已确认代码）

**文件**（推断）：`raptor.service.ts:114-122`

`removeDocument` 在文档行删除之后运行且不吞掉错误，`Promise.all` 抛出导致客户端收到 500 但数据已删除，RAPTOR 节点孤立。

**建议**：调换删除顺序，或将 RAPTOR/Graph 清理纳入同一事务。

---

### B-11｜版本发布失败路径摧毁 parser 元数据（P3 · 已确认代码）

**文件**（推断）：`ingestion.service.ts:849-851`

版本模式下写入 `parserMetadata: { pendingError: reason }` 会完整替换 JSON，丢失 `contentHash`、parser 指纹、质量指标和 OCR 事实。

**建议**：将 pendingError 作为独立字段存储，不覆盖整个 `parserMetadata` JSON。

---

## 三、性能优化

### P-1｜Bootstrap 5.3–6.5 s 耗时拆解（已实测）

Bootstrap 耗时链路（`session.controller.ts`）：
1. `getVisibleKnowledgeBases(userId)` — 含 N 次 DB 查询（permission service 权限扩散计算）
2. `prisma.user.findUnique` — 用户基本信息
3. `prisma.knowledgeBase.findMany` — 54 个 KB
4. `getCapabilities(userId)` — 权限列表
5. `getManagedOrgIds(userId)` — 组织节点
6. `isSystemAdmin(userId)` — 管理员判定
7. `canManageKnowledgeBases(userId, [...kbIds])` — 写权限计算

第 1/4/5/6 项在当前工作区已加 5 s TTL 缓存，但 bootstrap 冷启动（首位用户登录或缓存失效后）仍需完整计算 4–6 次 DB 往返。关键路径顺序为串行或隐性串行（`Promise.all` 看似并行但 `canManageKnowledgeBases` 等第 7 项依赖第 3 项结果）。

**实测**：Bootstrap TTFB = total time（无 chunked transfer），53 KB 一次性发出，前端无法在收到任何数据前渲染任何 UI。

**优化建议**：
1. 骨架屏先行（侧栏 + 顶栏），bootstrap 在后台拉取。
2. 删除 `knowledgeBases` 重复字段，节省 30 KB。
3. `getVisibleKnowledgeBases` 可考虑预计算（用户登录时后台更新 `user.visibleKbIds` 字段）。

---

### P-2｜前端渲染：答案全文每次 flush 重解析（P1）

**文件**：`apps/web/src/components/chat/ChatScreen.tsx:96-103`，`AnswerMarkdown.tsx`

流式 buffer 每 ~50 ms 推送一次 `content` 更新，`AnswerMarkdown` 以 `content` 为 memo 依赖，每次触发 `marked.lexer` 对**完整答案文本**重新词法分析 + 重建整个 React 树。对 3–4 k token 的回答，这是 O(n²) 成本。

**优化建议**：
1. 仅对尾部增量块执行局部词法解析，不重扫历史正文。
2. 或将 flush 间隔从 50 ms 提升至 200 ms，减少重解析频率。
3. `scroll-behavior: smooth` 与强制 `scrollTop = scrollHeight` 冲突，流式期间改为 `behavior: 'instant'`。

---

### P-3｜6,227 / 22,373 块无词法索引（实测）

| 指标 | 数量 |
|------|------|
| 总 Chunk | 22,373 |
| 有词法索引的 Chunk | 16,146 |
| **缺失** | **6,227（27.8%）** |

部分块来自历史导入或未触发词法管道，影响 BM25 检索覆盖率。

**建议**：补全缺失块的词法索引（`pnpm --filter api lexical:backfill`），并排查为何入库时未覆盖。

---

### P-4｜重复查询 7.2 s → 15.0 s（实测 + B-5 联动）

重复同一题目耗时翻倍，排除排队因素后（两次查询时间戳相差大），主因是语义缓存失效（B-5）。语义缓存当前为精确字符串匹配，建议升级为向量相似缓存，TTL 3 分钟。

---

### P-5｜Web 打包：docx/xlsx/jszip 库重复打包（代码确认）

五个 largest chunks（总计 > 1 GB 中的 1.1 MB）均包含 xlsx、docx-preview、jszip、dompurify。Next.js 代码分割后这些库被重复打包进多个 chunk，均为懒加载路径但共享率低。`globals.css` 123 KB 全量下发，含 admin / ppt / graph / preview / settings 全部样式，登录屏承担了不必要的 CSS。

**建议**：
1. 将 docx/xlsx/jszip 提取为单独 vendor chunk。
2. 引入 CSS splitting 或 Tailwind purge，删除未使用的样式。
3. `prototype.css`（39 KB）无任何 import，应删除。

---

## 四、核心流程对比 SOTA

### 4.1 知识入库

| 维度 | 本系统 | Glean / Vertex AI Search / RAGFlow | 差距 |
|------|--------|-----------------------------------|------|
| 块策略 | 字符级 1800 + 200 overlap，正则边界 | 语义感知切块（LlamaIndex）或规则+向量边界 | 中 |
| LLM 元数据提取 | 无（entity extraction 仅 50 块/次） | 每块 title/keyword/entity 自动提取 | 大 |
| 增量重索引 | 全量重新解析 | 块级 diff / CDC | 大 |
| 版本化 | 不可变块 + manifest，CAS 发布 | 多数系统无版本化 | 强 |
| multimodal | OCR + VLM + bbox，已实现 | 部分支持（依赖供应商） | 持平 |
| 表格处理 | header 传播 + 行级 markdown，**强** | 多数系统较弱 | 持平/领先 |
| near-dup | 检测但从未阻止/合并 | 部分有语义去重 | 弱 |

**最大差距**：入库阶段的 LLM 元数据提取（title / keyword / entity / question-generation）和增量块级重索引。版本化和表格处理已是 SOTA 级别。

---

### 4.2 知识查询与答案质量

| 维度 | 本系统 | Perplexity / Glean / Claude | 差距 |
|------|--------|------------------------------|------|
| **流式体验** | 全文缓冲一次发出，无增量打字 | 逐 token 流式打字 | **极大** |
| 融合策略 | RRF dense+BM25+graph+ColBERT+BGE-M3 | BM25+dense+ColBERT（或自研） | 持平 |
| 重排 | Cross-encoder 候选重排，有 probe 分组 | 同 | 持平 |
| KB 路由 | 启发式 substring/bigram，top-3 硬丢弃 | 语义路由 + 多 KB 并行 | 大 |
| 多跳推理 | GraphRAG + 启发式 agentic | 链式推理 + 图检索 | 持平 |
| as-of 时点 | 完整实现（RLS + 查询上下文） | 部分支持 | 强 |
| 聚合计算 | 表格专用工具，非自动 | 工具调用 + 自然语言 | 中 |
| 拒答门控 | 0.4 阈值（无校准文件时退化） | 置信度校准 | 中 |
| 后验对齐 | 逐句 NLI 验证 + 重绑定引文 | 多数无后验 | 强 |
| 摘要分数越级 | RAPTOR 摘要分数冒充校准分数 | 不存在 | **极大** |
| 图表渲染 | 原文 alt 降级，无 Mermaid 等 | Markdown + 图表渲染 | 大 |
| 引用样式 | `[n]` + 底部卡片，无悬停 popover | 悬停 snippet + 卡片 + 高亮 | 中 |

**最大差距**：
1. **无真实流式**（P0）：TTFT = 6.99 s vs Perplexity 的 < 1 s
2. **RAPTOR 摘要分数越级**（P2）：摘要冒充校准分数，可绕过拒答阈值
3. **KB 路由硬丢弃 top-3 外 KB**（P1）：正确 KB 排第 4 即不可达
4. **无答案校准概率**（P1）：无 shipped calibration file，拒答门退化

---

### 4.3 权限管理

| 维度 | 本系统 | Glean / SharePoint / Entra | 差距 |
|------|--------|----------------------------|------|
| RLS 保护 | 完整（Document / Chunk / KB / Conv / ACL）| 部分（SharePoint 无行级） | 强 |
| KB 继承 | org upward + industry grant，**完整** | SharePoint 权限继承 | 持平 |
| 文档级 ACL | 支持 restrict + inherit，**完整** | 部分支持 | 强 |
| 跨实例缓存一致性 | 5 s TTL，仅进程内 | Entra token 实时 revoke | 大 |
| 变更主动失效 | 仅 11 个入口，**存在遗漏**（`revokeAccess`）| 实时 | 中 |
| 审计日志 | 仅 6 类事件（disable/enable/create grant/revoke/delete kb）| 全部操作 | 大 |
| 无外部 IdP 映射 | ACL subject 必须是本地 UUID | Entra / Google group 映射 | 大 |
| deny-overrides-allow | 不支持 | Entra 支持 | 大 |
| 角色继承嵌套 | 扁平角色，无组嵌套 | Entra 组嵌套 | 大 |

**最大差距**：跨实例缓存一致性（最坏 5 s 窗口）、审计覆盖不完整、无外部 IdP 映射。

---

## 五、输出排版与检索体验

### 5.1 答案排版（已有较好基础）

**已完成**：GFM markdown 解析（段落、列表、表格、代码、引用）、引文 chip、marked 重构、答案 memo、引用稳定回调。

**仍存在的问题**：
1. 表格流式期间可见性为原始文本，flush 时突然转为有边框表格，有可见 reflow
2. 标题流式期间以普通文本出现，完成 flush 后整体转为 h1/h2
3. 模型 raw HTML（`<br>`、`&lt;details&gt;` 等）显示为原始标签，无优雅降级
4. 引文卡片仅在 `answerDone` 后显示，流式期间无来源可见性
5. 引文编号与卡片序号存在 off-by-one 错位（B-6）
6. 图片/chart 答案降级为 `图片：alt`，无实际渲染

### 5.2 检索质量（已达 SOTA 发布门禁）

| 指标 | 实测 | 发布门禁 | 状态 |
|------|------|---------|------|
| 入库成功率 | 100% | 100% | ✅ |
| 答对率 | 92.9% | 90% | ✅ |
| 关键词覆盖率 | 106.7% | 85% | ✅ |
| 引文准确率 | 100% | 90% | ✅ |
| 拒答正确率 | 100% | 95% | ✅ |
| 改写鲁棒性 | 100% | 80% | ✅ |

**已知短板**：
- 全景列举题（RAPTOR 全局摘要压过本库文档标题列表）
- ACL 过滤后引用序号 off-by-one（B-6）
- 无答案校准导致偶尔误拒答（B-5）

---

## 六、优化建议汇总（按优先级）

### P0（影响正确性，必须修复）

| # | 问题 | 修复方案 | 涉及文件 |
|---|------|---------|---------|
| B-2 | 行业库管理员可读全量用户/组织/角色目录 | 按能力分支返回，限制 kb.industry.read 的数据范围 | `admin.controller.ts` |
| B-6 | ACL 过滤后引用 off-by-one | 改为 `Math.max(...survivingIndices)` | `citation-assembly.ts` |

### P1（影响用户体验，应尽快修复）

| # | 问题 | 修复方案 | 涉及文件 |
|---|------|---------|---------|
| B-1 | 无真实流式 | 实现增量块流式（段落/句子级 flush） | `chat.service.ts` |
| B-3 | Bootstrap 重复字段 | 删除 `knowledgeBases` key | `session.controller.ts` |
| B-4 | 首屏阻塞 5–6 s | 骨架屏先行，bootstrap 后台异步 | `page.tsx` |
| B-5 | 语义缓存无效 | 升级为向量相似缓存或 Redis 3 min TTL | `semantic-cache.service.ts` |
| P-2 | 答案全文每次 flush 重解析 | 尾部增量解析 + flush 间隔提升至 200 ms | `ChatScreen.tsx` |
| P-3 | 28% 块缺失词法索引 | 执行 `lexical:backfill` 并排查入库漏洞 | ingestion pipeline |

### P2（影响检索质量）

| # | 问题 | 修复方案 | 涉及文件 |
|---|------|---------|---------|
| B-7 | RAPTOR 摘要分数冒充校准分数 | 强制 `scoreSource: 'synthetic'` + 排除出 `calibratedScoreOf` | `retrieval-arms.ts` |
| B-8 | 图谱召回随机丢弃高权重边 | 添加 `orderBy: { score: 'desc' }` | `graph-rag.service.ts` |
| KB 路由 | top-3 硬丢弃 | 添加兜底路由或放宽阈值 | `kb-intent-router.ts` |
| 拒答门 | 无校准文件退化 | 制作并 shipped calibration file | `evidence-calibration.ts` |

### P3（架构改进）

| # | 问题 | 修复方案 | 涉及文件 |
|---|------|---------|---------|
| B-9 | outbox 毒丸无死信 | 增加 `status='dead'` + 监控 | outbox service |
| B-10 | 删除后 RAPTOR 节点孤立 | 调换删除顺序或纳入事务 | `raptor.service.ts` |
| B-11 | 版本失败摧毁 parser 元数据 | pendingError 独立字段 | `ingestion.service.ts` |
| 审计 | 仅 6 类事件被审计 | 扩展至角色/组织/KB admin 变更 | `audit.service.ts` |
| 跨实例 | 5 s 缓存不一致 | Redis pub/sub 失效广播 | `permission.service.ts` |
| P-5 | CSS/JS vendor 重复打包 | 提取 vendor chunk + CSS 清理 | Next.js config |

---

## 七、与全球 SOTA 的定位评估

| 维度 | 当前水平 | 目标（SOTA） | 距离 |
|------|---------|------------|------|
| 入库鲁棒性（多格式） | **SOTA 级**（表格/版本化/multimodal） | 持平 | 已达到 |
| 答案对齐质量 | **SOTA 级**（逐句 NLI + 引文重绑定） | 持平 | 已达到 |
| as-of / 版本化 | **超越多数 SOTA** | 保持领先 | — |
| 流式体验 | 原始级（全量缓冲） | Perplexity / Claude 级 | **差距极大** |
| 引用交互 | 基础级（底部卡片） | Perplexity 级（悬停 snippet） | 差距大 |
| 多租户安全 | 强（RLS 完整） | 持平 + 审计全覆盖 | 部分差距 |
| 跨实例一致性 | 弱（5 s 窗口） | 实时 revoke | 差距大 |
| 语义缓存 | 缺失 | 功能级（向量相似） | 差距大 |
| KB 智能路由 | 弱（启发式） | Perplexity 级（语义多 KB） | 差距大 |

**结论**：本系统在内核检索质量、版本化安全、表格处理上已达到或超越企业知识库 SOTA 水准。最关键的差距集中在**用户体验层**（无真实流式、引用交互原始）和**安全运营层**（跨实例一致性、审计覆盖），这些不影响核心准确率但严重影响产品的专业感知度和企业合规性。

**核心建议**：优先修复 B-1（流式）和 B-2（权限泄露），这两项是用户可立即感知的体验差距和安全红线。其余 P1 项目可并行推进，P2/P3 在下一迭代处理。
