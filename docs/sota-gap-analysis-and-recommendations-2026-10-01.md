# GBrainKG 全面分析：缺陷修复、性能与 SOTA 差距（2026-10-01）

基线：`70bf8da`。本文件替代同日的 `claude-comprehensive-analysis-2026-10-01.md`，对其中每条结论重新核验过代码与测试库数据。
本轮修复只改了工作区，未提交、未部署。按 AGENTS.md，发生产需要你的明确指令。

## 一、本轮已修复（已验证）

| 编号 | 问题 | 修复 | 位置 |
|---|---|---|---|
| F-1 | ACL 剥离引用后，合法角标被误删。旧判断用幸存集合的大小当最大序号，幸存 {1,3} 时 `[3]` 被删 | 只按集合成员判断 | `apps/api/src/chat/citation-assembly.ts` |
| F-2 | 图谱关系 `findMany({ take })` 无排序，高权重 1-hop/2-hop 边被随机截断，召回不确定 | 四处查询按 `weight desc, id asc` 排序 | `apps/api/src/graph-rag/graph-rag.service.ts` |
| F-3 | 删除文档时先删行再清图谱/RAPTOR。清理失败则客户端收到 500，文档已没，派生事实成孤儿 | 先做幂等清理，再删文档行 | `apps/api/src/ingestion/ingestion.controller.ts` |
| F-4 | 版本模式下替换构建失败，`parserMetadata` 被整个覆盖，丢失 contentHash、解析指纹、质量与 OCR 信息（影响去重复用） | 合并写入 `pendingError` / `error` | `apps/api/src/ingestion/ingestion.service.ts` |
| F-5 | RAPTOR 宏观摘要的展示分（下限 0.75）在 `retrieval-arms` 注入路径缺少 `scoreSource: 'synthetic'`，可被当作校准分越过拒答门 | 补齐标记 | `apps/api/src/chat/retrieval-arms.ts` |
| F-6 | `session/bootstrap` 同一 KB 数组以 `kbs` 和 `knowledgeBases` 发两遍，首屏载荷约翻倍 | 删除重复字段。前端只读 `kbs`；RLS 隔离脚本改为优先读 `kbs` | `apps/api/src/auth/session.controller.ts`、`docs/test-reports/assets-2026-09-08/run_phase_c.py` |
| F-7 | 流式期间自动滚底与容器 `scroll-behavior: smooth` 冲突，每 50ms 一次平滑动画，最新行常落在可视区下方 | 自动滚底改为 `behavior: 'instant'` | `apps/web/src/components/chat/ChatScreen.tsx` |

验证结果：

- `apps/api` 与 `apps/web` 的 `tsc --noEmit` 均通过；改动文件 eslint 通过。
- 相关 jest：ingestion、auth、graph-rag 共 25 个套件 239 个用例通过；citation 相关 5 个套件 28 个用例通过。
- 已知环境问题：本地 `apps/api/.env` 设置了 `CORE_VERSIONING_ENABLED=1` 与 `CORE_GRAPH_INCREMENTAL_ENABLED=1`，jest 读取后 `graph-rag.service.spec.ts` 有 2 个 inline-rebuild 用例失败。干净的 HEAD 加同一 .env 也失败，与本轮改动无关。建议该 spec 自行固定这两个环境变量。
- 未做：真实 LLM 端到端问答回归（`pnpm gate` / `benchmark:intl`）。F-1、F-2、F-5 会影响答案与召回，发布前应在测试实例跑一遍门禁。

## 二、对旧报告结论的更正

- **P-3「28% 块缺失词法索引」不成立。** 缺失的 6,227 个块中 6,223 个属于已归档的评测库（`EVAL-BEIR-SciFact-Full-20260927*`），文档停在 `indexing`。活跃库仅 2 个块缺失。不影响线上检索。
- **5,184 条失败的 `enrichment_request` 事件**同样来自该次暂停的全量 benchmark（错误信息为 "Full-corpus benchmark paused"），已达重试上限，不再被扫描。建议：清理归档评测库及其事件，并给 outbox 增加 `dead` 终态和告警，避免以后真实失败被这类噪声淹没。
- **B-7 RAPTOR 分数越级**：`raptor.service` 自身路径已标记 synthetic，旧报告引用的路径不准；遗漏点在 `retrieval-arms` 的注入路径，已由 F-5 修复。
- **B-2 行业库角色可读全量用户目录**：属实，但前端行业库面板的「选择管理员」依赖完整用户列表，所以这是产品取舍而非单纯泄露。建议见第四节 R-6，需要你决定。

## 三、未修复的关键问题（需要你决策）

### Q-1 答案没有真正流式（体验差距最大）

`chat.service.ts` 的 grounding gate 把模型输出逐句核验后写入 `OrderedAnswer`，全部完成后才以**一条** `delta` 发给前端。用户的首字时间等于检索、生成、蕴含复核三者之和。旧报告实测首字约 7 秒；Perplexity、ChatGPT 类产品首字通常在 1 秒内。

建议方案「有序前缀流式」：

1. 每当某句通过核验，且它之前所有位置都已确定（通过或丢弃），立即推送该段前缀。
2. 被暂扣的句子只阻塞它之后的内容；暂扣句在结束时复核，通过则补发，后续段落随之放行。
3. 结束时若需整体替换为拒答，追加一个 `replace` 事件，前端用最终文本覆盖。
4. 每次推送前沿用 `assertRequestAuthorization` 的快照校验；`KNOWLEDGE_STRICT_OUTPUT=1` 模式保持整段缓冲不变。
5. 先发「检索中 / 已找到 N 个来源」的阶段事件，让首屏 1 秒内有反馈。

