# 开发流程复评：工程实践与缓存/冗余审计（2026-10-03）

对象：`/home/scottsun/gbrainkg`（GBrainKG）。方法：读代码、脚本、工作流本身，不采信既有文档的自述。

---

## 一、工程实践复评

### 已经做到位的部分

- **门禁在发布路径上**：`deploy-prod.sh` 默认先跑 `GATE_STRICT=1 bash scripts/release-quality-first-gate.sh`，失败即中止，不 rsync、不重启。
- **发布前快照**：每次 rsync 前把现网树打包到 `.releases/<timestamp>/`，manifest 记录 git SHA、`.env` 哈希、树摘要。回滚是现成命令。
- **隔离性是强制的**：`provision-instance.sh` 按实例建 `NOBYPASSRLS` 运行角色；`deploy-prod.sh` 在 `REDIS_DB` 不匹配时硬失败。配置漂移会让发布失败，而不是悄悄生效。
- **可观测性作为代码**：`observability/` 有真实指标（`chat_first_text_ms`、`retrieval_failopen_total`、`rls_enforce`、`ingestion_queue_depth`），日志是结构化 JSON 且带 requestId 贯穿。
- **评测框架有自检**：`benchmark:selftest` 在 CI 里跑，框架本身坏掉会被拦下。

### P0：会让坏变更上生产的缺口

| 问题 | 证据 | 后果 |
|---|---|---|
| **CI 不做类型检查**。`ci.yml` 只跑 `pnpm run test:api`（jest），没有 `tsc --noEmit`，也没有 eslint | `.github/workflows/ci.yml` | 类型错误可合并、可发布 |
| **发布门禁在同一台开发机上跑**，跑的是本地工作区，不是将要发布的 commit | `deploy-prod.sh:200` 附近的 `cd "$LOCAL_ROOT"` | 本地脏工作区通过门禁 ≠ 发布产物通过门禁 |
| **迁移没有可执行的验证**。73 个迁移里只有 2 个带 `verify.sql`，且脚本里没有任何地方执行它们 | `packages/database/prisma/migrations/**` | RLS / 约束类迁移出错只能等运行时暴露 |
| **`--skip-gate` 存在**。一条 `--skip-gate` 就能跳过全部验证直接发布 | `deploy-prod.sh` 参数解析 | 事故时的第一反应就是它 |

### P1：发布安全与变更管理

- **门禁指纹复用**：验证结果以「指纹 + 通过时间戳」缓存 1 小时内直接复用。指纹覆盖源码与构建产物哈希，不覆盖测试配置本身；同一小时内改测试不会让缓存失效。
- **无回滚脚本**：所有迁移只有正向。`rollback_single_instance` 只回滚代码不回滚 schema，涉及 schema 的发布不可逆。
- **健康检查失败不自动回滚**：打印回滚命令后退出。inst1 坏掉时 inst2 继续发布，范围不一致。
- **迁移失败被吞**：`gbrain apply-migrations --yes || true` 在部署中间失败不会中止。
- **门禁证据是本地文件**：`runtime/baseline-release-gate.json` 在 `.gitignore` 内，不共享、不可审计。
- **同时间戳迁移目录**：`20260926160000_rls_disable_no_policy_tables` 与 `20260926160000_rls_global_identity_runtime_access` 共用前缀，应用顺序靠字典序，属于巧合。

### P2：成本与体验类

- **`/chat` 曾是预渲染静态页**：`Cache-Control: s-maxage=31536000`，浏览器永久保留首次 HTML。发布后的新 bundle 对老客户端不生效，表现为「修复没生效」。已在 v48.4 改为 `force-dynamic`。
- **会话列表首屏全量**：曾固定取 100 条会话，登录即拉全部历史。已在 v48.3 改为游标分页，首屏 30 条。
- **会话详情携带完整 processingTrace**：单条可达数百 KB，折叠时不看也在传。已改为按需拉取。
- **无覆盖率阈值**：`quality-gate.yml` 收集覆盖率，不设阈值，回退不会被拦。
- **无依赖/密钥扫描**：无 Dependabot、无 `pnpm audit`、无 secret scan。

### 建议执行顺序

1. `ci.yml` 加 `tsc --noEmit` 与 `eslint`（半小时，纯加法）
2. 门禁改为在将要发布的 commit 上跑，或至少要求工作区干净
3. 带 `verify.sql` 的迁移在 `deploy-prod.sh` 中自动执行
4. `--skip-gate` 加审计日志并在 release notes 中强制声明
5. 补 `down.sql`（或书面记录不可逆的迁移）到 `migrate` 说明

---

## 二、提示词缓存利用

### 结论：结构正确，但没有主动利用

`chat.service.ts` 组装 `systemMessageContent` 的顺序是：**静态规则 → 表格聚合约束 → 拒答纪律 → 参考资料 → 专项指令 → 历史对话 → 个人记忆**。

这个顺序本身是对的：长的静态块在最前，逐轮变化的部分在尾部，KV cache 命中率的最大化条件满足。

**但没有任何一步是在为缓存做设计**：

- 全树无 `cache_control` / `prompt_cache_key` / 缓存断点。
- `usage.prompt_cache_hit_tokens` 被读取并记入 trace，但**没有任何行为依赖它** —— 命中率低不会触发任何降级或重排。
- 同一会话的两次 `getLlmChatConfig` 用不同 session id，无路由亲和性保证，前后轮可能落到不同副本。

### 一个具体伤害缓存的点

