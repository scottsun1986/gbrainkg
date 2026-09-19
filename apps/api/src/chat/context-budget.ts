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

export function fitEvidenceContext<T extends Record<string, any>>(
  citations: T[], tokenBudget: number,
): { citations: T[]; context: string; estimatedTokens: number; truncated: boolean } {
  let remaining = Math.max(0, Math.floor(tokenBudget));
  const included: T[] = [];
  const blocks: string[] = [];
  for (const citation of citations) {
    const index = included.length + 1;
    const title = citation.docTitle || citation.topic || `参考文档 ${index}`;
    const kbName = citation.kbName ? ` (所属知识库: ${citation.kbName})` : '';
    const section = citation.section ? `\n定位：${citation.section}` : '';
    const header = `【来源 ${index}】《${title}》${kbName}${section}\n`;
    const raw = String(citation.context || citation.snippet || '').trim();
    const headerTokens = estimateTokens(header);
    if (headerTokens + 8 > remaining) break;
    const maxContentTokens = remaining - headerTokens;
    let content = raw;
    if (estimateTokens(content) > maxContentTokens) {
      const suffix = '\n[本来源内容因上下文预算截断]';
      const contentBudget = Math.max(0, maxContentTokens - estimateTokens(suffix));
      let low = 0, high = content.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (estimateTokens(content.slice(0, mid)) <= contentBudget) low = mid;
        else high = mid - 1;
      }
      content = content.slice(0, low).replace(/\s+\S*$/, '').trimEnd();
      if (content) content += suffix;
    }
    if (!content) continue;
    const block = header + content;
    blocks.push(block);
    included.push(citation);
    remaining -= estimateTokens(block) + 4;
  }
  const context = blocks.join('\n\n---\n\n');
  return { citations: included, context, estimatedTokens: estimateTokens(context), truncated: included.length < citations.length || included.some((item, i) => !context.includes(String(item.context || item.snippet || '').trim())) };
}