风险：改变 grounding gate 的输出时序，需要用现有 spec 和 `pnpm gate` 全量回归。没有在本轮实施。

### Q-2 首屏仍被 bootstrap 阻塞

`page.tsx` 在 `session/bootstrap` 返回前只显示「正在验证登录状态…」。建议本地有 token 时立即渲染应用骨架（侧栏、顶栏、对话输入框），bootstrap 在后台填充；再把可见 KB 计算结果按用户缓存到 Redis，并随权限 epoch 失效。

### Q-3 语义缓存只做精确匹配

`semantic-cache.service.ts` 以原文精确匹配，`similarityThreshold` 未使用，近义改写全部未命中。建议在相同 scope 指纹与 knowledge epoch 内做 pgvector 近邻查询（阈值 0.96 起步），命中后仍走 `validateEvidenceDependencies`。需要先用改写集评估误命中率。

## 四、与全球主流企业知识库方案对比

对标对象：Glean、Microsoft 365 Copilot / SharePoint、Google Vertex AI Search / Agentspace、Perplexity Enterprise，以及开源 RAGFlow、WeKnora。

### 4.1 知识入库

已经领先：不可变版本与 manifest 发布、表格表头传播、OCR + 版面框、as-of 时点查询、transactional outbox。

| 编号 | 建议 | 主流做法 | 收益 |
|---|---|---|---|
| R-1 | 入库时为每块生成「可回答问题」与关键词（doc2query / HyDE 索引端） | Glean、Vertex 均有同类富化 | 口语化提问召回提升，代价是入库 LLM 成本 |
| R-2 | 块级增量重建：按 block contentHash 只重算变化块的 embedding、词法、图谱 | 主流连接器都做 CDC 增量 | 大文档修改后的入库时延和成本显著下降 |
| R-3 | 近重复文档检测后提供合并或标注「重复来源」 | Glean 做去重折叠 | 减少答案中重复引用 |
| R-4 | 连接器生态（飞书、企业微信、Confluence、SharePoint）与权限同步 | 企业级方案的核心卖点 | 决定能否成为企业唯一入口 |

### 4.2 知识查询

已经领先或持平：dense + BM25 + 图谱 + rerank 融合、逐句蕴含核验与角标重绑定、拒答复核。

| 编号 | 建议 | 说明 |
|---|---|---|
| Q-1 | 有序前缀流式 | 见第三节，优先级最高 |
| R-5 | KB 路由不硬截断 | `kb-intent-router` 只保留 top-3 KB，正确库排第 4 即不可达。建议改为对路由外的库保留低权重召回，或用 embedding 计算库级相关度 |
| R-7 | 拒答阈值校准 | 用评测集拟合分数到正确率的映射并随部署发布；无校准文件时当前退化为固定阈值 |
| R-8 | 追问建议与查询改写可见 | 答案末尾给 2–3 个基于证据的追问；展示「已理解为…」以便用户纠偏 |

### 4.3 答案排版与引用体验

| 编号 | 建议 | 主流做法 |
|---|---|---|
| U-1 | 角标悬停卡片：显示来源标题、片段、页码，点击定位到原文高亮 | Perplexity、Copilot 标配 |
| U-2 | 来源条在生成中即显示（检索完成就推送 citation 预览），不必等答案结束 | Perplexity 先展示来源 |
| U-3 | 流式期间增量渲染：已完成的 Markdown 块冻结，只重解析最后一个块，降低长答案的重复解析 | 主流聊天前端做法 |
| U-4 | 结构化答案模板：结论先行、要点列表、对比用表格、步骤用有序列表，由 prompt 与 `answer-style` 统一约束 | Copilot、Glean 的答案风格 |
| U-5 | 图片与图表：证据中的图片可内联预览；数值对比可选渲染为简单图表 | Copilot 支持 |
| U-6 | 答案操作：复制（含引用）、导出、反馈原因选择，并把反馈接入现有 `feedback-regression` | 主流均有 |

### 4.4 权限管理

已经领先：数据库 RLS 覆盖文档、块、KB、会话；文档级 ACL；evidence dependency 校验缓存与历史回答。

| 编号 | 建议 | 说明 |
|---|---|---|
| R-6 | 管理目录最小化 | 仅持有 `kb.industry.read` 的用户只拿到用户 id 与显示名（用于选管理员），不返回邮箱、角色、组织关系。需要你确认产品取舍 |
| R-9 | 跨实例权限缓存失效广播 | 当前进程内短 TTL 缓存。建议用 Redis pub/sub 在授权变更时广播失效 |
| R-10 | 审计全覆盖 | 角色、组织、KB 管理员、模型配置变更都写审计日志，支持导出 |
| R-11 | 外部身份源组映射 | ACL 主体支持 IdP 组（SCIM / OIDC groups），而非仅本地 UUID |
| R-12 | 显式拒绝优先 | 支持 deny 规则覆盖继承的 allow，满足敏感文档场景 |

## 五、建议执行顺序

1. 发布本轮修复 F-1 至 F-7：先在测试实例跑 `pnpm test` 与 `pnpm gate`，再由你确认发生产。
2. Q-1 有序前缀流式 + U-2 来源先显：体验收益最大。
3. Q-2 首屏骨架、U-1 角标悬停卡片、U-3 增量渲染。
4. R-5 KB 路由、R-7 阈值校准、Q-3 近义缓存：检索质量与时延。
5. R-6、R-9、R-10：权限与合规。
6. R-1、R-2、R-4：入库能力与生态，工作量最大。
7. 清理归档评测库数据，给 outbox 增加 `dead` 终态与告警。
