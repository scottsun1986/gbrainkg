/**
 * Text that actually represents the document, with the structural bookkeeping
 * the chunker injects into `Chunk.content` removed.
 *
 * The chunker writes two kinds of machine-generated markup into the stored
 * text:
 *
 *  - Navigation echo: `<!-- 大纲层级: 章 > 节 > 条 -->`, `<!-- bbox: ... -->`.
 *    These carry no document content (the same hierarchy is already available
 *    as `metadata.breadcrumb`), yet they were tokenized into every chunk, so the
 *    BM25 corpus grew a term that appears in almost every document (df ≈ N,
 *    useless idf) while inflating each document's length and therefore the
 *    average document length used for length normalisation.
 *  - Table bookkeeping: the human-readable table summary comment is boilerplate
 *    (the column names it lists are already present in the table header row),
 *    while the per-row semantics *are* content — they flatten a 2-D table into
 *    lines a lexical index can match — and must be kept.
 *
 * The `[上下文: ...]` Contextual Retrieval prefix is deliberately preserved:
 * the reference implementation prepends the context to the chunk for both the
 * embedding and the lexical index, which is exactly how the vocabulary gap
 * between colloquial questions and formal wording is closed.
 *
 * Only the indexing arms (embeddings and BM25) use this projection. The stored
 * `Chunk.content` is untouched, so previews, citations and answer context keep
 * their original structure.
 */
export function indexableChunkText(text: string): string {
  if (!text) return '';
  return text
    // Hierarchy echo — structure is preserved in metadata.breadcrumb instead.
    .replace(/<!--\s*大纲层级:[\s\S]*?-->/g, '')
    // Rendering bookkeeping that never appears in the source document.
    .replace(/<!--\s*bbox:[\s\S]*?-->/g, '')
    // Table shape summary is boilerplate; the header row itself is kept.
    .replace(/<!--\s*表格结构摘要:[\s\S]*?-->/g, '')
    // Keep the row semantics, drop only the wrapper comment markers.
    .replace(/<!--\s*表格结构化行语义:\s*([\s\S]*?)-->/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
