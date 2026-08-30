import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

type StoredChunk = {
  content: string;
  charStart: number;
  charEnd: number;
  metadata?: unknown;
};

/**
 * Rebuild legacy documents whose original parsed Markdown predates the
 * canonical content.md file. New documents always use the file path below.
 */
export function mergeStoredChunks(chunks: StoredChunk[]): string {
  const ordered = [...chunks].sort((a, b) => a.charStart - b.charStart);
  const output: string[] = [];
  let coveredUntil = 0;
  for (const chunk of ordered) {
    if (chunk.charEnd <= coveredUntil) continue;
    let content = String(chunk.content || '').trim();
    if (!content) continue;

    const metadata = chunk.metadata && typeof chunk.metadata === 'object'
      ? chunk.metadata as Record<string, unknown>
      : {};
    const section = typeof metadata.section === 'string' ? metadata.section.trim() : '';
    if (chunk.charStart < coveredUntil && section && content.startsWith(section)) {
      content = content.slice(section.length).trimStart();
    }
    const overlap = Math.max(0, coveredUntil - chunk.charStart);
    if (overlap > 0) content = content.slice(Math.min(overlap, content.length)).trimStart();
    if (content) output.push(content);
    coveredUntil = Math.max(coveredUntil, chunk.charEnd);
  }
  return output.join('\n\n').trim();
}

export async function readCanonicalDocument(
  uploadRoot: string,
  documentId: string,
  chunks: StoredChunk[],
): Promise<string> {
  const markdown = await readFile(join(uploadRoot, documentId, 'content.md'), 'utf8').catch(() => '');
  return markdown.trim() || mergeStoredChunks(chunks);
}
