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

const MAX_DOCUMENT_LENGTH = 60000;
const MIN_CHUNK_TOKENS = 50;
const MIN_DOC_LENGTH = 500;
// Cost guard: per-chunk LLM enrichment is O(chunks). Beyond this many chunks
// the marginal retrieval value drops while cost/latency explode (a 2600-chunk
// bulk document previously stalled the queue for 30+ minutes).
const MAX_ENRICH_CHUNKS = Number(process.env.CONTEXTUAL_RETRIEVAL_MAX_CHUNKS || 300);

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
  if (chunks.length > MAX_ENRICH_CHUNKS) {
    console.log(`[ContextualRetrieval] Skipping enrichment for ${chunks.length} chunks (> limit ${MAX_ENRICH_CHUNKS}). Cost guard active.`);
    return chunks;
  }

  const concurrency = options?.concurrency ?? 4;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const maxAttempts = 1 + Math.max(0, options?.retries ?? 1);
  const safeMarkdown = fullMarkdown.substring(0, MAX_DOCUMENT_LENGTH);
  
  const systemPrompt = `你是一个专业的文档分析助手。你的任务是为一个长文档中的指定文本块提供上下文描述。请为用户提供的文本块生成一段简短的上下文描述（50-100字），说明该文本块在原文档中的位置、涵盖的核心实体（组织、人名、法规）、时间范围以及与上下文的关系。${options?.documentTitle ? `文档标题是：${options.documentTitle}。\n` : ''}只输出上下文描述，不要重复原文本，信息必须来自文档本身。

整个文档的内容如下：
<document>
${safeMarkdown}
</document>`;

  console.log(`[ContextualRetrieval] Starting enrichment for ${chunks.length} chunks. Concurrency: ${concurrency}`);

  const enrichedChunks: IndexedMarkdownChunk[] = [...chunks];
  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;
  let totalCacheHitTokens = 0;

  for (let i = 0; i < enrichedChunks.length; i += concurrency) {
    const batch = enrichedChunks.slice(i, i + concurrency);
    
    const promises = batch.map(async (chunk, batchIndex) => {
      const originalIndex = i + batchIndex;
      
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
              { role: 'user', content: `请为以下文本块生成上下文描述：\n<chunk>\n${chunk.content}\n</chunk>` }
            ],
            temperature: 0,
            max_tokens: 200,
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
        return data.choices?.[0]?.message?.content?.trim() || null;
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
