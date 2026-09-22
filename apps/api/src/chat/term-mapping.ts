export interface TermMapping {
  from: string;
  to: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse an admin-maintained term mapping from KnowledgeBase.domainTerms.
 *
 * Accepted shapes (all corpus-agnostic — this module never hardcodes terms):
 *   { "<口语词>": ["<正式词1>", "<正式词2>"] }   // object map
 *   [{ "from": "<口语词>", "to": ["<正式词>"] }] // list of {from,to}
 *   ["<提示词1>", "<提示词2>"]                   // legacy flat hint terms
 *
 * A flat string array carries no mapping information, so it yields no
 * mappings; those terms continue to be handled as plain retrieval hints.
 */
export function parseTermMappings(raw: unknown): TermMapping[] {
  const out: TermMapping[] = [];
  const push = (from: unknown, to: unknown) => {
    const key = String(from ?? "").trim();
    if (!key) return;
    const targets = (Array.isArray(to) ? to : [to])
      .map((t) => String(t ?? "").trim())
      .filter((t) => t.length > 0 && t.toLowerCase() !== key.toLowerCase());
    if (!targets.length) return;
    out.push({ from: key, to: Array.from(new Set(targets)) });
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (obj.from != null) push(obj.from, obj.to ?? obj.targets ?? []);
      }
    }
    return out;
  }
  if (raw && typeof raw === "object") {
    for (const [from, to] of Object.entries(raw as Record<string, unknown>)) push(from, to);
  }
  return out;
}

/**
 * Expand a query containing a mapped colloquial term into retrieval variants
 * that carry the formal/document term. The original query is always preserved
 * by the caller; only supplementary arms are returned here. Substituting the
 * term (in addition to appending it) gives the vector arm a chance to match
 * the document's own vocabulary.
 */
export function expandQueryWithTermMappings(
  query: string,
  mappings: TermMapping[],
  maxVariants = 4,
): string[] {
  if (!query || !mappings.length) return [];
  const lower = query.toLowerCase();
  const variants: string[] = [];
  for (const mapping of mappings) {
    if (!mapping.from || !lower.includes(mapping.from.toLowerCase())) continue;
    variants.push(`${query} ${mapping.to.join(" ")}`.trim());
    const substituted = query.replace(new RegExp(escapeRegExp(mapping.from), "gi"), mapping.to[0]);
    if (substituted !== query) variants.push(substituted);
    if (variants.length >= maxVariants * 2) break;
  }
  return Array.from(new Set(variants.filter((v) => v && v !== query && v.length <= 200))).slice(
    0,
    maxVariants,
  );
}
