import { fallbackChunkToCitation } from './chat.service';

describe('fallbackChunkToCitation provenance', () => {
  it('propagates summary provenance so a derived summary can be expanded to its source', () => {
    const citation = fallbackChunkToCitation(
      {
        title: '软件研发中心绩效管理办法.doc',
        documentId: 'doc-1',
        id: 'chunk-1',
        evidence: 'evidence',
        raptor: true,
        isSummary: true,
        sourceChunkIds: ['chunk-a', 'chunk-b'],
      },
      0,
    );
    expect(citation.raptor).toBe(true);
    expect(citation.isSummary).toBe(true);
    expect(citation.sourceChunkIds).toEqual(['chunk-a', 'chunk-b']);
  });

  it('leaves sourceChunkIds undefined for a plain source chunk', () => {
    const citation = fallbackChunkToCitation({ title: 'T', documentId: 'd', id: 'c', evidence: 'e' }, 0);
    expect(citation.raptor).toBe(false);
    expect(citation.sourceChunkIds).toBeUndefined();
  });
});
