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
const HEADING_RULE_LIMIT = /(?:以上|以下|以内|超过|不足|不满|未满|达到|视为|每次|每月|每日|累计|扣发|扣除|扣款|罚款|不予|不得)/;
/** Predicates that state what happens to someone: a claim, never a heading. */
const HEADING_PREDICATE = /(?:扣|罚|补|奖|停|辞|退|缴|报|批|审|签|归档|提交|申请|登记|打卡|考勤|核算|计算|折算|执行|需要|应当|必须|可以|禁止|允许)/;

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
