export interface ContextBudgetInput {
  breadth: boolean;
  complexity?: string;
  subQueryCount?: number;
  evidenceCount?: number;
}

/**
 * Resolve the answer-context token budget. An explicit
 * RETRIEVAL_CONTEXT_TOKEN_BUDGET always wins (backwards compatible). Otherwise
 * the budget scales with question complexity instead of the previous fixed
 * 4,500/8,000 two-tier split: multi-hop and comparative questions need more
 * room to hold every reasoning hop, and many decomposed sub-queries each need
 * their own evidence. Bounded by RETRIEVAL_CONTEXT_TOKEN_BUDGET_MIN/MAX so a
 * pathological query cannot blow up the prompt.
 */
export function resolveContextTokenBudget(input: ContextBudgetInput): number {
  const max = Number(process.env.RETRIEVAL_CONTEXT_TOKEN_BUDGET_MAX || 12000);
  const min = Number(process.env.RETRIEVAL_CONTEXT_TOKEN_BUDGET_MIN || 3000);
  const explicit = Number(process.env.RETRIEVAL_CONTEXT_TOKEN_BUDGET);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(min, Math.min(max, explicit));

  let budget = input.breadth ? 8000 : 4500;
  const complexity = String(input.complexity || "simple");
  if (complexity === "multi_hop") budget += 2500;
  else if (complexity === "comparative") budget += 2000;
  else if (complexity !== "simple") budget += 1000;

  const subs = Number(input.subQueryCount || 0);
  if (subs > 0) budget += Math.min(subs, 4) * 750;

  const evidence = Number(input.evidenceCount || 0);
  if (evidence > 20) budget += 1000;

  return Math.max(min, Math.min(max, budget));
}

export function estimateTokens(value: string): number {
  let dense = 0;
  let other = 0;
  for (const char of value) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) dense++;
    else other++;
  }
  return dense + Math.ceil(other / 4);
}

// `fitEvidenceContext` used to live here as a second, unused context builder:
// it was exported, covered by tests, and never called from the answer path,
// which formats sources with compiled-truth tags, page/article anchors and KB
// names that the helper knew nothing about. Two competing formatters meant the
// shipped one had no budget test at all. The bound is now applied in the answer
// assembly path itself (RETRIEVAL_CONTEXT_TOKEN_HARD_CAP / ..._RATIO) where the
// real prompt string is built, and `estimateTokens` below is shared by both.
