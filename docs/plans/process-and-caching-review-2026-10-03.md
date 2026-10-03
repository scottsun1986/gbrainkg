# GBrainKG 开发流程复评与缓存/冗余审计（2026-10-03）

范围：仅依据仓库内的代码、配置、脚本与工作流，不采信文档中的自述。
对照基线：`v46.0`（提交 `d009f22`）。
本文同时记录：流程评估结论、缓存利用审计、冗余步骤审计，以及本轮已落地的代码修复。

---

## 一、流程复评结论

**总体判断：测试与可观测性层明显高于同类项目平均水平；发布路径是全项目风险最集中的地方。**

一句话概括风险分布：代码质量由测试兜住，但**真正决定「坏代码能否上生产」的那几道闸门要么缺失，要么可被静默跳过**。

### P0：能让坏变更上生产的缺口

| # | 问题 | 位置 | 修复方向 |
| --- | --- | --- | --- |
| 1 | `deploy-prod.sh` 唯一调用的 `scripts/ci.sh` **不做类型检查、不跑 lint**（`test:api` 是裸 `jest`），类型错误与 ESLint 违规可以直接进生产 | `scripts/ci.sh:53,55,59` | 把 `tsc --noEmit` 与 `lint` 作为 `run` 层加进 `ci.sh`，与 `ci.yml` 对齐 |
| 2 | RAG 质量门只在 `push` 触发且在 self-hosted runner 上，**任何 PR 都不会跑质量门**；仓库内无分支保护配置、无 CODEOWNERS | `.github/workflows/ci.yml:164`、`quality-gate.yml:66` | 质量门加入 `pull_request`（或 merge queue），并把必需检查写入仓库 |
| 3 | `release-functional-gate.sh` 在命中缓存指纹时 **直接 exit 0**，在跑 E2E、版式与核心检查之前就返回；指纹有效期 3600 秒 | `scripts/release-functional-gate.sh:33-36`、`release-gate-fingerprint.py:19` | 生产 profile 取消复用路径；记录**测试结果本身**的哈希，而不是墙上时间 |
| 4 | 73 个迁移中只有 2 个带 `verify.sql`，且**没有任何地方执行它**——包含刚新增的 FORCE RLS 迁移 | `packages/database/prisma/migrations/**` | 迁移验证设为强制项，并在 `deploy-prod.sh` 的 `migrate deploy` 之后调用 |

### P1：发布安全与变更管理

- **同时间戳迁移目录**：`20260926160000` 下有两个目录，Prisma 按字典序应用，顺序是偶然的（`20260926160000_rls_disable_no_policy_tables` 与 `_rls_global_identity_runtime_access`）。已应用迁移不能改名，需补兼容 shim 并在测试中强制时间戳唯一。
- **无回滚脚本**：全部迁移只有正向，无 `down.sql`；`deploy-prod.sh:408` 的 `rollback_single_instance` **只回滚代码不回滚 schema**，因此涉及 schema 的发布实际不可逆。
- **门禁跑在开发者机器上**：`deploy-prod.sh:209-214` 在本地对本地产物跑门禁，而 `--skip-gate`（`:200`）可一路绕过。门禁应针对即将运行的产物在目标机执行。
- **健康检查失败不自动回滚**：脚本刻意不做自动回滚（`:694-697`），坏版本会停留在实例上等待人工介入；多实例顺序发布时 inst1 已经降级而 inst2 仍是旧版。
- **迁移失败被吞**：`deploy-prod.sh:619` 的 `gbrain apply-migrations --yes || true` 会在部署中途静默吞掉迁移失败。
- **门禁结果存在本地文件**：`runtime/baseline-release-gate.json` 在 gitignore 内，且 `.env` 被计入指纹——本地改一次配置就会让已通过的门禁失效，同时这份「是否通过」的记录不可审计。
- **无覆盖率阈值**：`quality-gate.yml` 收集并上传覆盖率，`apps/api` 无 `coverageThreshold`，覆盖率回退不会被拦住。

### P2：可观测性与供应链

