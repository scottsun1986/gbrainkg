import { createHash } from 'node:crypto';

/** Full passage identity: shared introductions must not hide later differences. */
export function evidenceIdentity(text: string): string {
  const raw = text.replace(/<!--(?:[\s\S]*?)-->/g, '').replace(/\\([#*_])/g, '$1').replace(/\s+/g, '').trim();
  return raw ? createHash('sha256').update(raw).digest('hex') : '';
}

/** Use only after ACL/version filtering; keep the highest ranked provenance. */
export function distinctRankedPassages<T>(ranked: T[], textOf: (row: T) => string): T[] {
  const seen = new Set<string>();
  return ranked.filter(row => {
    const key = evidenceIdentity(textOf(row));
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
