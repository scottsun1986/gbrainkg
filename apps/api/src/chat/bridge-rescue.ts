/**
 * Second-hop rescue for multi-hop answers.
 *
 * Measured failure (HotpotQA, 2026-09-20, `In what state is the manufacturer of
 * Bisquick headquartered?`): the candidate pool already contained the document
 * that holds the answer — *General Mills*, "It is headquartered in Golden
 * Valley, Minnesota" — at pool rank 4, but its cross-encoder score was 0.063
 * against the question while the hop-1 document (Bisquick) scored 0.802. The
 * relevance floor therefore pruned it, the answer context kept only hop-1
 * evidence, and the model honestly answered "the reference materials do not
 * specify the state".
 *
 * The same shape repeats across the whole "evidence retrieved but answer wrong"
 * bucket (18/100 on HotpotQA, 27/100 on MuSiQue): hop-1 entity found, hop-2
 * document dropped by a score computed against the *full* question.
 *
 * The rule below is corpus-agnostic — it recognises an entity by (a) being a
 * capitalised multi-word span in the already-selected evidence, (b) having its
 * own document in the candidate pool, and (c) not appearing in the question
 * itself (if it were in the question it is hop-1, not a bridge). No business
 * vocabulary, no synonym lists, no per-domain patterns.
 */

/** Title comparison key: case/extension/whitespace-insensitive. */
export function normalizeTitleForMatch(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.(docx?|pdf|xlsx?|pptx?|txt|md|csv|html?)$/, '')
    .replace(/[\s\-_·．。()（）\[\]【】]+/g, '');
}

/**
 * Capitalised multi-word candidates in a passage (2-4 tokens), stopping-word filtered.
 * Deliberately *not* a relation pattern: precision comes from checking each
 * candidate against the candidate pool (does a document with this title exist?),
 * not from guessing which names matter.
 */
