# MinIO 对象存储 & BGE-M3 Hybrid 启用 Runbook

适用范围：`llmwiki_inst1` / `meetings2` 生产栈。**本 runbook 只描述最小启用步骤，
不在本工作区内执行生产变更**（需用户明确书面指令后走 `scripts/deploy-prod.sh`）。

---

## 1. MinIO 启用（storageProvider=minio）

### 1.1 前置检查

| 项 | 期望值 | 检查 |
|---|---|---|
| MinIO 服务 | `docker compose` 服务 `minio` 健康 | `docker ps --filter name=minio` |
| API 环境变量 | `MINIO_ENDPOINT` + `MINIO_ACCESS_KEY` + `MINIO_SECRET_KEY` 三者齐全 | 见下 |
| Bucket | `MINIO_BUCKET`（默认 `llmwiki-raw`） | 首次 PUT 会自动创建（幂等） |

> **缺任一必填变量时**，`ObjectStorageService` 明确 fallback 到本地盘
> （`UPLOAD_ROOT`）并 **warn 一次**（`missing MINIO_...`），`Document.storageProvider`
> 落库为 `local`。不会静默写错地方。

### 1.2 docker-compose 最小步骤

`deploy/docker-compose.prod.yml` 已内置 MinIO 服务与 API 注入（无需改 compose）：

```yaml
# minio 服务（已在文件中）
minio:
  image: minio/minio:RELEASE.2024-11-07T00-52-20Z
  command: server /data --console-address ":9001"
  environment:
    MINIO_ROOT_USER: ${MINIO_USER}
    MINIO_ROOT_PASSWORD: ${MINIO_PASS}

# api 服务已注入：
#   MINIO_ENDPOINT=${MINIO_API_ENDPOINT:-http://minio:9000}
#   MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_BUCKET / MINIO_REGION
```

生产 `.env`（从 `deploy/production.env.example` 复制）最小集：

```bash
# MinIO 控制台 root（只给 minio 容器用，不是 S3 凭证）
MINIO_USER=llmwiki-minio
MINIO_PASS=<long-random>

# S3 API 凭证（API 容器走这套；与 root 口令不同，便于轮换）
MINIO_ACCESS_KEY=<long-random-access-key>
MINIO_SECRET_KEY=<long-random-secret-key>
MINIO_BUCKET=llmwiki-raw
MINIO_REGION=us-east-1

# API 进程视角的 S3 endpoint。
# compose 内网用 http://minio:9000（已作为 MINIO_API_ENDPOINT 默认值）。
# 本机直跑 API 时用 http://127.0.0.1:9000。
MINIO_API_ENDPOINT=http://minio:9000
```

**不要**把 `MINIO_ENDPOINT=http://127.0.0.1:9000` 注入到 api 容器内——容器内
`127.0.0.1` 是 API 自己；host 视角的 endpoint 只用于宿主机侧工具（`mc` 等）。
生产 env 示例里的 `MINIO_ENDPOINT` 是宿主机/运维视角，compose 通过
`MINIO_API_ENDPOINT` 覆盖给 api 容器。

### 1.3 验证

1. 起容器后看 api 日志：**不应**再出现
   `Object storage is falling back to local disk`。
2. 上传一个文档，查库：
   ```sql
   SELECT "storageProvider", "objectKey" FROM "Document" ORDER BY "createdAt" DESC LIMIT 1;
   -- 期望 storageProvider='minio', objectKey='raw/<docId>/<uuid>'
   ```
3. 对象存在性（在 minio 容器或宿主机用 `mc`）：
   ```bash
   mc alias set local http://127.0.0.1:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"
   mc ls local/llmwiki-raw/raw/
   ```
4. 删除文档后对象应同步消失（`DELETE` 走 `objectKey`）。

### 1.4 行为契约（代码位置：`apps/api/src/storage/object-storage.service.ts`）

- **put**：`keyPrefix/<uuid>` → MinIO PUT（S3 v4 自签，path-style，无 SDK）；同时
  本地 `UPLOAD_ROOT` 仍写一份给 parser（`rawFileOid`）。
