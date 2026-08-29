# 企业级 LLM Wiki 知识库平台项目方案

**项目代号**：LLMWiki
**版本**：v1.2（2026-08-28）
**文档性质**：立项方案（含市场调研、产品设计、架构设计、实施计划）
**v1.1 变更**：解除 gbrain 运行时依赖，改为"自研薄核心 + 最佳开源组件"拼装路线；技术栈统一为 Python；重排里程碑与风险。
**v1.2 变更（核心理念升级）**：抛弃「检索式 RAG」主线，回归 **LLMWiki 理念——编译式个人大脑**：新增知识与权限变更时**面向每一个人**触发 gbrain 式知识整理（Compiled Truth 重编译 + Timeline 证据追加 + Dream Cycle），查询=问大脑而非搜碎片。gbrain 恢复为核心依赖（单人大脑引擎），多租户编排层自研。

---

## 1. 项目概述

### 1.1 项目目标

打造一个企业级 LLM 知识库平台，实现：

1. **对话式知识查询**：自然语言多轮对话，流式输出，**每个回答可查看引用源**（溯源到知识页的 Compiled Truth 段落与其 Timeline 证据链，最终回溯原始文档）
2. **多格式知识支持**：Markdown / Word / PDF / Excel / PPT / HTML / 图片(OCR) / 网页 等，统一入库
3. **三类知识库分级**：
   - **个人知识库**：个人独享，他人不可见不可用
   - **组织知识库**：由 1~N 名管理员维护，**同层及下层组织**可使用
   - **行业知识库**：可动态创建，由 1~N 名管理员维护，可授权给**特定角色 / 人员 / 组织**使用
4. **智能检索范围**：默认查询"自己可见的所有知识库"，也可指定某几个库查询
5. **完善的 RBAC 权限**：采用开源 RBAC 方案（Casbin），权限过滤下沉到检索层；**权限变更即时触发该用户大脑视图重编译**
6. **模型后台可配**：LLM 与 Embedding（及 Rerank）模型在管理后台**分别独立配置**，支持多供应商切换
7. **编译式个人大脑（v1.2 核心）**：每个用户拥有一份**面向自己持续整理的大脑**（Brain Repo）；新增知识、权限变更、夜间 Dream Cycle 均触发面向个人的 gbrain 式整理

### 1.2 核心设计哲学（LLMWiki 理念 = gbrain 理念的企业化落地）

> **"Markdown 是唯一真相之源；知识不是被检索的，是被持续编译的。"**

- **每个知识库** = 一个 Git 托管的 Markdown 仓库，人类可直接读写（Obsidian / Web 编辑器均可）
- **每个用户** = 一份**个人大脑**（Brain Repo）：由编译引擎面向该用户持续整理的知识页集合
  - 知识页面采用 **Compiled Truth（顶部结论）+ Timeline（底部证据链）** 结构（gbrain 知识模型）
  - 个人大脑的内容边界 = 该用户可见的知识（个人库 + 组织库继承范围 + 被授权的行业库）
  - **权限变更 → 个人大脑重编译**：新授权的知识编译进来、撤销的知识即时移出（权限即视图边界）
  - **新增知识 → 面向所有可见者增量编译**：新文档发布后，编译引擎对每个可见用户的相关主题页做增量整理（更新 Compiled Truth、追加 Timeline、重建交叉引用）
  - **夜间 Dream Cycle**：面向每人的知识健康整理（矛盾检测、过期提醒、同主题合并、孤儿页面清理）——大脑"每天醒来都比前一天更聪明"
- **查询 = 问大脑，不是搜碎片**：查询命中的是**整理好的知识页面**（Compiled Truth 可直接作答），引用 = 知识页 + Timeline 证据链 → 原始文档；向量/全文索引只是大脑的**检索加速层**（编译产物，可随时重建）
- 原始文件（docx/pdf 等）存对象存储，与转换后的 Markdown 双向关联，保证证据可回溯
- 兼容 gbrain / Obsidian / Notion vault 的 Markdown 目录直接导入

**与 gbrain 的关系（v1.2 恢复为核心依赖）**：
- **gbrain（MIT，TS）作为单人大脑引擎**：Brain Repo 管理（sync/import/embed）、混合检索内核、Skillpack 知识整理约定（ingest/query/maintain）
- **多租户编排层自研**：为每个用户维护独立 Brain Repo（Gitea 按 user 分库或目录分区）；把 gbrain 的单人循环（信号→实体检测→READ→WRITE→sync）编排为**企业级批量编译流水线**
- 权限模型（Casbin）、三级知识库、模型网关、解析管道等企业能力仍在自研层

---

## 2. 市场调研与竞品分析

### 2.1 竞品格局总览

企业知识库 + LLM 赛道目前分三个梯队：

| 梯队 | 代表 | 模式 | 说明 |
|---|---|---|---|
| 商业闭源 SaaS | **Glean**、Guru、飞书知识问答、钉钉 AI 助理、腾讯 ima | 订阅制 | Glean 是标杆（估值 ~$7B），企业 AI 搜索 + 助手 + Agent，100+ SaaS 连接器，按席位收费（约 $40–60/人/月） |
| 开源自部署 | **Onyx**(原 Danswer)、**RAGFlow**、**FastGPT**、**MaxKB**、QAnything、Dify | 开源 + 企业版 | 国内 MaxKB / FastGPT / RAGFlow / Dify 生态活跃；Onyx 在欧美企业渗透率高 |
| 个人 AI 记忆 | gbrain、Khoj、Reor | 开源 | gbrain（YC 总裁 Garry Tan 出品，MIT，29k★）验证了 "Markdown + pgvector 混合检索" 路线的有效性 |

