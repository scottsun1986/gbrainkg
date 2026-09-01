# GBrain 使用机制评估与升级开发方案

> 评估日期：2026-09-01
>
> 项目版本：当前工作区版本
>
> 本机 GBrain 版本：0.47.6.0
> 评估范围：知识入库、Source 设计、组织与个人知识权限、检索与问答、Dream/Synthesize、知识图谱、OpenClaw 个人知识模式及运行保障

## 一、执行摘要

当前项目使用的是真实 GBrain CLI 和 GBrain 数据结构，并非模拟实现。项目已经具备以下正确基础：

- 使用 GBrain Source 承载知识，执行增量 `sync`、混合检索、重排、父文档加载和 `dream`。
- 上传文件先解析为规范化 Markdown，再写入 GBrain；数据库保存业务对象、权限和入库状态。
- 查询前按当前用户权限计算可见知识库，查询后再次用数据库做最终权限校验，采用“检索权限 + 最终业务权限”双保险。
- 对话历史只用于消歧和改写当前问题，未简单把整段历史拼进检索词，方向符合长会话检索的通行实践。
- 采用共享 Source 和权限范围 Source，而不是为每名员工完整复制一份知识，避免了最严重的数据膨胀问题。

但从 GBrain 官方完整能力来看，当前属于“真实接入、核心检索可用、部分最佳实践已经落实”，还不能称为完整发挥 GBrain 能力，主要原因是：

1. Source 目前主要按“相同可见人员集合”生成，而不是按稳定的知识库/内容仓库生成。权限变化会引起 Source 身份变化，增加迁移、清理和选库检索的复杂度。
2. 多 Source 查询是在应用层逐个调用 GBrain 后合并结果，不是 GBrain 官方企业方案中的一次 OAuth `federated-read` 查询。因此跨 Source 的统一排序、图关系和全局推理能力没有完整发挥。
3. 当前对命名 Source 执行的 `gbrain dream --source ...`，按 GBrain 0.47.6.0 的官方实现，只运行确定性的 Source freshness 阶段，不会自动运行跨页 `synthesize`、概念归纳等全局混合阶段。
4. 项目中的“范围派生页”是平台自行生成的文档清单和摘要，并不等同于 GBrain 官方 `synthesize` 产生的、带来源和缺口说明的跨页知识结论。
5. GBrain 能找到正确文档，但对中文长文中的精确条款定位仍可能选错切片。当前答对精确条款，部分依赖加载完整父文档后由大模型二次定位；长文超过上下文预算时仍有漏答风险。
6. 页面中的知识图谱目前是平台用标题、词语共现生成的展示图，不是 GBrain 的 page links、entity、facts 和 graph retrieval 图谱，也没有参与检索。
7. 本地 12 个 GBrain Source 仓库均没有 Git 远端备份，运行检查显示 `BACKUP_LOCAL_ONLY`。这不符合企业知识“Git 作为可审计事实源和灾备”的稳健要求。

最适合本项目的目标方案不是照搬 OpenClaw 的个人助手模式，也不是每人一个 GBrain，而是：

> 一个企业 Brain 数据库 + 每个稳定知识库一个 Source + 动态授权的联合读取 + 数据库最终权限校验 + 权限范围内的 Synthesize/Dream 派生知识。

个人知识库仍使用独立 Source，并且只授权本人；超级管理员也不获得个人库内容读取权限。组织库和行业库按现有业务授权规则动态计算用户可读 Source。只有在权限范围完全一致且来源可追溯时，才生成和使用跨 Source 的总结知识。

## 二、官方 GBrain 机制和最佳实践基线

### 2.1 Brain 与 Source 的官方边界

GBrain 官方把 Brain 定义为一个数据库，把 Source 定义为 Brain 内的命名内容仓库。页面身份由 `(source_id, slug)` 共同确定。官方建议：

- 数据所有者改变时，优先考虑 Brain 边界。
- 所有者相同，但内容仓库、主题或同步来源不同时，使用 Source 边界。
- 多用户企业使用一个 Brain、多个独立 Source；通过 OAuth 限定写 Source，并使用 `federated-read` 对允许的 Source 做硬性读取约束。
- Source 是内容身份和同步边界，不宜随着临时用户集合频繁变化。

