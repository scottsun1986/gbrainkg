import { createHash } from 'node:crypto';

export function truthContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Exact output delta, not an LLM's narrative of what might have changed. */
export function compiledTruthDiff(before: string | null, after: string, beforeSources: any[] = [], afterSources: any[] = []) {
  const oldLines = new Set((before || '').split('\n').map(line => line.trim()).filter(Boolean));
  const newLines = new Set(after.split('\n').map(line => line.trim()).filter(Boolean));
  const added = [...newLines].filter(line => !oldLines.has(line));
  const removed = [...oldLines].filter(line => !newLines.has(line));
  const oldById = new Map(beforeSources.map(source => [source.docId, source]));
  const newById = new Map(afterSources.map(source => [source.docId, source]));
  return {
    contract: 'compiled-truth-diff-v1', baseline: before === null ? 'missing' : 'present',
    beforeHash: before === null ? null : truthContentHash(before), afterHash: truthContentHash(after),
    changed: before !== after, addedLineCount: added.length, removedLineCount: removed.length,
    // The counts/hashes stay exact even when the display delta is too large.
    addedLines: added.slice(0, 200), removedLines: removed.slice(0, 200),
    displayTruncated: added.length > 200 || removed.length > 200,
    sourcesAdded: [...newById.keys()].filter(id => !oldById.has(id)),
    sourcesRemoved: [...oldById.keys()].filter(id => !newById.has(id)),
    sourcesChanged: [...newById.keys()].filter(id => oldById.has(id) &&
      JSON.stringify(oldById.get(id)) !== JSON.stringify(newById.get(id))),
  };
}

/** Timeline reports actual lifecycle fields; title/version alone never proves
 * that another document was repealed or superseded. */
export function compiledTimeline(docs: any[]): string {
  const entries = [...docs].sort((a, b) => {
    const at = a.effectiveFrom ? new Date(a.effectiveFrom).getTime() : Infinity;
    const bt = b.effectiveFrom ? new Date(b.effectiveFrom).getTime() : Infinity;
    return (at === bt ? 0 : at - bt) || String(a.id).localeCompare(String(b.id));
  });
  return ['# Source lifecycle timeline', ...entries.map(doc => JSON.stringify({
    documentId: doc.id, title: doc.title, version: doc.version,
    effectiveFrom: doc.effectiveFrom || null, effectiveTo: doc.effectiveTo || null,
    lifecycleStatus: doc.lifecycleStatus || 'current', supersedesDocumentId: doc.supersedesDocumentId || null,
    source: `llmwiki://documents/${doc.id}`,
  }))].join('\n');
}

/** Timeout handles must be removed when a fast synthesis wins its race. */
export async function withSynthesisTimeout<T>(operation: Promise<T>, timeoutMs = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('synthesis_timeout')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
