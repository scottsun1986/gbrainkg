import { Logger } from '@nestjs/common';
import { RetrievalArmsService } from './retrieval-arms';
import { selectDerivedContext } from './derived-context';

describe('cached chunk contract', () => {
  const hit = { id: 'chunk-1', documentId: 'doc-1', kbId: 'kb-1', version: 2, ord: 0, evidence: 'source tail', title: 'Title' };
  it('returns chunk shape after live citation authorization', async () => {
    const check = jest.fn(async (result) => {
      expect(result.citations[0]).toMatchObject({ docId: hit.documentId, chunkId: hit.id, version: 2 });
      return result;
    });
    const arms = new RetrievalArmsService({ logger: new Logger(), prisma: { chunk: { findMany: jest.fn() } }, filterQueryResultByCurrentPermission: check });
    arms.subQueryChunkCache.set('anonymous:uncached:kb-1:now:query:15', { hits: [hit], expiresAt: Date.now() + 10000 });
    expect(await arms.searchChunksFallback(['kb-1'], 'query')).toEqual([hit]);
    expect(check).toHaveBeenCalledTimes(1);
  });
  it('does not replay a cached chunk rejected after version or ACL change', async () => {
    const arms = new RetrievalArmsService({ logger: new Logger(), prisma: { chunk: { findMany: jest.fn() } }, filterQueryResultByCurrentPermission: async () => ({ citations: [] }) });
    arms.subQueryChunkCache.set('anonymous:uncached:kb-1:now:query:15', { hits: [hit], expiresAt: Date.now() + 10000 });
    expect(await arms.searchChunksFallback(['kb-1'], 'query')).toEqual([]);
  });
});

describe('scope summary selection', () => {
  it('retrieves a relevant tail section beyond a long inventory', () => {
    const text = 'Inventory\n' + 'unrelated asset\n'.repeat(500) + '\n\n# Policy\norbital safeguards apply';
    const selected = selectDerivedContext(text, 'orbital safeguards', 200);
    expect(selected).toContain('orbital safeguards apply');
    expect(selected.length).toBeLessThanOrEqual(200);
  });
});
