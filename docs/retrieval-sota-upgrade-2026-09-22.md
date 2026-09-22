# 检索与证据链升级（2026-09-22）

本次升级实现五项能力，保持所有事实最终回到授权范围内的已发布原文分块。

## 1. GraphRAG provenance citation

- 图谱关系返回完整 `documentId/chunkId/snippet/documentVersion` provenance。
- 图谱命中先按当前 KB ACL、文档 `published` 状态回查 `Chunk`，再作为 citation 进入重排与 grounding。
- `formattedContext` 不再直接进入回答提示词；无原文 provenance 的关系只能参与导航。

## 2. 多跳证据端到端预算

- 多跳和比较问题按直接证据、子问题、桥接证据分组。
- 硬上限的 80% 在各组代表证据间公平分配，其余候选使用剩余预算。
- grounding 使用与模型提示词完全相同的截断文本。
- 四跳紧预算、引用映射、相邻块多来源合并和图谱原文回查均有回归测试。

## 3. Budgeted DRIFT

- 社区向量/关键词检索选择最多两个社区。
- 社区内规范实体名称生成最多两个导航探针。
- 探针进入普通 dense、BM25、图谱和 reranker 链路；社区摘要本身不作为事实。
- `GRAPHRAG_DRIFT_MAX_COMMUNITIES`、`GRAPHRAG_DRIFT_MAX_PROBES` 和证据阈值约束额外开销。

## 4. CanonicalBlock v1

每个新分块在 `Chunk.metadata.canonical_block` 中保存稳定契约：

- 文档 ID、KB、标题、版本和来源类型；
- ord、字符范围、页码、章节、breadcrumb 和条款；
- 文本/表格类型、表头、行数、bbox、前后邻居；
- 原文及可索引文本哈希；
- dense、sparse、multi-vector、contextualized 状态。

迁移会为历史分块回填兼容记录，新入库分块使用 SHA-256 完整记录。

## 5. BGE-M3 hybrid retrieval

`BGE_M3_HYBRID_ENABLED=true` 时，兼容网关须返回：

```json
{
  "data": [{
    "embedding": [0.1],
    "sparse_embedding": { "indices": [1], "values": [0.8] },
    "colbert_vecs": [[0.1]]
  }]
}
```

- dense 写入现有 `Chunk.embedding`；
- learned sparse 写入倒排表 `ChunkSparseEmbedding`；
- token multi-vector 写入 `Chunk.multi_vector`，只对有界候选集执行 ColBERT MaxSim；
- 文档批量编码发送 `late_chunking=true`，由兼容网关执行 provider-native late chunking；
- sparse 和 late-interaction 分别作为独立 RRF 通道。

现有 OpenAI-compatible 网关若只返回 dense，应保持 `BGE_M3_HYBRID_ENABLED=false`。启用前在测试环境执行数据库迁移，再通过全系统重处理或 `ChunkEmbeddingService.embedDocumentChunks` 回填历史数据。
