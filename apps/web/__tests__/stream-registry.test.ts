import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPoll, isTerminal, labelForRun, pollDelayFor, runningConversationIds,
  type RunMap, type RunState,
} from '../src/lib/stream-registry';

/**
 * Regression cover for "同时新建多个会话，后面的会话没进列表" and for the
 * run lifecycle the non-streaming endpoint drives.
 */

const running = (conversationId: string, runId = `run-${conversationId}`): RunState =>
  ({ runId, conversationId, status: 'running', stage: 'retrieving' });

describe('run registry', () => {
  it('tracks several conversations at once without merging them', () => {
    const runs: RunMap = new Map();
    runs.set('conv-a', running('conv-a'));
    runs.set('conv-b', running('conv-b'));
    assert.equal(runs.size, 2);
    assert.deepEqual(runningConversationIds(runs).sort(), ['conv-a', 'conv-b']);
    // One finishing must not disturb the other: the sidebar shows both.
    const afterA = applyPoll(runs, 'conv-a', { ...running('conv-a'), status: 'completed', stage: 'persisting' });
    assert.equal(afterA.has('conv-a'), false, '完成的会话应移出运行中列表');
    assert.equal(afterA.has('conv-b'), true, '另一条未完成的运行不能被连带清掉');
  });

  it('drops a run once it reaches a terminal status', () => {
    const runs: RunMap = new Map([['conv-a', running('conv-a')]]);
    for (const status of ['completed', 'failed'] as const) {
      const next = applyPoll(new Map(runs), 'conv-a', { ...running('conv-a'), status, stage: 'persisting' });
      assert.equal(next.has('conv-a'), false, status);
    }
  });

  it('does not resurrect a run that already finished', () => {
    const runs: RunMap = new Map();
    // The run was removed (completed, cancelled, or unmounted) while a poll was
    // in flight; the late response must not make the conversation spin again.
    const next = applyPoll(runs, 'conv-a', { ...running('conv-a'), status: 'running', stage: 'generating' });
    assert.equal(next.size, 0);
  });

  it('keeps the stage while the run is still going', () => {
    const runs: RunMap = new Map([['conv-a', running('conv-a')]]);
    const next = applyPoll(runs, 'conv-a', { ...running('conv-a'), stage: 'generating' });
    assert.equal(next.get('conv-a')?.stage, 'generating');
    assert.equal(next.size, 1);
  });

  it('treats both terminal statuses as terminal and running as not', () => {
    assert.equal(isTerminal('completed'), true);
    assert.equal(isTerminal('failed'), true);
    assert.equal(isTerminal('running'), false);
  });
});

describe('run labels', () => {
  it('names the current stage, and the outcome once settled', () => {
    assert.equal(labelForRun(running('a')), '检索证据');
    assert.equal(labelForRun({ ...running('a'), stage: 'generating' }), '生成回答');
    assert.equal(labelForRun({ ...running('a'), status: 'completed' }), '已完成');
    assert.equal(labelForRun({ ...running('a'), status: 'failed' }), '未完成');
  });

  it('falls back rather than throwing on an unknown stage', () => {
    assert.equal(labelForRun({ ...running('a'), stage: 'wat' as never }), '处理中');
  });

  it('has no label for a conversation with no run', () => {
    assert.equal(labelForRun(undefined), null);
  });
});

describe('poll cadence', () => {
  it('polls hardest while the user is actually waiting', () => {
    // Retrieval holds the run for tens of seconds with nothing new to show;
    // generation is when the answer is about to change.
    assert.ok(pollDelayFor('generating') < pollDelayFor('retrieving'));
    assert.ok(pollDelayFor('verifying') < pollDelayFor('retrieving'));
    assert.ok(pollDelayFor('queued') < pollDelayFor('retrieving'));
  });

  it('never busy-loops on any known stage', () => {
    for (const stage of ['queued', 'retrieving', 'reranking', 'generating', 'verifying', 'persisting'] as const) {
      assert.ok(pollDelayFor(stage) >= 500, `${stage} must not busy-loop`);
    }
  });
});
