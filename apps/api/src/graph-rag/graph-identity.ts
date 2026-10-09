/**
 * Graph entity identity (F05).
 *
 * Kept in a standalone module so both the write path (graph-rag.service) and
 * the incremental projection can share the exact same key derivation without a
 * circular import.
 *
 * The previous identity was the raw name, so (a) two real-world entities of
 * different kinds sharing one spelling could not coexist — the second write
 * overwrote the first's type — and (b) a same-name merge silently changed an
 * entity's kind. Keying on (normalized name, type) keeps `name` as a reusable
 * label and stops cross-kind overwrites. Equal-type homonyms still share a key;
 * that residual case is surfaced by the read-only graph quality audit rather
 * than papered over. The normalization must stay in sync with the migration's
 * backfill (regexp_replace(lower(btrim(name)), '\s+', ' ', 'g')).
 */
export function entityIdentityKey(name: string, type: string): string {
  const normalized = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${normalized}|${String(type || 'concept')}`;
}
