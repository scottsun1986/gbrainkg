# 深度审计：占位实现猎捕与核心方案再评估（2026-09-12 夜）

范围：入库管道、知识查询管道、权限隔离。方法：代码级逐项核查（文件:行号级证据）+ 运行日志 + 本会话实测数据交叉验证。基线：`main@b0a5c86`。

---

## 一、两个用户报告的 bug —— 均为真实 bug，已修复

### 1. Dream 周期持续失败（"12 个 source · 3 成功 · 9 部分"）
**是 bug。** 根因：两个 GBrain source 仓库残留 `.git/index.lock`（git 进程被中途杀死所致，一把残留自 9 月 1 日、一把来自当天早晨的服务重启），其后每次 Dream 的 `git add -A` 都失败且永不自愈。
修复：清理陈锁（验证 22:04 Dream 恢复成功）+ 适配器新增自愈——add/commit 遇锁失败时，锁龄超过 10 分钟即删除并重试一次（`gbrain-adapter/src/index.ts` runGit/clearStaleIndexLock）。

### 2. 会话列表"昨天/七天"分组消失
**不是分组代码被删，是被淹没。** 当天自动化评测灌入 779 个测试会话，把侧栏"最近 100 条"窗口全部占满，旧会话被挤出，空分组按设计隐藏。
修复：清理 779 个测试会话（保留用户数据）+ 前端补回"昨天"分组标签。实测现在显示"今天 / 近 7 天"。

---

## 二、占位实现清单（本轮逐项核查结论）

### 已确认修复（上一轮 v13）
Chunk.embedding 缺列、RAPTOR 表缺失、tsv 触发器、评测 judge 无证据正文、富化推理模型适配——均已闭环并有验收数据。

### 本轮新确认（按严重度）

| # | 发现 | 状态 |
|---|---|---|
| 1 | **RAPTOR Level-2 全库节点被自家权限守卫 100% 剪除**（documentId=null 的 citation 一律丢弃），trace 显示"召回成功"实际零贡献 | ✅ 本轮已修复（按 kbId∈可见集放行） |
| 2 | `/chat/search` 对越权 kb_scope 静默过滤，与 completions 的 403 语义不一致 | ✅ 本轮已修复（统一 403） |
| 3 | **FOLLOWUPS 建议追问从未赋值**（死变量），"建议追问"标题永远空渲染 | ✅ 已改为非空才渲染；接真实推荐是待办 |
| 4 | NotificationsPanel 硬编码两条欢迎通知 | ⚠️ 占位（无后端通知系统，属装饰） |
| 5 | shareConversation 分享的是首页 URL 而非会话链接（后端无 share 端点），语义为假 | ⚠️ 占位 |
| 6 | late-chunking.ts 死代码（无 import + 开关关闭，双重死亡） | ⚠️ 建议删除或接线 |
| 7 | GraphRAG searchGlobalCommunities 零生产调用（local search 是真的） | ⚠️ 半占位 |
| 8 | AuditLog/AuditService 孤儿（写入服务全仓零调用、无读取；前端审计页读的是拼装数据）；budget_ledger/budget_reservations/calibration_profiles 连 DDL 都不存在 | ⚠️ 未实现（非未接线） |
| 9 | **aclEpoch 机制空转**：bumpScopeEpoch 全仓零调用，权限撤销不 bump 任何 epoch；注释宣称的"epoch 失效"语义不成立。实际安全靠实时 DB 复核撑住（见权限节） | ⚠️ 应接线或删注释 |
| 10 | 主生成流不读 reasoning_content：推理模型若把输出全放 reasoning_content 会得到空回答（当前默认模型 max_tokens 无上限、content 正常到达，故未触发；judgeEntailment 与 RAPTOR 都已处理 reasoning） | ⚠️ 待加流式兜底 |
| 11 | WeKnora 联邦检索（含 RRF）双开关默认关 + 绑定用本系统 documentId 冒充 WeKnora knowledge_id（即使开启也不匹配） | ⚠️ 灰度未开通 |
| 12 | HyDE 要求显式 HYDE_ENABLED=true，默认 .env 下永不执行 | ⚠️ 默认关闭 |
| 13 | GraphRAG 自动抽取 AUTO_GRAPH_EXTRACT 默认关（手动 reindex 可用） | ⚠️ 默认关闭 |

