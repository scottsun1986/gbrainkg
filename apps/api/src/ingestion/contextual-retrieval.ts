import { IndexedMarkdownChunk } from './markdown-chunker';
import { estimateTokens } from '../chat/context-budget';

export interface ContextualRetrievalConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

export interface ContextualRetrievalOptions {
  concurrency?: number;      // default 4
  documentTitle?: string;    // used in prompt for better context
  enabled?: boolean;         // default true, can be disabled
  timeoutMs?: number;        // default 30000
  retries?: number;          // default 1 (one retry after a failed attempt)
}

const MIN_CHUNK_TOKENS = 50;
const MIN_DOC_LENGTH = 500;
// Cost guard budget: per-chunk LLM enrichment is O(chunks). Instead of a hard
// cliff that skipped whole documents above the limit (a 300/301 behaviour
// flip), over-budget documents are section-stratified sampled down to this
// budget and the remaining chunks are marked contextual_skipped.
const MAX_ENRICH_CHUNKS = Number(process.env.CONTEXTUAL_RETRIEVAL_MAX_CHUNKS || 300);
// Sliding-window context: each request carries only the neighbouring text
// around the chunk (plus title and section path), not the whole document.
const NEIGHBOR_CONTEXT_CHARS = Number(process.env.CONTEXTUAL_RETRIEVAL_NEIGHBOR_CHARS || 1500);

/**
 * Pick the indices to enrich when the document is over budget. The first
 * chunk of every distinct section is mandatory (keeps chapter openings
 * described); the rest of the budget is filled with evenly spaced chunks.
 * Returns null when every chunk fits the budget.
 */
function selectIndicesForBudget(
  chunks: IndexedMarkdownChunk[],
  budget: number,
): Set<number> | null {
  if (chunks.length <= budget) return null;
  const selected = new Set<number>();
  const seenSections = new Set<string>();
  for (let i = 0; i < chunks.length && selected.size < budget; i++) {
    const section = chunks[i].metadata?.section;
    const key = typeof section === 'string' && section ? section : `#${i}`;
    if (!seenSections.has(key)) {
      seenSections.add(key);
      selected.add(i);
    }
  }
  if (selected.size < budget) {
    const rest: number[] = [];
    for (let i = 0; i < chunks.length; i++) if (!selected.has(i)) rest.push(i);
    const need = Math.min(budget - selected.size, rest.length);
    const step = rest.length / need;
    for (let k = 0; k < need; k++) selected.add(rest[Math.floor(k * step)]);
  }
  return selected;
}

/**
 * Sliding window around a chunk: ~NEIGHBOR_CONTEXT_CHARS of the document on
 * each side of the chunk's [charStart, charEnd) range. Falls back to the
 * document head when offsets are missing or out of bounds.
 */
function neighborWindow(
  fullMarkdown: string,
  chunk: IndexedMarkdownChunk,
): { before: string; after: string } {
  const docLength = fullMarkdown.length;
  let start = Number.isInteger(chunk.charStart) ? (chunk.charStart as number) : 0;
  let end = Number.isInteger(chunk.charEnd) ? (chunk.charEnd as number) : docLength;
  if (start < 0 || end <= start || end > docLength) {
    start = 0;
    end = Math.min(docLength, 2 * NEIGHBOR_CONTEXT_CHARS);
  }
  return {
    before: fullMarkdown.slice(Math.max(0, start - NEIGHBOR_CONTEXT_CHARS), start),
    after: fullMarkdown.slice(end, Math.min(docLength, end + NEIGHBOR_CONTEXT_CHARS)),
  };
}