这意味着本项目中的“集团总部组织库”“软件测试行业库”“曹杨个人库”天然适合作为稳定 Source；某员工当前能否读取这些 Source，则应由权限层动态决定。

### 2.2 官方检索流程

GBrain 的完整检索栈包含：

1. 查询意图判断和查询扩展。
2. 向量检索、BM25 关键词检索和图检索。
3. RRF 融合、Source-aware 排序、去重和重排。
4. 自动截断与上下文预算控制。
5. CRAG/证据强度判断。
6. 必要时读取完整页面，而不是只依赖搜索切片。

官方建议按问题类型选择操作：

- 已知标题、准确术语：先 `search`，确认页面后 `get`。
- 语义、概念、跨页关系：使用 `query`。
- “全部、多少、完整清单”等广度问题：使用 `query`，提高召回并关闭过早截断；必要时使用页面清单和完整页面。
- 不应仅凭一个命中切片回答需要全文或全局上下文的问题。

### 2.3 Dream、Synthesize 与长期记忆

GBrain 的长期知识能力不是单一后台任务：

- Source freshness Dream：同步、lint、反向链接、抽取、事实抽取、情绪权重重算等确定性维护。
- Synthesize：针对多个页面产生带来源、缺口和成本信息的跨页结论，属于昂贵操作，不应放在每次普通问答热路径中。
- Context Pack / Delta / Recall：用于长期 Agent 的会话启动、压缩恢复、增量记忆和显式回忆。
- Brain-Agent Loop：识别实体，先读 Brain，回答后仅把真正的新知识写回，再同步，使知识随交互积累。

一个重要实现细节是：当前官方版本对非默认命名 Source 执行裸 `gbrain dream --source <source>` 时，只隐式运行 Source freshness 阶段；跨 Source 的 synthesis 和全局阶段需要独立、安全地调度，不能把一次 `dream --source` 当作“全部 Dream 已执行”。

## 三、当前项目实现分析

### 3.1 当前总体链路

```text
上传文件/文本
  → API 保存文档和任务
  → Parser Worker 识别格式，PDF 按页区分原生/扫描/混合
  → 原生文本提取或百度 OCR
  → 规范化 Markdown
  → 平台父子切片并写业务数据库
  → 计算权限范围 Source
  → 本地 Git Source 仓库写入并提交
  → gbrain sync 增量入库、分块、Embedding
  → Source freshness Dream
  → 平台范围派生页

用户问题
  → 当前权限和选定知识库
  → 历史对话消歧并改写独立问题
  → 对每个允许 Source 执行 gbrain query
  → 应用层合并和重排
  → 读取候选完整页面
  → 数据库做最终文档权限过滤
  → 构造带引用的上下文
  → LLM 生成答案和在线预览链接
```

### 3.2 做得符合官方方向的部分

| 方面 | 当前实现 | 评价 |
|---|---|---|
| GBrain 接入 | CLI Adapter 调用真实 `sync/query/get/dream` | 符合，不是模拟 |
| 内容规范化 | 文档转 Markdown，写 title、aliases、source URI、知识库和文档 ID | 符合可追溯内容源原则 |
| 增量同步 | 以文档版本和内容哈希控制同步，删除失效页面 | 基本符合幂等和增量同步原则 |
| 混合检索 | balanced 模式、查询扩展、Embedding、reranker | 符合官方检索主线 |
| 父文档回填 | 候选页执行 `get`，向模型提供较完整正文 | 符合“切片发现、页面回答”原则 |
| 权限 | 查询前计算 Source，查询后数据库校验 | 符合纵深防御要求 |
| 会话改写 | 历史只用于指代消歧和生成独立查询 | 符合长对话检索实践 |
| PDF 解析 | 原生、扫描、混合 PDF 分流，仅扫描页使用 OCR | 适合低成本生产部署 |
| 定时任务 | BullMQ 持久化调度，默认每日运行维护 | 调度机制可靠性方向正确 |

### 3.3 不完全符合或需要加强的部分

