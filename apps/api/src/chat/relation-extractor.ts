/** Relation syntax and explicit deployment configuration, without a subject lexicon. */
import { resolveRelationSurfaceForms } from './corpus-agnostic-config';

export function extractRelationFromQuery(query: string): string | null {
  if (!query) return null;
  const table = resolveRelationSurfaceForms();
  for (const [relation, forms] of Object.entries(table).sort((a, b) => b[0].length - a[0].length)) {
    for (const form of [relation, ...forms]) {
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(query)) return relation;
    }
  }
  // Attribute-of and possessive grammar accepts previously unseen relations.
  const english = query.match(/\b(?:the|a|an)\s+([\p{L}][\p{L}\s-]{0,50}?)\s+of\b/iu)
    || query.match(/['’]s\s+([\p{L}][\p{L}\s-]{0,50}?)(?=\s+(?:is|was|are|were|has|have|had|who|that|which)\b|[,.?!]|$)/iu)
    || query.match(/\b(?:the|a|an)\s+([\p{L}][\p{L}-]*)\s+(?:who|that|which)\b/iu)
    || query.match(/^\s*who\s+(?!(?:is|was|are|were|has|have|had|does|did|can|will)\b)([\p{L}][\p{L}-]*)\b/iu);
  if (english) return english[1].trim().toLowerCase();
  const chinese = query.match(/的([^的，。！？?\s]{1,20}?)(?:是谁|是什么|是哪个|在哪|如何|怎么|[？?])/u);
  return chinese ? chinese[1] : null;
}

export function surfaceFormsForRelation(rel: string): string[] {
  const table = resolveRelationSurfaceForms();
  const forms = table[rel.toLowerCase()];
  return Array.from(new Set([rel, ...(Array.isArray(forms) ? forms : [])]));
}
