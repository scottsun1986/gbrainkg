import { WeKnoraClient } from './weknora-client';
describe('official WeKnora read-only contract', () => {
  const binding = { knowledgeId: 'external-1', documentId: 'doc-1', kbId: 'kb-1', version: 3 };
  afterEach(() => jest.restoreAllMocks());
  it('never sends an empty scope as a broad search', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    expect(await new WeKnoraClient({ baseUrl: 'http://weknora', apiKey: 'fixture' }).search('question', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses official API fields and excludes unmapped documents', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, data: [
      { id: 'chunk-1', knowledge_id: 'external-1', content: 'allowed', score: 0.8 },
      { id: 'chunk-secret', knowledge_id: 'external-other', content: 'private', score: 1 },
    ] })));
    const result = await new WeKnoraClient({ baseUrl: 'http://weknora', apiKey: 'fixture' }).search('question', [binding]);
    expect(result).toEqual([{ provider: 'weknora', externalChunkId: 'chunk-1', documentId: 'doc-1', kbId: 'kb-1', documentVersion: 3, content: 'allowed', score: 0.8 }]);
    expect(fetchMock).toHaveBeenCalledWith('http://weknora/api/v1/knowledge-search', expect.objectContaining({
      redirect: 'error', body: JSON.stringify({ query: 'question', knowledge_ids: ['external-1'] }),
    }));
  });
  it('does not expose upstream error bodies', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('private error body', { status: 403 }));
    await expect(new WeKnoraClient({ baseUrl: 'http://weknora', apiKey: 'fixture' }).search('question', [binding])).rejects.toThrow('WEKNORA_HTTP_403');
  });
});