| 问题 | 当前影响 | 建议 |
|---|---|---|
| Source 按 audience hash 生成 | 权限变化可能迁移 Source；多个库合并在同一 Source；内容身份不稳定 | 改为一个知识库一个稳定 Source |
| 应用层 `queryMany` | 各 Source 分别检索后合并，不能充分利用 GBrain 联合排序和跨 Source 图关系 | 使用受 OAuth allowedSources 限制的一次 federated query |
| 所有查询都走 `query` | 精确标题/条款、广度统计没有使用最合适的 search/get/list 策略 | 建立意图路由器 |
| 只保存最终 citation/context | GBrain evidence、CRAG grade、检索成本和扩展信息没有完整保留 | 建立可观察的 Retrieval Trace |
| 范围派生页不是官方 Synthesize | 主要是资产分布和文档列表，不能代表跨页知识结论 | 使用权限范围内的 GBrain synthesize，并保存来源和 gaps |
| 派生页无 documentId 可直接通过过滤 | 选定知识库与派生范围不一致、权限刚变化时，可能出现过期或越界上下文 | 必须校验全部 `derivedFrom`、权限 epoch 和选库范围 |
| 发布事件按可见用户入队 | 同一 Source/文档可能被重复同步，用户越多浪费越大 | 改为 Source 中心的一次同步，再发布权限范围失效事件 |
| 中文精确段落定位不稳定 | 正确文档的错误切片也可能排名靠前 | 候选页内二阶段 child rerank + 相邻段落扩展 |
| 知识图谱与 GBrain 图分离 | UI 图不参与问答，不能验证 graph retrieval | 接入 GBrain page_links/entity/facts，关系均带 provenance |
| Git Source 无远端 | 单机故障后内容仓库不可恢复 | 配置私有远端或对象存储镜像，监控推送状态 |
| Dream 指标混淆 | 页面可能显示已运行，但无法分辨 freshness 与 synthesize | 拆分任务、阶段和产物指标 |

## 四、与 GBrain + OpenClaw 个人知识库模式的对比

OpenClaw 场景通常是一个人通过 Telegram 等入口与个人 Agent 交互，OpenClaw 作为 harness，GBrain 作为长期知识存储；个人 Git Brain 是事实源，夜间任务做补充整理。它的核心价值是“对个人边界内的全部知识持续记忆和主动联想”。

本项目是政府/企业多组织、多角色、多知识库系统，核心矛盾不是“Agent 是否记得更多”，而是“任何一次读取、派生和回答都不能越过实时权限边界”。两者不能直接等同。

| 维度 | OpenClaw 个人模式 | 当前项目 | 本项目建议 |
|---|---|---|---|
| 所有者 | 通常单一用户 | 企业、组织、行业和个人混合 | 企业 Brain + 个人 owner-only Source |
| 权限复杂度 | 低，个人边界为主 | 多层组织、角色、人员、管理与阅读分离 | OAuth Source 范围 + DB 最终 ACL |
| Agent Harness | OpenClaw 常驻、主动调用记忆 verbs | Web/API 问答服务 | 保留受控 Web/API，个人场景选配记忆 verbs |
| 写回 | 对话可持续写入个人 Brain | 文档经审核入库 | 共享库保持显式发布；个人库可“记住/忘记” |
| Dream | 个人全集夜间整理风险低 | 全企业全集可能跨权限泄露 | Source freshness + 权限范围 Synthesize |
| 会话记忆 | context_pack、delta、entity 非常重要 | 当前会话历史改写 | 引入 session context pack，但不自动污染共享库 |
| 知识派生 | 可在个人全部知识上全局总结 | 当前是平台资产清单式派生 | 仅在完全相同授权范围内派生并保存 provenance |
| 审计要求 | 通常较弱 | 政企要求强 | 保存检索、权限、引用和派生链路 |

建议吸收 OpenClaw 的以下能力：

- 会话开始或上下文压缩后加载 `context_pack`。
- 每轮只处理 `delta`，对“他、这个制度、刚才那个文件”等实体做显式解析。
- 个人库提供“记住”和“忘记”操作，写入本人 Source。
- 使用 entity card、timeline 和来源链接增强跨会话记忆。

不建议照搬的部分：

- 不应把每次聊天自动写入组织库或行业库。
- 不应对全企业所有 Source 运行无权限隔离的全局总结。
- 不应把每个用户复制成一个完整 Brain；这会带来同步、成本、一致性和删除合规问题。

## 五、新知识入库的推荐流程

以下流程同时考虑 GBrain 官方理念、中文制度文档、低成本 OCR、动态权限和生产可维护性。

