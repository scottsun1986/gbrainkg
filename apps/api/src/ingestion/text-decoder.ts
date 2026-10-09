/** Decode local text only. No remote dependencies or charset service. */
export function decodeDocumentText(bytes: Buffer): { text: string; encoding: string; warnings: string[] } {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  else if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0) encoding = 'utf-16le';
  try {
    return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''), encoding, warnings: [] };
  } catch {
    // GB18030 is a superset of the common GBK Chinese exports. Report this
    // fallback explicitly; a guessed encoding must never be silently hidden.
    try {
      return { text: new TextDecoder('gb18030', { fatal: true }).decode(bytes), encoding: 'gb18030', warnings: ['原文件不是有效 UTF-8，按 GB18030 解码，请核对'] };
    } catch {
      return { text: bytes.toString('utf8'), encoding: 'utf-8-lossy', warnings: ['无法确定文本编码，存在替换字符，请核对原件'] };
    }
  }
}