### 2.2 重点竞品分析

#### （1）Glean（商业标杆，对标本产品的"北极星"）
- **优势**：权限感知检索（Permission-Aware Retrieval，索引时继承数据源 ACL）、100+ 连接器（Slack/Drive/Confluence/Jira...）、知识助手、Agent 平台、DLP
- **劣势**：闭源 SaaS、贵、数据出企业、不支持私有 Markdown 资产沉淀、无法自主换模型
- **借鉴**：检索前权限过滤（pre-filter）设计；连接器生态思路；引用溯源交互

#### （2）Onyx（原 Danswer，MIT，开源企业级最完整）
- **优势**：Agentic RAG（混合索引 + AI Agent 检索）、Deep Research、50+ 连接器、SSO/OIDC/SAML、SCIM、RBAC（企业版）、Docker/K8s 部署成熟
- **劣势**：权限细粒度控制（文档级 ACL）在付费企业版；无"组织架构树 + 知识库分层"概念；知识以"连接器同步"为中心而非"人维护知识"为中心；Python/Django + Vespa 技术栈重
- **借鉴**：连接器架构、混合索引 + 重排、Chat UI 交互

#### （3）RAGFlow（Apache-2.0，深度文档理解最强）
- **优势**：DeepDoc 深度文档解析（复杂 PDF/表格/扫描件）、模板化分块可视化可干预、引用溯源交互好、LLM/Embedding 可配置、多路召回 + 融合重排
- **劣势**：重资源（16GB+ RAM）、ES/Infinity 技术栈较重、无组织级权限模型、无知识编辑能力
- **借鉴**：文档解析管道（MinerU/Docling）、分块可视化干预、引用交互

#### （4）FastGPT / MaxKB（国内开源主流）
- **优势**：中文生态好、可视化 Workflow 编排、多模型接入、开箱即用
- **劣势**：MaxKB 为 GPLv3 且 SSO/细粒度权限在 Pro 付费版；FastGPT 附加协议（多租户 SaaS / 去 logo 受限）；两者定位偏"低代码 Agent 平台"而非"企业知识资产库"
- **借鉴**：模型供应商抽象层设计（用户级/库级模型配置 UI）

### 2.3 业内主流技术方案（RAG 演进）

| 方案 | 核心做法 | 采用情况 |
|---|---|---|
| Naive RAG | 单路向量检索 → 拼 Prompt | 已淘汰，仅作基线 |
| **Hybrid RAG** | 向量 + 关键词(BM25) 双路召回 + **RRF 融合** + Rerank 重排 | 仅作**大脑检索加速层**（gbrain 内核），非主回答路径 |
| Advanced RAG | 查询改写/HyDE/多粒度分块/Parent-Child chunk/上下文压缩 | 仅在加速层选择性采用 |
| Agentic RAG | LLM 作为 Agent 自主决定检索策略、多跳检索 | P2 采用（复杂问题分解多跳） |
| GraphRAG | 实体/关系图谱 + 社区摘要，解决全局性问题 | 与编译式大脑天然契合（交叉引用/实体页即轻量 GraphRAG），随编译引擎实现 |
| Permission-Aware RAG | 检索前按用户权限过滤（Glean 模式） | **安全底座保留**（编译视图 + 检索过滤双保险） |
| **编译式大脑（Compile-then-Query，本方案核心）** | 知识入库/权限变更时**面向每个人**增量编译个人大脑（Compiled Truth + Timeline + 交叉引用）；查询=问整理好的知识页；夜间 Dream Cycle 持续整理 | **v1.2 主线**（gbrain 理念） |

**结论：本项目差异化定位** —— 市面产品（含 Glean/Onyx/RAGFlow）全部是"检索式"：知识存进去什么样，查出来还是碎片。本产品以 **LLMWiki/gbrain 理念**为核：**知识面向每个人持续编译成"大脑"，回答来自整理好的结论而非碎片拼凑**——这是"企业 Memex"，不是"又一个企业搜索"。

---

## 3. 产品设计

### 3.1 用户角色

| 角色 | 职责 | 来源 |
|---|---|---|
| 超级管理员 | 平台管理：用户/组织架构、模型配置、行业库开设、全局审计 | 后台 |
| 组织管理员 | 维护其组织层级内的组织知识库（可设多名） | 授权 |
| 行业库管理员 | 维护指定行业知识库（可设多名） | 授权 |
| 普通用户 | 对话查询、维护个人知识库、按权限阅读 | 全员 |
| 审计员 | 只读审计日志（查询/访问/权限变更） | 授权（可选） |

### 3.2 知识库模型（核心业务规则）

```
知识库类型 type ∈ { personal, org, industry }

个人库 personal：
  - 创建即归属本人，owner = user_id
  - 任何人不可见、不可检索、不可授权（系统级强制，不走 Casbin 策略）

组织库 org：
  - 绑定到组织树某节点 org_node_id
  - 管理员 = 1..N 人（仅管理员可写入/审核发布）
  - 可见范围 = 该节点及其所有子孙节点上的用户（同层及下层组织）
  - 支持下级组织"投稿 → 管理员审核"流（P1）

行业库 industry：
  - 由超级管理员动态创建（如"金融行业库""医疗行业库"）
  - 管理员 = 1..N 人（仅管理员可写入）
  - 可见范围 = 显式 ACL 授权：subject ∈ { user | role | org_node }，支持设置有效期（到期自动失效）
```

### 3.3 功能清单

