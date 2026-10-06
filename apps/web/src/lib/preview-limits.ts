/** Bound client-side Office parsing before decompression and sheet materialization. */
export const MAX_OFFICE_PREVIEW_BYTES = 32 * 1024 * 1024;
const MAX_OFFICE_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_OFFICE_ENTRIES = 2000;

export function assertOfficeArchiveBudget(buffer: ArrayBuffer): void {
  if (buffer.byteLength > MAX_OFFICE_PREVIEW_BYTES) throw new Error('文件过大，请下载原件查看');
  const view = new DataView(buffer);
  // Legacy XLS and CSV are not ZIP containers.
  if (buffer.byteLength < 4 || view.getUint32(0, true) !== 0x04034b50) return;
  let end = -1;
  for (let offset = buffer.byteLength - 22; offset >= Math.max(0, buffer.byteLength - 65557); --offset) {
    if (view.getUint32(offset, true) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error('Office 文件目录无效');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count > MAX_OFFICE_ENTRIES || offset === 0xffffffff) throw new Error('Office 文件内容过多，请下载原件查看');
  let expanded = 0;
  for (let index = 0; index < count; ++index) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Office 文件目录无效');
    const size = view.getUint32(offset + 24, true);
    expanded += size;
    if (size === 0xffffffff || expanded > MAX_OFFICE_EXPANDED_BYTES) throw new Error('Office 解压内容过大，请下载原件查看');
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  if (offset > end) throw new Error('Office 文件目录无效');
}

export async function readPreviewBlob(response: Response, maxBytes = MAX_OFFICE_PREVIEW_BYTES): Promise<Blob> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('文件过大，请下载原件查看');
  }
  if (!response.body) return new Blob([], { type: response.headers.get('content-type') || '' });
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('文件过大，请下载原件查看'); }
      chunks.push(new Uint8Array(value));
    }
  } finally { reader.releaseLock(); }
  return new Blob(chunks, { type: response.headers.get('content-type') || '' });
}

export function boundedSheetRange(range: { s: { r: number; c: number }; e: { r: number; c: number } }) {
  return { s: { ...range.s }, e: { r: Math.min(range.e.r, range.s.r + 999), c: Math.min(range.e.c, range.s.c + 99) } };
}
