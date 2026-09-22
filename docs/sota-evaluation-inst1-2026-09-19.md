# inst1（生产）SOTA 全面测评报告

日期：2026-09-19
目标实例：**inst1 @ meetings2（119.45.22.137）**，API 3000 / Web 3200 / 公网 20080，DB `llmwiki`，Redis DB 0
硬件：**2 vCPU / 3 GB RAM**，/data 98G（已用 7G）
发布版本：本次审计整改 + 引用重绑定修复（见 [审计整改报告](audit-remediation-and-sota-evaluation-2026-09-19.md)）

测试口径：除标注外全部为**只读**操作；未向 inst1 导入任何公开数据集（避免污染客户知识库），也未在生产跑 exact-KNN 金标准（2C3G 会打满页缓存影响线上）。

---

## 1. 语料与索引规模（只读实测）

| 指标 | 数值 |
| --- | --- |
| 文档总数 | 110,363（published 13,601） |
| 知识库 / 用户 | 23 KB / 10 用户 |
| chunk 总数 | 91,732 |
| **发布内容向量覆盖率** | **16,786 / 16,786 = 100%** |
| 历史积压 | `indexing` 38,302 篇、`parsing` 33,118 篇（**本次发布前既存**，队列为空，即不会自动推进） |
| 词法索引 | 91,732 / 91,732 chunk 已索引，postings = Σdf = **9,711,926**，词表 232,251 |
| 索引体积 | `ChunkLexicalDoc`（含 GIN 47MB）229 MB |

## 2. 正确性门禁

| 门禁 | 结果 |
| --- | --- |
| 词法索引全量一致性（tokenizer ↔ postings ↔ 统计） | **91,732/91,732 chunk 零偏差**，`consistent = true` |
| 过滤 HNSW 短结果（审计指出的故障模式） | 新配置（ef_search=200 + iterative_scan，库级参数）**0/20 查询返回不足 10 行**；旧配置（ef=40 无迭代）**2/20** |
| 迁移 | 3 个迁移已应用（graph 索引 / semantic cache 原子 upsert / 词法 BM25） |
| 服务健康 | api · web · parser 全 active；API 3000、Web 3200、公网网关 200、GBrain OK |

## 3. 端到端质量（10 条真实用户问题在线复放）

题目来源：inst1 近 21 天真实用户提问（只读抽样），逐条串行复放（不并发，避免影响线上）。

| 指标 | 结果 |
| --- | --- |
| 完成 / 拒答 / 错误 | 7 回答 · 3 拒答 · **0 错误** |
| 首 token 延迟 | p50 **952 ms** · p95 33.8 s |
| 总耗时 | p50 **957 ms** · p95 46.9 s |
| 平均引用数 | 1.86 条/答 |
| 拒答构成 | 2 条隐私类问题（孙智强身份证号 / 儿子姓名，**应当拒答**）+ 1 条表格统计（息攘杯 85 分以上团队数，能力缺口） |

典型正例（多版本对比，1.0 s 完成）：问「员工绩效的构成是什么」→ 正确区分《绩效管理办法》v1 与 V2 的权重区间并分别引用 [1][2]。

## 4. 引用支持审计（确定性判据，与流水线同一套校验）

对落库回答逐句校验：带角标的句子是否真的被其引用证据支持。

| 窗口 | 标记句 | 支持率 | 错配率 | 超范围角标 | 错配中"同答案其它引用可支持" |
| --- | --- | --- | --- | --- | --- |
| 修复前（近 120 条回答，803 句） | 803 | **55.5%** | 16.9% | 271 | **66.9%** |
| 修复后（新产生回答，21 句） | 21 | **81.0%** | 19.1% | 0 | 0 |

结论与限制：

- 生产历史回答的引用支持率**只有 55.5%**，错配率 16.9%，其中 **2/3 的错配在同答案其它引用里能找到真正支撑**——这正是本次"角标重绑定"要覆盖的区间。
- 修复后样本仅 21 句，**不足以做统计显著的 before/after 声明**；修复效果以定向复现为准（用户上报的「王群丽」案例中 5 句有 2 句被判定错标并重绑定到正确文档）。
- 落库引用数组是压缩过的（只留被引用条目），因此历史数据无法离线复放重绑定——这也解释了为什么"超范围角标"高达 271。

## 5. 并发与延迟（生产实测）

`load_test.py --endpoint search --concurrency 2 --requests 20`（含 3 次预热，不计入统计）：

