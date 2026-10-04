import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftKey, registerRun, rekeyRun, runOwnsView, unregisterRun,
  type RunMap, type StreamRunLike,
} from '../src/lib/stream-registry';

/**
 * Regression cover for "同时新建多个会话，后面的会话没进列表".
 *
 * The chat screen used to keep one `streaming` boolean and start the SSE fetch
 * from an effect keyed on `[streaming]`. A second send while the first was still
 * running called `setStreaming(true)` on an already-true value, so React dropped
 * the update, the effect never re-ran, and no request was ever sent: the
 * optimistic message bubble appeared but the conversation was never created.
 *
 * The registry has no such merge point — every send registers its own key.
 */
const makeRun = (convId: string | null, title = 'q'): StreamRunLike => ({
  convId,
  controller: new AbortController(),
  flush: () => {},
  title,
});

describe('concurrent stream registry', () => {
  it('registers every send, so a second new conversation is never dropped', () => {
    const runs: RunMap = new Map();
    // Two brand-new conversations asked in a row: both start as drafts.
    const a = registerRun(runs, 1, makeRun(null, '第一个问题'));
    const b = registerRun(runs, 2, makeRun(null, '第二个问题'));
    assert.equal(a.key, draftKey(1));
    assert.equal(b.key, draftKey(2));
    assert.notEqual(a.key, b.key, '两条流不能共用一个键，否则第二条会被合并掉');
    assert.equal(runs.size, 2, '第二次提问必须真正登记，不能被丢弃');
  });

  it('keys an existing conversation by its id', () => {
    const runs: RunMap = new Map();
    const r = registerRun(runs, 1, makeRun('conv-1'));
    assert.equal(r.key, 'conv-1');
    assert.equal(r.draft, false);
  });

  it('rekeys a draft to the assigned id and drops the draft key', () => {
    const runs: RunMap = new Map();
    const draft = registerRun(runs, 1, makeRun(null));
    assert.equal(rekeyRun(runs, draft.key, 'conv-9'), true);
    assert.equal(runs.has(draft.key), false);
    assert.equal(runs.get('conv-9')?.convId, 'conv-9');
    assert.equal(runs.size, 1);
  });

  it('refuses to rekey a run that is no longer registered', () => {
    const runs: RunMap = new Map();
    // The stream finished (and unregistered) before the conversation event landed.
    assert.equal(rekeyRun(runs, draftKey(1), 'conv-9'), false);
  });

  it('unregisters only the finishing run and leaves the others running', () => {
    const runs: RunMap = new Map();
    const runA = makeRun('conv-a');
    const runB = makeRun('conv-b');
    registerRun(runs, 1, runA);
    registerRun(runs, 2, runB);
    assert.equal(unregisterRun(runs, 'conv-a', runA), true);
    assert.equal(runs.has('conv-b'), true, '并发的另一条流不能被误清');
    assert.equal(runs.size, 1);
  });

  it('will not unregister a run under a key that now belongs to someone else', () => {
    const runs: RunMap = new Map();
    const stale = makeRun(null);
    const fresh = makeRun(null);
    registerRun(runs, 1, fresh);
    // A late cleanup from an older run must not evict the newer one.
    assert.equal(unregisterRun(runs, draftKey(1), stale), false);
    assert.equal(runs.get(draftKey(1)), fresh);
  });
});

describe('view ownership decides which stream may write to the screen', () => {
  it('a draft stream owns the blank view only while it holds it', () => {
    // Blank view held by draft 2: draft 2 writes, draft 1 does not.
    assert.equal(runOwnsView(null, draftKey(2), null, draftKey(2)), true);
    assert.equal(runOwnsView(null, draftKey(2), null, draftKey(1)), false);
    // A stream that already has a server id no longer owns the blank view.
    assert.equal(runOwnsView(null, draftKey(2), 'conv-9', 'conv-9'), false);
  });

  it('a conversation stream owns the view only for its own conversation', () => {
    assert.equal(runOwnsView('conv-a', null, 'conv-a', 'conv-a'), true);
    assert.equal(runOwnsView('conv-a', null, 'conv-b', 'conv-b'), false, 'B 生成时用户在看 A，A 的视图不应被 B 改写');
    assert.equal(runOwnsView(null, null, null, draftKey(3)), false, '空白视图没有归属者时谁都不该写');
  });

  it('keeps ownership across a rekey so the new conversation renders its deltas', () => {
    // Before the conversation event the view is the draft key.
    assert.equal(runOwnsView(draftKey(1), draftKey(1), null, draftKey(1)), true);
    // After rekey the view follows the assigned id.
    assert.equal(runOwnsView('conv-7', 'conv-7', 'conv-7', 'conv-7'), true);
  });
});