**P0（MVP 必须）**
1. 对话式查询：多轮会话、流式输出（SSE）、会话历史、追问
2. 引用溯源：回答内联标注 [1][2]，右侧引用面板展示原文片段、来源文档、库类型；点击可查看 Markdown 源文（Web 阅读器）与下载原始文件
3. 知识库选择器：默认"我可见的全部"，可勾选个人/组织/行业库组合
4. 知识摄入：Web 上传 + 拖拽，格式 md/txt/docx/pdf/xlsx/pptx/html/csv + 图片 OCR；解析为 Markdown 入 Git 仓库
5. 三级知识库 CRUD + 管理员授权（组织库/行业库）
6. RBAC 权限中心（Casbin）：角色、组织树管理、行业库 ACL
7. 模型后台配置：LLM / Embedding / Reranker 三类模型分别配置（供应商 + Base URL + Key + 模型名 + 参数），连接测试，全局默认
8. 个人知识库：上传/编辑/删除自己的知识

**P1（增强）**
9. Obsidian 集成：管理员用 Obsidian + Git 插件直接编辑知识库仓库，push 后自动重建索引；Obsidian URI 跳转；gbrain/Obsidian vault 一键导入
10. 查询改写（结合会话历史的指代消解）、Parent-Child 分块
11. 网页抓取入库、定时同步；组织库投稿审核流
12. 审计日志与查询分析（谁查了什么、引用命中分布、库热度）
13. 知识健康度：过期检测、孤儿页面、同主题多版本提醒
14. 评测体系（RAGAS：检索召回率、答案忠实度）+ Langfuse 观测

**P2（远期）**
15. Agentic RAG 多跳检索、GraphRAG 全局问答
16. 连接器生态（Confluence/飞书/SharePoint/网盘同步，借鉴 Onyx 架构）
17. 音视频 ASR 入库、文档级 ACL 细粒度权限（可演进 OpenFGA）
18. 开放 API / MCP Server（让企业内部其他 AI 应用调用本知识库）

### 3.4 关键交互设计（对话 + 引用）

```
┌────────────────────────────────────────────────────────────┐
│ [知识库范围: ● 我可见的全部 ▾]   [新会话]  [历史会话列表]     │
├────────────────────────────────────────────────────────────┤
│ 用户: 去年行业的合规新规里对数据出境有哪些要求？               │
│                                                            │
│ AI: 根据《xxx 管理办法》第七条……[1]，以及行业库中 ……[2]      │
│     ……（流式输出）                                          │
│                                                            │
│ 引用 (3):                                                   │
│  [1] 管理办法解读.md — 金融行业库 · 命中段落预览… [查看原文]  │
│      [原始文件.pdf] [在 Obsidian 中打开]                     │
│  [2] 数据合规指引.md — 研发中心组织库 · …                    │
│  [3] 我的笔记.md — 个人库 · …                               │
└────────────────────────────────────────────────────────────┘
```

---

## 4. 总体架构

### 4.1 技术路线决策（v1.2 修订）：检索内核用 gbrain，编译编排自研

| 维度 | 方案 A：基于 Onyx/RAGFlow 二开 | **方案 B：gbrain 单人内核 + 自研多租户编译编排（v1.2 选定）** |
|---|---|---|
| 核心理念 | 检索式（碎片召回） | **编译式**（面向每人持续整理大脑）——Onyx/RAGFlow 无此范式，二开等于重写 |
| 检索/索引内核 | 现成但重组件（Vespa/ES/Infinity） | **gbrain 原生**：Markdown Brain Repo + pgvector 混合检索（MIT，TS，29k★，单人场景久经验证） |
| 多租户/权限 | 有基础但非组织树模型，深改冲突大 | **自研编排层**：Casbin + 组织树 + 三级库 + **面向每人的编译调度**——这是差异化主体 |
| 编译引擎（核心） | 无 | 自研 Brain Compiler：编排 gbrain 的 ingest/query/maintain 能力，按「人×主题」批量增量编译 |
| 技术栈 | Vespa/ES 重组件 | gbrain(TS/Bun) + 编排层(NestJS/TS 同栈直接复用 gbrain npm 包) + PG/pgvector |
| 协议 | Onyx MIT（EE 闭源）/ RAGFlow Apache-2.0 | gbrain MIT，可闭源修改、可长期自维护 |

**决策（v1.2）**：**恢复 gbrain 为核心依赖**——单人 Brain Repo 引擎直接复用（仓库管理/同步/混合检索/知识整理约定）；自研预算全部投入真正的差异化：**多租户编译编排（面向每个人的 Brain Compiler + 权限驱动重编译 + Dream Cycle）与权限模型**。检索式 RAG 仅作为大脑的加速层存在。

### 4.2 架构图（v1.2：编译式大脑）