### 5.1 第一阶段：接收、版本和解析

1. 上传文件或录入文本时，在一个事务中创建 `DocumentVersion` 和 Outbox 事件；以文件 SHA-256 保证幂等。
2. 保存原文件，文件名统一按 UTF-8 处理，同时保留展示名称和安全存储名。
3. Word、HTML、TXT 等走相应原生解析器。
4. PDF 逐页判断文本覆盖率：
   - 可读页：直接提取文本。
   - 扫描页：调用百度 OCR。
   - 混合 PDF：只对扫描页 OCR，然后按原页序合并。
5. 保存页码、解析引擎、OCR 置信度和原文坐标，支持预览定位和审计。

### 5.2 第二阶段：规范化和结构化

1. 生成 canonical Markdown，写入稳定 frontmatter：文档 ID、版本、知识库 ID、标题、别名、来源 URI、发布时间、解析哈希。
2. 通用识别标题、章、节、条、款、项、列表和表格。这里识别的是文档结构，不是针对某个问题硬编码“第 N 条”。
3. 为每个结构块生成稳定 section anchor，例如文档版本内的 `section-0014`，并记录原页码和字符范围。
4. 建立父子切片：
   - 父节点：完整文档或章节，用于回答。
   - 子节点：条款、段落、表格，用于精确召回。
   - 每个子节点带父节点 ID、相邻节点 ID、标题路径和页码。
5. 自动校验乱码、空内容、页面覆盖率、章节顺序、重复率、OCR 低置信页和切片覆盖率。不合格文档进入隔离队列，不提前标记“已发布”。

### 5.3 第三阶段：稳定 Source 入库

1. 每个知识库使用永久 Source key，例如 `kb-<knowledgeBaseId>`；权限变化不改变 Source 身份。
2. 以 `(source, document, version)` 为唯一任务键，一个文档只同步一次，不按可见用户重复同步。
3. 将 canonical Markdown 提交到 Source Git 仓库，再运行 `gbrain sync --source`。
4. 验证 GBrain page 数、chunk 数、Embedding 模型签名、向量覆盖率和内容哈希。
5. 同步成功后更新 `BrainSourceDocument`，递增相关 `knowledgeEpoch`，使旧查询缓存和旧派生页失效。
6. 执行命名 Source 的 freshness Dream，并分别记录 lint、sync、extract、facts 等阶段结果。

### 5.4 第四阶段：发布和派生

1. 为标题、结构节点和关键段落自动生成若干检索烟测问题，验证至少能命中正确文档和正确 section。
2. Source 同步和烟测均成功后，业务文档才进入 `PUBLISHED`。
3. 找出因本次知识或权限变化而受影响的权限指纹。
4. 对需要跨页总结的范围，通过带 allowedSources 的 GBrain 客户端异步执行 `synthesize`。
5. 每个派生产物必须保存：输入 Source、输入文档版本、证据、gaps、模型签名、权限 epoch 和生成时间。
6. 派生产物只在当前用户和本次选定知识库仍覆盖其全部来源时参与检索。

## 六、“员工考勤办法第十条是什么内容”的实际处理过程

### 6.1 当前数据和实测结果

本次在当前环境中实际定位到：

- 文档：`企业考勤管理制度详细手册.doc`
- 知识库：`集团总部知识库`
- 文档状态：已发布
- GBrain Source：当前为 `llmwiki-shared`
- GBrain 页面：8 个 content chunks，使用 `BAAI/bge-m3` Embedding
- 业务数据库中的第 5 个切片、GBrain 中的第 3 个内容块包含“第十条 旷工”的完整正文

通过项目 GBrain Adapter 实际查询“员工考勤办法第十条是什么内容”时：

1. GBrain `query` 命中了正确文档。
2. 返回结果已经经过 reranker，页面综合分数约为 0.5661。
3. 但首个返回 snippet 是后续请假条款，不是“第十条”；GBrain 原始证据强度为 `weak_semantic`。
4. Adapter 随后对正确候选页执行 `gbrain get`，加载了约 4,022 字符的父文档正文。
5. 最终 LLM 从完整父文档中定位到第十条，并严格按引用内容回答。

实际生成的最终回复为：

