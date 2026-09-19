import AdmZip = require('adm-zip');
import * as tar from 'tar';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { basename, extname, posix } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import {
  SUPPORTED_UPLOAD_EXTENSIONS,
  isArchiveFilename,
} from './parser-capabilities';

export interface ExtractedArchiveFile {
  filename: string;
  buffer: Buffer;
  size: number;
  relativePath: string;
}

export interface ExtractArchiveOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxSingleFileBytes?: number;
}

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500MB
const DEFAULT_MAX_SINGLE_FILE_BYTES = 200 * 1024 * 1024; // 200MB

const TEXT_LIKE_EXTENSIONS = new Set(['.md', '.txt', '.csv', '.html', '.htm']);

/**
 * Sanitizes and validates an archive entry path.
 * Returns null if the entry represents:
 * - A path traversal attack (zip-slip)
 * - OS / metadata artifacts (__MACOSX, .DS_Store, Thumbs.db, hidden dotfiles)
 * - An unsupported file extension
 */
export function sanitizeArchiveEntryPath(rawPath: string): string | null {
  if (!rawPath || typeof rawPath !== 'string') return null;

  // Normalize path separators and remove null/control characters
  let clean = rawPath.replace(/\\/g, '/').replace(/[\0-\x1f\x7f]/g, '');

  // Latin-1 to UTF-8 fallback if needed
  if (/[ÃÂà-ÿ]/.test(clean)) {
    try {
      const decoded = Buffer.from(clean, 'latin1').toString('utf8');
      if (decoded !== clean && !decoded.includes('\uFFFD')) {
        clean = decoded;
      }
    } catch {
      /* keep original */
    }
  }

  // Posix path normalization
  const normalized = posix.normalize(clean);

  // Guard against path traversal / zip-slip
  if (
    normalized.startsWith('../') ||
    normalized === '..' ||
    posix.isAbsolute(normalized) ||
    normalized.includes('/../')
  ) {
    return null;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // Filter out OS artifacts and hidden directories/files
  for (const seg of segments) {
    if (seg === '__MACOSX') return null;
    if (seg.startsWith('.')) return null; // .DS_Store, .git, ._xxx, .hidden
  }

  const leafName = segments[segments.length - 1];
  const lowerLeaf = leafName.toLowerCase();
  if (lowerLeaf === 'thumbs.db' || lowerLeaf === 'desktop.ini' || lowerLeaf === 'ehthumbs.db') {
    return null;
  }

  const ext = extname(lowerLeaf);
  if (!ext || !SUPPORTED_UPLOAD_EXTENSIONS.has(ext)) {
    return null;
  }

  return segments.join('/');
}

/**
 * Strips common root directory if all entries reside within the same top-level folder.
 * e.g., 'archive-root/docs/a.md' and 'archive-root/docs/b.md' -> 'docs/a.md' and 'docs/b.md'
 */
export function stripCommonArchiveRoot(relativePaths: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (relativePaths.length === 0) return result;

  const splitPaths = relativePaths.map((p) => p.split('/'));
  const firstSplit = splitPaths[0];

  let commonPrefixCount = 0;
  for (let i = 0; i < firstSplit.length - 1; i++) {
    const candidate = firstSplit[i];
    const isCommon = splitPaths.every((parts) => parts.length > i + 1 && parts[i] === candidate);
    if (isCommon) {
      commonPrefixCount = i + 1;
    } else {
      break;
    }
  }

  for (const p of relativePaths) {
    const parts = p.split('/');
    const stripped = parts.slice(commonPrefixCount).join('/');
    result.set(p, stripped);
  }

  return result;
}

/**
 * Generates a clean, unique document filename/title from an archive relative path.
 * Replaces subfolder slashes with '-' to keep names descriptive yet valid flat filenames.
 */
export function generateUniqueDocumentTitle(
  strippedPath: string,
  usedTitles: Set<string>,
): string {
  const ext = extname(strippedPath);
  const baseWithoutExt = strippedPath.slice(0, -ext.length || undefined);
  const cleanBase = baseWithoutExt
    .replace(/[\\/\0-\x1f\x7f]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200);

  let candidate = `${cleanBase || 'document'}${ext}`;
  let counter = 1;
  while (usedTitles.has(candidate.toLowerCase())) {
    candidate = `${cleanBase || 'document'}-${counter}${ext}`;
    counter++;
  }
  usedTitles.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Extracts valid documents from a ZIP archive buffer.
 */
async function extractZipEntries(
  buffer: Buffer,
  options: ExtractArchiveOptions,
): Promise<{ relativePath: string; buffer: Buffer }[]> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxSingleFileBytes = options.maxSingleFileBytes ?? DEFAULT_MAX_SINGLE_FILE_BYTES;

  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err: any) {
    throw new BadRequestException(`ZIP 压缩包损坏或格式不正确：${err?.message || '无法解析'}`);
  }

  const entries = zip.getEntries();
  const rawItems: { relativePath: string; buffer: Buffer }[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const safePath = sanitizeArchiveEntryPath(entry.entryName);
    if (!safePath) continue;

    if (rawItems.length >= maxFiles) {
      throw new BadRequestException(`压缩包内文件数量超出安全限制 (${maxFiles} 个)`);
    }

    // Pre-check the declared uncompressed size BEFORE inflating anything into
    // memory (entry.getData() would otherwise materialize a zip-bomb entry
    // first and only reject it afterwards). Mirrors the streaming guard used
    // by the TAR path below. A forged header is still caught by the real-size
    // check after extraction.
    const declaredSize = Number(entry.header?.size ?? -1);
    if (Number.isFinite(declaredSize) && declaredSize >= 0) {
      if (declaredSize > maxSingleFileBytes) {
        throw new BadRequestException(
          `压缩包内文件 "${safePath}" 超出单文件最大限制 (${Math.round(maxSingleFileBytes / (1024 * 1024))}MB)`,
        );
      }
      if (totalBytes + declaredSize > maxTotalBytes) {
        throw new BadRequestException(
          `压缩包解压总大小超出安全上限 (${Math.round(maxTotalBytes / (1024 * 1024))}MB)`,
        );
      }
    }

    const ext = extname(safePath).toLowerCase();
    let data: Buffer;
    try {
      data = entry.getData();
    } catch (err: any) {
      // Password protected or corrupt entry
      continue;
    }

    if (!data || data.length === 0) continue;

    if (data.length > maxSingleFileBytes) {
      throw new BadRequestException(
        `压缩包内文件 "${safePath}" 超出单文件最大限制 (${Math.round(maxSingleFileBytes / (1024 * 1024))}MB)`,
      );
    }

    // Fast-fail empty or pure-whitespace text documents
    if (TEXT_LIKE_EXTENSIONS.has(ext)) {
      const text = data.toString('utf8').trim();
      if (!text) continue;
    }

    totalBytes += data.length;
    if (totalBytes > maxTotalBytes) {
      throw new BadRequestException(
        `压缩包解压总大小超出安全上限 (${Math.round(maxTotalBytes / (1024 * 1024))}MB)`,
      );
    }

    rawItems.push({ relativePath: safePath, buffer: data });
  }

  return rawItems;
}