| 指标 | 结果 |
| --- | --- |
| 成功 / 错误 | 20 / 0，**error_rate = 0** |
| 吞吐 | **0.96 QPS**（并发 2） |
| 延迟 | p50 **1,104 ms** · p95 **11.6 s** · p99 12.2 s · max 12.3 s |

## 6. 本次在生产暴露并已修复的问题

1. **交互式事务打满连接池**：我为 SET LOCAL 而引入的每请求 `$transaction` 在 2C3G + 后台作业并存时触发 `Unable to start a transaction in the given time`。已改为**数据库级 HNSW 参数**（`ALTER DATABASE llmwiki SET hnsw.ef_search=200 / hnsw.iterative_scan='relaxed_order'`）+ 无事务查询，并重新发布验证。
2. **GIN 索引后灌数据**：迁移先建索引、回填后灌数据会留下 pending list；已 `VACUUM (ANALYZE)` 收尾。
3. **客户端断开后服务端继续跑**：评测客户端 180s 主动 abort 后，服务端流水线仍在消耗连接与 LLM 配额，多个残留请求叠加放大了连接池压力。建议后续把请求级 AbortController 贯通到检索各臂（本次先记录，未改动）。

## 7. SOTA 门禁判定（对照审计 §5）

| 门禁 | 判定 | 依据 / 缺口 |
| --- | --- | --- |
| 1. 真实 10 万文档导入成功率 ≥ 99.9%、可重试、无跨版本污染 | ⚠️ 未达成 | inst1 确有 11 万文档，但历史成功率不可回溯；且 38,302 篇停在 `indexing`、33,118 篇停在 `parsing`，需要专项清理作业 |
| 2. 过滤 ANN Recall@10 ≥ 0.98（exact KNN 为 gold） | ⚠️ 生产未跑金标准 | 隔离环境 12.6k 与 100k chunk 已达 0.998–1.000；生产只做了短结果抽检（0/20）。2C3G 不适合跑 exact gold |
| 3. BEIR / MIRACL / 私有 hard-negative 公开基准 | ❌ 未做 | 需要向实例灌入公开语料；为避免污染客户库，未在 inst1 执行 |
| 4. claim-level 端到端 + 人工双盲 | ⚠️ 部分 | 用确定性引用支持审计替代（55.5% → 81.0%），**无人工双盲抽检** |
| 5. 固定硬件 p50/p95/p99 / QPS / 首 token / 错误率 | ✅ 已产出 | §3、§5：并发 2 下 0.96 QPS、0 错误、p50 1.1s、p95 11.6s、首 token p50 952ms |
| 6. live gate fail-closed + 可复现配置 | ✅ 已完成 | `ci-gate.sh GATE_STRICT=1` + 词法/引用/召回报告落盘 |

**总体结论：inst1 仍不能宣称"已验证 SOTA"。** 当前真实瓶颈按优先级是：

1. **质量侧：引用支持率**（历史 55.5%）——重绑定已上线，需持续观测新回答并把"未支持句"纳入拦截；
2. **延迟侧：长尾**（p95 11–47 s，来自多跳/子查询/多轮 LLM）——需要针对 2C3G 的预算与并发调度优化；
3. **数据侧：7.1 万篇积压文档**（indexing/parsing）——它们不在检索范围内，属于可用性缺口；
4. **基准侧：公开基准缺位**——需在**独立实例或测试机**灌入 BEIR/MIRACL 才能补齐门禁 3。

## 8. 复现命令（在 inst1 上）

```bash
# 词法索引全量校验（只读）
cd /home/ubuntu/gbrainkg/apps/api
set -a; . /home/ubuntu/.config/llmwiki/production.env; set +a
node dist/bootstrap/lexical-index-cli.js --verify

# 引用支持审计（只读）
npx --yes tsx@4.23.13 scripts/citation-support-audit.ts --limit=120
npx --yes tsx@4.23.13 scripts/citation-support-audit.ts --since=2026-09-19T14:43:00Z --limit=40

# 端到端在线复放（串行，真实用户问题）
SOTA_API_BASE=http://127.0.0.1:3000 SOTA_PASSWORD=... \
  npx --yes tsx@4.23.13 scripts/sota-live-eval.ts --questions=10 --out=/tmp/sota-live-inst1.json

# 并发压测（轻量）
python3 tests/evaluation/intl-benchmark/load_test.py --api-base http://127.0.0.1:3000 \
  --user admin --password ... --kb-id <uuid> --endpoint search --concurrency 2 --requests 20
```