> 根据《企业考勤管理制度详细手册》[1]，员工考勤办法第十条规定的是旷工的认定与处理办法：
>
> - 旷工定义：包括未请假擅自不到岗、假期逾期未归、迟到/早退超 30 分钟且未请假、弄虚作假骗取休假证明、不服从工作调动且无故不到岗等情形。
> - 处理办法：旷工期间扣发当日全部工资及各类津贴补贴；连续旷工 3 天（含）以上或一年内累计旷工 5 天（含）以上，公司可依法解除劳动合同。[1]

### 6.2 当前机制为什么能够答对

本次并不是单纯依靠向量切片直接答对，而是多层机制共同作用：

1. 标题、aliases、BM25、向量和查询扩展使正确制度文档进入候选集。
2. GBrain 混合检索和 reranker 将正确页面保留在前列。
3. 项目没有只把错误 snippet 交给模型，而是进一步执行 `get` 读取父文档。
4. 数据库在模型回答前再次确认文档仍处于发布状态、用户仍有权限、知识库仍在本次选择范围内。
5. 回答提示要求只依据提供的知识、标注引用、信息不足时不得编造。

这符合 GBrain “搜索用于发现，页面用于回答”的理念。

### 6.3 当前机制还不能保证什么

本次正确不能证明所有精确条款查询都可靠：

- 首个 snippet 实际上没有命中目标条款，说明精确 passage recall 不够稳定。
- 如果文档非常长，父文档超过 80K/120K 预算，目标条款可能没有进入最终上下文。
- 如果前面还有多个高分页面，正确父文档可能没有进入当前只加载 3/5 页的范围。
- `weak_semantic` 没有触发明确的检索升级或拒答策略。
- 当前 citation 主要到文档级，尚未稳定定位到“第十条/页码/section anchor”。

因此，最大程度贴近知识库内容，不能只靠增大上下文，而应增加通用的二阶段段落定位。

## 七、目标查询流程

推荐把上述问题按以下过程处理：

```text
问题 + 最近对话
  → 实体/指代解析，生成独立问题
  → 数据库计算实时可见 Source + 本次选定知识库
  → 意图路由：精确制度条款查询
  → 一次 GBrain federated search/query（OAuth allowedSources 硬限制）
  → 保留 evidence、CRAG、source、page、chunk 和扩展查询信息
  → 得到候选页面
  → 对候选页的全部 child chunks 做同问题二阶段重排
  → 选择目标 section，并附带前后相邻段落
  → 必要时 get 父章节，而不是盲目加载整篇长文
  → DB 校验文档、版本、Source、derivedFrom 和实时 ACL
  → 证据质量门控
  → 生成带文档、条款、页码/anchor 和在线预览链接的答案
```

对于“第十条”这样的表达，系统可以利用解析阶段形成的通用结构字段提高精确匹配权重，但不能增加“如果用户问第 N 条就搜索某种固定字符串”的问题特判。相同机制应自然支持“第三章第二节”“处罚标准表”“附件二第 4 项”和不带编号的普通段落。

### 7.1 意图路由建议

| 查询类型 | GBrain 操作 | 后续处理 |
|---|---|---|
| 已知文档名、精确术语、编号 | `search`，必要时 `get` | 候选页内 child rerank |
| 概念、原因、关系 | `query` | 图增强、重排、CRAG |
| 全部条款、多少项、完整名单 | `query`，关闭过早 autocut | 覆盖度检查，必要时遍历完整页面 |
| 多文档归纳、差异、趋势 | 检索后 `synthesize` | 只在授权 Source 范围内执行 |
| 证据弱或冲突 | 升级一次检索 | 仍不足则明确说明无法确认 |

### 7.2 回答质量门控

生成答案前至少满足：

- 引用对应当前发布版本。
- 目标段落存在于实际上下文中，而不是只存在于同一文档的其他未加载位置。
- 派生结论的全部 `derivedFrom` 文档当前均可读。
- 精确问题至少存在一个强关键词/结构或语义证据；若只有 weak evidence，则做二阶段检索。
- 回答中的数字、日期、条款和结论能映射到具体 section。
- 引用链接打开原文件在线预览并定位到相应页/section；不支持精确定位的格式至少打开对应文档。

## 八、详细优化开发方案

### P0：正确性和安全性修复（最高优先级）