```
              ┌──────────────────────────────────────────────────┐
              │              用户 / 管理员                         │
              │   Web 对话端    管理后台    Obsidian(编辑源知识)    │
              └──────┬──────────────┬──────────────┬─────────────┘
                     │              │              │ Git
             ┌───────▼──────────────▼──────────────▼───────┐
             │               API 网关 (Nginx)               │
             └───┬──────────────┬──────────────┬───────────┘
                 │              │              │
      ┌──────────▼──────────┐ ┌─▼──────────┐ ┌▼─────────────────────┐
      │ Chat Service        │ │ Admin API  │ │ Git 服务 (Gitea)      │
      │ 会话/流式/引用       │ │ 用户/权限/  │ │ ├ 源知识库 Repos      │
      │ 【问大脑】           │ │ 模型/审计   │ │ └ 个人大脑 Repos      │
      └──────────┬──────────┘ └─┬──────────┘ │   (每用户一个)         │
                 │              │            └──────────┬───────────┘
     ┌───────────▼──────────────▼───────────────────────▼────────────┐
     │                  核心服务层 (NestJS/TypeScript)                 │
     │  ┌────────────────────┐ ┌──────────────┐ ┌─────────────────┐  │
     │  │ Brain Query        │ │ 权限中心      │ │ 模型网关客户端    │  │
     │  │ 大脑语义查询        │ │ Casbin       │ │ LiteLLM/new-api │  │
     │  │ Compiled Truth 作答│ │ org 树+ACL   │ │ 编译用LLM/嵌入   │  │
     │  │ +证据链对齐         │ │ 可见性计算    │ │                │  │
     │  └─────────┬──────────┘ └──────┬───────┘ └────────┬────────┘  │
     │  ┌─────────▼───────────────────▼──────────────────▼────────┐ │
     │  │        ★ Brain Compiler（自研编译编排引擎）★              │ │
     │  │  触发器: 知识发布 / 权限变更 / Dream Cron                  │ │
     │  │  编排 gbrain: ingest(实体检测→Truth重写→Timeline追加      │ │
     │  │  →交叉引用) · maintain(矛盾/过期/合并/孤儿)               │ │
     │  │  调度: dirty队列(人×主题) · 权限收缩优先 · 懒编译兜底      │ │
     │  └─────────┬───────────────────────────────────────────────┘ │
     │  ┌─────────▼────────────────────────────────────────────────┐ │
     │  │ gbrain 内核（npm 复用）: Brain Repo sync/embed/query、     │ │
     │  │ hybrid search(vector+FTS+RRF)、Markdown 渲染              │ │
     │  └───────────────────────────────────────────────────────────┘ │
     └───────┬───────────────┬───────────────────┬───────────────────┘
             │               │                   │
     ┌───────▼──────┐ ┌──────▼──────┐ ┌──────────▼──────────┐
     │ PostgreSQL   │ │ Redis       │ │ MinIO               │
     │ +pgvector    │ │ dirty队列   │ │ 原始文件(docx/pdf)   │
     │ 业务+加速索引 │ │ 缓存        │ │                    │
     └──────────────┘ └─────────────┘ └─────────────────────┘
             │
     ┌───────▼───────────┐           ┌─────────────────────┐
     │ 解析 Worker        │           │ 模型推理             │
     │ MinerU/Docling/   │           │ API(OpenAI兼容)/     │
     │ PaddleOCR         │           │ vLLM/Ollama/TEI      │
     └───────────────────┘           └─────────────────────┘
```

**两类仓库，一条编译流水线**：
```
源知识库 Repo（管理员维护，人类可读）
   │ 文档发布事件 knowledge.published
   ▼
Brain Compiler ── 权限中心计算可见人群 ──► 对每个可见用户:
   │  gbrain ingest：实体检测 → 读该用户大脑主题页 →
   │  重写 Compiled Truth / 追加 Timeline 证据 / 更新交叉引用
   ▼
个人大脑 Repo（每用户一个，Git 版本化，可审计可回滚）
   │
   ├──► 加速索引（pgvector/FTS，可重建）
   └──► Chat 查询：问大脑 → 知识页作答 + 证据链溯源

权限变更 permission.changed（授权/撤销/调岗/组织调整）
   ──► 受影响用户大脑视图重编译（纳入新知识 / 移除撤销知识，即时生效）
   ──► 查询时权限过滤仍在（安全双保险）

夜间 Dream Cycle（面向每人）
   ──► 矛盾检测 · 过期提醒 · 同主题合并 · 孤儿清理 · 交叉引用修复
```

### 4.3 组件职责

| 组件 | 承担职责 | 来源 |
|---|---|---|
| **Brain Compiler（自研·核心差异化）** | 编译触发（知识发布/权限变更/Dream）、dirty 队列调度（人×主题粒度）、编排 gbrain ingest/maintain、编译成本控制（合并/优先级/懒编译） | 自研 |
| **gbrain（恢复为核心依赖）** | 单人大脑引擎：Brain Repo 管理、ingest 知识整理（实体检测/Truth/Timeline/交叉引用）、hybrid 检索内核、maintain 健康检查 | MIT，npm 直接复用 |
| Chat Service（自研） | 会话/流式/引用 API；「问大脑」查询编排（大脑查询 → 知识页作答 → 证据链对齐） | 自研 |
| 权限中心（自研） | Casbin + 组织树 + 可见性计算 + **权限变更事件（触发重编译）** | 自研 |
| 管理后台 + 前端 | 对话、引用（知识页+证据链）、库/人员/角色/行业库/模型/审计控制台 | 自研 |
| Casbin | RBAC 策略求值 | Apache-2.0 |
| MinerU / Docling + PaddleOCR | 多格式 → Markdown 解析（源知识库入库前置） | 按类型路由 |
| Gitea | 源知识库 Repos + 个人大脑 Repos 托管 | MIT |
| MinIO | 原始文件存储 | AGPL（自托管） |
| LiteLLM / new-api | 模型网关（**编译用 LLM 与查询用 LLM 可分别配置**） | MIT |
| TEI | Embedding + Reranker | Apache-2.0 |
| Langfuse | 编译 Trace + 查询 Trace 观测 | MIT |

### 4.4 关键设计决策

