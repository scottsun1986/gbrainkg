/**
 * Parse-coverage contract (F06).
 *
 * Publication deliberately allows partially parsed documents (only "no
 * extractable text" rejects). That policy is fine for local facts, but an
 * exhaustive conclusion — "all items", "does anything exist", "total count" —
 * silently becomes false when the fact sits in a source unit the parser failed
 * or skipped: retrieval found nothing, yet the answer claims absence.
 *
 * The parsed coverage recorded at ingestion time (`parserMetadata.coverage`:
 * { total, processed, failed, skipped }) is carried onto the evidence and used
 * two ways:
 *   1. the prompt receives a scope note for any cited document with failed or
 *      skipped units, so the model knows the parsed range;
 *   2. completeness-sensitive questions get a deterministic scope qualifier on
 *      the final answer when they would otherwise read as absolute.
 */
export interface ParseCoverage {
  total: number;
  processed: number;
  failed: number;
  skipped: number;
}

const finiteInt = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
};

/** Normalize an ingestion coverage record; null when it cannot prove anything. */
export function normalizeParseCoverage(raw: unknown): ParseCoverage | null {
  if (!raw || typeof raw !== 'object') return null;
  const total = finiteInt((raw as any).total);
  const processed = finiteInt((raw as any).processed);
  const failed = finiteInt((raw as any).failed) ?? 0;
  const skipped = finiteInt((raw as any).skipped) ?? 0;
  if (total === null || processed === null || total <= 0) return null;
  return { total, processed, failed, skipped };
}

export function isIncompleteCoverage(coverage: ParseCoverage | null | undefined): boolean {
  if (!coverage) return false;
  return coverage.failed > 0 || coverage.skipped > 0 || coverage.processed < coverage.total;
}

/**
 * Completeness-sensitive question shapes: enumeration, totals, existence and
 * absence checks, where a partial parse changes the meaning of "none".
 */
export function isCompletenessSensitiveQuestion(question: string): boolean {
  const q = String(question || '');
  if (!q.trim()) return false;
  const zh = /(全部|所有|一切|逐个|逐一|列举|罗列|列出|哪些|哪几(?:个|种|项|条|行|人|次)|一共|总共|合计|总数|多少(?:个|种|项|条|行|人|次|台|份)|是否存在|有没有|是否包含|是否包括|是否涉及|是否出现|无一|均无)/;
  const en = /\b(all of|all the|every (one|item|entry|row|record)|each of|enumerate|list (all|every)|which ones|how many|total (number|count|of)|does .{0,40} exist|do any|is there any|are there any|whether .{0,40} (exists?|present))\b/i;
  return zh.test(q) || en.test(q);
}

export interface ParseCoverageCitation {
  docTitle?: string | null;
  parseCoverage?: ParseCoverage | null;
  [key: string]: unknown;
}

/** Unique incomplete documents among the citations, in stable order. */
export function collectIncompleteCoverageSources(
  citations: ParseCoverageCitation[],
): Array<{ title: string; coverage: ParseCoverage }> {
  const seen = new Set<string>();
  const sources: Array<{ title: string; coverage: ParseCoverage }> = [];
  for (const citation of citations || []) {
    const coverage = normalizeParseCoverage(citation?.parseCoverage);
    if (!isIncompleteCoverage(coverage)) continue;
    const title = String(citation?.docTitle || '').trim() || '未命名文档';
    if (seen.has(title)) continue;
    seen.add(title);
    sources.push({ title, coverage: coverage! });
  }
  return sources;
}

function formatDetails(
  sources: Array<{ title: string; coverage: ParseCoverage }>,
  english: boolean,
): string {
  return sources
    .slice(0, 3)
    .map(({ title, coverage }) => english
      ? `“${title}”: ${coverage.processed}/${coverage.total} units parsed (failed ${coverage.failed}, skipped ${coverage.skipped})`
      : `《${title}》：已解析 ${coverage.processed}/${coverage.total} 个来源单元（失败 ${coverage.failed}，跳过 ${coverage.skipped}）`)
    .join(english ? '; ' : '；') + (sources.length > 3 ? (english ? `; ${sources.length - 3} more` : `；另有 ${sources.length - 3} 份`) : '');
}

/** Prompt-side scope note; empty when every cited source parsed completely. */
export function buildCoverageScopeNote(citations: ParseCoverageCitation[], english: boolean): string {
  const sources = collectIncompleteCoverageSources(citations);
  if (!sources.length) return '';
  const details = formatDetails(sources, english);
  if (english) {
    return `[Parse-coverage notice] Some cited sources have unparsed units (${details}). For completeness questions ("all", "how many", "does X exist"), answer only within the successfully parsed range and state that range; never present missing coverage as "does not exist" or as an exhaustive list.`;
  }
  return `【解析覆盖提示】以下来源存在未成功解析的内容（${details}）。对"全部/有多少/是否存在"这类完整性结论，只能就已成功解析的范围作答并说明该范围；不得把未解析内容表述为"不存在"或"已全部列出"。`;
}

/**
 * True for the deterministic scope sentences this module appends. They are
 * meta-statements about parsing, not factual claims about the corpus, so the
 * sentence-grounding statistics must not count them as unsupported claims.
 */
export function isCoverageScopeStatement(text: string): boolean {
  const value = String(text || '').trim();
  return value.startsWith('【范围说明】') || value.startsWith('[Scope note]');
}

/**
 * Deterministic final-answer qualifier. Returns '' when the question is not
 * completeness-sensitive, coverage is complete, or the answer already
 * acknowledges the parsing limit.
 */
export function buildCoverageQualifier(
  question: string,
  citations: ParseCoverageCitation[],
  answer: string,
  english: boolean,
): string {
  if (!isCompletenessSensitiveQuestion(question)) return '';
  const sources = collectIncompleteCoverageSources(citations);
  if (!sources.length) return '';
  const acknowledges = english
    ? /(pars(e|ing|ed)|coverage)[^.!?\n]{0,60}(partial|incomplete|failed|skipped|not fully)/i.test(answer)
    : /(解析|覆盖)[^。！？\n]{0,40}(不完整|未完整|未覆盖|失败|跳过|未成功|部分)/.test(answer);
  if (acknowledges) return '';
  const details = formatDetails(sources, english);
  if (english) {
    return `\n\n[Scope note] ${details}. The answer above covers only the successfully parsed content; unparsed content cannot be treated as absent or as a complete list.`;
  }
  return `\n\n【范围说明】${details}。以上结论仅覆盖已成功解析的内容，未解析部分不能视为"不存在"，也不能据此认定已完整列举。`;
}