1. 派生页权限闭环：任何没有 `documentId` 的结果不得默认通过；校验全部 `derivedFrom`、知识 epoch、权限 epoch 和本次选定知识库集合。
2. 为 QueryResult 保留 GBrain 的 evidence、CRAG、source ID、chunk ID、rerank、扩展查询和成本元数据。
3. 增加候选页内 child rerank：在正确页面中重新定位最相关条款，并带相邻段落。
4. 对 weak evidence 增加一次明确升级路径；仍不足时拒绝猜测。
5. 修复 Dream 指标：分别展示 Source freshness、Scope synthesize、处理页数、事实数、派生页数、跳过阶段和失败原因。
6. 将本地 Source Git 配置到私有远端或备份存储，并监控未推送提交。

验收标准：任何无权限原文或过期派生页都不能进入 LLM 上下文；精确条款能够定位到条款级引用。

### P1：Source 和检索架构升级

1. 新建稳定 `kb-<id>` Source 命名和映射表。
2. 编写迁移器：双写新旧 Source、校验 page/hash/chunk 数、切换读取、停止旧写、延迟清理旧 Source。迁移期间不得直接删除现有 Source。
3. 接入 GBrain OAuth：按当前用户实时生成 allowedSources，使用 `federated-read` 做一次联合查询。
4. 数据库最终 ACL 继续保留；OAuth 是检索硬边界，DB 是业务事实和最终边界。
5. Source 同步任务改为 `(source, doc, version)` 去重，取消按每名可见用户重复同步。
6. 实现 query intent router，按 search/query/get/list/synthesize 选择路径。

验收标准：权限变化不触发内容 Source 迁移；新增员工只改变授权；联合检索结果可解释且选库范围准确。

### P2：完整 GBrain 派生能力

1. 保留每日 Source freshness Dream。
2. 新增权限范围 Synthesize Worker：知识或权限 epoch 变化后，只重算受影响的权限指纹。
3. 通过 OAuth allowedSources 调用 GBrain `synthesize`，保存 sources、answer、gaps、cost、模型和输入版本。
4. 高敏感范围不执行全局跨 Source Dream；全员公开 Source 或隔离信任域可建立独立 Brain 执行完整全局 Dream。
5. UI 将“平台同步状态”“Source freshness Dream”“Scope Synthesize”“官方 compiled truth/派生产物”分开展示。
6. 允许管理员查看产物正文、证据、差异和更新原因，但查看本身也必须经过知识权限校验。

验收标准：一次新知识发布后，可明确看到影响了哪些 Source、权限范围、facts、派生结论和检索缓存；所有派生结论 100% 可追溯。

### P3：个人记忆与知识图谱

1. 为个人库增加显式 `remember/forget/recall`；默认不把普通聊天写回知识库。
2. 会话开始和压缩后使用 context pack；每轮只计算 delta，增强代词和跨会话实体解析。
3. 用 GBrain page links、entities、facts 替换或补充当前词语共现图。
4. 结构关系包括：文档包含条款、制度引用制度、版本替代、适用组织、人员/角色涉及范围。
5. 自动或 LLM 抽取的关系必须标注未验证状态、来源文档和证据位置。
6. 图谱只展示当前用户所有可见知识，个人库关系不会因超级管理员身份泄露。

## 九、可观测性和验证方案

### 9.1 单次查询 Trace

管理界面应能看到但不得暴露敏感正文：

- 用户、权限指纹、知识 epoch、选定知识库和最终 allowedSources。
- 原问题、历史消歧结果、独立查询、意图类别和选择的 GBrain verb。
- 查询扩展、候选 chunk/page、BM25/向量/图/RRF/rerank 分数。
- evidence/CRAG 等级、是否升级检索、是否读取父章节。
- 被 ACL 过滤的结果数量和原因。
- 最终采用的 section、相邻段落、引用和预览地址。
- LLM 模型、token、耗时以及是否因证据不足拒答。

### 9.2 入库 Trace

- 文件哈希、版本、解析器、每页解析方式、OCR 置信度。
- canonical Markdown 路径和 Git commit。
- GBrain Source、page/chunk 数、Embedding/reranker 模型签名。
- 结构块数量、低质量页、检索烟测结果。
- freshness Dream 各阶段产物。
- 受影响权限范围和 Synthesize 产物差异。

