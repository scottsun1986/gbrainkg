# 上游开源边界评估（2026-10-06）

前提约束（用户设定）：**GBrain 等来源于其它开源项目的部分，不改动其代码，以便后续自动更新。**

---

## 1. 结论

**边界是干净的。** 本仓库**不包含任何上游源码**：无 git submodule、无 vendored 目录、无上游代码副本。GBrain 本体（CLI + Bun 运行时 + 它自己的数据库 schema）安装在仓库之外，我们通过**子进程调用**使用它。

因此"不改上游代码"这条约束**当前没有被违反**，本次所有改动都落在我们自己的适配层与业务代码里。

真正需要关注的是**耦合面** —— 即我们在多大程度上依赖 gbrain 的对外契约（命令、输出格式、配置键、数据库表）。这决定了升级上游时会不会被打断。

---

## 2. 上游 / 自有 的划分

| 组件 | 归属 | 位置 | 说明 |
|---|---|---|---|
| `gbrain` CLI + Bun 运行时 | **上游** | 仓库外（`~/.local/share/gbrain`、`/usr/local/bin/bun`） | 不 fork、不内嵌 |
| gbrain 自有数据库表（`pages`、`content_chunks`、`minion_jobs`、`oauth_tokens` 等约 47 张） | **上游** | 与应用共库的 `public` schema | 由 gbrain 自己的迁移创建 |
| `packages/gbrain-adapter` | **自有** | 仓库内 | 以子进程方式调用 gbrain，**不含上游源码** |
| `apps/api`、`apps/web`、`apps/parser-worker`、`packages/database` | 自有 | 仓库内 | 业务代码与迁移 |

---

## 3. 耦合面清单与更新风险

适配器（`packages/gbrain-adapter/src/index.ts`）依赖上游契约的地方，按风险从高到低：

### 3.1 CLI 子命令（中风险）
调用面：`migrate`、`migrate embeddings --status`、`query`、`query-expansion`、`sources`、`sync`、`rebuild knowledge source`、`sync knowledge documents`、`call --source <id> <tool> <json>`。

子命令名一旦重命名或参数语义变化，调用即失败。**当前无版本断言** —— 适配器不会在启动时校验 gbrain 版本，升级后表现为运行时报错而非启动即失败。

### 3.2 配置写入的键名（中高风险）
通过 `gbrain config set <key> <value>` 写入的键，全部是上游的**内部配置 schema**：

```
provider_base_urls.<chat|embedding|reranker 三个 recipe>
chat_model / expansion_model
search.expansion / search.mode
```

这些是上游未承诺稳定的实现细节。上游重命名或改层级时，我们会**静默写错或写入失败**，且难以在应用侧察觉。

### 3.3 输出解析（中风险）
- 多数输出走 `JSON.parse`，并带"从首个 `{`/`[` 起切片再解析"的容错，对前置噪声不敏感 —— 这一层**较健壮**。
- 但 `migrate embeddings --status` 依赖正则 `Column:\s+([\w]+\.[\w]*embedding[\w]*)\s+(\d+)d` 解析维度状态；这是**格式耦合**。
  （注：本次优化把该正则从只认 `content_chunks.embedding` 改为认任意 `*embedding*` 列，**降低了**耦合。）
- 页面正文解析依赖 frontmatter 正则；本次已改为锚定式匹配，取代原先会误删正文的宽松多行模式，**同样降低**了耦合。

### 3.4 数据库共库（中风险，且是本轮踩过的）
- 应用与 gbrain **共用同一个 PostgreSQL**，上游拥有自己的表集合。
- 风险形态一：我们的校验器曾按"public 下任何启用 RLS 的表都必须 FORCE"判定，把 gbrain 的 47 张表判为发布失败 —— **这是我们把自有规则强加到了上游对象上**，已修复为只检查"有策略但未 FORCE"。
- 风险形态二：上游升级可能改变它自己的 RLS 表集合 / 建表方式，我们的校验器与授予脚本需随之保持不敏感（现已改为按策略存在性判定，不再依赖具体表名清单）。
- 风险形态三：gbrain 的 v35 迁移需要一个**超级用户**去预建事件触发器（`role llmwiki may not CREATE EVENT TRIGGER`）。这意味着**上游升级可能要求人工的、带超级用户权限的步骤**，目前未纳入我们的部署脚本。

---

## 4. 本次优化对"可更新性"的影响

**净改善**，逐条：

