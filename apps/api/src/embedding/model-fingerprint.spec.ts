import { embeddingFingerprint } from './model-fingerprint';

const config = { baseUrl: 'http://model/v1', apiKey: 'secret', modelName: 'BAAI/bge-m3', dimensions: 1024 };
it('does not reuse vectors across weights, routes, projections or instances', () => {
  const fp = embeddingFingerprint(config, {});
  expect(embeddingFingerprint({ ...config, deploymentRevision: 'new-weights' }, {})).not.toBe(fp);
  expect(embeddingFingerprint({ ...config, baseUrl: 'http://other/v1' }, {})).not.toBe(fp);
  expect(embeddingFingerprint(config, { INSTANCE_ID: 'inst2' })).not.toBe(fp);
  expect(embeddingFingerprint(config, { EMBEDDING_MAX_CHARS: '3000' })).not.toBe(fp);
  expect(embeddingFingerprint({ ...config, apiKey: 'rotated-secret' }, {})).toBe(fp);
});
