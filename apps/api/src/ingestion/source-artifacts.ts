import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { uploadRoot } from '../storage/upload-paths';
import { instanceIdentity } from '../observability/instance-identity';

export interface SourceCell { coordinate: string; column: number; type: string; value: unknown; display?: string; formula?: string; cached?: unknown; inherited?: boolean; number_format?: string; unit?: string; unit_source?: string; display_scale?: number }
export interface SourceRow { row: number; cells: SourceCell[]; is_header?: boolean; is_summary?: boolean }
export interface StructuredTable { id: string; sheet: string; range: string; headers: string[]; header_columns?: number[]; header_units?: Array<string|null>; column_units?: Record<string,string[]>; rows: SourceRow[]; row_count: number; complete: boolean; mode: string; artifact_id?: string; artifact_path?: string; sha256?: string }

/** Persist bytes under the receiving document/version; never inherit cached
 * source URLs or permissions from a different document. */
export async function persistSourceArtifacts(parsed: any, documentId: string, version: number, parserUrl: string) {
  if (!(parsed.assets || []).length && !(parsed.structured_tables || []).some((table: StructuredTable) => table.artifact_id || table.artifact_path)) return parsed;
  const relativeDir = `${documentId}/artifacts.v${version}`;
  const dir = join(uploadRoot(), relativeDir);
  await mkdir(dir, { recursive: true });
  let totalBytes = 0;
  const acceptBytes = (bytes:number) => { totalBytes += bytes; if (totalBytes > 200 * 1024 * 1024) throw new Error("Derived artifacts exceed combined 200 MiB budget"); };
  const headers: Record<string, string> = {};
  const token = process.env.PARSER_AUTH_TOKEN || process.env.AUTH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  for (const table of parsed.structured_tables || []) {
    if (!table.artifact_id) {
      if (table.artifact_path && !table.artifact_path.startsWith(relativeDir + '/')) {
        const source = table.artifact_path; const target = `${relativeDir}/table.${table.sha256 || createHash('sha256').update(table.id).digest('hex')}.jsonl`;
        if (!resolve(uploadRoot(),source).startsWith(resolve(uploadRoot(),documentId)+sep)) throw new Error('Invalid inherited artifact owner');
        acceptBytes((await stat(join(uploadRoot(),source))).size);
        await copyFile(join(uploadRoot(), source), join(uploadRoot(), target)); table.artifact_path = target;
      }
      continue;
    }
    if (!/^[a-f0-9]{32}$/.test(table.artifact_id)) throw new Error('Invalid parser artifact identity');
    const relative = `${relativeDir}/table.${table.artifact_id}.jsonl`;
    const response = await fetch(`${parserUrl}/artifacts/${table.artifact_id}?instance_id=${encodeURIComponent(instanceIdentity())}`, {
      headers, signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) throw new Error('Structured fact download failed');
    const sha = createHash('sha256'); let size = 0;
    const budget = new Transform({ transform(chunk, _encoding, next) {
      size += chunk.length;
      if (size > 200 * 1024 * 1024) return next(new Error('Structured artifact exceeds 200 MiB budget'));
      try { acceptBytes(chunk.length); } catch (error) { return next(error as Error); }
      sha.update(chunk); next(null, chunk);
    } });
    const destination = join(uploadRoot(), relative); const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    try { await pipeline(Readable.fromWeb(response.body as any), budget, createWriteStream(temporary)); await rename(temporary,destination); }
    finally { await unlink(temporary).catch(()=>undefined); }
    table.artifact_path = relative; table.sha256 = sha.digest('hex');
    delete table.artifact_id;
  }
  for (const asset of parsed.assets || []) {
    if (asset.data_base64) {
      if (asset.data_base64.length > 70 * 1024 * 1024) throw new Error('Image asset exceeds encoded budget');
      const data = Buffer.from(asset.data_base64, 'base64');
      acceptBytes(data.length);
      if (data.length > 50 * 1024 * 1024) throw new Error('Image asset exceeds budget');
      const hash = createHash('sha256').update(data).digest('hex');
      asset.sha256 = hash; asset.id ||= hash;
      asset.path = `${relativeDir}/image.${hash}`;
      const destination=join(uploadRoot(),asset.path); const temporary=`${destination}.${process.pid}.${Date.now()}.tmp`;
      try { await writeFile(temporary,data); await rename(temporary,destination); } finally { await unlink(temporary).catch(()=>undefined); }
      delete asset.data_base64;
    } else if (asset.artifact_id) {
      if (!/^[a-f0-9]{32}$/.test(asset.artifact_id)) throw new Error('Invalid parser asset identity');
      asset.path = `${relativeDir}/image.${asset.artifact_id}`;
      const response = await fetch(`${parserUrl}/artifacts/${asset.artifact_id}?instance_id=${encodeURIComponent(instanceIdentity())}`, { headers, signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error('Image asset download failed');
      let size = 0; const sha = createHash('sha256');
      const budget = new Transform({ transform(chunk, _encoding, next) { size += chunk.length;
        if (size > 50 * 1024 * 1024) return next(new Error('Image asset exceeds 50 MiB budget'));
        try { acceptBytes(chunk.length); } catch (error) { return next(error as Error); }
        sha.update(chunk); next(null, chunk); } });
      const destination=join(uploadRoot(),asset.path); const temporary=`${destination}.${process.pid}.${Date.now()}.tmp`;
      try { await pipeline(Readable.fromWeb(response.body as any), budget, createWriteStream(temporary)); await rename(temporary,destination); }
      finally { await unlink(temporary).catch(()=>undefined); }
      asset.sha256 = sha.digest('hex'); delete asset.artifact_id;
    }
    if (asset.path && !asset.path.startsWith(relativeDir + '/')) {
      const source = asset.path; const target = `${relativeDir}/image.${asset.sha256 || createHash('sha256').update(asset.id).digest('hex')}`;
      if (!resolve(uploadRoot(),source).startsWith(resolve(uploadRoot(),documentId)+sep)) throw new Error('Invalid inherited asset owner');
      acceptBytes((await stat(join(uploadRoot(),source))).size);
      await copyFile(join(uploadRoot(), source), join(uploadRoot(), target)); asset.path = target;
    }
    if (asset.path) asset.url = `/api/v1/kbs/_/documents/${documentId}/assets/${encodeURIComponent(asset.id)}?version=${version}`;
  }
  return parsed;
}

/** Markdown packages remain one document. Images use the same Worker and
 * cache as standalone files, with recognition anchored at the local link. */
export async function enrichMarkdownPackage(parsed: any, metadata: any, documentId: string, version: number, parserUrl: string, ocr: any) {
  const packageAssets = metadata?.package_assets || [];
  if (!packageAssets.length) return parsed;
  const headers: Record<string,string> = {};
  const token = process.env.PARSER_AUTH_TOKEN || process.env.AUTH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  parsed.assets ||= []; parsed.source_units ||= [];
  parsed.source_units.push({ id:'md:body',kind:'document',status:'processed',markdown:String(parsed.markdown),native_text_chars:Number(parsed.native_text_chars || 0),original_char_start:0,original_char_end:String(parsed.markdown).length });
  for (const asset of packageAssets) {
    const form = new FormData(); const bytes = await readFile(join(uploadRoot(), asset.path));
    form.append('file', new Blob([bytes]), asset.filename); form.append('instance_id', instanceIdentity());
    if (ocr) for (const [field, value] of Object.entries({ ocr_provider: ocr.provider, ocr_endpoint: ocr.baseUrl, ocr_api_key: ocr.apiKey, ocr_secret_key: ocr.secretKey })) if (value) form.append(field, String(value));
    let text = '', recognizedChars = 0, error: string | undefined;
    try {
      const response = await fetch(`${parserUrl}/parse-execute?parser_type=auto`, { method:'POST', body:form, headers, signal:AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result: any = await response.json();
      if (result.status !== 'completed' || !(result.native_text_chars ?? result.markdown?.trim().length)) throw new Error('图片未提取到真实正文');
      text = String(result.markdown || '').trim(); recognizedChars = result.native_text_chars ?? text.length;
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    const url = `/api/v1/kbs/_/documents/${documentId}/assets/${asset.id}?version=${version}`;
    const relativeDocument = metadata.archive?.path || '';
    let inserted = false;
    parsed.markdown = String(parsed.markdown).replace(/!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g, (full: string, alt: string, angle: string, bare: string, offset: number) => {
      const ref = angle || bare;
      let decoded: string; try { decoded = decodeURIComponent(ref.split('#')[0]); } catch { return full; }
      // Resolve against the original package path, never the flattened title.
      const { posix } = require('node:path');
      if (posix.normalize(posix.join(posix.dirname(relativeDocument), decoded)).normalize('NFC') !== asset.relativePath.normalize('NFC')) return full;
      inserted = true;
      parsed.source_units.push({ id:`md-image:${asset.id}:${offset}`, kind:'image', status: error ? 'failed' : 'processed',
        asset_ids:[asset.id], anchor:relativeDocument, original_char_start:offset, original_char_end:offset + full.length,
        markdown:text, native_text_chars:recognizedChars, ...(error ? {error} : {}) });
      return `![${alt}](${url})${text ? `\n\n${text}\n\n` : ''}`;
    });
    // Reference-style links keep their structural location; append recognition
    // as an explicitly associated asset unit when the regex has no inline link.
    if (!inserted) {
      parsed.source_units.push({ id:`md-image:${asset.id}`, kind:'image', status:error ? 'failed' : 'processed', asset_ids:[asset.id], anchor:asset.relativePath, markdown:text, native_text_chars:recognizedChars, ...(error ? {error} : {}) });
      if (text) parsed.markdown += `\n\n![${asset.filename}](${url})\n\n${text}`;
    }
    parsed.assets.push({ ...asset, url, status:error ? 'failed' : 'processed', text, ...(error ? {error} : {}) });
    parsed.native_text_chars = Number(parsed.native_text_chars || 0) + recognizedChars;
  }
  for (const unit of parsed.source_units) { const at = unit.markdown ? parsed.markdown.indexOf(unit.markdown) : -1; if (at >= 0) { unit.char_start = at; unit.char_end = at + unit.markdown.length; } }
  const bodyUnit=parsed.source_units.find((unit:any)=>unit.id==='md:body');if(bodyUnit){bodyUnit.char_start=0;bodyUnit.char_end=parsed.markdown.length;}
  const processed = parsed.source_units.filter((unit: any) => unit.status === 'processed' || unit.status === 'completed').length;
  const failed = parsed.source_units.filter((unit: any) => unit.status === 'failed').length;
  parsed.coverage = { total:parsed.source_units.length, processed, failed, skipped:parsed.source_units.length - processed - failed };
  return parsed;
}

export function attachSourceLocations(chunks: any[], parsed: any) {
  return chunks.map(chunk => {
    const units = (parsed.source_units || []).filter((unit: any) => Number.isFinite(unit.char_start) && Number.isFinite(unit.char_end) &&
      unit.char_start < chunk.charEnd && unit.char_end > chunk.charStart);
    const assetIds = (parsed.assets || []).filter((asset:any) => asset.url && chunk.content.includes(asset.url)).map((asset:any) => asset.id);
    const unit = units[0];
    return { ...chunk, metadata: { ...chunk.metadata, source_units: units,
      ...(unit ? { source_position: { unitId: unit.id, page: unit.page, sheet: unit.sheet, slide: unit.slide,
        shape: unit.shape, table: unit.table_id || unit.table, rowStart: unit.row_start, rowEnd: unit.row_end, range: unit.range,
        assetIds: unit.asset_ids || [] } } : {}),
      asset_ids:assetIds, source_projection: 'original-extraction',
    } };
  });
}
