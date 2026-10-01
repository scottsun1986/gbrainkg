import { rerankPairs } from './pair-reranker';
import { runWithRequestContext } from '../observability/request-context';
import { QueryExecution } from './query-execution';

describe('request pair reranking', () => {
  const config = { modelName: 'reranker', provider: { baseUrl: 'https://fixture.invalid', apiKey: '' } };
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  it('scores only newly added pairs and preserves compressed index mapping', async () => {
    const fetch = jest.fn(async (_url, options) => ({ ok: true, json: async () => ({ results: JSON.parse(options.body).documents.map((_text: string, index: number) => ({ index, relevance_score: .9 - index * .1 })) }) }));
    global.fetch = fetch as any;
    await runWithRequestContext({ requestId: 'pair-test' }, async () => {
      expect(await rerankPairs(config, 'question', ['one', 'two'], 1000)).toHaveLength(2);
      const scores = await rerankPairs(config, 'question', ['two', 'three'], 1000);
      expect(JSON.parse(fetch.mock.calls[1][1].body).documents).toEqual(['three']);
      expect(scores[0].relevance_score).toBe(.8);
      expect(scores[1].relevance_score).toBe(.9);
      await rerankPairs(config, 'different', ['one'], 1000);
      expect(fetch).toHaveBeenCalledTimes(3);
    });
  });
  it('never starts work after the shared deadline', async () => {
    const fetch = jest.fn(); global.fetch = fetch;
    const execution = new QueryExecution('question', true); execution.deadline.abort();
    await runWithRequestContext({ requestId: 'cancelled', execution }, async () => {
      expect(await rerankPairs(config, 'question', ['one'], 1000)).toEqual([]);
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