1. **编译式大脑优先于检索拼装**：回答主体来自**整理好的 Compiled Truth**（编译期已由 LLM 消化过多源证据），查询期 LLM 只做轻量综述与语言组织——质量由编译决定，而非当场检索的运气。
2. **"面向每一个人"的编译粒度**：编译单元 = `user × topic`。同一份新知识对不同用户编译结果不同（各自大脑的既有认知、各自可见的证据范围不同）。个人库变更只编译本人。
3. **权限变更 = 视图重编译事件**：授权→新知识编译进该用户大脑；撤销→该主题内容**即时移出**（安全要求：不等夜间 Dream）；调岗/组织调整→全量 dirty。检索时权限过滤**仍保留**（双保险：防编译滞后窗口越权）。
4. **编译成本控制**：dirty 队列合并去重（同主题批量）、权限收缩最高优先级、活跃用户/热点主题优先、查询命中 dirty 页先整理再答（懒编译兜底）、夜间 Dream 全量整理。编译 LLM 用量与质量指标进 Langfuse 观测。
5. **两层仓库，索引只是编译产物**：源知识库 Repo（管理员维护）与个人大脑 Repo（每用户）分离；任何索引（向量/FTS）损坏或换模型，从大脑 Repo 全量重建即可。
6. **引用三级回溯**：答案 → 知识页（Compiled Truth 段落）→ Timeline 证据条目 → 原始文档（MinIO + git commit）。每一级都可审计。
7. **权限 Pre-filter 保留为安全底座**：个人大脑按用户物理隔离存储；查询时仍按可见库过滤——编译滞后窗口内也不会越权。

---

## 5. 权限模型设计（RBAC）

### 5.1 开源方案选型

| 方案 | 类型 | 结论 |
|---|---|---|
| **Casbin** ⭐ | 授权库（ACL/RBAC/ABAC 模型可自定义），全语言支持，policy 持久化 PG | **选定**：py-casbin + sqlalchemy adapter，嵌入 FastAPI |
| Casdoor | IAM 平台（内置 Casbin + 登录 UI + OIDC/SAML） | 可选：作为 IdP 提供 SSO，或对接企业已有 AD/LDAP/OIDC |
| Keycloak | 重型 IAM | 备选（企业已有 IdP 则直接对接） |
| OpenFGA | Zanzibar 风格细粒度关系授权 | P2 演进项（文档级 ACL 时迁移） |

**选型理由**：Casbin 嵌入式无额外服务；RBAC with domains 模型天然匹配"知识库=域"；策略存 PG 便于审计；需要文档级细粒度时可平滑演进到 OpenFGA。

### 5.2 Casbin 模型定义（RBAC + Domains）

```ini
[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act

[role_definition]
g = _, _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub, r.dom) && (r.dom == p.dom || keyMatch(r.dom, p.dom)) && r.obj == p.obj && r.act == p.act
```

约定：
- `dom` = 知识库标识 `kb:{type}:{id}`（如 `kb:org:12`、`kb:industry:3`）
- `g, alice, kb_admin, kb:org:12` —— alice 是组织库 12 的管理员
- `p, kb_admin, kb:org:*, kb, write` —— 库管理员可写
- **个人库不走策略**：服务层硬编码 `owner == user_id` 才可见，Casbin 中不注册个人库任何策略
- **组织库可见性**：由组织树计算（用户 → 所属 org 节点链 → 命中库绑定的节点即 `read`），组织树变更通过事件刷新用户可见库缓存
- **行业库 ACL**：授权条目扩展表 `industry_grant(kb_id, subject_type, subject_id, expires_at)`，权限中心编译为 Casbin 策略或运行时求值（含有效期与角色/人员/组织三类主体）

### 5.3 可见知识库计算（每次查询入口执行）

```
visible_kbs(user) =
    personal_kbs(user)                       # 本人所有
  ∪ { org_kb | org_kb.node ∈ ancestors∪self(user.org_nodes) }
  ∪ { industry_kb | grant(industry_kb, subject ∈ {user, user.roles, user.org_nodes}) 且未过期 }

查询时用户勾选子集 ⊆ visible_kbs；否则请求 403。
结果缓存于 Redis（TTL + 权限变更事件失效）。
```

### 5.4 权限管理功能（后台）

- 用户管理：手动 / LDAP / OIDC 同步；用户归属多组织节点
- 组织树：CRUD、拖拽调整、合并（合并时其组织库自动跟随）
- 角色管理：自定义角色（如"合规审核员"），角色可被行业库 ACL 引用
- 授权向导：行业库 → 添加授权（人员/角色/组织三种 Tab，支持有效期、批量）
- 管理员任免：组织库/行业库支持多名管理员，任免有审计
- 审计：全部权限变更、越权尝试（403）记录，审计员可查
- **越权回归测试集**：CI 中跑固定用例矩阵（用户 × 库 × 操作），权限逻辑改动必须全绿

---

## 6. 数据模型设计（核心表）