`retrieval-arms.ts` 的最终排序在同分时已加了 `(ord, chunkId)` 兜底，但 `citation-assembly.ts` 的 `entries.sort` 之前只按 `b.best` 排。`best` 是归一化后的值，同分极常见；`Array.sort` 的稳定性只在同一输入序下成立，而检索臂的超时/降级会让输入序在两次相同查询间变化 —— 证据块顺序一变，其后所有 token 的缓存全部失效。

已在 v48.5 前补上 `key.localeCompare` 作为最终 tie-break。

### 可以做但没做的

1. 把 `dynamicDirectives`（每轮可能变化）从 system message 移到 user message，让 system message 变成给定证据集下的常量。
2. 在 provider 支持时发送 `cache_control: {type: 'ephemeral'}` 标记 system 前缀边界。
3. 用 `prompt_cache_key` = 会话 id，让同一会话的前缀在同一副本上保持热。
4. trace 里已记录 `cacheHitRate`；把它接到告警上：命中率低于阈值说明证据顺序不稳或 system message 被逐轮污染。

---

## 三、入库与问答的冗余步骤

### 已消除的重复工作

| 位置 | 问题 | 修法 |
|---|---|---|
| `chunk-embedding.service.ts` | dense 臂算完向量，hybrid 臂对同一段文本再调一次嵌入端点，返回的 dense 半边被丢弃 | hybrid 写入时若 chunk 尚无向量，用同一次请求的 dense 结果补上（`COALESCE`，不覆盖已有值） |
| `retrieval-arms.ts` / `citation-assembly.ts` | `extractRawChunkText` 的解析前缀、`isStructuralHeadingLine` 的标题识别、`isSourceLabelHeading` 的来源标签识别，三处各自重写同一套正则 | 已收进 `version-sibling-evidence.ts` 与 `ordered-answer.ts`，其余调用点复用 |
| `semantic-cache.service.ts` | 语义缓存命中时不校验 ACL | 已通过 `validateEvidenceDependencies` 在写入与读取两侧各校验一次 |

### 入库路径

- **重复计算**：`document.coverage()` 被算两次 —— 一次在 `processDocument` 末尾取覆盖率，一次在健康检查里再取。每次都是全库 count。改成在同一事务里复用第一次的结果。
- **无效循环**：`enrichment.processor.ts` 对每个 chunk 单独 await `embed`，而 `chunk-embedding.service.embedAndStore` 已提供批量路径。批量化后嵌入调用次数从「chunk 数」降到「batch 数」。
- **`office-converter` 无冷启动上限**：每个 PPTX 预览请求起一个 `soffice` 进程；已有常驻 unoserver 时走常驻，但回退路径没有并发闸门。并发 10 个预览会起 10 个 soffice。加了信号量（上限 2）与超时回退。

### 问答路径

- **`getVisibleKnowledgeBases` 每次请求重算**：一次问答至少调用 5 次（答案路径、rerank hop 授权、引用 ACL、搜索过滤、缓存重验证），每次跑 `getUserOrgIds` + 4 次 KB 查询。已在 v48.3 加 5 秒 TTL 缓存，权限变更入口主动失效。
- **`rerankPool` 重复调用**：多跳路径上被 await 3 次。前两次在同一候选集上，第三次在 hop 后。可跳过条件是「引用集与上次相同」，目前没有实现 —— 这是一个已知的剩余冗余。
- **语义缓存的向量查询与 dense 臂查询各 embed 一次**：缓存 lookup 先 `embedOne`，dense 臂再 `embedOne`。`embedOne` 自带结果缓存与 singleflight，所以第二次是进程内命中，不是网络往返。无实际浪费。

### 未修的已知冗余

1. `rerankPool` 的可跳过判定（上表最后一行）—— 需要先记录「上次 rerank 的候选集指纹」。
2. 入库的 `document.coverage()` 复用 —— 需要跨函数传递中间结果，改动面比收益大。
3. office-converter 信号量已加，但回退路径的 soffice 进程在异常时可能残留；缺一个 reaper。

---

## 四、与本轮发布相关的两点

- v48.4 修的「发布后修复不生效」不是工程实践缺陷的抽象讨论，而是一个具体的、已在生产造成两次「明明修了却没变化」排查的坑：预渲染静态 HTML 被浏览器缓存一年。已改 `force-dynamic`，本条同时进入上面的 P2 清单以防复发。
- v48.5 修的两个门禁失败项（P2-03 答案随机 HIT/MISS、P7-02 快照刚建就被丢）都不是「门禁太严」，而是**被测行为本身不确定**。P7-02 更正如下。

### P7-02 的两轮归因

**第一轮（v48.5，已上线但归因错误）**：图谱快照缓存超过 32 条时整体 `clear()`，会丢掉仍新鲜的快照 —— 这个问题真实存在，已改为 LRU 淘汰（`KG_CACHE_MAX_SNAPSHOTS`，默认 64），并保留。这是正确的改进。

**第二轮（真正的失败原因，v48.6）**：门禁套件跑约 9 分钟，而 `KG_CACHE_TTL_MS` 默认 300 秒。P7-02 执行时快照早已过期，走 stale-while-revalidate 分支（后台重建，实测 11 秒）。该分支**确实是从快照返回的**（0.02s），却返回 `cached: false` —— 把一次快照命中伪装成全量重建，测试因此判失败。

门禁跑得比缓存活得久，这类「标志位谎报」平时不会暴露，只在长套件里现形。修法是让 `cached` 只表达「本次是否现算」，陈旧性由已有的 `stale` 字段单独承载；Web 端只读 `stale`，无下游影响。

**教训**：这类缺陷的排查成本远高于修复成本，因为失败现场（`cached=False`）与真实原因（TTL 过期）之间没有任何语义关联。看到「缓存没命中」的第一反应应当是先确认快照是否已过期，而不是先怀疑淘汰策略。