/**
 * Extracts valid documents from a TAR / TAR.GZ / TGZ archive buffer.
 */
async function extractTarEntries(
  buffer: Buffer,
  options: ExtractArchiveOptions,
): Promise<{ relativePath: string; buffer: Buffer }[]> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxSingleFileBytes = options.maxSingleFileBytes ?? DEFAULT_MAX_SINGLE_FILE_BYTES;

  const isGzip =
    (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b);

  const rawItems: { relativePath: string; buffer: Buffer }[] = [];
  let totalBytes = 0;

  const parseStream = new tar.Parser();

  parseStream.on('entry', (entry: any) => {
    if (entry.type !== 'File') {
      entry.resume();
      return;
    }

    const safePath = sanitizeArchiveEntryPath(entry.path);
    if (!safePath) {
      entry.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let entrySize = 0;
    let entryAborted = false;

    entry.on('data', (chunk: Buffer) => {
      if (entryAborted) return;
      chunks.push(chunk);
      entrySize += chunk.length;
      if (entrySize > maxSingleFileBytes) {
        entryAborted = true;
        parseStream.emit(
          'error',
          new BadRequestException(
            `压缩包内文件 "${safePath}" 超出单文件最大限制 (${Math.round(maxSingleFileBytes / (1024 * 1024))}MB)`,
          ),
        );
      }
    });

    entry.on('end', () => {
      if (entryAborted) return;
      const data = Buffer.concat(chunks);
      if (data.length === 0) return;

      const ext = extname(safePath).toLowerCase();
      if (TEXT_LIKE_EXTENSIONS.has(ext)) {
        const text = data.toString('utf8').trim();
        if (!text) return;
      }

      totalBytes += data.length;
      if (totalBytes > maxTotalBytes) {
        parseStream.emit(
          'error',
          new BadRequestException(
            `压缩包解压总大小超出安全上限 (${Math.round(maxTotalBytes / (1024 * 1024))}MB)`,
          ),
        );
        return;
      }

      if (rawItems.length >= maxFiles) {
        parseStream.emit(
          'error',
          new BadRequestException(`压缩包内文件数量超出安全限制 (${maxFiles} 个)`),
        );
        return;
      }

      rawItems.push({ relativePath: safePath, buffer: data });
    });
  });

  const readable = Readable.from(buffer);

  await new Promise<void>((resolve, reject) => {
    readable.on('error', reject);
    parseStream.on('error', reject);
    parseStream.on('finish', resolve);

    if (isGzip) {
      const gunzip = createGunzip();
      gunzip.on('error', (err) => {
        reject(new BadRequestException(`GZIP 解压缩失败：${err.message || '文件损坏'}`));
      });
      readable.pipe(gunzip).pipe(parseStream);
    } else {
      readable.pipe(parseStream);
    }
  });

  return rawItems;
}