- Alertmanager 的接收配置只存在于宿主机 bind-mount，**仓库里没有对应文件**，`ALERT_WEBHOOK_URL` 默认为空——告警可能发往空路由。
- `gbrainkg-alerts.yml` 有一条 `probe_success{job="gbrainkg-api"}` 规则，但 `prometheus.yml` 里**没有配置 blackbox exporter**，该规则永远不会触发。
- 无 Dependabot、无 `pnpm audit`、无 secret 扫描。密钥校验是消费者惰性触发，`replace-with-a-long-random-secret` 这类占位符能通过长度检查。
- 全部 55 个 tag 均为轻量 tag，无签名；`v45.0` 指向的提交信息覆盖了大量不相关改动，无 PR 痕迹、无 release notes。
- `tests/e2e-web`（Playwright 套件）被任何工作流引用不到，属孤儿测试。

### 已经是行业最佳实践的部分（不要动）

- **多实例隔离是强制的而非文档约定**：`provision-instance.sh:97` 按库创建 `NOBYPASSRLS` 运行角色，`deploy-prod.sh:544-551` 在 `REDIS_DB` 不匹配时**直接让部署失败**。
- **RLS 用可执行的验证表达**：`verify.sql` 断言 13 张表的 RLS 既启用又有策略，并验证无作用域会话看不到任何行。
- **启动失败关闭**：`main.ts:36-42` 在 `RLS_ENFORCE=1` 配了迁移身份时拒绝启动，并用 `SELECT 1` 复验运行角色。
- **请求 ID 处理正确**：入站 id 做清洗与长度截断、回显，并经 `AsyncLocalStorage` 贯穿到 JSON 日志，日志层做深度密钥脱敏。
- **Prometheus 规则即代码**，且含 RAG 专属信号（`retrieval_failopen_total`、`rls_enforce`、`ingestion_queue_depth`），并为新指标配了 `absent()` 兜底。
- **发布前快照可回滚**：`deploy-prod.sh:555` 保留树摘要与可恢复归档，只留最近 5 份。
- **评测自检本身就是门禁**：`benchmark:selftest` 被 CI 调用，这正是本次修复的「指标悄悄停止测量」那类故障的防线。

---

## 二、提示词缓存利用审计

### 结论

**前缀顺序是对的，但缓存只做对了一半。**

`messages` 数组的构造顺序是：不可变的指令块（约 4-6KB）在 token 0，检索到的证据紧随其后，每轮变化的值（历史、个人记忆）在尾部。这是缓存友好的正确排布，代码注释的说明也准确。**没有发现把易变内容插在静态块之前的错误。**

但顺序是唯一做了的缓存工作：

| # | 问题 | 位置 |
| --- | --- | --- |
| 1 | 全文没有 `cache_control`、`prompt_cache_key`、缓存断点或粘性路由提示 | `apps/` 全量 grep 无命中 |
| 2 | 四次 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 读取**只进 trace 与 SSE `done` 载荷**，不改变任何行为——是测量，不是利用 | `chat.service.ts:5079,5103,5455` |
| 3 | 同一会话的两次 `getLlmChatConfig` 用不同 session id 且无路由亲和，连续轮次可能落到不同副本，从而错过本已热的前缀 | `chat.service.ts:4665` vs `1914` |
| 4 | 入库侧的 contextual-retrieval 调用**完全没用同一套静态前缀**：按文档解析 prompt 并传入每文档前缀，因此每篇文档都是冷提示 | `ingestion.service.ts:596-597` |

### 已修复：证据顺序不稳定会破坏缓存

这是审计里唯一有实际缓存后果的缺陷。两处最终排序缺少确定性 tie-break：

- `retrieval-arms.ts` 的通用分支只有 `b.score - a.score`；分数相同时由 `Array.sort` 的稳定性决定顺序，而某条检索臂这次在超时内返回、下次没有时，同一问题的证据顺序就会变。
- `citation-assembly.ts` 的 entries 只按 `b.best` 排序，相等时按 Map 插入顺序。

证据块位于静态指令之后，顺序一抖，**整块证据的前缀缓存全部失效**。

修复：两处都补确定性 tie-break（`retrieval-arms` 用 `ord` 再 `chunkId`；`citation-assembly` 用 group key）。

---

## 三、入库与问答的冗余步骤审计

### 已修复

