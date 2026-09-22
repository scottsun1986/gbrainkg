/**
 * Corpus-agnostic lexical tokenizer used by the full-corpus BM25 channel.
 *
 * The tokenizer has no business vocabulary, synonym table or per-domain
 * branch: it only applies Unicode word segmentation plus script-aware
 * n-gram expansion, so the same code serves every knowledge base.
 *
 * Scripts handled:
 *  - Han / Kana / Hangul and other scripts written without spaces are cut into
 *    adjacent bigrams (standard CJK IR practice) so that partial words still
 *    match across morphological boundaries.
 *  - Space-delimited scripts (Latin, Cyrillic, ...) keep whole words.
 *  - Identifier-like tokens ("EQ-0077", "PRD_2026/9") are split at their
 *    separators into letter/digit parts, and long digit runs are emitted as
 *    their own terms, which is what keeps exact IDs retrievable.
 *
 * Terms are restricted to letters and digits on purpose: PostgreSQL's text
 * search parser treats those atomically, so the tsvector built at index time
 * and the tsquery built at request time always agree on the same term set.
 *
 * The very same function is used at index time and at query time; a term that
 * is not produced here can never reach the BM25 postings.
 */

export interface TokenizeOptions {
  /** Hard cap on the number of emitted tokens (runaway-input guard). */
  maxTokens?: number;
  /** Emit adjacent-character bigrams for scripts without spaces. Default true. */
  cjkBigrams?: boolean;
  /** Emit single characters for scripts without spaces. Default true. */
  cjkUnigrams?: boolean;
}

const DEFAULT_MAX_TOKENS = Number(process.env.LEXICAL_MAX_TOKENS || 4000);

/** Characters that are written without word separators (Han, Kana, Hangul). */
const CJK_CHAR = /[\u0E00-\u0E7F\u1100-\u11FF\u1780-\u17FF\u2E80-\u2FFF\u3000-\u303F\u3040-\u30FF\u3130-\u318F\u31A0-\u31BF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/u;
/** Word characters kept verbatim inside a token. */
const KEEP_CHAR = /[\p{L}\p{N}]/u;
/** Latin/digit runs: covers identifier parts such as "EQ", "0077" or "R9". */
const ALNUM_RUN = /[A-Za-z0-9]+/g;

/**
 * Minimal structural types for Intl.Segmenter: the API exists in Node 18+ but
 * is not part of every TS lib target this project compiles against.
 */
interface WordSegment {
  segment: string;
  isWordLike?: boolean;
}
interface WordSegmenter {
  segment(input: string): Iterable<WordSegment>;
}

let segmenter: WordSegmenter | null | undefined;

function getSegmenter(): WordSegmenter | null {
  if (segmenter !== undefined) return segmenter;
  try {
    const Ctor = (Intl as unknown as { Segmenter?: new (locale?: string, opts?: object) => WordSegmenter })
      .Segmenter;
    segmenter = Ctor ? new Ctor('und', { granularity: 'word' }) : null;
  } catch {
    segmenter = null;
  }
  return segmenter ?? null;
}

/** Normalise every token into a tsquery-safe lexeme. */
export function normalizeTerm(raw: string): string {
  const lowered = String(raw || '')
    .normalize('NFKC')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
  let out = '';
  for (const ch of lowered) {
    out += KEEP_CHAR.test(ch) ? ch : ' ';
  }
  return out.trim();
}

/**
 * Split text into index/query terms. Deterministic, side-effect free.
 */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const source = String(text || '');
  if (!source) return [];
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const withBigrams = options.cjkBigrams !== false;
  const withUnigrams = options.cjkUnigrams !== false;

  // 1. Whitespace/word segmentation. Intl.Segmenter is a no-op fallback when
  //    unavailable, in which case the script rules below still work.
  const segments: string[] = [];
  const seg = getSegmenter();
  if (seg) {
    for (const part of seg.segment(source)) {
      if (part.isWordLike === false) continue;
      segments.push(part.segment);
    }
  } else {
    segments.push(...source.split(/[\s\p{P}\p{S}]+/u));
  }

  const tokens: string[] = [];
  const push = (term: string) => {
    if (!term) return;
    tokens.push(term);
  };

  for (const segment of segments) {
    const chars = [...segment.normalize('NFKC').toLowerCase()];
    if (!chars.length) continue;
    const hasCjk = chars.some((ch) => CJK_CHAR.test(ch));
    if (hasCjk) {
      if (withUnigrams) {
        for (const ch of chars) {
          if (KEEP_CHAR.test(ch)) push(ch);
        }
      }
      if (withBigrams) {
        for (let i = 0; i + 1 < chars.length; i += 1) {
          const pair = `${chars[i]}${chars[i + 1]}`;
          if (KEEP_CHAR.test(chars[i]) && KEEP_CHAR.test(chars[i + 1])) push(pair);
        }
      }
      continue;
    }
    const term = normalizeTerm(segment);
    // normalizeTerm turns every separator into a space, so a segment such as
    // "1.2" must be emitted as its parts: the text search parser would split it
    // anyway, and index/query have to agree term for term.
    for (const part of term.split(/\s+/)) {
      if (part.length >= 2) push(part);
    }
  }

  // 2. Identifier parts / long numbers keep exact IDs and codes retrievable
  //    even when the surrounding script is space-delimited. Separators such as
  //    "-", "_" or "/" are not part of any term: the text search parser splits
  //    them anyway, so both sides of the index agree.
  for (const match of source.matchAll(ALNUM_RUN)) {
    const term = match[0].toLowerCase();
    if (term.length >= 2 && term.length <= 64) push(term);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (!token || token.length > 128 || /\s/.test(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= maxTokens) break;
  }
  return out;
}

/** Term frequency map for one chunk/document. */
export function tokenFrequencies(text: string, options: TokenizeOptions = {}): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokenize(text, options)) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }
  return tf;
}

/** Expand a query into the same term space as the index. */
export function tokenizeQuery(query: string, options: TokenizeOptions = {}): string[] {
  return tokenize(query, { maxTokens: 256, ...options });
}

/** Total number of indexable characters, used for BM25 length normalisation. */
export function lexicalLength(text: string): number {
  let length = 0;
  for (const ch of String(text || '')) {
    if (KEEP_CHAR.test(ch)) length += 1;
  }
  return Math.max(1, length);
}
