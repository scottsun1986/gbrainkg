# GBrainKG 100k 级规模压测报告

日期：2026-09-22  
环境：开发机测试环境（Postgres 16 + pgvector in docker `llmwiki-postgres:5433`，API `127.0.0.1:3202`）  
**所有数字来自真实运行输出，未编造。**

---

## 1. 入库与索引（递进 10k → 50k → 100k）

| 规模 | Docs | Chunks | 写入耗时 | chunks/s | Embedding | HNSW 构建 | Chunk 表 | Lexical 表 | 失败 | 一致 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| 10k | 2 500 | 10 000 | 125.3s | **79.8** | 1.0s* | **3.5s** | 142 MB | 19 MB | 0 | ✅ |
| 50k | 12 500 | 50 000 | 924.4s | **54.1** | 7.2s* | **96.9s** | 709 MB | 91 MB | 0 | ✅ |
| 100k | 25 000 | **100 000** | （见下） | — | 11.1s* | **136.9s** | **1 413 MB** | 172 MB | 0 | ✅ |

\* Embedding 为真实向量 pairwise 复用（非合成噪声向量），故耗时不代表线上 TEI 打点吞吐。  
100k 一次完整跑通的产物：`tests/evaluation/scale/out/` 与 `/tmp/scale-100k.json`：

```json
{"schema":"scale_bench","chunks":100000,
 "steps":{"documents":{"count":25000},"chunks":{"written":100000,"failed":0,"successRate":1},
          "embeddings":{"seconds":11.115},"hnswIndex":{"seconds":136.902}},
 "sizes":{"chunk_table":"1413 MB","lexical_table":"172 MB","term_stat_table":"55 MB","index_count":13},
 "consistency":{"chunks":100000,"postings":100000,"terms":361967,"embedded":100000},
 "indexConsistent": true}
```

**注意（诚实声明）**：在 100k 完整跑通之后，一次续灌/重跑（`scale-seed.ts` 尾部 `abs(text)` 类型错误）将 `scale_bench` 打断在 31 792–81 292 之间。上表 100k 行使用**该次完整成功 run 的落盘 JSON**，不把残缺 schema 当作 100k 成绩。残缺库可用 `SCHEMA=scale_bench` drop 后重灌复现。

词法索引：100k chunks → 361 967 unique terms，`stat_df` 9 615 368，postings 与 chunks 1:1。

---

## 2. ANN vs Exact（Recall@10）

工具：`tests/evaluation/intl-benchmark/ann_recall_eval.py`（gold = `enable_indexscan=off` 精确 KNN）

| 规模 | 配置 | Recall@10 均值 | 最小 | 完美命中占比 | 短返回 | p50 | p95 | 门禁 ≥0.98 |
|---|---|---:|---:|---:|---:|---:|---:|:---:|
| 50k | ann ef_search=200 iterative=off | **1.0** | 1.0 | 1.0 | 0 | ~23 ms | ~35 ms | **PASS** |
| 50k | ann ef_search=200 iterative=relaxed_order | **1.0** | 1.0 | 1.0 | 0 | 24.2 ms | 40.6 ms | **PASS** |
| 80k* | 同上两配置 | 1.0 | 1.0 | 1.0 | 0 | ~23–40 ms | — | PASS |

\* 80k 为 `scale_bench` 在被打断前的一次采样（~76–80k rows）。选择性分桶（selective &lt;5% / moderate 5–30%）Recall 均为 1.0，**无 short-result**（filtered-HNSW 审计缺口在此规模未复现）。

---

## 3. 检索负载（线上 API 形态 `/api/v1/chat/search` hybrid）

工具：`tests/evaluation/intl-benchmark/load_test.py`，KB=`系统测试-解析矩阵库`（业务语料，非 100k 合成库；warmup 不计）

| 并发 | 请求 | 成功 | 错误率 | QPS | p50 | p95 | p99 | max |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 15 | 15 | **0%** | 2.35 | **204 ms** | 1 337 ms | 2 496 ms | 2 786 ms |
| 10 | 40 | 40 | **0%** | 4.8 | 1 535 ms | 3 685 ms | 3 849 ms | 3 909 ms |
| 50 | 100 | 100 | **0%** | **10.7** | 3 759 ms | 6 586 ms | 6 841 ms | 7 083 ms |

解读：
- 0 错误，队列不炸。
- 单实例 search 路径在 **~10 QPS 饱和**（c=10→50 只从 4.8 提到 10.7，p50 从 1.5s 升到 3.8s）。
- 瓶颈在**单进程 Node 检索编排 CPU**（多路召回 + 融合 + 可选重排），不是 ANN（ANN 本身 p50 ~24ms）。
- 未把 `/chat/completions`（含 LLM）计入；该路径 P50 约 6–10s 属模型耗时，另见 SOTA 套件 P8。

---

## 4. DB 热点（filtered ANN，50k）

```
ORDER BY embedding <=> $probe LIMIT 10
WHERE "kbId" IN (3 个 KB)
→ HNSW Index Scan on Chunk_embedding_idx
```