### 9.3 回归数据集

建立中文政企知识专项评测集：

- 精确条、款、项、章、表格和附件查询。
- 文档标题别名、口语改写、错别字和中英文混合查询。
- “一共有多少条”“列出全部”等覆盖度查询。
- 新旧制度冲突、废止与替代关系。
- 超长文档、扫描 PDF、混合 PDF、低质量 OCR。
- 个人/组织/行业库交叉权限、授权新增和撤销后的即时结果。
- 长会话中的“他、这个、刚才那个制度”等指代查询。

建议质量门槛：

- 正确段落 Recall@5 ≥ 95%。
- 有据答案的引用精确率 ≥ 98%。
- 权限泄漏为 0。
- 派生产物来源覆盖率 100%。
- 精确事实无法获得足够证据时必须拒绝猜测。
- 新知识发布后在约定 SLO 内可检索，权限撤销即时阻断。

## 十、建议的最终架构

```text
                  ┌─────────────────────────────┐
文件/文本 ───────→│ 解析、OCR、结构化、质量门禁 │
                  └──────────────┬──────────────┘
                                 ↓
                  ┌─────────────────────────────┐
                  │ Canonical Markdown + Git SoR │
                  └──────────────┬──────────────┘
                                 ↓
        ┌────────────────────────────────────────────┐
        │ 一个企业 GBrain                           │
        │ kb-personal-A | kb-org-X | kb-industry-Y   │
        └─────────────────────┬──────────────────────┘
                              ↓
用户/角色/组织 ACL → OAuth allowedSources → Federated Retrieval
                              ↓
          search/query/get + child rerank + CRAG/evidence
                              ↓
                 数据库最终 ACL / provenance 校验
                              ↓
                    带 section 的引用式回答

后台：Source freshness Dream
      + 受权限隔离的 Scope Synthesize
      + 远端 Git 灾备、评测和全链路 Trace
```

这个架构保留 GBrain 的 Source、混合检索、图关系、Dream、Synthesize 和长期记忆优势，同时把组织权限、知识库管理、个人隐私和审计交给本项目的业务数据库。它比每人一个 GBrain 更节省、更一致，也比当前 audience-hash Source 更稳定。

## 十一、实施结论

当前系统已经具备一条真实可工作的 GBrain RAG 链路。“员工考勤办法第十条”实测能够给出正确、有来源的答案，证明现有的正确页面召回、父文档加载和严格引用提示确实有效；但错误首切片也证明，当前不能只用“最终答对”判断 GBrain 已经发挥到最大能力。

建议先完成 P0 的权限与段落定位闭环，再迁移到“稳定知识库 Source + OAuth federated-read”，最后接入权限范围内的官方 Synthesize 和真实 GBrain 图谱。该顺序能够在不改变现有功能需求的前提下，先消除泄漏和错答风险，再逐步获得完整的跨 Source 总结与长期知识能力。

### 本轮升级实施记录

本轮已将上述 P0—P3 方案落实到代码，部署时需要执行 Prisma 迁移并让后台队列完成一次访问对账：

- P0：派生页新增 Source/ACL/知识 epoch 绑定；查询仅在全部来源、版本和当前选库都匹配时使用派生页。GBrain 返回的 evidence、Source、slug、分数和段落定位写入查询审计。父文档命中后按通用文档结构进行第二阶段段落排序；Markdown 入库也会把章节、条款和枚举结构作为子切片边界。
- P1：Source 由“受众 hash”改为“一个知识库一个稳定 Source”。发布任务改为按 `(知识库 Source, 文档, 版本)` 同步一次，再失效受影响 Scope；查询只请求当前用户本次选定知识库的 Source。精确命名查询可由意图路由选择 `search`，语义/关系/广度查询使用 `query`。
- P2：保留命名 Source 的 freshness Dream；Scope 只在 dirty 或首次生成时执行。每个受权 Source 通过 GBrain `synthesize` 生成跨页综合，结果、gaps、warnings、成本信息和来源一并写入派生页；模型不可用时明确标记为 partial，而非伪装为已综合。
- P3：新增仅本人可访问的 GBrain Memory Verbs API（`remember`、`recall`、`forget`、`context_pack`），普通聊天不会自动写入共享知识；对话输入区提供“记住”显式入口。知识图谱优先读取 GBrain page links，同时保留清晰标注的词项发现关系。
- 运行保障：Source 可通过 `GBRAIN_SOURCE_REMOTE_URL_TEMPLATE` 绑定私有 Git 远端并在写入/Dream 后使用 GBrain 的安全 push；未配置远端时不会把知识推送到未知位置。

