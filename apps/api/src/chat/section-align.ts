/**
 * 结构对齐偏置（Corpus-Agnostic）。
 * 问题点名某个小节/表角色（如「汇总表」「附则」）时，提升同结构候选的排序，
 * 避免同文档的长明细表把短汇总分片挤出上下文。
 * 不做业务词表；只用通用文档结构词与标题相等/包含匹配。
 */

/** 通用表角色：短汇总表 vs 长明细表 */
function stripContextPrefix(text: string): string {
  return String(text || "")
    .replace(/^\s*\[\s*上下文[\s\S]*?\]\s*/u, "")
    .replace(/^\s*\[\s*context[\s\S]*?\]\s*/iu, "");
}

export type TableRole = 'summary' | 'detail' | 'unknown';

export interface SectionAlignInput {
  section?: string | null;
  breadcrumb?: string | null;
  headingHierarchy?: string[] | null;
  title?: string | null;
  tableRole?: string | null;
  evidence?: string | null;
  charStart?: number | null;
}

/** 从问题中抽取可能的小节名（2–8 字中文词 / 英文词），按长度降序。 */
export function extractSectionAnchors(query: string, limit = 8): string[] {
  const anchors = new Set<string>();
  // Split on interrogative particles so「考核汇总表的编号是多少」
  // yields 考核汇总表 / 编号 rather than one long token.
  const segments = query
    .split(/[\s,\u3002\uFF1F\uFF01\u3001\uFF1A\uFF1B\uFF08\uFF09()\[\]\u3010\u3011\u300A\u300B]|\u7684|\u662F|\u6709|\u5728|\u548c|\u4E0E|\u53CA|\u6216|\u591A\u5C11|\u4EC0\u4E48|\u51E0|\u54EA\u4E2A|\u54EA\u4E9B|\u8BF7\u95EE|\u8BF7|\u7ED9\u51FA|\u5217\u51FA/g)
    .map((s) => s.replace(/[^\u4e00-\u9fffA-Za-z0-9_-]/g, ''))
    .filter((s) => /[\u4e00-\u9fff]{2,12}|[A-Za-z][A-Za-z0-9_-]{2,20}/.test(s));
  for (const run of segments) {
    anchors.add(run);
    for (const suffix of ['\u8868', '\u7AE0', '\u8282', '\u5F55', '\u5219', '\u9879', '\u90E8\u5206']) {
      if (run.length > 2 && run.endsWith(suffix)) anchors.add(run.slice(0, -1));
    }
    if (run.length >= 3) {
      for (const head of ['\u6C47\u603B', '\u7EDF\u8BA1', '\u660E\u7EC6', '\u603B\u5219', '\u9644\u5219', '\u9644\u5F55', '\u6458\u8981']) {
        if (run.includes(head)) anchors.add(head);
      }
    }
  }
  const latin = query.match(/[A-Za-z][A-Za-z0-9_-]{2,20}/g) || [];
  for (const w of latin) anchors.add(w.toLowerCase());
  return [...anchors]
    .filter((a) => a.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, limit);
}

const SUMMARY_TABLE_HINTS = /(汇总|合计|统计|总计|总览|摘要)/;
const DETAIL_TABLE_HINTS = /(明细|清单|逐条|逐项)/;

/** 由表形态推断 summary/detail（行数少 + 汇总词，或明确明细词）。 */
export function classifyTableRole(opts: {
  rowCount?: number | null;
  headerText?: string | null;
  section?: string | null;
}): TableRole {
  const text = `${stripContextPrefix(opts.headerText || "")}\n${opts.section || ""}`;
  if (DETAIL_TABLE_HINTS.test(text) && !SUMMARY_TABLE_HINTS.test(text)) return 'detail';
  if (SUMMARY_TABLE_HINTS.test(text)) return 'summary';
  if (typeof opts.rowCount === 'number') {
    if (opts.rowCount > 0 && opts.rowCount <= 8) return 'summary';
    if (opts.rowCount > 20) return 'detail';
  }
  return 'unknown';
}


function haystackOf(input: SectionAlignInput): string {
  return [
    input.section,
    input.breadcrumb,
    (input.headingHierarchy || []).join(' '),
    input.title,
    // Markdown headings inside the chunk body (gbrain citations often carry
    // section only as `## 汇总` at the start of evidence, not a metadata field).
    ...(stripContextPrefix(input.evidence || "").match(/^#{1,6}\s*.+$/gm) || []),
    input.evidence?.slice(0, 200),
  ]
    .filter(Boolean)
    .join(' ');
}

/** Structural view used for strong matches: metadata fields + body headings. */
function structuralOf(input: SectionAlignInput): string {
  return [
    input.section,
    input.breadcrumb,
    (input.headingHierarchy || []).join(' '),
    input.title,
    ...(stripContextPrefix(input.evidence || "").match(/^#{1,6}\s*.+$/gm) || []),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * 返回 [0, 1.5] 的排序乘子。默认 1.0。
 * - 问题点名的小节出现在 breadcrumb/标题 → 最多 ×1.35
 * - 问题含汇总类词且候选是 summary 表 → ×1.25
 * - 问题含汇总类词且候选是超长 detail 表 → ×0.85（轻微压制，不惩罚正常明细问答）
 */
export function sectionAlignMultiplier(query: string, input: SectionAlignInput): number {
  const hay = haystackOf(input);
  const hayLower = hay.toLowerCase();
  let mult = 1;
  const anchors = extractSectionAnchors(query);
  let matched = false;
  for (const anchor of anchors) {
    if (anchor.length < 2) continue;
    const a = anchor.toLowerCase();
    // section/breadcrumb/title/body-headings match is stronger than body echo
    const structural = structuralOf(input).toLowerCase();
    if (structural.includes(a)) {
      mult = Math.max(mult, 1.35);
      matched = true;
      break;
    }
    if (hayLower.includes(a)) {
      mult = Math.max(mult, 1.15);
      matched = true;
    }
  }
  const queryWantsSummary = SUMMARY_TABLE_HINTS.test(query) || /编号|序号|汇总/.test(query);
  const role = (input.tableRole || classifyTableRole({ headerText: input.evidence, section: input.section })) as TableRole;
  if (queryWantsSummary && role === 'summary') mult = Math.max(mult, 1.25);
  if (queryWantsSummary && role === 'detail') {
    // only suppress when the query explicitly named a summary-ish section
    // and this candidate is clearly a long detail table
    const namedSummary = anchors.some((a) => SUMMARY_TABLE_HINTS.test(a));
    const longDetail = (input.evidence || '').length > 800 && role === 'detail';
    if (namedSummary && longDetail && !matched) mult = Math.min(mult, 0.85);
  }
  return mult;
}

/** 原地按结构对齐重排分数；返回是否有任何乘子 ≠ 1。 */
export function applySectionAlign<T extends SectionAlignInput & { score?: number | null }>(
  query: string,
  citations: T[],
): boolean {
  let changed = false;
  for (const c of citations) {
    const m = sectionAlignMultiplier(query, c);
    if (m !== 1) {
      changed = true;
      const base = Number(c.score ?? 0);
      c.score = Number((base * m).toFixed(4));
    }
  }
  return changed;
}