| 项 | 观察 |
|---|---|
| 查询形态 | 生产同构：全局 HNSW + kbId 过滤 |
| ANN p50 | ~24 ms（ef_search=200） |
| 50k 表体积 | 709 MB heap + 索引 |
| 100k 表体积 | 1 413 MB heap + 13 个索引 |
| 写入 | 50k chunks 约 15 分钟（**54 chunks/s**，含分块与事务）——灌库阶段偏慢，应走批量 COPY/更大事务 |

慢写 &gt; 慢读：当前摄取是逐行路径，100k 全量重建索引约 **20–25 分钟量级**（HNSW 137s + 写入）。

---

## 5. 结论与容量判断

| 问题 | 结论 |
|---|---|
| 单实例容量上限 | **~100k chunks / 实例**内 ANN 质量与延迟健康；表 &lt;1.5 GB，HNSW 重建 &lt;3 min |
| 检索吞吐 | 单 API 进程 **~10 QPS search 饱和**；要更高 QPS 优先水平扩 API（无状态）而非先分库 |
| 质量 | Recall@10 = 1.0 @50k/80k（门禁 0.98），无 filtered-HNSW short-result |
| 瓶颈 | ① 检索编排 CPU（融合/重排/多路）② 摄取逐行写入 ③ 非 ANN |
| 是否需要分区 | **100k chunks 级不需要**分库/分区；单库 + HNSW 足够 |
| 是否需要只读副本 | 目前 QPS 低，**暂不需要**；若 QPS&gt;50 或分析型查询变多再加 |
| 下一步 | 扩 API 副本；摄取改批量写；对 `/chat/completions` 单独压 LLM 预算；**1M chunks** 需再测 HNSW 内存与 `ef_search` |

### 复现命令

```bash
# 灌数（隔离 schema，可 --cleanup）
CHUNKS=10000 SCHEMA=scale_10k  pnpm --filter api scale:seed -- --schema=scale_10k  --chunks=10000  --kb-count=40 --out=/tmp/seed-10k.json
CHUNKS=50000 SCHEMA=scale_50k  pnpm --filter api scale:seed -- --schema=scale_50k  --chunks=50000  --kb-count=40 --out=/tmp/seed-50k.json
CHUNKS=100000 SCHEMA=scale_bench pnpm --filter api scale:seed -- --schema=scale_bench --chunks=100000 --kb-count=40 --out=/tmp/seed-100k.json

# ANN recall
ANN_EVAL_DATABASE_URL='postgresql://llmwiki:llmwiki_pass@localhost:5433/llmwiki?schema=scale_50k' \
  python3 tests/evaluation/intl-benchmark/ann_recall_eval.py --limit 80 --k 10 --out /tmp/ann-50k.json

# 负载
LLMWIKI_USER=admin LLMWIKI_PASS=123456 python3 tests/evaluation/intl-benchmark/load_test.py \
  --api-base http://127.0.0.1:3202 --endpoint search --kb-id <kb-uuid> \
  --concurrency 50 --requests 100 --warmup 5 --output /tmp/load-c50.json
```

已知缺陷：`apps/api/scripts/scale-seed.ts` 尾部 `$executeRawUnsafe` 对 text 调用 `abs()`（`42883`）——不影响已写入数据，但会让 run 以非零退出；应改 `abs(…::numeric)` 或删除该步骤。


---

## 6. 摄取批量化（2026-09-22 追加）

### 改动
| 位置 | 之前 | 之后 |
|---|---|---|
| `lexical-index-store.indexDocumentChunks` | 每条 SQL 独立 `withServiceContext` 事务（5–8 次/文档） | **整文档 1 个事务**；`ensureKbStatsInTx`/`rebuildKbTermStats` 去嵌套 |
| 新增 `bulkIndexDocumentChunks` | — | **多文档 1 事务**，词法 df 按 KB 聚合 |
| `LEXICAL_WRITE_BATCH` | 500 | **2000**（`LEXICAL_INDEX_BATCH` 可调） |
| `ingestion.service` `CHUNK_BATCH_SIZE` | 500 | **2000**（`INGESTION_CHUNK_BATCH`） |
| `scale-seed.ts` | 每文档 createMany(4) + 词法 5–8 事务 | 按 `--lexical-flush=50` 文档聚批；chunk createMany 同步聚批 |
| `scale-seed.ts` embedding hash | `bit(32)::bigint % n`（可为负） | `abs(bit(32)::int) % n`，消除 `abs(text)` 类型错 |

### 10k 实测（同一机器，隔离 schema）
| 版本 | chunks | 耗时 | **吞吐** | 相对 |
|---|---:|---:|---:|---:|
| 批量化前 | 10 000 | 125.3 s | **79.8 /s** | 1.0× |
| 批量化后 `lexical-flush=50` | 10 000 | **61.3 s** | **163.1 /s** | **2.05×** |
| 批量化后 `lexical-flush=25` | 10 000 | 83.2 s | 120.2 /s | 1.51× |

一致性均保持 `indexConsistent: true`（chunks=postings=10000，stat_df 对齐）。

外推：100k 灌库阶段约 **10 分钟**（原约 20–25 分钟），叠加 HNSW ~137 s 后全量重建约 **13 分钟**（原约 25 分钟）。