```sql
-- 用户 / 组织 / 角色
users(id, username, display_name, email, status, source, created_at)
org_nodes(id, parent_id, name, path, sort, status)          -- 组织树（path 物化路径）
roles(id, name, description, builtin)
user_org(user_id, org_node_id)
user_role(user_id, role_id)

-- 知识库
knowledge_bases(id, type CHECK ('personal','org','industry'), name, description,
                owner_user_id,          -- personal: 本人
                org_node_id,            -- org: 绑定组织节点
                git_repo_url,           -- Git 仓库 (Gitea)
                embedding_model_id, status, created_at)

kb_admins(kb_id, user_id)                                   -- 组织库/行业库管理员(1..N)
industry_grants(kb_id, subject_type CHECK('user','role','org'),
                subject_id, granted_by, expires_at, created_at)

-- 文档与分块（自研索引表）
documents(id, kb_id, md_path, title, source_type CHECK('upload','web','obsidian','import'),
          raw_file_oid,          -- MinIO 对象（原始 docx/pdf…）
          version, git_commit, uploaded_by, status, created_at, updated_at)
chunks(id, document_id, kb_id, ord, content, token_count,
       char_start, char_end,
       tsv tsvector,           -- 全文检索列（zhparser 中文分词）
       embedding vector(1024), -- pgvector，维度随 embedding 模型
       metadata jsonb)
-- 索引: ivfflat/hnsw(embedding), gin(tsv), btree(kb_id)

-- 会话与引用
conversations(id, user_id, title, kb_scope jsonb, created_at)
messages(id, conversation_id, role, content, citations jsonb, latency_ms, created_at)
citations(id, message_id, chunk_id, document_id, kb_id, snippet)

-- 模型配置
model_providers(id, name, kind CHECK('llm','embedding','rerank'),
                base_url, api_key_encrypted, default_params jsonb, enabled)
model_configs(id, provider_id, model_name, context_len, dimensions,
              is_default, test_status, created_at)
kb_model_overrides(kb_id, kind, model_config_id)             -- 库级覆写（可选）

-- Casbin 策略表（adapter 自建）+ 审计表 audit_logs(...)
```

**混合检索 SQL（核心，约数十行）**：

```sql
WITH vec AS (SELECT id, row_number() OVER (ORDER BY embedding <=> :qvec) rk
             FROM chunks WHERE kb_id = ANY(:visible_kbs) LIMIT 200),
     fts AS (SELECT id, row_number() OVER (ORDER BY ts_rank_cd(tsv, :q) DESC) rk
             FROM chunks WHERE kb_id = ANY(:visible_kbs) AND tsv @@ :q LIMIT 200)
SELECT c.*, (coalesce(v.rk,9999) + coalesce(f.rk,9999)) rrf
FROM chunks c LEFT JOIN vec v USING(id) LEFT JOIN fts f USING(id)
WHERE v.id IS NOT NULL OR f.id IS NOT NULL
ORDER BY rrf LIMIT 50;   -- 再交 Reranker 精排 Top-K
```

---

## 7. 模型配置设计

### 7.1 后台功能

1. **三类模型分别管理**：LLM（生成）、Embedding（向量化）、Reranker（重排）各自独立的供应商/模型列表
2. **供应商注册**：名称 + Base URL + API Key（加密存储）+ 协议（OpenAI 兼容 / Anthropic / Ollama / vLLM）
3. **模型注册**：模型名、上下文长度、（embedding）维度、默认参数（temperature、top_p、max_tokens）
4. **默认与切换**：每类设全局默认；支持"连接测试"按钮（发一次最小请求验证）
5. **切换 Embedding 的重建流程**：提示管理员"将触发全量重嵌入任务"→ 异步队列分批执行，期间查询降级为关键词检索
6. **部署形态**：内网部署 **LiteLLM Proxy / new-api** 统一网关，平台后台只配网关地址与密钥；网关层做密钥轮换、限额、多模型路由与用量统计

### 7.2 典型配置示例

| 用途 | 供应商 | 模型 | 说明 |
|---|---|---|---|
| LLM（生成） | OpenAI 兼容网关 | qwen3-max / GPT-5 / DeepSeek V4 | 可切换 |
| Embedding | 自托管 TEI / API | bge-m3（1024 维） | 中文最优实践之一 |
| Reranker | 自托管 TEI / API | bge-reranker-v2-m3 | 混合检索后精排 |
| LLM（解析辅助） | 同上 | 轻量模型 | OCR 后处理/摘要（P1） |

---

## 8. 关键流程

### 8.1 知识摄入（多格式 → 源知识库 → 触发面向个人的编译）

```
上传 docx/pdf/xlsx/pptx/html/img/md
  → MinIO 存原始文件 (raw_file_oid)
  → 解析 Worker（MinerU/Docling 按类型路由；图片走 PaddleOCR）→ Markdown
  → Git commit 进入源知识库仓库（作者=操作人，可审计可回滚）
  → 状态机: 解析中 → 索引中 → 已发布
  → ★ 发布事件 knowledge.published：
      权限中心计算该库全部可见用户 → 对每人标记 dirty(topic)
      → Brain Compiler 增量编译（见 8.2）
  → 组织库可选"待审核"流（P1）
```

### 8.2 Brain Compiler：面向每一个人的编译流水线（v1.2 核心）

```
【触发器 1 · 新增知识】knowledge.published
  → 可见人群 = 权限中心.visible_users(kb)
  → 对每个用户 u、每个受影响主题 t：入队 dirty(u, t)（合并去重）

【触发器 2 · 权限变更】permission.changed（授权/撤销/调岗/角色/组织树）
  → 受影响用户的全量 dirty（视图边界变化）
  → 撤销类变更最高优先级：即时重编译（该用户大脑中对应内容即时移出）
  → 查询侧权限过滤同时生效（双保险，防编译窗口越权）

【触发器 3 · 夜间 Dream Cycle】cron
  → 面向每人执行 gbrain maintain：矛盾检测 · 过期提醒 · 同主题合并 ·
    孤儿页面清理 · 交叉引用修复 · （P2）外部信息 enrich

【编译执行（per dirty(u,t)，编排 gbrain skillpack）】
  1. READ   读取用户 u 的大脑主题页（现有 Compiled Truth + Timeline）
  2. GATHER 收集 u 可见范围内主题 t 的新证据（源知识库 diff）
  3. WRITE  编排 gbrain ingest：
     - 实体检测（人物/法规/项目/概念 → 实体页）
     - 重写 Compiled Truth（吸收新证据，冲突则标注矛盾）
     - 追加 Timeline（证据条目：来源库/文档/时间/原文链接）
     - 更新交叉引用与 backlinks
  4. SYNC   gbrain sync + embed（该用户大脑的加速索引增量更新）
  5. 版本化 Git commit（谁的编译、因何触发，全程可审计可回滚）

【调度与成本控制】
  dirty 队列按 (优先级, 用户, 主题) 调度：
  权限收缩 > 查询命中懒编译 > 活跃用户/热点主题 > 夜间全量
  同主题批量合并；编译 LLM 用量/质量指标入 Langfuse
```

