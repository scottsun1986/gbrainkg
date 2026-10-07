/** Keep asynchronously verified fragments at their original model positions. */
export class OrderedAnswer {
  private fragments: Array<{ position: number; text: string; blockStart: boolean }> = [];
  append(position: number, text: string, blockStart = false): void { this.fragments.push({ position, text, blockStart }); }
  render(): string {
    return this.fragments.slice().sort((a, b) => a.position - b.position).reduce((out, item) =>
      out + (item.blockStart && out && !out.endsWith('\n') ? '\n' : '') + item.text, '');
  }
}

/** A row remains one unit even when its prose cells contain punctuation. */
export function answerSentenceBoundary(pending: string): number {
  return /^[ \t]*\|/.test(pending) ? pending.indexOf('\n') : pending.search(/[。！？；\n!?;]/);
}

/** Remove formatting/citation shells left after an unsupported clause is held. */
export function tidyVerifiedAnswer(text: string): string {
  let fence: { marker: string; length: number } | undefined;
  const lines: Array<{ text: string; protected: boolean }> = [];
  for (const line of text.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      lines.push({ text: line, protected: true });
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
      continue;
    }
    if (match) {
      fence = { marker: match[1][0], length: match[1].length };
      lines.push({ text: line, protected: true });
      continue;
    }
    const parts = line.split(/(`+[^`]*`+)/g);
    const boldCount = parts.filter((_, i) => i % 2 === 0)
      .reduce((n, part) => n + (part.match(/(?<!\\)\*\*/g) || []).length, 0);
    const cleaned = boldCount % 2 ? parts.map((part, i) => i % 2 ? part : part.replace(/(?<!\\)\*\*/g, '')).join('') : line;
    const body = cleaned.replace(/\[\d+\]/g, '').replace(/[*_`#\s]/g, '');
    if (cleaned.trim() && !body && !cleaned.includes('`')) continue;
    if (!cleaned.trim() && (!lines.length || (!lines[lines.length - 1].protected && !lines[lines.length - 1].text.trim()))) continue;
    lines.push({ text: cleaned, protected: false });
  }
  while (lines.length) {
    const last = lines[lines.length - 1];
    if (last.protected || (last.text.trim() && !/^\s*#{1,6}\s+/.test(last.text))) break;
    lines.pop();
  }
  const kept = dropEmptySectionHeadings(lines.map(line => line.text));
  return kept.join('\n');
}

/**
 * Drop section headings that ended up with no content.
 *
 * The grounding gate verifies every sentence independently, so the sentences
 * under a section can be held and dropped while its heading — navigation, not a
 * claim — streams through immediately. The user then sees a header with nothing
 * under it (production: "来源 1《…》" followed immediately by "来源 2《…》").
 *
 * A heading is removed when every line between it and the next heading is
 * blank or marker-only. Content is never touched. The rule is applied by both
 * tidyVerifiedAnswer and the streaming classifier, so the pushed prefix stays a
 * prefix of the final text.
 */
export function dropEmptySectionHeadings(lines: string[]): string[] {
  // A heading inside a code fence is code, not navigation: a fence never opens a
  // section and the literal lines under it are content. Track the marker and its
  // length (like scanLines) because a fence is closed only by the same marker
  // with at least its length, so "~~~~text ... ~~~~" never treats the inner
  // "```literal" as an opener.
  let fence: { marker: string; length: number } | undefined;
  const inCode = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (fence) {
      inCode[i] = true;
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim()) {
        fence = undefined;
      }
      continue;
    }
    if (match) {
      // A bare "```" with no fence open opens a fence; the heading under it is
      // code, not navigation.
      fence = { marker: match[1][0], length: match[1].length };
      inCode[i] = true;
      continue;
    }
  }
  const isHeading = (line: string) => !/^\s*\|/.test(line) && isStructuralHeadingLine(line);
  const isEmptyLine = (line: string) => {
    const stripped = line.replace(/\[\d+\]/g, '').replace(/[*_`#\s|]/g, '');
    return stripped.length === 0;
  };
  const keep = new Array<boolean>(lines.length).fill(true);
  for (let i = 0; i < lines.length; i++) {
    if (inCode[i] || !lines[i].trim() || !isHeading(lines[i])) continue;
    let hasContent = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (inCode[j] || isHeading(lines[j])) break;
      if (!isEmptyLine(lines[j])) {
        hasContent = true;
        break;
      }
    }
    if (!hasContent) keep[i] = false;
  }
  return lines.filter((_, index) => keep[index]);
}

/**
 * Structural heading lines (章节标题 / markdown 标题 / 加粗小标题).
 *
 * The per-sentence grounding gate verifies every sentence against evidence and
 * HOLDS anything unsupported for the flush-time NLI review — which re-emits
 * recovered sentences at the END of the answer. A heading ("**三、技能接入与
 * 创建**") carries no facts of its own, so it routinely fails the lexical
 * overlap bar, gets held, and lands after the last content bullet: sections
 * end up headless and headings dangle at the tail (observed in production:
 * held=6/recovered=6 headings appended after the closing paragraph, one
 * heading glued onto the previous line's citation marker).
 *
 * Headings are navigation, not claims: stream them through immediately, in
 * order. Constraints keep this narrow — short, no citation markers, no
 * terminal punctuation (a real sentence ends with 。.!?), and shaped like a
 * heading (Chinese section ordinal, markdown #, bold-phrase title, or a bare
 * list/label fragment).
 */
export function isStructuralHeadingLine(sentence: string): boolean {
  const raw = String(sentence || '').trim();
  let t = raw;
  if (!t) return false;
  // Markdown table syntax (rows / separators) is table STRUCTURE, not a
  // heading: the gate holds marker-less header rows and drops |---|
  // separators (production: held=7/dropped=3 left a table body headless and
  // its header appended at the answer tail). Table lines are handled by the
  // dedicated isTableSyntaxLine branch in gateSentence.
  if (/^\|/.test(t) || (/^[-:|\s]+$/.test(t) && t.includes('-'))) return false;
  // A heading may carry citation markers ("**一、现行版 V2.0 的上下班要求[2]**"):
  // the marker binds the section to its source, it does not turn navigation
  // into a claim. Excluding marked headings re-introduced the
  // held-then-appended-at-tail disorder for them (production follow-up).
  t = t.replace(/\[\d+\]/g, '').trim();
  if (!t) return false;
  // Per-source labels are checked before the colon arms: their payload is
  // empty (or only bold markers), so the colon arms below see '**' as the
  // rest and reject the line.
  if (isSourceLabelHeading(t)) return true;
  if (/[：:]/.test(t)) {
    const idx = t.search(/[：:]/);
    const head = t.slice(0, idx);
    const rest = t.slice(idx + 1);
    const rawRest = raw.slice(raw.search(/[：:]/) + 1);
    // Arm A — section-ordinal heading with a nominal colon payload:
    //   "**一、现行有效版本：V2《企业考勤制度手册V2.docx》（现行有效）**",
    //   "**三、生态开放：第三方产品接入路径**".
    // The payload names the section's subject — a document title (《》) or a
    // short digit-free path phrase. A payload carrying a citation marker or
    // ending as a sentence is a claim and stays gated.
    if (
      /^\*\*?\s*[一二三四五六七八九十\d]+\s*[、.．]/.test(head)
      && t.length <= 64
      && !/\[\d+\]/.test(rawRest)
      && !/[。．.!！?？;；]$/.test(rest)
      && (rest.includes('《') || (rest.length <= 20 && !/\d/.test(rest)))
    ) {
      return true;
    }
    // Arm B — discourse lead-in ending at the colon ("两版规定存在差异，
    // 分别陈述如下:", a bullet label introducing nested items "- **作息安排
    // 分令时执行**:"): the payload after the colon is empty, so the line
    // navigates the block that follows and must stay in place.
    return rest.replace(/\s/g, '').length <= 4
      && t.length <= 40
      && head.length >= 6
      && !/\d/.test(t);
  }
  if (t.length > 40) return false;
  if (/[。．.!！?？;；]$/.test(t)) return false;
  if (isPlainTextHeading(t)) return true;
  return /^\*\*?\s*[一二三四五六七八九十\d]+\s*[、.．]/.test(t)
    || /^#{1,6}\s+\S/.test(t)
    || /^\*\*[^*]{2,40}\*\*$/.test(t)
    || /^[（(【\[]?\s*[一二三四五六七八九十\d]+\s*[)）】\]]?\s*[\u4e00-\u9fffA-Za-z]{0,28}$/.test(t);
}

/**
 * Per-source label used to introduce a document's section in a multi-source
 * answer: "**来源 1《软件研发中心绩效管理办法.doc》（第 1-5 页）：**",
 * "来源 2《…》", "**Source 2 — …**".
 *
 * These lines name the document the section below them is about and carry no
 * claim of their own, but they routinely end in a full stop ("…》**。") and
 * therefore failed the terminal-punctuation rule, fell to the grounding gate,
 * were held for lacking evidence and dropped — leaving the section with no
 * header, or a bare header with nothing under it (production).
 *
 * Shape: a source word, a number, a 《document title》 or the rest of a short
 * phrase, optionally a page range, then a colon or a full stop. Any real
 * sentence has content after the title, which this pattern does not allow.
 */
export function isSourceLabelHeading(t: string): boolean {
  if (t.length > 80) return false;
  // The number may be followed by a colon, a full stop, or an em/en dash and
  // spaces ('Source 2 — Employee Handbook.pdf'), all of which introduce the
  // document name.
  const label = /^\**\s*(?:来源|引用|參考來源|来源文件|Source|Reference|Ref)\s*[:：]?\s*(\d{1,2})\s*(?:[:：.、]|[—–-]+\s*)?\s*/i.exec(t);
  if (!label) return false;
  // Peel the tail in one loop: bold markers, terminal punctuation, and
  // page/anchor parentheticals can alternate ("**《T》（第 5-11 页）：**"),
  // so a fixed sequence of replacements leaves fragments behind.
  let body = t.slice(label[0].length).trim().replace(/^[—–-]+\s*/, '');
  for (let guard = 0; guard < 8; guard++) {
    const before = body;
    body = body
      // Order matters: the anchor parenthetical sits BEFORE the colon, so it
      // has to go while the text still ends in "）", not after the colon has
      // been stripped off.
      .replace(/^\*+\s*/, '')
      .replace(/\*+\s*$/, '')
      // Anchor parenthetical: a short bracketed tail holding only digits,
      // ranges, page/latin markers and separators ('（第 5-11 页）', '(p.5)',
      // '[第 5-11 页]'). Anything longer stays as part of the title.
      .replace(/[（(【\[][^（()【】\[\]]{0,24}[)）】\]]\s*$/, (m) =>
        /[0-9０-９]|[a-zA-Z]/.test(m) && !/[。．.!?！？]/.test(m.replace(/[0-9\-–~至页pP\.\s第版修订a-zA-Z]/g, '')) ? '' : m,
      )
      .replace(/[。．.!！?？;；:：]\s*$/, '')
      .trim();
    if (body === before) break;
  }
  if (!body) return false;
  // 《…》 names the document outright. Punctuation is checked only OUTSIDE the
  // book-title marks: '．' is a character of '《》' itself.
  if (body.includes('《') && body.includes('》')) {
    return !/[。．.!！?？;；，,]/.test(body.replace(/《[^》]*》/g, ''));
  }
  if (body.length > 40) return false;
  // A document name ends in an extension: treat the whole body as the name and
  // skip the sentence-punctuation test, whose '.' would otherwise match the
  // dot in "Handbook.pdf" or "手册V2.docx".
  if (/\.[a-z0-9]{1,5}$/i.test(body)) return true;
  if (/[。．.!！?？;；，,]/.test(body)) return false;
  // Otherwise accept only a short nominal phrase. A sentence that merely
  // mentions 来源 1 ("来源 1 规定员工迟到…") carries a predicate and stays gated.
  const sentenceWord = /(?:规定|说明|要求|处理|指|认为|显示|表示|为|是|由|从|在|含|包括)|[a-z]\s+(?:says|states|requires|provides|specifies)/i;
  return !sentenceWord.test(body);
}

/** Section-type tails: a heading ends by naming the section, not by stating a rule. */
const HEADING_TAIL = /(?:处理|方式|流程|标准|规定|说明|依据|界定|认定|渠道|条件|范围|要求|职责|步骤|环节|情形|问题|解答|清单|目录|要点|总结|结论|附录|注意|建议|方案|措施|办法|机制|原则|目标|背景|概述|适用|对象|期限|时点|节点|口径|误区|案例|示例|对比|差异|影响|风险|保障|资源|成本|效益|模板|总则|细则|附则|正文|引言|前言|序言|答疑|问答|结语|声明)$/;
/** Limit wording: turns an ordinal line into a rule statement, not a heading. */
const HEADING_RULE_LIMIT = /(?:以上|以下|以内|超过|不足|不满|未满|达到|视为|每次|每月|每日|累计|不予|不得)/;
/** Predicates that state what happens to someone: a claim, never a heading. */
const HEADING_PREDICATE = /(?:扣|罚|补|奖|停|辞|退|缴|报|批|审|签|归档|提交|申请|登记|核算|计算|折算|执行|需要|应当|必须|可以|禁止|允许)/;

/**
 * Plain-text section heading (no bold, no '#').
 *
 * Models routinely emit "一、考勤迟到处理流程" or "2. 处理方式" with no markup. The
 * previous matcher required the line to be a *single* short phrase, so a heading
 * whose subject is more than one token ("一、迟到一小时的处理") fell through to the
 * grounding gate, was held for lacking evidence, and — since headings are
 * navigation rather than claims — was recovered at the END of the answer. That is
 * the reported "标题跑到最后" misplacement.
 *
 * The discriminator is what the line *is*: a heading names a section, a claim
 * states a rule. A rule shows up as limit wording ("一、迟到一小时以上…"), a
 * predicate applied to a person ("一、迟到者扣除…") or a quantity; a heading ends
 * on a section-type noun. Single-token headings ("一、总则") are allowed because
 * the ordinal plus short nominal phrase cannot carry a rule.
 */
export function isPlainTextHeading(t: string): boolean {
  const matched = /^[（(【\[]?\s*[一二三四五六七八九十百千零两\d]{1,3}\s*[、.．)）】\]]\s*(.*)$/.exec(t);
  if (!matched) return false;
  const rest = String(matched[1] || '').trim();
  if (rest.length < 2 || rest.length > 40) return false;
  // Punctuation ends a sentence; a colon introduces a payload and belongs to the
  // colon arms above, which already decided this line is not a heading.
  if (/[。．.!！?？;；:：]$/.test(rest) || /[：:]/.test(t)) return false;
  if (HEADING_TAIL.test(rest) && !HEADING_RULE_LIMIT.test(rest)) return true;
  if (HEADING_RULE_LIMIT.test(rest)) return false;
  if (HEADING_PREDICATE.test(rest)) return false;
  // A heading's only number is its own ordinal.
  if (/[0-9０-９]/.test(rest)) return false;
  return true;
}

/**
 * Markdown table line (a row or a separator). Separate from heading
 * recognition: table lines stream through in order to preserve the table
 * (splitting a header/separator from its body wrecks rendering), but numeric
 * grounding still applies per row in gateSentence — a fabricated number must
 * not ride the table's structure through.
 */
export function isTableSyntaxLine(sentence: string): boolean {
  const t = String(sentence || '').trim();
  if (!t) return false;
  if (/^[-:|\s]+$/.test(t) && t.includes('-')) return true;
  return t.startsWith('|') && t.length <= 600;
}

/**
 * Block-level answer element that deserves its own line: heading, table line,
 * or list item. Used by the streaming gate to normalise layout — insert a
 * newline before it when the streamed answer does not end with one — because
 * models routinely run them together with the preceding prose
 * ("…另行规定[2]。**二、旧版…**", "1. …[2]。2. …[2]。").
 */
export function isBlockLevelStart(sentence: string): boolean {
  if (isStructuralHeadingLine(sentence) || isTableSyntaxLine(sentence)) return true;
  return /^\s*(?:\d{1,2}\s*[.、)]\s|\*\*\s*\d{1,2}\s*[.、)]|[-*•]\s)/.test(String(sentence || ''));
}

/** Enumerative discourse label at the start of a line ("其一：", "其次，", "最后。"). */
export function isEnumerativeLabelLine(line: string): boolean {
  const t = String(line || '').trim().replace(/^\*+\s*/, '').replace(/\s*\*+$/, '');
  if (!t || t.length > 60) return false;
  return /^(?:其[一二三四五六七八九十]+|首先|其次|再次|最后|另外|此外)\s*[：:，,、.．]/.test(t);
}

/**
 * A line that must open a new block.
 *
 * Extends isBlockLevelStart with the label shapes models use for multi-source
 * answers but that are NOT headings on their own: a bold label carrying its
 * payload on the same line ("**来源《…》**：…"), a per-source label without a
 * number, and enumerative discourse labels ("其一：…"). Layout-only: it never
 * changes how the line is grounded or classified.
 */
export function isAnswerBlockStart(line: string): boolean {
  const t = String(line || '').trim();
  if (!t) return false;
  if (isBlockLevelStart(t)) return true;
  // A line-leading bold span that ends the line or is followed (optionally
  // after a parenthetical qualifier, which may itself carry a citation marker)
  // by a colon opens a block: "**来源《…》**：…",
  // "**《…》口径**（适用范围 [1]）：…", "**其二**：…".
  // A bold run followed directly by prose ("**重要**内容…") stays emphasis.
  if (/^\*\*[^*\n]{1,80}\*\*\s*(?:[（(【\[][^（()【】]{0,120}[)）】\]]\s*)?(?:[：:]|$)/.test(t)) return true;
  if (/^(?:来源|引用|参考来源|来源文件|Source|Reference|Ref)\s*[:：]?\s*\d{0,2}\s*(?:[《:：]|[—–-])/.test(t)) return true;
  return isEnumerativeLabelLine(t);
}

/** A list item line (bullet or ordered), including nested indentation. */
function isListItemLine(line: string): boolean {
  return /^\s*(?:[-*+•]\s|\d{1,2}\s*[.、)]\s)/.test(String(line || ''));
}

/**
 * A line that is only brackets/punctuation with no letter, digit or Han
 * character — residue from a clause the grounding gate held and dropped (a lone
 * "）" left after a partially removed parenthetical). Markdown structure
 * characters (-, |, #, *, >, `, ~, =, _) are excluded so rules, tables and
 * fences survive.
 */
function isMarkupResidueLine(line: string): boolean {
  const t = String(line || '').trim();
  if (!t || t.length > 4) return false;
  if (/[-|#*>`~_=]/.test(t)) return false;
  return /^[（）()【】\[\]「」『』、，。；：,.!?！？;:…·]+$/.test(t);
}

/**
 * Split a bold block label that the model glued to the end of the preceding
 * sentence ("…[2]；**二、《…》口径（…）**") into its own line, so the normalizer
 * can give it a block boundary. Only a label that ends the line or is followed
 * (optionally after a parenthetical qualifier) by a colon is split; bold
 * emphasis followed by prose is left inline.
 */
function splitInlineBlockLabels(line: string): string[] {
  const boundary = /([。！？；.!?;]|\[\d+\])\s*(?=\*\*[^*\n]{1,80}\*\*\s*(?:[（(【\[][^（()【】]{0,120}[)）】\]]\s*)?(?:[：:]|$))/g;
  const segments: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(line))) {
    const end = match.index + match[1].length;
    segments.push(line.slice(last, end));
    segments.push('');
    last = end;
    while (last < line.length && /\s/.test(line[last])) last += 1;
  }
  segments.push(line.slice(last));
  return segments;
}

/**
 * Bold is reserved for a standalone label line. The model also uses bold for
 * inline emphasis, which renders inconsistently (some bold becomes a block,
 * some stays inline). Strip bold from every non-label run so the only bold in
 * an answer is a label; the block pass below then gives each label its own
 * line. A label is a leading bold span (after any list marker) that ends the
 * line or is followed — optionally after a parenthetical qualifier — by a
 * colon.
 */
function normalizeBoldMarkers(line: string): string {
  const first = /\*\*[^*\n]+\*\*/.exec(line);
  if (!first) return line;
  const before = line.slice(0, first.index);
  const leading = /^\s*(?:[-*+•]\s+|\d{1,2}\s*[.、)]\s+)?$/.test(before);
  const afterSpan = line.slice(first.index + first[0].length);
  const labelTail = /^\s*(?:[（(【\[][^（()【】]{0,120}[)）】\]]\s*)?(?:[：:]|$)/.test(afterSpan);
  if (!leading || !labelTail) return line.replace(/\*\*/g, '');
  // Keep the leading label; strip any later inline bold.
  return line.slice(0, first.index + first[0].length) + afterSpan.replace(/\*\*/g, '');
}

/**
 * Guarantee one blank line before every block-level element.
 *
 * The web renderer lexes with `breaks: true`, so a single newline is a hard
 * break *inside the same paragraph*: two sections separated by "\n" render
 * glued together with no paragraph spacing — the reported multi-source layout
 * defect ("**来源 2…**" not parallel to "**来源 1…**"). Blocks must be separated
 * by a blank line.
 *
 * Pure layout pass: it only inserts/collapses blank lines, normalizes bold
 * (label-only), splits a glued block label, and drops markup residue — never
 * edits prose, never touches lines inside a code fence, and never splits a
 * list or table (consecutive list items / table rows keep no blank between
 * them).
 */
/**
 * Canonicalize source labels to one bold form.
 *
 * The model emits the same label both ways — "**来源 1《…》**" and
 * "来源2《…》（…）" — which renders inconsistently (one bold, one plain). A
 * source label is always a bold block label, so wrap every non-bold label in
 * `**…**`. A label is a leading source word + number + 《title》 + an optional
 * parenthetical (which may span lines), followed by a colon or the line end.
 * Already-bold labels are untouched; a sentence that merely starts with a
 * source word ("来源2《…》规定…") has trailing prose and is not matched.
 */
export function boldSourceLabels(text: string): string {
  const re = /(^|\n)([ \t]*(?:[-*+•][ \t]+)?)((?:来源|Source|引用|参考来源|来源文件|Ref)[ \t]*[:：]?[ \t]*\[?\d{1,2}\]?[ \t]*(?:《[^》\n]*》[ \t]*)?(?:[（(【\[][^（()）【】\[\]\n]*(?:\n[^（()）【】\[\]\n]*)*?[)）】\]][ \t]*)?)(?=[：:]|\n|$)/g;
  return String(text || '').replace(re, (_match, lead: string, indent: string, label: string) => `${lead}${indent}**${label.trim()}**`);
}

export function normalizeAnswerLayout(text: string): string {
  const lines = boldSourceLabels(String(text || '')).split('\n');
  const out: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const rawLine of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(rawLine);
    if (!fence && match) {
      if (out.length && out[out.length - 1].trim()) out.push('');
      out.push(rawLine);
      fence = { marker: match[1][0], length: match[1].length };
      continue;
    }
    if (fence) {
      out.push(rawLine);
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
      continue;
    }
    for (const segment of splitInlineBlockLabels(rawLine)) {
      const line = normalizeBoldMarkers(segment);
      if (isMarkupResidueLine(line)) continue;
      if (line.trim() && isAnswerBlockStart(line) && out.length && out[out.length - 1].trim()) {
        const prev = out[out.length - 1];
        const sameContinuation =
          (isListItemLine(prev) && isListItemLine(line)) ||
          (isTableSyntaxLine(prev) && isTableSyntaxLine(line));
        if (!sameContinuation) out.push('');
      }
      out.push(line);
    }
  }
  const collapsed: string[] = [];
  for (const line of out) {
    if (!line.trim() && collapsed.length && !collapsed[collapsed.length - 1].trim()) continue;
    collapsed.push(line);
  }
  return collapsed.join('\n');
}

/**
 * Split a heading off the front of a string that merged it with the sentence
 * that follows.
 *
 * The gate finds sentence boundaries by scanning for sentence punctuation, but a
 * heading ("**来源 1《…》**（第 5-11 页）") contains none. When the model omits the
 * newline before the heading, the scan runs past it into its own first sentence
 * and both arrive as one string, which no longer classifies as a heading — so
 * the gates treat navigation as an unsupported claim and drop it, leaving the
 * section with no header.
 *
 * Only a leading heading is separated, and only when the head really does
 * classify as one, so ordinary prose (including text containing "V3.0") is left
 * untouched.
 */
export function splitLeadingHeading(input: string): { heading: string; rest: string } | null {
  // Only strong markers open a heading. A digit ordinal ("2. …") is excluded on
  // purpose: it also matches the "3.0" of a version string, and cutting there
  // would shred ordinary prose into two fragments that each stop being a
  // sentence.
  const OPENERS = /\*\*|__|#{1,6}\s(?=[^#])|[一二三四五六七八九十]+[、.．]/g;
  const markers = [...input.matchAll(OPENERS)]
    .map((match) => ({ index: match.index ?? -1, length: match[0].length }))
    .filter((marker) => marker.index > 0);
  const starts = markers.map((marker) => marker.index);
  // Walk the strong markers in order and try the cut immediately AFTER each one
  // (plus any punctuation/parenthetical tail that belongs to the heading). A
  // heading's own closing "**" is itself a candidate, which is what lets
  // "**来源 1《…》**（第 5-11 页）该手册…" split at the parenthesis rather than at
  // the first marker.
  for (let i = 0; i < markers.length; i++) {
    const afterMarker = markers[i].index + markers[i].length;
    // Extend over a trailing parenthetical: （集团总部知识库）/（第 5-11 页）.
    // No length cap: a knowledge-base parenthetical can name two libraries and
    // run well past 24 chars, and capping it split the heading from its own
    // qualifier, leaving the qualifier to be gated as a claim.
    const anchor = /^\s*[（(【\[][^（()【】\[\]]{0,120}[)）】\]]/.exec(input.slice(afterMarker));
    const cut = anchor ? afterMarker + anchor[0].length : afterMarker;
    if (cut <= 0 || cut >= input.length) continue;
    const head = input.slice(0, cut).trim();
    if (!head || head.length > 120) continue;
    // The head must be a complete heading: balanced bold, and classified as a
    // heading on its own. Anything else was prose that merely contains a "**".
    if ((head.match(/\*\*/g) || []).length % 2 !== 0) continue;
    if (!isStructuralHeadingLine(head)) continue;
    // A heading stands alone. When the same clause merely continues on the same
    // line, the bold run was emphasis inside a sentence — "…视为旷工**半日**；
    // **超过2小时**的，视为旷工**1日**" — and tearing it off both orphaned the
    // clause it belonged to and split the sentence across a line break
    // (production: the answer broke right after "超过2小时"). Require the tail
    // to open a new block: end of text, a line break, or a bullet/heading.
    //
    // An anchor parenthetical is the exception: "**来源 1《…》**（集团总部知识库）该手册…"
    // is a heading whose document and library qualifiers are followed by its
    // own prose on the same line, and the qualifier is what identifies it as
    // one — without that the whole line reads as a claim. The qualifier may sit
    // just after the closing marker or just inside it, so accept either.
    const rest = input.slice(cut);
    const anchored = Boolean(anchor) || /[（(【\[][^（()【】\[\]]{0,120}[)）】\]]\s*\*\*$/.test(head);
    if (rest.trim() && !/^\s*(?:\n|[-*•]\s|\d{1,2}\s*[.、)]|#{1,6}\s)/.test(rest) && !anchored) continue;
    return { heading: head, rest };
  }
  return null;
}
