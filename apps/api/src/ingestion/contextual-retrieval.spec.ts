import { enrichChunksWithContext, ContextualRetrievalConfig } from './contextual-retrieval';
import { estimateTokens } from '../chat/context-budget';
import { IndexedMarkdownChunk } from './markdown-chunker';

jest.mock('../chat/context-budget', () => ({
  estimateTokens: jest.fn().mockReturnValue(100),
}));

describe('ContextualRetrieval', () => {
  const config: ContextualRetrievalConfig = {
    baseUrl: 'https://api.example.com',
    apiKey: 'test-key',
    modelName: 'test-model',
  };

  const createChunks = (count: number, content = 'Test content', tokens = 100): IndexedMarkdownChunk[] => {
    return Array.from({ length: count }, (_, i) => ({
      content: `${content} ${i}`,
      charStart: i * 10,
      charEnd: (i + 1) * 10,
      tokenCount: tokens,
      metadata: { section: 'test', chunkStrategy: 'test', overlapChars: 0 },
      ord: i,
    }));
  };

  const fullMarkdown = 'A'.repeat(1000); // >= MIN_DOC_LENGTH (500)

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a. Normal operation', () => {
    it('enriches chunks with context prefix when document is long enough', async () => {
      const chunks = createChunks(2);
      const mockResponse = { choices: [{ message: { content: 'Mocked context description.' } }] };
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await enrichChunksWithContext(fullMarkdown, chunks, config, { concurrency: 2 });

      expect(result).toHaveLength(2);
      expect(result[0].content).toContain('[上下文: Mocked context description.]\n\n');
      expect(result[0].metadata.contextual_retrieval).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('records the prefix in metadata.contextPrefix alongside content', async () => {
      const chunks = createChunks(1);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Mocked context description.' } }] }),
      });

      const result = await enrichChunksWithContext(fullMarkdown, chunks, config);

      const expectedPrefix = '[上下文: Mocked context description.]\n\n';
      expect(result[0].metadata.contextPrefix).toBe(expectedPrefix);
      expect(result[0].metadata.contextual_prefix).toBe(expectedPrefix);
      expect(result[0].content.startsWith(expectedPrefix)).toBe(true);
    });

    it('respects MIN_DOC_LENGTH threshold', async () => {
      const shortDoc = 'A'.repeat(499);
      const chunks = createChunks(1);

      const result = await enrichChunksWithContext(shortDoc, chunks, config);
      expect(result).toEqual(chunks);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('respects MIN_CHUNK_TOKENS threshold', async () => {
      const chunks = createChunks(1, 'short', 49);
      const result = await enrichChunksWithContext(fullMarkdown, chunks, config);

      expect(result).toEqual(chunks);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('correctly formats the context prefix', async () => {
      const chunks = createChunks(1);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Test ctx' } }] }),
      });

      const result = await enrichChunksWithContext(fullMarkdown, chunks, config);
      expect(result[0].content).toMatch(/^\[上下文: Test ctx\]\n\nTest content 0$/);
    });

    it('handles multiple chunks in batch', async () => {
      const chunks = createChunks(5);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Ctx' } }] }),
      });

      const result = await enrichChunksWithContext(fullMarkdown, chunks, config, { concurrency: 2 });
      expect(result).toHaveLength(5);
      expect(global.fetch).toHaveBeenCalledTimes(5);
    });
  });

  describe('b. Budget sampling (cost guard)', () => {
    it('samples down to the budget instead of skipping the whole document', async () => {
      const maxChunks = Number(process.env.CONTEXTUAL_RETRIEVAL_MAX_CHUNKS || 300);
      const spy = jest.spyOn(console, 'log').mockImplementation();
      const chunks = createChunks(maxChunks + 20);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Ctx' } }] }),
      });

      const result = await enrichChunksWithContext(fullMarkdown, chunks, config, { concurrency: 8 });

      expect(result).toHaveLength(maxChunks + 20);
      expect(global.fetch).toHaveBeenCalledTimes(maxChunks);
      expect(result.filter((c) => c.metadata.contextual_skipped === true)).toHaveLength(20);
      // The first chunk of the shared section is mandatory in the sample.
      expect(result[0].metadata.contextual_retrieval).toBe(true);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('exceed budget'));
      spy.mockRestore();
    });

    it('keeps the first chunk of each section in the sampled subset', async () => {
      const originalLimit = process.env.CONTEXTUAL_RETRIEVAL_MAX_CHUNKS;
      process.env.CONTEXTUAL_RETRIEVAL_MAX_CHUNKS = '6';
      let enrich: typeof enrichChunksWithContext;
      jest.isolateModules(() => {
        enrich = require('./contextual-retrieval').enrichChunksWithContext;
      });
      try {
        const sections = ['A', 'A', 'A', 'B', 'B', 'B', 'C', 'C', 'C', 'D', 'D', 'D'];
        const chunks: IndexedMarkdownChunk[] = sections.map((section, i) => ({
          content: `Test content ${i}`,
          charStart: i * 10,
          charEnd: (i + 1) * 10,
          tokenCount: 100,
          metadata: { section, chunkStrategy: 'test', overlapChars: 0 },
          ord: i,
        }));
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'Ctx' } }] }),
        });

        const result = await enrich(fullMarkdown, chunks, config, { concurrency: 4 });

        // Mandatory section openers: 0(A), 3(B), 6(C), 9(D) plus evenly
        // spaced fillers (1 and 7) make up the 6-chunk budget.
        for (const index of [0, 1, 3, 6, 7, 9]) {
          expect(result[index].metadata.contextual_retrieval).toBe(true);
        }
        expect(result[2].metadata.contextual_skipped).toBe(true);
        expect(global.fetch).toHaveBeenCalledTimes(6);
      } finally {
        if (originalLimit === undefined) delete process.env.CONTEXTUAL_RETRIEVAL_MAX_CHUNKS;
        else process.env.CONTEXTUAL_RETRIEVAL_MAX_CHUNKS = originalLimit;
      }
    });
  });

  describe('c. Sliding-window context', () => {
    const bodyText = 'X'.repeat(1000);
    const windowDoc = 'B'.repeat(2000) + bodyText + 'C'.repeat(2000);
    const windowChunk: IndexedMarkdownChunk = {
      content: bodyText,
      charStart: 2000,
      charEnd: 3000,
      tokenCount: 100,
      metadata: { section: '总则', chunkStrategy: 'test', overlapChars: 0 },
      ord: 0,
    };

    it('sends only the neighbouring text around the chunk, not the whole document', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Ctx' } }] }),
      });

      await enrichChunksWithContext(windowDoc, [windowChunk], config);

      const callArgs = (global.fetch as jest.Mock).mock.calls[0][1];
      const request = JSON.parse(callArgs.body);
      const systemPrompt = request.messages[0].content;
      const userContent = request.messages[1].content;

      // No full-document dump anywhere: the system prompt is prompt-only.
      expect(systemPrompt).not.toContain('B'.repeat(100));
      // The window carries ~1500 chars on each side of the chunk.
      expect(userContent).toContain('B'.repeat(100));
      expect(userContent).toContain('C'.repeat(100));
      expect(userContent).not.toContain('B'.repeat(1501));
      expect(userContent).not.toContain('C'.repeat(1501));
      expect(userContent).toContain(bodyText);
    });

    it('includes the document title and section path in the request', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Ctx' } }] }),
      });

      await enrichChunksWithContext(windowDoc, [windowChunk], config, { documentTitle: '测试文档' });

      const request = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      const userContent = request.messages[1].content;
      expect(userContent).toContain('文档标题：测试文档');
      expect(userContent).toContain('章节路径：总则');
    });

    it('omits the surrounding block when no neighbour text is available', async () => {
      const doc = 'D'.repeat(600);
      const chunk: IndexedMarkdownChunk = {
        content: 'X'.repeat(200),
        charStart: -5, // invalid offsets force the document-head fallback
        charEnd: 10_000,
        tokenCount: 100,
        metadata: { section: '总则', chunkStrategy: 'test', overlapChars: 0 },
        ord: 0,
      };
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Ctx' } }] }),
      });

      await enrichChunksWithContext(doc, [chunk], config);

      const request = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(request.messages[1].content).not.toContain('<surrounding>');
      expect(request.messages[1].content).toContain('<chunk>');
    });
  });

  describe('d. Error handling and resilience', () => {
    it('handles LLM API timeout gracefully (falls back to original chunk)', async () => {
      const chunks = createChunks(1);
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Timeout'));

      const result = await enrichChunksWithContext(fullMarkdown, chunks, config, { retries: 0 });
      expect(result[0].content).toBe(chunks[0].content);
      expect(result[0].metadata.contextual_retrieval).toBeUndefined();
    });

    it('handles LLM API error (non-200 response)', async () => {
      const chunks = createChunks(1);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const result = await enrichChunksWithContext(fullMarkdown, chunks, config, { retries: 0 });
      expect(result[0].content).toBe(chunks[0].content);
    });

    it('handles malformed LLM response', async () => {
      const chunks = createChunks(1);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ bad: 'data' }),
      });

      const result = await enrichChunksWithContext(fullMarkdown, chunks, config, { retries: 0 });
      expect(result[0].content).toBe(chunks[0].content);
    });

    it('retry logic on failure (800ms backoff, 1 retry)', async () => {
      const chunks = createChunks(1);
      let attempts = 0;
      (global.fetch as jest.Mock).mockImplementation(async () => {
        attempts++;
        if (attempts === 1) throw new Error('Network error');
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Recovered' } }] }) };
      });

      const result = await enrichChunksWithContext(fullMarkdown, chunks, config, { retries: 1 });
      expect(attempts).toBe(2);
      expect(result[0].content).toContain('Recovered');
    });
  });

  describe('e. Edge cases', () => {
    it('empty chunks array', async () => {
      const result = await enrichChunksWithContext(fullMarkdown, [], config);
      expect(result).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('single chunk document', async () => {
      const chunks = createChunks(1);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Single' } }] }),
      });

      const result = await enrichChunksWithContext(fullMarkdown, chunks, config);
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('Single');
    });

    it('chunk with very long content', async () => {
      const longChunk = createChunks(1, 'A'.repeat(10000));
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Long' } }] }),
      });

      const result = await enrichChunksWithContext(fullMarkdown, longChunk, config);
      expect(result[0].content).toContain('Long');
    });

    it('unicode/emoji in content', async () => {
      const emojiChunk = createChunks(1, 'Hello 🌍');
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Emoji ctx' } }] }),
      });

      const result = await enrichChunksWithContext(fullMarkdown, emojiChunk, config);
      expect(result[0].content).toContain('Hello 🌍');
      expect(result[0].content).toContain('Emoji ctx');
    });

    it('document with only whitespace', async () => {
      const whitespaceDoc = ' '.repeat(600);
      const chunks = createChunks(1);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Ws ctx' } }] }),
      });

      const result = await enrichChunksWithContext(whitespaceDoc, chunks, config);
      expect(result[0].content).toContain('Ws ctx');
    });
  });
});