/**
 * High-level helper to extract supported documents from an archive buffer.
 * Automatically deletes/discards the archive buffer itself after extraction.
 */
export async function extractArchiveDocuments(
  archiveBuffer: Buffer,
  archiveFilename: string,
  options: ExtractArchiveOptions = {},
): Promise<ExtractedArchiveFile[]> {
  const lowerName = archiveFilename.toLowerCase();
  let rawItems: { relativePath: string; buffer: Buffer }[];

  if (lowerName.endsWith('.zip')) {
    rawItems = await extractZipEntries(archiveBuffer, options);
  } else if (
    lowerName.endsWith('.tar') ||
    lowerName.endsWith('.tar.gz') ||
    lowerName.endsWith('.tgz')
  ) {
    rawItems = await extractTarEntries(archiveBuffer, options);
  } else {
    throw new BadRequestException(`不支持的压缩包格式: ${archiveFilename}`);
  }

  if (rawItems.length === 0) {
    throw new BadRequestException(
      '压缩包内未包含有效且受支持的文档（支持格式：PDF、Word、PPT、Excel、Markdown、TXT、CSV、HTML 等）。',
    );
  }

  const relativePaths = rawItems.map((item) => item.relativePath);
  const strippedMap = stripCommonArchiveRoot(relativePaths);
  const usedTitles = new Set<string>();

  const result: ExtractedArchiveFile[] = [];
  for (const item of rawItems) {
    const strippedPath = strippedMap.get(item.relativePath) || item.relativePath;
    const filename = generateUniqueDocumentTitle(strippedPath, usedTitles);
    result.push({
      filename,
      buffer: item.buffer,
      size: item.buffer.length,
      relativePath: item.relativePath,
    });
  }

  return result;
}