**审计误报更正**：审计初报"语义缓存 lookup/store 键错位导致永不命中"——经我核对调用链为**误报**（processChat 传入的 userScope.fingerprint 就是 cacheScopeKey；本会话 CMRC 实测缓存命中 TTFT 0.6s 亦佐证）。已在代码处补注释防止后人再误判。

---

## 三、核心方案再评估

### 3.1 入库管道 —— 真实、完整、达标

链路：上传/文本 → BullMQ → 解析（native/AnyDoc/OCR/VLM 分级路由，未配置时诚实降级并标记质检而非伪造）→ 质量门禁 → Contextual Retrieval（真 LLM，含推理模型适配、预算采样、滑动窗口）→ 版本围栏事务写块 → 发布 coreReady 门控 → enrichment（embedding 64/批续跑+覆盖率校验 → RAPTOR 向量化摘要树 → 图谱可选）。
**结论：入库侧已无占位，工程完整度属先进水平。** 与 SOTA 的差距是策略层而非真实性：词法通道是 contains+trigram 而非 BM25/中文分词；无语义分块；Chunk 无 versionId（documentId 全删 + CAS 围栏的过渡方案）。

### 3.2 查询管道 —— 真实、层次完整，两处空转已修

现状：精确缓存 → 推理模型感知的规划（简单题零 LLM）→ 混合召回（pgvector 语义 + 关键词 + RAPTOR 向量摘要 + GraphRAG 关系上下文）→ 多跳 ReAct → 批量重排 → MMR/覆盖选择 → 时效裁决 → 流式生成 + 句子级证据核验门控 → 缓存（含 ACL 复核）。
本轮修复后，此前"看起来有实际没有"的全局召回臂（RAPTOR Level-2）恢复贡献。
**差距**：无 CRAG 式"检索失败→改写重试→降级"闭环（当前是扩检一次+诚实拒答）；query router 是启发式而非学习式；无 late-interaction；推理模型的流式兜底缺失（#10）。

### 3.3 权限隔离 —— 架构真实且扎实，无越权通道

逐项核查结论：
- **ACL 模型真实**：个人库仅 owner；组织库仅向上继承；行业库按 user/role/org 三类主体+过期过滤；kbAdmin 不外溢同组织其它库；无"全量返回"捷径。
- **三层防线**：范围解析（请求 scope ∩ 可见集）→ 检索后逐条过滤（docId→库+发布+时效；inventory→库级；RAPTOR→库级[本轮补]；derived→源集+epoch 精确匹配）→ 缓存命中前实时复核。
- **GraphRAG/知识图谱按可见库构建与缓存**（缓存键含可见集），无跨权访问。
- **AdminGuard 类级全覆盖**，未发现漏保护端点；open-api 凭证是真验签（sha256+AES-GCM 回退），权限继承用户 ACL。
- **缺口**（非越权，是机制空转与颗粒度）：aclEpoch 无触发点（#9，安全靠实时复核兜底，但语义应修正或接线）；图谱实体表不随文档下架即时清理（可见范围内的元数据滞后）；open-api 无凭证级 scope/限流（凭证=用户身份，无独立应用授权粒度）。

### 3.4 总体判定

与上轮"不能认定 SOTA"相比，本轮结论升级为：**核心链路（入库/查询/权限）已无占位式虚假实现，真实性达标；工程形态达到业内先进水平**。距离"最优/SOTA"剩余的是一份明确的、可执行的差距清单：

| 优先级 | 事项 |
|---|---|
| P1 | aclEpoch 接线（权限变更 bump）或删除虚假注释；推理模型流式 reasoning 兜底 |
| P1 | 词法通道 BM25 化（两步走方案已在融合文档 §1.3 裁决） |
| P2 | 通知/分享/建议追问三个前端占位：接真实数据或删除入口 |
| P2 | CRAG 检索纠错闭环；语义分块实验；late-chunking 决策（删或接） |
| P3 | AuditLog 启用（真实审计）或删表；open-api 凭证级 scope/限流；图谱实体随下架清理 |

---

## 四、本轮变更

`b0a5c86`：Dream 自愈、RAPTOR Level-2 放行、search 越权 403、会话"昨天"分组、建议追问空块隐藏。单测 29 套件/222 用例全绿，API+Web 已重建部署本机。