### 8.3 对话查询（问大脑，而非搜碎片）

```
用户提问（含所选库范围 ⊆ visible_kbs）
  → 1. 权限计算 visible_kb_ids（Redis 缓存）——安全底座
  → 2. 主题定位：问题 → 大脑主题页（gbrain query：语义+关键词混合，仅在
       该用户大脑范围内）
  → 3. 命中主题页若为 dirty → 先增量整理再回答（懒编译兜底）
  → 4. 作答素材 = 该页 Compiled Truth（编译期已消化多源证据）
  → 5. LLM 轻量综述（组织语言/结合会话上下文），非碎片拼装
  → 6. 引用对齐：回答 [n] ↔ 知识页 Timeline 证据条目 ↔ 原始文档
  → 7. 流式输出（SSE）；追问进入下一轮
  → 8. 异步：Langfuse trace（命中主题页、Truth 版本、证据链、token）
  → 9. 本次对话中的新知识/新偏好 → 反哺 dirty 队列（个人大脑持续进化）
```

### 8.4 Obsidian 工作流

```
【管理员 · 维护源知识库】Obsidian 编辑 vault → obsidian-git push
  → Gitea Webhook → 解析/发布 → 触发面向可见者的编译（8.2）

【普通用户 · 查看自己的大脑】（P2）个人大脑 Repo 可在 Obsidian 中打开：
  Compiled Truth / Timeline / 实体页 / 交叉引用图谱——
  "你的大脑"是可见、可编辑、可带走的知识资产
```

---

## 9. 技术栈选型

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | React 18 + Next.js + Tailwind + shadcn/ui（SSE 流式） | 生态成熟；对话端与管理后台同栈 |
| 核心后端 + 编译编排 | **NestJS (TypeScript) + BullMQ** | **与 gbrain（TS/Bun）同栈，直接 npm 复用其 Brain Repo/检索内核**；BullMQ 做 dirty 编译队列 |
| **大脑引擎** | **gbrain（MIT npm 包）** | Brain Repo 管理、ingest（实体/Truth/Timeline/交叉引用）、hybrid 检索、maintain 健康检查——单人循环久经验证 |
| 文档解析 Worker | Python 微服务（MinerU / Docling + PaddleOCR） | 解析生态在 Python，独立服务边界清晰 |
| 权限 | **Casbin（node-casbin + pg adapter）**（IdP 可选 Casdoor/对接现有 AD） | 嵌入式 RBAC，策略入库可审计；权限变更发事件驱动重编译 |
| 检索/向量 | **PostgreSQL 16 + pgvector + zhparser**（gbrain 原生栈） | 一库多用，运维最简 |
| 模型网关 | LiteLLM Proxy 或 new-api | OpenAI 兼容统一出口；**编译用/查询用模型分别路由** |
| Embed/Rerank 自托管 | TEI | bge-m3 + bge-reranker-v2-m3 |
| Git 服务 | Gitea（内网） | 源知识库 Repos + **个人大脑 Repos**（每用户）托管 |
| 对象存储 | MinIO（S3 兼容） | 原始文件 |
| 缓存/队列 | Redis | 可见性缓存、dirty 编译队列、解析任务队列 |
| 观测 | Langfuse（自托管）+ Prometheus/Grafana | **编译 trace**（Truth 变更/证据数/LLM 用量）+ 查询 trace |
| 部署 | Docker Compose（≤500 人）→ Kubernetes/Helm（大规模） | 渐进式 |

**协议合规**：gbrain MIT（可闭源修改、可长期自维护）、Casbin Apache-2.0、Gitea MIT、LiteLLM MIT、TEI Apache-2.0、Docling CDLa-Permissive；MinerU 部分组件 AGPL 需评估（默认 Docling 主引擎）；MinIO AGPL 自托管无分发义务；Obsidian 闭源商用需 Commercial License（约 $50/用户/年）。

---

## 10. 非功能需求与指标

| 维度 | 指标 |
|---|---|
| 性能 | 大脑查询 P95 < 800ms；首 token P95 < 2s；并发 100 路对话 |
| 编译时效 | **权限撤销重编译 < 5 分钟全量完成**（安全线）；新知识对活跃用户 < 30 分钟编译可见；夜间 Dream 全量完成 < 6h |
| 编译质量 | Compiled Truth 与证据一致性抽检 ≥ 95%；矛盾检出率、过期召回率纳入评测 |
| 安全 | API Key 加密存储；传输 TLS；**个人大脑按用户物理隔离** + 查询权限过滤双保险；提示词注入防护 |
| 审计 | 登录、查询（主题页版本）、知识变更（git）、**编译记录**（触发原因/输入证据/Truth diff）、权限变更；留存 ≥1 年 |
| 可用性 | 关键数据（PG + 两类 Git Repo + MinIO）每日备份，RPO ≤ 24h，RTO ≤ 4h |
| 成本 | 编译 LLM 用量预算化（按人×主题配额）；Langfuse 监控编译 token 成本 |
| 质量 | 100 条黄金问答集 + 编译质量抽检集，纳入 CI 回归 |

