import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOfficeArchiveBudget, boundedSheetRange, readPreviewBlob } from '../src/lib/preview-limits';

function zipDirectory(expandedSize: number): ArrayBuffer {
  const buffer = new ArrayBuffer(4 + 46 + 22);
  const view = new DataView(buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint32(4, 0x02014b50, true);
  view.setUint32(4 + 24, expandedSize, true);
  view.setUint32(50, 0x06054b50, true);
  view.setUint16(50 + 10, 1, true);
  view.setUint32(50 + 16, 4, true);
  return buffer;
}

test('Office archive rejects decompression amplification before parsing', () => {
  assert.doesNotThrow(() => assertOfficeArchiveBudget(zipDirectory(4096)));
  assert.throws(() => assertOfficeArchiveBudget(zipDirectory(129 * 1024 * 1024)), /解压内容过大/);
  assert.throws(() => assertOfficeArchiveBudget(zipDirectory(0xffffffff)), /解压内容过大/);
});

test('sparse worksheet bounds preserve origin without allocating full advertised range', () => {
  const original = { s: { r: 12, c: 4 }, e: { r: 1048575, c: 16383 } };
  assert.deepEqual(boundedSheetRange(original), { s: { r: 12, c: 4 }, e: { r: 1011, c: 103 } });
  assert.equal(original.e.r, 1048575);
});

test('preview stream enforces byte limit even without content-length', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(6)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readPreviewBlob(new Response(stream), 10), /文件过大/);
  assert.equal(cancelled, true);
  const blob = await readPreviewBlob(new Response('hello'), 10);
  assert.equal(await blob.text(), 'hello');
});