| 改动 | 对可更新性的影响 |
|---|---|
| 嵌入维度校验正则改为匹配任意 `*embedding*` 列 | **降低**耦合（原先硬编码旧列名） |
| frontmatter 解析改锚定模式 | **降低**耦合（原先宽松模式会误删内容） |
| `envNumber` 等数值解析加 NaN 防护 | 无关耦合，但避免上游超时设置被静默替换 |
| 校验器改为按"策略存在性"判定并豁免外来表 | **降低**耦合（不再把上游表当自有对象检查） |
| 发布脚本 INF-01 修复 | 无关耦合，但避免升级中断时留下不一致状态 |
| 适配层其余改动（M-10/M-11/M-28/M-29/M-78/M-80/M-81） | 均在**自有适配层**内，未触碰上游代码 |

**没有一处改动修改了上游代码或其数据库对象**（唯一涉及上游对象的是"豁免检查"，属于不干预）。

---

## 5. 待办与建议

| 优先级 | 事项 | 理由 |
|---|---|---|
| 高 | **增加 gbrain 版本断言**：适配器启动时读取上游版本，低于已知兼容下限即明确报错 | 当前升级后是运行时随机失败，而非启动即失败 |
| 高 | **把 `config set` 的键名集中为常量并加注释标注来源**，便于升级时定点核对 | 这是最易被上游静默破坏的一处 |
| 中 | **把 gbrain 升级步骤写入部署文档**，含 v35 事件触发器的超级用户预建步骤 | 上游升级目前有未自动化的人工前提 |
| 中 | 校验器与授予脚本继续保持"不依赖上游表名清单"的写法 | 上游改表集合时不需改我们的脚本 |
| 低 | 在 CI 中记录当前上游版本，便于回溯"哪次升级引入了变化" | 事后定位 |

---

## 6. 方法说明

- 依据仓库实际状态（`.gitmodules` 不存在、`packages/` 内容、适配器源码中的子进程调用与解析逻辑）。
- 未执行上游升级，因此以上为**静态评估**，不含升级实测。

---

## 7. 实施记录（§5 的第 1、2 条已落地）

### 7.1 GBrain 版本断言

`packages/gbrain-adapter/src/index.ts` 新增 `ensureGbrainVersion()` 与常量 `GBRAIN_MIN_VERSION = '0.60.0'`（可用环境变量 `GBRAIN_MIN_VERSION` 覆盖）。

设计取舍：**只有"成功读到版本且低于下限"才致命**；`--version` 本身也是上游接口，若二进制缺失或输出无法解析，则**告警一次后继续**（fail-open），避免一个探测失败就阻断全部 gbrain 操作。

探测点放在 `executeProcess` 而非 `run`：这样请求路径、取消语义与进程池配额计数**完全不变**（最初放在 `run` 里曾把契约测试里"已中止请求"的报错从 `GBRAIN_CANCELLED` 变成 `AbortError`，并因占用进程池导致 16 个测试挂起 —— 已修正）。另提供 `GBRAIN_SKIP_VERSION_CHECK=1` 供测试显式跳过。

实测四种情形：

| 情形 | 结果 |
|---|---|
| 安装 0.50.0（低于下限） | **明确报错** `GBRAIN_VERSION_TOO_OLD: installed 0.50.0 is below the supported minimum 0.60.0` |
| 安装 0.60.25.0 | 通过版本检查 |
| 二进制缺失 | 不因版本被拒（fail-open） |
| 版本输出无法解析 | 告警一次后继续 |

### 7.2 配置键名集中化

新增常量表 `GBRAIN_CONFIG_KEYS`，把原先散落在调用处的 9 处上游配置键（`search.mode`、`search.expansion`、`search.reranker.model`、`search.reranker.enabled`、`chat_model`、`expansion_model`、以及按 recipe 生成的 `provider_base_urls.<recipe>`）集中到一处，并注明"这些标识符属于上游、升级时需在此核对"。

今后上游若改名或改层级，只需核对这一张表，而不再需要通读适配器。

### 7.3 验证

| 检查 | 结果 |
|---|---|
| GBrain adapter 构建 | 通过 |
| adapter 契约测试 | **17 / 17** |
| API 单元测试 | **1291 passed / 0 failed** |
| 版本比较四种情形实测 | 全部符合预期 |

### 7.4 未做（§5 的第 3、4 条）

- 把 gbrain 升级步骤（含 v35 事件触发器的超级用户预建）写入部署文档 —— 未做。
- CI 记录当前上游版本 —— 未做。

两条都属于文档与流水线调整，不影响运行中的系统。