- **get**：`getStream/getBuffer(objectKey, provider)`；minio 走 S3 GET。
- **delete**：`ingestion.controller.deleteDocument` 先按 `objectKey + storageProvider`
  删对象，再删本地 `rawFileOid` 与目录。
- **fallback**：缺 env → `provider='local'` + warn 一次；单次 put/delete 失败
  fail-open（保留本地副本）。

---

## 2. BGE-M3 sparse / late-interaction 启用

### 2.1 开关语义（ROI-2 变更）

| 变量 | 默认 | 说明 |
|---|---|---|
| `BGE_M3_HYBRID_ENABLED` | **`true`**（代码 `!== 'false'`） | sparse + ColBERT 总开关。显式 `false` 才关。 |
| `BGE_M3_HYBRID_ENDPOINT` | 空 → 回落 `<embedding baseUrl>/embeddings` | 须实现 BGE-M3 hybrid 响应契约 |
| `BGE_M3_LATE_CHUNKING` | `true` | 文档批量编码带 `late_chunking=true` |
| `BGE_M3_MULTI_VECTOR_MAX_TOKENS` | `128` | ColBERT token 上限 |

### 2.2 需要的 endpoint

`BGE_M3_HYBRID_ENDPOINT` 指向的网关 **必须** 在同一响应里返回三种向量：

```json
{
  "data": [{
    "embedding": [0.1],
    "sparse_embedding": { "indices": [1], "values": [0.8] },
    "colbert_vecs": [[0.1]]
  }]
}
```

兼容变体：`sparse_embedding` 也接受 `{tokenId: weight}` 对象；`colbert_vecs` /
`multi_vector` / `token_embeddings` 同义。只返回 dense 的 OpenAI 兼容网关
**不需要**关开关——sparse/late 路径会 fail-open：

- `HybridRetrievalService.searchSparse`：查询无 sparse 臂 → `recordFailopen("sparse")` + 返回 `[]`
- `HybridRetrievalService.rerankLateInteraction`：查询无 multiVector → `recordFailopen("late_interaction")` + 空 Map
- SQL 异常同样打点，dense+BM25 始终在线

观测指标：`retrieval_failopen_total{channel="sparse"|"late_interaction"}`。

### 2.3 启用 / 回填步骤

1. 确认迁移已应用：`packages/database/prisma/migrations/20260922100000_canonical_blocks_bge_m3_hybrid`
   （`ChunkSparseEmbedding` 表 + `Chunk.multi_vector/late_context/hybrid_indexed`）。
2. 配置 `BGE_M3_HYBRID_ENDPOINT`（或确认 embedding baseUrl 网关已支持 hybrid）。
3. 新文档自动走 `ChunkEmbeddingService.indexHybridDocument`（随
   `embedDocumentChunks` 触发）。
4. 历史数据回填：对每个文档调用
   `ChunkEmbeddingService.embedDocumentChunks(documentId)`，或全系统重处理。
5. 验证：新 chunk 的 `hybrid_indexed=true`，`ChunkSparseEmbedding` 有行，
   `multi_vector` 非空；检索命中走 sparse/late RRF 通道。

### 2.4 回退

```bash
BGE_M3_HYBRID_ENABLED=false
```

已有 `ChunkSparseEmbedding` / `multi_vector` 数据会自动被忽略（开关短路），
无需回滚迁移。

---

## 3. 相关文件

| 文件 | 作用 |
|---|---|
| `apps/api/src/storage/object-storage.service.ts` | MinIO/local 对象存储 + S3 v4 签名 |
| `apps/api/src/embedding/embedding.service.ts` | dense + hybrid 编码客户端 |
| `apps/api/src/embedding/chunk-embedding.service.ts` | 分块写入（批量 `$executeRaw` + `formatVectorValues`） |
| `apps/api/src/retrieval/hybrid-retrieval.service.ts` | sparse / late-interaction 检索臂 |
| `deploy/docker-compose.prod.yml` | minio 服务 + api env 注入 |
| `deploy/production.env.example` | 生产 env 模板 |
| `docs/retrieval-sota-upgrade-2026-09-22.md` | BGE-M3 响应契约背景 |