---

## 11. 实施计划（里程碑）

| 阶段 | 周期 | 交付 | 验收标准 |
|---|---|---|---|
| **M0 技术 Spike** | 2 周 | gbrain 编排 PoC：单用户 Brain Repo 全循环（ingest→query→maintain）；**多用户 Repo 编排验证**（100 用户 dirty 编译压测）；解析质量实测；权限模型评审 | 单次增量编译 < 30s；100 用户×10 主题批量编译吞吐达标；解析满意度 ≥90% |
| **M1 MVP** | 6–8 周 | 个人库 + 组织库、**编译式对话**（大脑查询+引用）、库选择器、多格式上传、Brain Compiler v1（知识发布触发编译）、Casbin RBAC（组织树+库管理员）、模型后台配置 | 内部试点 1 个部门真实使用；新知识发布后 30 分钟内编译可见；越权回归全绿 |
| **M2 企业化** | 6–8 周 | **权限变更驱动重编译**（撤销<5 分钟）、行业库 + ACL、Dream Cycle（矛盾/过期/合并）、Obsidian 集成（源库维护 + 个人大脑查看）、审计（含编译记录）、Langfuse 编译观测 | 权限撤销重编译 5 分钟内完成且查询不可再见；管理员 Obsidian push 后 30 分钟内编译进可见者大脑 |
| **M3 GA** | 4–6 周 | SSO（OIDC/LDAP）、K8s 部署与压测（500 人编译调度）、编译/回答质量评测基线、备份恢复演练、渗透测试 | 压测达标（编译队列不积压）；评测基线入 CI |

**团队配置建议**：项目经理 ×1、后端（TS/NestJS）×2、算法/编译引擎 ×1、前端 ×1、测试兼 DevOps ×1（约 6 人）。

---

## 12. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| **编译 LLM 成本失控**（面向每人×每主题编译） | 高 | dirty 合并去重 + 优先级调度 + 按人/主题配额；轻量模型做增量编译、重模型只做夜间 Dream；Langfuse 成本看板；编译频率可按库级配置 |
| **编译时延导致新知识"不可见"** | 高 | 查询命中 dirty 页懒编译兜底（先整理再答）；活跃用户/热点主题优先队列；SLA：活跃用户 30 分钟内可见 |
| **权限撤销编译窗口越权** | 高 | 双保险：撤销即时移出（最高优先级编译）+ 查询侧权限过滤始终生效（编译永远不是安全边界，只是质量层） |
| gbrain 多用户编排深度超预期（其为单人工具） | 中 | M0 先做 100 用户编排压测；gbrain 仅用作单脑引擎（进程级隔离、按用户调用），编排层完全自研可控；极端情况可替换为自研 ingest 实现（约定不变） |
| Compiled Truth 编译错误/幻觉污染大脑 | 中 | 编译输出结构化校验（引用必须指向真实证据条目）；Truth diff 人工抽检 + 矛盾告警；git 版本化支持一键回滚；Truth 页标注"编译生成"水印 |
| 复杂 PDF/表格解析质量差 | 中 | M0 真实样本实测选引擎；Docling/MinerU 按类型路由；解析人工预览后发布 |
| 大脑 Repo 存储膨胀（每用户一份） | 中 | 主题页去重（编译产物远小于源文档）；冷用户 Repo 归档压缩；按需懒激活（首次查询时初始化） |
| 中文全文检索效果（zhparser）不佳 | 低 | M0 实测；备选 ParadeDB pg_search 或 jieba 预分词 |
| Embedding 换模型全量重建耗时长 | 中 | 分批异步 + 双索引热切换；期间降级关键词检索 |
| 提示词注入通过知识内容攻击 | 中 | 证据内容隔离标注 + 消毒 + 系统提示加固；权限过滤保证泄露上限为"用户本可见内容" |
| MinerU 协议风险（AGPL 组件） | 低 | 默认 Docling 主引擎；MinerU 商用评估后再启用 |
| Obsidian 商用许可 | 低 | 仅管理员安装（数量少）；普通用户走 Web；预算列入成本 |

---

## 13. 附录：调研参考

- Onyx：https://github.com/onyx-dot-app/onyx （原 Danswer，MIT + 企业版）
- RAGFlow：https://github.com/infiniflow/ragflow （Apache-2.0）
- MaxKB：https://github.com/1Panel-dev/MaxKB （GPLv3 + Pro）
- FastGPT：https://github.com/labring/FastGPT （附加条款开源协议）
- Glean：https://www.glean.com （商业标杆）
- gbrain：https://github.com/garrytan/gbrain （MIT；**v1.2 核心依赖**：单人大脑引擎 + 设计哲学来源）
- Casbin：https://casbin.org （Apache-2.0）｜ Casdoor：https://casdoor.org
- OpenFGA：https://openfga.dev ｜ LiteLLM：https://litellm.ai ｜ new-api
- pgvector：https://github.com/pgvector/pgvector ｜ zhparser ｜ ParadeDB：https://paradedb.com
- Docling：https://github.com/DS4SD/docling （CDLa-Permissive）｜ MinerU：https://github.com/opendatalab/MinerU
- TEI：https://github.com/huggingface/text-embeddings-inference
- Langfuse：https://langfuse.com ｜ RAGAS：https://docs.ragas.io
