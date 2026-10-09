import React from 'react';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { prepareQaRows, validateQa, qaValue, canRetryImport, qaVersions, type QaRow, type QaItem } from '../src/lib/ingestion-ui';
import { QaVersionContent, QaApprovalContent } from '../src/components/libraries/QaPanel';
import { IngestionCoverage } from '../src/components/preview/IngestionCoverage';
const row = (answer: QaRow['answer']): QaRow => ({ id: 'stable-1', question: '标准问', answer, aliases: ['相似问'] });

test('QA import preserves zero, false, stable IDs and aliases', () => {
  const prepared = prepareQaRows([row(0), row(false)]);
  assert.deepEqual(prepared.map(value => value.answer), ['0', 'false']);
  assert.equal(prepared[0].id, 'stable-1');
  assert.deepEqual(prepared[1].aliases, ['相似问']);
  assert.equal(qaValue(null), '');
});
test('QA import blocks empty answers, error rows, conflicts and invalid time ranges', () => {
  assert.equal(prepareQaRows([row(''), { ...row('answer'), errors: ['坏行'] }, { ...row('different'), conflict: true }]).length, 0);
  assert.ok(validateQa({ ...row('answer'), effectiveFrom: '2026-10-10', effectiveTo: '2026-10-09' }).length);
  assert.ok(validateQa({ ...row('answer'), effectiveFrom: 'not-a-date' }).length);
});
test('archive retry requires an existing document and recoverable result', () => {
  assert.equal(canRetryImport({ path: 'broken.pdf', status: 'failed', documentId: 'doc-1' }), true);
  assert.equal(canRetryImport({ path: 'broken.pdf', status: 'failed' }), false);
  assert.equal(canRetryImport({ path: 'image.png', status: 'asset' }), false);
  assert.equal(canRetryImport({ path: 'nested.zip', status: 'skipped' }), false);
});
test('coverage separates native facts and generated text, exposes failed source range', () => {
  const html = renderToStaticMarkup(<IngestionCoverage kbId="kb-1" docId="doc-1" canWrite metadata={{ coverage: { total: 2, processed: 1, failed: 1, skipped: 0 }, native_text_chars: 0, generated_text_chars: 20, source_units: [{ id: 'page-2', kind: 'page', status: 'failed', page: 2, error: '<script>bad</script>' }] }} />);
  assert.match(html, /原文提取 0 字/);
  assert.match(html, /系统生成说明 20 字/);
  assert.match(html, /第 2 页/);
  assert.match(html, /重试来源单元 page-2/);
  assert.ok(!html.includes('<script>bad</script>'));
});
test('read-only users can inspect coverage without retry controls', () => {
  const html = renderToStaticMarkup(<IngestionCoverage kbId="kb-1" docId="doc-1" metadata={{ source_units: [{ id: 'image-1', kind: 'image', status: 'failed' }] }} />);
  assert.ok(!html.includes('checkbox'));
  assert.ok(!html.includes('重试选中'));
  assert.match(html, /未报告覆盖率/);
});

test('published QA updates keep active content separate from the review candidate', () => {
  const item: QaItem = { id: 'doc-1', title: 'old title', status: 'published', version: 2, ingestVersion: 3,
    effectiveFrom: '1999-01-01', effectiveTo: '1999-12-31', displayVersion: 3, qaState: 'needs_review',
    qa: { ...row('new answer'), effectiveFrom: '2026-12-01', reviewStatus: 'pending' },
    pendingQa: { ...row('new answer'), effectiveFrom: '2026-12-01', reviewStatus: 'pending' },
    activeQa: { ...row('active answer'), effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30', reviewStatus: 'approved' } };
  const view = qaVersions(item);
  assert.equal(view.state, 'needs_review');
  assert.equal(view.displayVersion, 3);
  assert.equal(view.displayed?.answer, 'new answer');
  assert.equal(view.displayed?.effectiveTo, undefined);
  const html = renderToStaticMarkup(<QaVersionContent item={item} />);
  assert.match(html, /待发布候选 v3/);
  assert.match(html, /当前已发布 v2/);
  assert.match(html, /new answer/);
  assert.match(html, /active answer/);
  assert.ok(!html.includes('1999'));
  const review = renderToStaticMarkup(<QaApprovalContent qa={view.pending!} version={view.displayVersion} />);
  assert.match(review, /2026-12-01/);
  assert.match(review, /长期有效/);
  assert.match(review, /待发布候选版本：v3/);
  assert.ok(!review.includes('2026-11'));
  assert.ok(!review.includes('active answer'));
});
test('first QA candidates have no published content even if legacy status is stale', () => {
  const item: QaItem = { id: 'doc-1', title: 'QA', status: 'published', version: 1, qaState: 'needs_review', displayVersion: 2,
    activeQa: null, pendingQa: { ...row(false), reviewStatus: 'pending' } };
  const html = renderToStaticMarkup(<QaVersionContent item={item} />);
  assert.match(html, /尚无已发布版本/);
  assert.match(html, /false/);
  assert.ok(!html.includes('当前已发布'));
});
test('QA preview idProvided remains available to server conflict decisions', () => {
  assert.equal(prepareQaRows([{ ...row(0), idProvided: false }])[0].idProvided, false);
});