| # | 问题 | 位置 | 修复 |
| --- | --- | --- | --- |
| 1 | **每个 chunk 被嵌入两次**：`embedAndStore` 先算 dense，随后 `indexHybridDocument` 对同一段可索引文本再调 `embedHybrid`，而该调用带 `return_dense: true` 返回的 dense 半边被直接丢弃 | `chunk-embedding.service.ts:174-181, 139-143` | hybrid 索引时把该次请求已付费的 dense 向量**顺带写入缺失的 chunk**（`COALESCE` 只补空缺，永不覆盖既有向量，两条路径不可能产生分歧） |
| 2 | **可见知识库集合在一次问答中重算 5 次以上**：答案路径本身、rerank hop 的授权、引用 ACL 校验、搜索结果过滤各算一次，每次都跑 `getUserOrgIds` 加四次 KB 查询，且各自开独立 RLS 事务 | `permission.service.ts:472` 及 36 处调用点 | 按既有短 TTL 缓存模式加 `visibleKbsCache`；所有权限变更入口本就调用 `invalidatePermissionCaches`，语义不变 |
| 3 | 纯文本标题被判为 claim，被证据门暂扣后在**答案末尾**回收 —— 即「标题跑到最后/错位」 | `chat.service.ts:339` `isStructuralHeadingLine` | 新增纯文本标题识别（见第四节） |

### 核实为「不成立」的审计项

- **「query 被嵌入两次」不成立。** `embedOne` 自带结果缓存与 singleflight（`embedding.service.ts:111-140`），语义缓存 lookup 与向量臂在缓存 TTL 内共用同一次嵌入。审计看到的两次调用在实现层面已收敛为一次。此处**不改**：为了一次性的调用点观感去改嵌入路径，收益为零而回归风险非零。
- **`unstable sort` 在 `isChapterListing` 分支已有 `ord` tie-break**，只有通用分支缺失，已按上面修复，未扩大改动面。

### 未修（记录待办，附理由）

- `rerankPool` 在多跳路径最多被 await 三次，未检查引用集合是否变化（`chat.service.ts:3323,3424,3736`）。跳过条件需要「引用集合哈希」的稳定定义，与本次的排序改动耦合，建议单独一轮做。
- `filterSearchResultsForUser` 与 `filterQueryResultByCurrentPermission` 解析同一份可读文档集合，QA 路径调用七次（`citation-assembly.ts:134`、`chat.service.ts:1573,1962,2043,2090,2831,2958,3139`）。按请求 memo 化可行，但涉及 ACL 正确性，应与权限测试一同提交。
- 入库侧 `simhash64(markdown)` 在 `evaluateExtendedContentQuality` 与 `ingestion.service.ts:561` 各算一次全文档一遍；近重复门在精确哈希缓存命中后仍加载最多 500 行兄弟记录。两者都在入库热路径之外（每文档一次），收益小于改动风险。
- `VerifiedLateChunking` / `TableEvidenceService` 按调用构造而非单例注入（`chat.service.ts:1971`）。
- 辅机阶段（RAPTOR 摘要与图谱抽取）严格串行，未并行。

---

## 四、本轮代码改动

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/chat/chat.service.ts` | `isStructuralHeadingLine` 新增纯文本标题识别（`isPlainTextHeading`）：以「行是什么」判别——标题以章节类名词收尾，断言则含限值措辞、作用于人的谓词或数量。补 2 个回归测试（含 8 条反例，确保数字断言与限值句仍走证据门） |
| `apps/api/src/chat/retrieval-arms.ts` | 最终排序补 `ord`/`chunkId` tie-break |
| `apps/api/src/chat/citation-assembly.ts` | group 排序补 key tie-break |
| `apps/api/src/embedding/chunk-embedding.service.ts` | hybrid 索引复用同请求的 dense 向量填补空缺 |
| `apps/api/src/permission/permission.service.ts` | 新增 `visibleKbsCache`（短 TTL，随权限变更失效） |

验证：`npx tsc --noEmit` 干净；API 全量 **1062 passed / 0 failed**（新增 2 例）；embedding 30/30；permission 27/27。

---

## 五、建议执行顺序

1. **补 `ci.sh` 的类型检查与 lint**（P0，一行改动级），这是当前唯一能让类型错误直达生产的缺口。
2. **质量门加入 PR 触发**，并把必需检查写入仓库。
3. **取消 release gate 的缓存复用**，改为记录测试结果哈希。
4. **迁移验证强制化**：至少让 `deploy-prod.sh` 在 `migrate deploy` 后执行同目录的 `verify.sql`（本仓库已有两份可参照）。
5. 之后再做第四节列出的未修冗余项，每项与被触及的权限/检索测试一同提交。