export function extractCapitalisedCandidates(text: string, limit = 8): string[] {
  const stop = new Set(['The', 'A', 'An', 'In', 'On', 'At', 'Of', 'And', 'Or', 'For', 'With', 'By', 'Is', 'Was', 'Were', 'Are', 'It', 'He', 'She', 'They', 'This', 'That', 'As', 'From', 'To', 'His', 'Her', 'Their', 'Its', 'Who', 'Which', 'When', 'Where', 'How']);
  // Unicode-aware, and *without* a trailing \b: with ASCII \w, "Andrei Ujică"
  // matched as "Andrei Ujic" (the engine backtracked so that the boundary fell
  // before "ă"), and "Nicolae Ceaușescu" as "Nicolae Ceau". Multi-hop questions
  // about non-English names therefore probed for a *wrong* entity and never
  // fetched the page that holds the answer (measured: "Where was the director of
  // The Autobiography of Nicolae Ceaușescu born?" — the corpus has
  // "Andrei Ujică … born 1951 in Timişoara" but the bridge hop searched
  // "Andrei Ujic").
  // `{1,6}` (was `{1,3}`) + the trailing lookahead: a five-token name such as
  // "Axel Julius De la Gardie" was previously cut to "Axel Julius De la", so the
  // corpus lookup for the bridge entity failed and the hop never ran. The second
  // lookahead keeps the match from stopping just before another capitalised word.
  const re =
    /(\p{Lu}[\p{L}\p{M}'\u2019-]*(?:\s+(?:of|the|de|la|van|von|al)?\s*\p{Lu}[\p{L}\p{M}'\u2019-]*){1,6})(?![\p{L}\p{M}])(?!\s+(?:of|the|de|la|van|von|al)?\s*\p{Lu})/gu;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(text || ''))) !== null && out.length < limit) {
    const candidate = match[1]
      .split(/\s+/)
      .filter((token) => !stop.has(token))
      .join(' ')
      .replace(/[.,;:!?"'“”„…]+$/, '')
      .trim();
    if (candidate.length >= 4 && candidate.length <= 60 && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

export interface BridgeRescueInput {
  /** Already-selected (hop-1) evidence texts, highest ranked first. */
  selectedTexts: string[];
  /** The pool the selection picked from — rescue can only return documents from here. */
  pool: Array<{ title?: string | null; text?: string | null; score?: number | null }>;
  question: string;
  maxRescue?: number;
}

export interface BridgeRescuePlan {
  /** Indices into `pool` that should be appended to the answer context. */
  indices: number[];
  /** The entity names that justified each rescue (for traces / debugging). */
  names: string[];
  /** Question aspects that no selected evidence covers (why a rescue was needed). */
  missingAspects: string[];
}

/** Stopwords for question-aspect extraction (generic, language-agnostic in spirit). */
const ASPECT_STOPWORDS = new Set([
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'the', 'a', 'an',
  'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'that', 'this',
  'is', 'was', 'were', 'are', 'be', 'been', 'did', 'do', 'does', 'has', 'have', 'had',
  'his', 'her', 'their', 'its', 'it', 'he', 'she', 'they', 'both', 'named', 'called',
  // Vague nouns carry no answer dimension: without them "what kind of magazines?"
  // would count "kind" as a missing aspect forever.
  'kind', 'kinds', 'type', 'types', 'sort', 'sorts', 'name', 'names', 'way', 'ways',
  'thing', 'things', 'someone', 'anyone', 'something',
]);

/**
 * Content aspects of a question: Latin words (≥4 chars) plus CJK bigrams.
 * Used only to decide whether the selected evidence is missing a dimension of
 * the question — i.e. whether a bridge document is worth adding at all.
 */
export function questionAspects(question: string): string[] {
  const text = String(question || '').toLowerCase();
  const aspects = new Set<string>();
  for (const word of text.match(/[a-z][a-z'-]{3,}/g) || []) {
    if (!ASPECT_STOPWORDS.has(word)) aspects.add(word);
  }
  const cjk = (String(question || '').match(/[\u4e00-\u9fa5]+/g) || []).join('');
  for (let i = 0; i + 2 <= cjk.length; i += 1) aspects.add(cjk.slice(i, i + 2));
  return Array.from(aspects);
}

/**
 * Whether a text mentions an aspect. Plural/singular is the one morphological
 * difference that shows up constantly in questions ("what kind of magazines?"
 * vs an evidence sentence saying "magazine"), and treating it as a missing
 * aspect made the rescue fire on questions that were already answerable.
 */
function mentionsAspect(text: string, aspect: string): boolean {
  const lower = String(text || '').toLowerCase();
  if (lower.includes(aspect)) return true;
  if (aspect.endsWith('s') && aspect.length > 4 && lower.includes(aspect.slice(0, -1))) return true;
  return false;
}

/**
 * Decide which pooled documents to add back as bridge evidence.
 *
 * Guardrails (each one exists because of an observed false positive):
 *  - the name must be multi-word (single capitalised tokens are usually ordinary
 *    sentence starts or the subject itself);
 *  - the name must not appear in the question (that is hop-1, already in context);
 *  - a document title must match the name *exactly* after normalisation, which is
 *    what separates "the evidence names X and a document titled X exists" from a
 *    regex hit on prose;
 *  - at most `maxRescue` documents are added, in the order the names appear.
 */
export function planSecondHopRescue(input: BridgeRescueInput): BridgeRescuePlan {
  const maxRescue = Math.max(0, input.maxRescue ?? 2);
  const plan: BridgeRescuePlan = { indices: [], names: [], missingAspects: [] };
  if (!maxRescue || !input.selectedTexts.length || !input.pool.length) return plan;

  const byTitle = new Map<string, number>();
  input.pool.forEach((citation, index) => {
    const key = normalizeTitleForMatch(String(citation?.title || ''));
    if (!key) return;
    const existing = byTitle.get(key);
    if (existing === undefined || scoreOf(input.pool[existing]) < scoreOf(citation)) {
      byTitle.set(key, index);
    }
  });

  const questionLower = String(input.question || '').toLowerCase();
  const selectedLower = input.selectedTexts.join('\n').toLowerCase();
  const evidenceText = input.selectedTexts.join('\n');

  // Aspect gate: the selected (hop-1) evidence must be *missing* a dimension of
  // the question, and the rescued document must cover it. Without this gate the
  // rescue fires on questions whose answer is already in context, adding a
  // document that only perturbs the model's phrasing — measured on HotpotQA as
  // a 3-fixed/7-broken wash, where most "broken" cases were the same correct
  // answer re-worded (e.g. the contiguous gold span split across two clauses).
  const missingAspects = questionAspects(input.question).filter(
    (aspect) => !mentionsAspect(selectedLower, aspect),
  );
  plan.missingAspects = missingAspects;
  if (!missingAspects.length) return plan;

  for (const name of extractCapitalisedCandidates(evidenceText, 8)) {
    if (plan.indices.length >= maxRescue) break;
    if (!/\s/.test(name) || name.length < 6) continue;
    if (questionLower.includes(name.toLowerCase())) continue;
    // The bridge entity must come from the *hop-1* text, not from a stray mention.
    if (!selectedLower.includes(name.toLowerCase())) continue;
    const index = byTitle.get(normalizeTitleForMatch(name));
    if (index === undefined || plan.indices.includes(index)) continue;
    const candidateText = String(input.pool[index]?.text || '').toLowerCase();
    if (!candidateText) continue;
    // Being *named* by the hop-1 evidence is already strong justification: the
    // document is the entity the question's next hop is about. Requiring the
    // passage to literally contain the question's aspect word rejected real
    // bridges — "Who is Magnus Julius De La Gardie's paternal grandmother?" names
    // "Axel Julius De la Gardie" (his father), whose page answers with
    // "son of … and Ebba Brahe" and never says "grandmother".
    const namedByEvidence = selectedLower.includes(name.toLowerCase());
    if (!namedByEvidence && !missingAspects.some((aspect) => mentionsAspect(candidateText, aspect))) {
      continue;
    }
    plan.indices.push(index);
    plan.names.push(name);
  }
  return plan;
}

function scoreOf(citation: any): number {
  const value = Number(citation?.score ?? citation?.rerankScore ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export interface DocumentCompletionInput {
  /** Currently selected citations, best first. */
  selected: Array<{ docId?: string | null; title?: string | null }>;
  /** The pre-selection pool (candidates that were available). */
  pool: Array<{ docId?: string | null; title?: string | null; score?: number | null }>;
  /** How many of the leading documents are worth completing (default 3). */
  maxDocs?: number;
  /** Extra chunks per document (default 1). */
  maxPerDoc?: number;
  /** Document key extractor; defaults to docId then normalised title. */
  keyOf?: (citation: any) => string;
}

export interface DocumentCompletionPlan {
  indices: number[];
  docs: string[];
}

/**
 * Passage-level completeness for the documents that already won selection.
 *
 * Measured failure (MuSiQue / 2Wiki / HotpotQA, 2026-09-21): the gold *page* is
 * in the answer context and the model even cites it, yet the answer says "the
 * reference materials do not mention it" — because the selected chunk of that
 * page is a different section than the one holding the fact. The retrieval
 * detail shows full evidence at page level (all gold titles inside top-10),
 * while the context-preview log shows the gold passage is absent.
 *
 * So: for the leading documents that selection already trusted, add their
 * next-best chunk from the pool. This never introduces a new document, so it
 * cannot dilute relevance ranking — it only widens coverage *within* the pages
 * the system has already decided are the answer's sources.
 */
export function planDocumentCompleteness(input: DocumentCompletionInput): DocumentCompletionPlan {
  const maxDocs = Math.max(0, input.maxDocs ?? 3);
  const maxPerDoc = Math.max(0, input.maxPerDoc ?? 1);
  const plan: DocumentCompletionPlan = { indices: [], docs: [] };
  if (!maxDocs || !maxPerDoc || !input.selected.length || !input.pool.length) return plan;

  const keyOf = input.keyOf ?? ((citation: any) => {
    const id = citation?.docId;
    if (id) return `id:${id}`;
    const title = normalizeTitleForMatch(String(citation?.title || ''));
    return title ? `title:${title}` : '';
  });

  const seen = new Set(input.selected.map(keyOf).filter(Boolean));
  const alreadySelected = new Set(
    input.selected.map((c: any) =>
      String(c?.evidence || c?.snippet || c?.text || c?.context || '').replace(/\s+/g, '').slice(0, 30),
    ),
  );
  const byDoc = new Map<string, number[]>();
  input.pool.forEach((citation, index) => {
    const key = keyOf(citation);
    if (!key || !seen.has(key)) return;
    const list = byDoc.get(key) || [];
    list.push(index);
    byDoc.set(key, list);
  });

  const targets: string[] = [];
  for (const citation of input.selected) {
    const key = keyOf(citation);
    if (!key || targets.includes(key)) continue;
    targets.push(key);
    if (targets.length >= maxDocs) break;
  }

  for (const key of targets) {
    const candidates = (byDoc.get(key) || [])
      .slice()
      .sort((a, b) => scoreOf(input.pool[b]) - scoreOf(input.pool[a]));
    let added = 0;
    for (const index of candidates) {
      if (added >= maxPerDoc) break;
      const citation: any = input.pool[index];
      const evidenceKey = String(citation?.evidence || citation?.snippet || citation?.text || citation?.context || '')
        .replace(/\s+/g, '')
        .slice(0, 30);
      if (!evidenceKey || alreadySelected.has(evidenceKey)) continue;
      alreadySelected.add(evidenceKey);
      plan.indices.push(index);
      added += 1;
    }
    if (added) plan.docs.push(key);
  }
  return plan;
}

export interface AspectPassageInput {
  /** Currently selected citations, best first. */
  selected: Array<{ docId?: string | null; title?: string | null; evidence?: string | null; snippet?: string | null; context?: string | null }>;
  /** The pre-selection pool. */
  pool: Array<{ docId?: string | null; title?: string | null; evidence?: string | null; snippet?: string | null; context?: string | null; score?: number | null }>;
  question: string;
  /** How many leading documents may contribute a passage (default 4). */
  maxDocs?: number;
  /** Total additions allowed (default 2). */
  maxAdditions?: number;
  keyOf?: (citation: any) => string;
}

export interface AspectPassagePlan {
  indices: number[];
  aspects: string[];
  docs: string[];
}

const textOf = (citation: any): string =>
  String(citation?.evidence || citation?.snippet || citation?.context || citation?.text || '');

/**
 * Locate the *passage* that answers a question inside documents that are
 * already selected.
 *
 * Why this is not the rejected `planDocumentCompleteness`: that variant appended
 * each leading document's next-best chunk by *score*, which is another chunk the
 * cross-encoder already judged similar to the question — measured harmful
 * (HotpotQA 7/20 -> 2/20 on the targeted failure set). The gap it failed to
 * close is different in kind: the answering passage scores *low* against the
 * full question (it talks about the intermediate entity, not the question), so
 * "next best by score" never reaches it.
 *
 * Here the candidate is selected by *coverage of the question aspects that the
 * current context is missing* — the same signal the context-preview diagnosis
 * used to prove the passage was absent (e.g. a question about a sibling needs a
 * chunk containing "sister"/"sibling"; a question about a headquarters state
 * needs one containing "headquarters" or the state name). No new document can
 * enter the context: only chunks of documents selection already trusted.
 */
export function planAspectPassageRescue(input: AspectPassageInput): AspectPassagePlan {
  const maxDocs = Math.max(0, input.maxDocs ?? 4);
  const maxAdditions = Math.max(0, input.maxAdditions ?? 2);
  const plan: AspectPassagePlan = { indices: [], aspects: [], docs: [] };
  if (!maxDocs || !maxAdditions || !input.selected.length || !input.pool.length) return plan;

  const selectedText = input.selected.map(textOf).join('\n').toLowerCase();
  const missing = questionAspects(input.question).filter((a) => !mentionsAspect(selectedText, a));
  plan.aspects = missing;
  if (!missing.length) return plan;

  const keyOf = input.keyOf ?? ((citation: any) => {
    const id = citation?.docId;
    if (id) return `id:${id}`;
    const title = normalizeTitleForMatch(String(citation?.title || ''));
    return title ? `title:${title}` : '';
  });
  const already = new Set(
    input.selected.map((c: any) => String(textOf(c)).replace(/\s+/g, '').slice(0, 30)),
  );

  const docsInOrder: string[] = [];
  for (const citation of input.selected) {
    const key = keyOf(citation);
    if (!key || docsInOrder.includes(key)) continue;
    docsInOrder.push(key);
    if (docsInOrder.length >= maxDocs) break;
  }

  const byDoc = new Map<string, number[]>();
  input.pool.forEach((citation, index) => {
    const key = keyOf(citation);
    if (!key) return;
    const list = byDoc.get(key) || [];
    list.push(index);
    byDoc.set(key, list);
  });

  for (const key of docsInOrder) {
    if (plan.indices.length >= maxAdditions) break;
    const candidates = byDoc.get(key) || [];
    let bestIndex = -1;
    let bestCoverage = 0;
    for (const index of candidates) {
      const citation: any = input.pool[index];
      const evidenceKey = String(textOf(citation)).replace(/\s+/g, '').slice(0, 30);
      if (!evidenceKey || already.has(evidenceKey)) continue;
      const text = textOf(citation).toLowerCase();
      const coverage = missing.reduce((n, aspect) => (mentionsAspect(text, aspect) ? n + 1 : n), 0);
      if (coverage > bestCoverage) {
        bestCoverage = coverage;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      already.add(String(textOf(input.pool[bestIndex])).replace(/\s+/g, '').slice(0, 30));
      plan.indices.push(bestIndex);
      plan.docs.push(key);
    }
  }
  return plan;
}

/** Sentence splitter that keeps CJK full stops as boundaries too. */
function splitSentences(text: string): string[] {
  return String(text || '')
    .split(/(?<=[.!?。！？；;])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

/**
 * Sentences in the assembled context that actually speak to the question.
 *
 * Used when the model answered "the materials do not say" while the context in
 * fact contains a sentence covering the question's own content terms: measured
 * on 30 previously failed multi-hop questions, half of them (15/30) had the gold
 * text *inside the assembled context* and the model still refused. This helper
 * supplies the sentence back to the model in a focused second pass instead of
 * re-running the whole prompt.
 *
 * Scoring is corpus-agnostic: question content terms (Latin words ≥4 chars and
 * CJK bigrams, stop-words removed) matched against the sentence.
 */
export function selectSupportingSentences(
  evidenceTexts: string[],
  question: string,
  options: { limit?: number; minTerms?: number } = {},
): string[] {
  const limit = Math.max(1, options.limit ?? 3);
  const minTerms = Math.max(1, options.minTerms ?? 2);
  const aspects = questionAspects(question);
  if (!aspects.length) return [];

  const scored: Array<{ sentence: string; hits: number }> = [];
  for (const text of evidenceTexts) {
    for (const sentence of splitSentences(text)) {
      const lower = sentence.toLowerCase();
      const hits = aspects.reduce((n, aspect) => (mentionsAspect(lower, aspect) ? n + 1 : n), 0);
      if (hits >= minTerms) scored.push({ sentence, hits });
    }
  }
  return scored
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((item) => item.sentence);
}

export interface TopRankGuaranteeInput {
  /** Final selection, best first. */
  selected: Array<{ docId?: string | null; title?: string | null }>;
  /** Pre-selection candidate pool, in retrieval/rerank order. */
  pool: Array<{ docId?: string | null; title?: string | null; score?: number | null }>;
  /** How many leading documents (by score) must be represented (default 5). */
  topDocs?: number;
  keyOf?: (citation: any) => string;
}

export interface TopRankGuaranteePlan {
  indices: number[];
  docs: string[];
}

/**
 * Rank-based safety net: never let the answer context lose a leading document.
 *
 * Measured failure (2026-09-21): two multi-hop questions where the answering
 * chunk sat at **pool rank 4 of 50** in a *different* document than the top
 * hit — `…James Charles Mathew` (holds "buried in Cork") behind three chunks of
 * "Charles Mathew", and `Engelbert Dollfuss` (holds "failed coup") behind three
 * chunks of "Rome Protocols". The score-ratio floor pruned rank 4 as
 * "irrelevant" (a bridge chunk scores ~0.06 against the full question while the
 * hop-1 page scores ~0.8), so the context kept 3-6 sources from the top document
 * and the model correctly said the fact was not in the materials.
 *
 * The cross-encoder is scoring bridge evidence against the wrong question; the
 * retrieval ranking already knew those documents belonged in the top 5 of the
 * corpus. This plan only restores *distinct leading documents* — it never adds a
 * second passage of a document that is already represented, which is the
 * variant that measured harmful.
 *
 * Documents are taken in **score order, not pool order**. Measured reason: the
 * answer path merges probe candidates with scores near 0.000, so pool order can
 * be dominated by noise. On the Rome-Protocols case the pool was
 * `Rome Protocols .896 | Yehuda Avner .001 | Herb Gray .013 | Seaford .002 | … |
 * Engelbert Dollfuss .165` — the only document holding the answer sat at pool
 * position 7 while being the *second highest scoring* document. Ordering by pool
 * position restored four junk documents and left the answer out.
 */
export interface RetrySentenceSource {
  text: string;
  citation: any;
}

/** What kind of fact the question asks for. Pattern-based, corpus-agnostic. */
export type AnswerType = 'year' | 'date' | 'number' | 'place' | 'person' | 'unknown';

export function answerTypeOf(question: string): AnswerType {
  const text = String(question || '').toLowerCase();
  if (/(?:what|which|in what)\s+year\b|\byear\s+(?:was|did|were)\b|哪一年|哪年|什么年份/.test(text)) return 'year';
  if (/\bwhen\b|什么时候|哪一天|何年何月/.test(text)) return 'date';
  if (/how many|how much|多少|几个|几个星期|金额/.test(text)) return 'number';
  if (/\bwhere\b|哪里|在哪|何处/.test(text)) return 'place';
  if (/\bwho\b|谁/.test(text)) return 'person';
  return 'unknown';
}

const MONTH_RE = /(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)/i;

/** Does a sentence contain the *kind* of fact the question asks for? */
export function matchesAnswerType(sentence: string, type: AnswerType): boolean {
  const text = String(sentence || '');
  switch (type) {
    case 'year':
      return /\b(?:1[0-9]{3}|20[0-9]{2})\b/.test(text) || /\d{4}年/.test(text);
    case 'date':
      return (/\b(?:1[0-9]{3}|20[0-9]{2})\b/.test(text) && MONTH_RE.test(text)) || /\d{1,2}月\d{1,2}日/.test(text);
    case 'number':
      return /\d/.test(text);
    // Places and people are typed by entity recognition, which this layer does not
    // have; treating them as untyped keeps the selection honest instead of
    // pretending a regex knows a city from a surname.
    case 'place':
    case 'person':
    case 'unknown':
    default:
      return true;
  }
}

/**
 * Typed passage selection over a candidate pool.
 *
 * Measured failure that motivates it (2026-09-21, "Sadok Sassi played for a
 * national team that made its first World Cup in what year?"): the answering
 * sentence — "They have qualified for four FIFA World Cups, **the first one in
 * 1978**" — sat in the pool at rank 5, but the previous selector ranked sentences
 * purely by question-term coverage, so "The **Rugby League** World Cup … first
 * held in France in **1954**" (which shares *more* words with the question) won
 * the three offered slots and the answer was never available to the model.
 * Preferring sentences that carry the asked fact *type* fixes that ranking.
 */
export function selectTypedPassageSources(
  sources: RetrySentenceSource[],
  question: string,
  options: { limit?: number; minTerms?: number; answerType?: AnswerType; linkText?: string } = {},
): RetrySentenceSource[] {
  const limit = Math.max(1, options.limit ?? 4);
  const minTerms = Math.max(1, options.minTerms ?? 2);
  const type = options.answerType ?? answerTypeOf(question);
  const aspects = questionAspects(question);
  if (!aspects.length) return [];
  const linkLower = String(options.linkText || '').toLowerCase();
  // Tokenise the *raw* title: normaliseTitleForMatch strips spaces, which turned
  // "Tunisia national football team" into one token and defeated the linkage test.
  const linkTerms = (linkText: string): string[] =>
    (String(linkText || '').toLowerCase().match(/[a-z\u4e00-\u9fa5]{3,}/g) || []);

  const scored: Array<{ source: RetrySentenceSource; score: number }> = [];
  for (const source of sources) {
    // Document linkage: the passage must come from a document that is connected
    // to the question or to the already-selected hop-1 evidence.
    // Measured: without it the distractor "Olle Nordin … played at the 1978 FIFA
    // World Cup" (shares "national team"/"played"/"World Cup") outranked the real
    // bridge "Tunisia national football team … the first one in 1978".
    if (linkLower) {
      const title = String(source.citation?.docTitle || source.citation?.topic || '');
      const titleTerms = linkTerms(title);
      const linked = titleTerms.some((term) => linkLower.includes(term)) ||
        (title && linkLower.includes(normalizeTitleForMatch(title)));
      if (titleTerms.length && !linked) continue;
    }
    for (const sentence of splitSentences(source.text)) {
      const lower = sentence.toLowerCase();
      const hits = aspects.reduce((n, aspect) => (mentionsAspect(lower, aspect) ? n + 1 : n), 0);
      if (hits < minTerms) continue;
      const typed = matchesAnswerType(sentence, type);
      // A typed sentence outranks an untyped one even with fewer shared terms:
      // sharing words is cheap, carrying the asked fact is not.
      const score = (typed ? 2 : 0) + hits;
      scored.push({ source: { text: sentence, citation: source.citation }, score });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.source);
}

/**
 * Sentences worth offering back to the model when it refused.
 *
 * Sources may include pool documents that did *not* make it into the answer
 * context: measured (2026-09-21) that widening only this re-check recovers the
 * hard multi-hop cases that a wider *context* also recovered — but without the
 * side effect of a wider context (which made the model answer 6 of 30
 * unanswerable questions instead of refusing).
 */
export function selectRetrySentenceSources(
  sources: RetrySentenceSource[],
  question: string,
  options: { limit?: number; minTerms?: number } = {},
): RetrySentenceSource[] {
  const limit = Math.max(1, options.limit ?? 3);
  const minTerms = Math.max(1, options.minTerms ?? 2);
  const aspects = questionAspects(question);
  if (!aspects.length) return [];

  const scored: Array<{ source: RetrySentenceSource; hits: number }> = [];
  for (const source of sources) {
    for (const sentence of splitSentences(source.text)) {
      const lower = sentence.toLowerCase();
      const hits = aspects.reduce((n, aspect) => (mentionsAspect(lower, aspect) ? n + 1 : n), 0);
      if (hits >= minTerms) scored.push({ source: { text: sentence, citation: source.citation }, hits });
    }
  }
  return scored
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((item) => item.source);
}

/** 1-based indices of `【资料N】` / `资料N` markers the retry answer used. */
export function parseRetryMarkers(answer: string): number[] {
  const found = new Set<number>();
  for (const match of String(answer || '').matchAll(/【资料\s*(\d+)】|资料\s*(\d+)/g)) {
    const value = Number(match[1] || match[2]);
    if (Number.isInteger(value) && value >= 1) found.add(value);
  }
  return Array.from(found).sort((a, b) => a - b);
}

/**
 * Rewrite `【资料N】` markers into the `[k]` citation markers the rest of the
 * pipeline understands, using caller-supplied mapping (N -> k).
 */
export function rewriteRetryMarkers(answer: string, mapping: Map<number, number>): string {
  return String(answer || '').replace(/【资料\s*(\d+)】|资料\s*(\d+)/g, (whole, a, b) => {
    const value = Number(a || b);
    const mapped = mapping.get(value);
    return mapped ? `[${mapped}]` : whole;
  });
}

export function planTopRankGuarantee(input: TopRankGuaranteeInput): TopRankGuaranteePlan {
  const topDocs = Math.max(0, input.topDocs ?? 5);
  const plan: TopRankGuaranteePlan = { indices: [], docs: [] };
  if (!topDocs || !input.selected.length || !input.pool.length) return plan;

  const keyOf = input.keyOf ?? ((citation: any) => {
    const id = citation?.docId;
    if (id) return `id:${id}`;
    const title = normalizeTitleForMatch(String(citation?.title || ''));
    return title ? `title:${title}` : '';
  });
  const represented = new Set(input.selected.map(keyOf).filter(Boolean));

  const byScore = input.pool
    .map((citation, index) => ({ citation, index, score: scoreOf(citation) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // Union of the two orderings, because neither alone is reliable:
  //  * score order fails when one hop-1 document dominates (Sadok Sassi .898 vs
  //    everything else .027-.098) — the bridge page "Tunisia national football
  //    team" is 6th by score but 3rd in the pool, and was dropped;
  //  * pool order fails when probe candidates with ~0.000 scores are interleaved
  //    (Rome Protocols case: the answering page is 2nd by score, 7th by position).
  const leading: string[] = [];
  const addLeading = (citation: any) => {
    const key = keyOf(citation);
    if (!key || leading.includes(key)) return;
    leading.push(key);
  };
  for (const { citation } of byScore.slice(0, topDocs)) addLeading(citation);
  for (const citation of input.pool.slice(0, topDocs)) addLeading(citation);

  for (const key of leading) {
    if (represented.has(key)) continue;
    const index = byScore.find((item) => keyOf(item.citation) === key)?.index ?? -1;
    if (index < 0) continue;
    plan.indices.push(index);
    plan.docs.push(key);
    represented.add(key);
  }
  return plan;
}
