import { posix, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeDocumentText } from './text-decoder';
import { ExtractedArchiveFile } from './archive-extractor';

const mime: Record<string,string> = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.tif':'image/tiff', '.tiff':'image/tiff', '.bmp':'image/bmp' };
/** Resolve package-local dependencies only; never fetch external URLs. */
export function associateMarkdownResources(files: ExtractedArchiveFile[]) {
  const byPath = new Map(files.map(file => [file.relativePath.normalize('NFC'), file]));
  const dependencies = new Map<string, Array<{ id:string; mime:string; filename:string; relativePath:string; buffer:Buffer }>>();
  const usedAssets = new Set<string>();
  for (const file of files) {
    if (extname(file.relativePath).toLowerCase() !== '.md') continue;
    const text = decodeDocumentText(file.buffer).text;
    const refs = [...text.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)].map(match => match[1] || match[2]);
    const definitions = new Map([...text.matchAll(/^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)].map(match => [match[1].toLowerCase(), match[2]]));
    for (const match of text.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)) { const path = definitions.get((match[2] || match[1]).toLowerCase()); if (path) refs.push(path); }
    const assets = [];
    for (const ref of refs) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(ref)) continue;
      let decoded: string; try { decoded = decodeURIComponent(ref.split('#')[0]); } catch { continue; }
      const path = posix.normalize(posix.join(posix.dirname(file.relativePath), decoded)).normalize('NFC');
      if (path.startsWith('../') || posix.isAbsolute(path)) continue;
      const asset = byPath.get(path); if (!asset || !mime[extname(path).toLowerCase()]) continue;
      const id = createHash('sha256').update(asset.buffer).digest('hex');
      assets.push({ id, mime: mime[extname(path).toLowerCase()], filename: asset.filename, relativePath: asset.relativePath, buffer: asset.buffer });
      usedAssets.add(asset.relativePath);
    }
    if (assets.length) dependencies.set(file.relativePath, assets);
  }
  return { dependencies, usedAssets };
}