OAuth `federated-read` 是 GBrain HTTP/MCP 服务侧的硬边界：本项目当前后端以受信任本地 CLI 对每个已授权 Source 逐一调用，并保留数据库最终 ACL。部署 GBrain HTTP 服务并为每个用户/权限指纹配置 OAuth client 后，可将同一份稳定 Source 列表直接作为 `federated-read` 授权集，无需再迁移或复制知识内容。

## 十二、项目代码审阅范围

本评估不是只根据界面或配置推断，重点审阅了以下实现：

- [`packages/gbrain-adapter/src/index.ts`](../packages/gbrain-adapter/src/index.ts)：GBrain CLI 桥接、Source 仓库、sync/query/get/dream、模型和检索参数。
- [`apps/api/src/ingestion/ingestion.service.ts`](../apps/api/src/ingestion/ingestion.service.ts)：上传、解析任务、规范化、切片、发布和 GBrain 编译触发。
- [`apps/api/src/brain-compiler/brain-compiler.service.ts`](../apps/api/src/brain-compiler/brain-compiler.service.ts)：Source 规划、增量同步、访问重算、Dream 调度和运行指标。
- [`apps/api/src/brain-compiler/brain-scope.service.ts`](../apps/api/src/brain-compiler/brain-scope.service.ts)：权限指纹、范围派生页和 provenance。
- [`apps/api/src/chat/chat.service.ts`](../apps/api/src/chat/chat.service.ts)：对话改写、Source 查询、父页回填、权限后过滤、引用和回答生成。
- [`apps/api/src/knowledge-graph.controller.ts`](../apps/api/src/knowledge-graph.controller.ts)：当前知识图谱节点、关系和权限过滤。
- [`apps/parser-worker/src/main.py`](../apps/parser-worker/src/main.py)：PDF 分类、文本提取、OCR 分流及格式解析实现。
- 当前数据库中的知识库、文档、Source 映射、GBrain content chunks 和“员工考勤办法第十条”实际查询结果。

## 十三、官方资料

- [Company Brain：企业多用户、多 Source 与 OAuth 方案](https://github.com/garrytan/gbrain/blob/master/docs/tutorials/company-brain.md)
- [Personal Brain：GBrain 与 OpenClaw 个人知识架构](https://github.com/garrytan/gbrain/blob/master/docs/tutorials/personal-brain.md)
- [Brains and Sources：Brain/Source 边界](https://github.com/garrytan/gbrain/blob/master/docs/architecture/brains-and-sources.md)
- [Retrieval Architecture：混合检索、重排、图和 CRAG](https://github.com/garrytan/gbrain/blob/master/docs/architecture/RETRIEVAL.md)
- [Search Modes：search/query/get 的选择](https://github.com/garrytan/gbrain/blob/master/docs/guides/search-modes.md)
- [Brain-first Lookup：先查 Brain 再回退](https://github.com/garrytan/gbrain/blob/master/docs/guides/brain-first-lookup.md)
- [Ambient Recall：长期 Agent 的 recall/context pack/delta](https://github.com/garrytan/gbrain/blob/master/docs/guides/ambient-recall.md)
- [Brain-Agent Loop：对话与知识积累闭环](https://github.com/garrytan/gbrain/blob/master/docs/guides/brain-agent-loop.md)
- [Memory Verbs：recall/remember/entity/synthesize 等协议](https://github.com/garrytan/gbrain/blob/master/docs/protocol/MEMORY_VERBS_v1.md)
- [Dream Cycle 实现](https://github.com/garrytan/gbrain/blob/master/src/core/cycle.ts)
- [Dream Source 范围阶段实现](https://github.com/garrytan/gbrain/blob/master/src/core/cycle/phase-scope.ts)
- [Infrastructure Layer：入库和 Thin Harness 原则](https://github.com/garrytan/gbrain/blob/master/docs/architecture/infra-layer.md)