export async function enrichChunksWithContext(
  fullMarkdown: string,
  chunks: IndexedMarkdownChunk[],
  config: ContextualRetrievalConfig | null | undefined,
  options?: ContextualRetrievalOptions,
): Promise<IndexedMarkdownChunk[]> {
  const isEnabled = options?.enabled !== false; // Default true
  const documentLength = fullMarkdown.length;

  if (!isEnabled || !config || documentLength < MIN_DOC_LENGTH || chunks.length === 0) {
    console.log(`[ContextualRetrieval] Skipping enrichment. enabled: ${isEnabled}, config: ${!!config}, docLength: ${documentLength}, chunks: ${chunks.length}`);
    return chunks;
  }

  const concurrency = options?.concurrency ?? 4;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const maxAttempts = 1 + Math.max(0, options?.retries ?? 1);

  const enrichedChunks: IndexedMarkdownChunk[] = [...chunks];
  const budgetIndices = selectIndicesForBudget(chunks, MAX_ENRICH_CHUNKS);
  if (budgetIndices) {
    console.log(`[ContextualRetrieval] ${chunks.length} chunks exceed budget ${MAX_ENRICH_CHUNKS}; enriching a section-stratified sample of ${budgetIndices.size}.`);
    for (let i = 0; i < chunks.length; i++) {
      if (budgetIndices.has(i)) continue;
      enrichedChunks[i] = {
        ...chunks[i],
        metadata: {
          ...chunks[i].metadata,
          contextual_skipped: true,
        } as IndexedMarkdownChunk['metadata'],
      };
    }
  }
  const candidateIndices: number[] = [];
  for (let i = 0; i < enrichedChunks.length; i++) {
    if (!budgetIndices || budgetIndices.has(i)) candidateIndices.push(i);
  }

  // The prompt no longer embeds the whole document; per-chunk sliding-window
  // context plus title and section path keep each request small.
  const systemPrompt = `你是一个专业的文档分析助手。你的任务是为一个长文档中的指定文本块提供上下文描述。请根据文档标题、章节路径与邻近上下文，为用户提供的文本块生成一段简短的上下文描述（50-100字），说明该文本块在原文档中的位置、涵盖的核心实体（组织、人名、法规）、时间范围以及与上下文的关系。只输出上下文描述，不要重复原文本，信息必须来自文档本身。`;

  console.log(`[ContextualRetrieval] Starting enrichment for ${candidateIndices.length}/${chunks.length} chunks. Concurrency: ${concurrency}`);

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;
  let totalCacheHitTokens = 0;

  for (let offset = 0; offset < candidateIndices.length; offset += concurrency) {
    const batch = candidateIndices.slice(offset, offset + concurrency);

    const promises = batch.map(async (originalIndex) => {
      const chunk = enrichedChunks[originalIndex];

      // Skip short chunks
      if ((chunk.tokenCount ?? 0) < MIN_CHUNK_TOKENS) {
        skipCount++;
        return; // Skip
      }

      // Skip chunks that already possess rich structural heading context (e.g. multi-level section breadcrumbs)
      const skipStructured = process.env.CONTEXTUAL_RETRIEVAL_SKIP_STRUCTURED !== 'false';
      if (skipStructured) {
        const hasRichSection = typeof chunk.metadata?.section === 'string' &&
          chunk.metadata.section.includes('>') &&
          chunk.metadata.section !== 'Default';
        const hasChapterArticle = typeof chunk.metadata?.chapter_no === 'number' &&
          typeof chunk.metadata?.article_no === 'number';
        if (hasRichSection || hasChapterArticle) {
          skipCount++;
          return;
        }
      }

      const sectionPath = typeof chunk.metadata?.section === 'string' ? chunk.metadata.section : '';
      const { before, after } = neighborWindow(fullMarkdown, chunk);
      const userContent = [
        options?.documentTitle ? `文档标题：${options.documentTitle}` : null,
        sectionPath ? `章节路径：${sectionPath}` : null,
        before || after
          ? `邻近上下文：\n<surrounding>\n${before ? `…${before}\n` : ''}${after ? `\n${after}…` : ''}\n</surrounding>`
          : null,
        `请为以下文本块生成上下文描述：\n<chunk>\n${chunk.content}\n</chunk>`,
      ]
        .filter(Boolean)
        .join('\n\n');

      const enrichOnce = async (): Promise<string | null> => {
        const response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.modelName,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent }
            ],
            temperature: 0,
            // Reasoning-first models spend the budget on reasoning_content
            // before any visible content; 200 tokens came back empty every
            // time. Leave room for both phases.
            max_tokens: 1200,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (typeof data?.usage?.prompt_cache_hit_tokens === 'number' && data.usage.prompt_cache_hit_tokens > 0) {
          totalCacheHitTokens += data.usage.prompt_cache_hit_tokens;
        }
        const message = data.choices?.[0]?.message || {};
        if (message.content?.trim()) return message.content.trim();
        // Reasoning models emit their conclusion inside reasoning_content;
        // take its final section as the context description.
        const reasoning = String(message.reasoning_content || '').trim();
        if (reasoning) {
          const tail = reasoning.split(/\n+/).filter(Boolean).slice(-3).join(' ');
          return tail.length > 10 && tail.length < 400 ? tail : null;
        }
        return null;
      };

      let contextDescription: string | null = null;
      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            contextDescription = await enrichOnce();
            break;
          } catch (error) {
            if (attempt >= maxAttempts) throw error;
            await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
          }
        }
      } catch (error) {
        console.warn(`[ContextualRetrieval] Error enriching chunk ${originalIndex}:`, error);
        failCount++;
      }

      if (contextDescription) {
        const prefix = `[上下文: ${contextDescription}]\n\n`;
        enrichedChunks[originalIndex] = {
          ...chunk,
          content: prefix + chunk.content,
          metadata: {
            ...chunk.metadata,
            contextual_prefix: prefix,
            contextPrefix: prefix,
            contextual_retrieval: true,
          } as IndexedMarkdownChunk['metadata'],
        };

        enrichedChunks[originalIndex].tokenCount = estimateTokens(enrichedChunks[originalIndex].content);
        successCount++;
      } else {
        failCount++;
      }
    });

    await Promise.allSettled(promises);
  }

  console.log(`[ContextualRetrieval] Finished enrichment. Success: ${successCount}, Skipped: ${skipCount}, Failed: ${failCount}, Prompt Cache Hit Tokens: ${totalCacheHitTokens}`);

  return enrichedChunks;
}
