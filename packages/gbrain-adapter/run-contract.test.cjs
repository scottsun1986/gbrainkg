const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BrainRepoAdapter } = require('./dist/index.js');

test('cancelling a real running child terminates it and releases quota', async () => {
  const adapter = new BrainRepoAdapter('/tmp/adapter-contract-no-io');
  adapter.gbrainBin = process.execPath;
  const controller = new AbortController();
  const pending = adapter.run(['-e', 'setInterval(() => {}, 1000)'], undefined, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /GBRAIN_CANCELLED/);
  assert.equal(adapter.processPool.stats.running, 0);
});

test('cancelling a queued request removes it without starting a process', async () => {
  const adapter = new BrainRepoAdapter('/tmp/adapter-contract-no-io');
  const releases = await Promise.all(Array.from({ length: adapter.processPool.stats.max }, () => adapter.processPool.acquire()));
  const controller = new AbortController();
  let started = false;
  adapter.executeProcess = async () => { started = true; return { stdout: '', stderr: '' }; };
  try {
    const pending = adapter.run(['get', 'fixture'], undefined, controller.signal);
    controller.abort();
    await assert.rejects(pending, /GBRAIN_CANCELLED/);
    assert.equal(adapter.processPool.stats.queued, 0);
    assert.equal(started, false);
  } finally { releases.forEach(release => release()); }
});

test('configuration changes cannot reuse a previous retrieval cache entry', async () => {
  const adapter = new BrainRepoAdapter('/tmp/adapter-contract-no-io');
  let signature = 'model-v1';
  let calls = 0;
  adapter.ensureSearchConfig = async () => { adapter.searchConfigSignature = signature; };
  adapter.run = async () => { calls++; return { stdout: '[]', stderr: '' }; };
  await adapter.query('gbrain://source/one', 'question');
  await adapter.query('gbrain://source/one', 'question');
  assert.equal(calls, 1);
  signature = 'model-v2';
  await adapter.query('gbrain://source/one', 'question');
  assert.equal(calls, 2);
});

test('multiple adapter instances share one child-process quota', async () => {
  const first = new BrainRepoAdapter('/tmp/adapter-contract-no-io');
  const second = new BrainRepoAdapter('/tmp/adapter-contract-no-io-2');
  assert.equal(first.processPool, second.processPool);
  let active = 0;
  let peak = 0;
  const execute = async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { stdout: '', stderr: '' };
  };
  first.executeProcess = execute;
  second.executeProcess = execute;
  const limit = first.processPool.maxConcurrency;
  await Promise.all(Array.from({ length: limit + 4 }, (_, index) =>
    (index % 2 ? first : second).run(['get', `unique-${index}`])));
  assert.equal(peak, limit);
  assert.equal(active, 0);
});

test('federated merge preserves same-title pages from separate sources', async () => {
  const adapter = new BrainRepoAdapter('/tmp/adapter-contract-no-io');
  adapter.query = async () => ({ topics: ['shared'], answer: '', reranked: false,
    citations: [{ topic: 'shared', slug: 'shared', snippet: 'evidence', score: 0.5 }] });
  const result = await adapter.queryMany(['gbrain://source/one', 'gbrain://source/two'], 'question');
  assert.equal(result.citations.length, 2);
  assert.deepEqual(result.citations.map(c => c.sourceKey), ['one', 'two']);
});

test('search distinguishes genuine empty results from protocol failures', () => {
  const adapter = new BrainRepoAdapter('/tmp/adapter-contract-no-io');
  assert.deepEqual(adapter.parseSearchRows('[]'), []);
  assert.equal(adapter.parseSearchRows('[{"slug":"docs/one","score":0.8}]')[0].title, 'docs/one');
  for (const raw of ['', 'PRIVATE invalid json', '{}', '[null]', '[{"slug":7}]', '[{"slug":"x","score":"0.5"}]']) {
    assert.throws(() => adapter.parseSearchRows(raw), /GBRAIN_INVALID_SEARCH_(JSON|SCHEMA)/);
  }
});

test('real child output overflow is bounded and rejected', async () => {
  const adapter = new BrainRepoAdapter('/tmp/adapter-contract-no-io');
  adapter.gbrainBin = process.execPath;
  const previous = process.env.GBRAIN_MAX_OUTPUT_BYTES;
  process.env.GBRAIN_MAX_OUTPUT_BYTES = '128';
  try {
    await assert.rejects(adapter.executeProcess(['-e', 'process.stdout.write("x".repeat(4096))']), /GBRAIN_OUTPUT_LIMIT/);
  } finally {
    if (previous === undefined) delete process.env.GBRAIN_MAX_OUTPUT_BYTES;
    else process.env.GBRAIN_MAX_OUTPUT_BYTES = previous;
  }
});

test('real child failure does not expose arguments or stderr', async () => {
  const adapter = new BrainRepoAdapter('/tmp/adapter-contract-no-io');
  adapter.gbrainBin = process.execPath;
  await assert.rejects(
    adapter.executeProcess(['-e', 'process.stderr.write("PRIVATE_DOCUMENT");process.exit(2)']),
    error => error.message === 'GBRAIN_EXIT_FAILED (2)',
  );
});

test('failed read clears dedup state without an unhandled rejection', async () => {
  const adapter = new BrainRepoAdapter('/tmp/adapter-contract-no-io');
  let calls = 0;
  adapter.executeProcess = async () => { calls++; throw new Error('fixture failure'); };
  const results = await Promise.allSettled([adapter.run(['get', 'same']), adapter.run(['get', 'same'])]);
  assert.equal(calls, 1);
  assert.ok(results.every(r => r.status === 'rejected'));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(adapter.run(['get', 'same']), /fixture failure/);
  assert.equal(calls, 2);
});

test('argument boundaries cannot collide and migrations are not deduplicated', async () => {
  const adapter = new BrainRepoAdapter('/tmp/adapter-contract-no-io');
  let calls = 0;
  adapter.executeProcess = async () => { calls++; return { stdout: '', stderr: '' }; };
  await Promise.all([adapter.run(['get', 'a b']), adapter.run(['get', 'a', 'b'])]);
  assert.equal(calls, 2);
  await Promise.all([adapter.run(['migrate', 'embeddings']), adapter.run(['migrate', 'embeddings'])]);
  assert.equal(calls, 4);
});
