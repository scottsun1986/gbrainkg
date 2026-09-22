import { lexicalLength, normalizeTerm, tokenize, tokenizeQuery } from './lexical-tokenizer';

describe('lexical tokenizer', () => {
  it('emits adjacent bigrams and unigrams for scripts without spaces', () => {
    const tokens = tokenize('交通费报销');
    // Intl.Segmenter splits CJK text into words; bigrams are emitted inside a
    // word and unigrams keep partial-word queries (e.g. a single character)
    // retrievable.
    expect(tokens).toContain('交通');
    expect(tokens).toContain('报销');
    expect(tokens).toContain('交');
    expect(tokens).toContain('销');
    // Multi-word runs keep their unigrams (so a query that segments differently
    // still matches character by character) plus the bigrams of each segment.
    const multiWord = tokenize('碳中和目标');
    expect(multiWord).toEqual(expect.arrayContaining(['碳', '中', '和', '目', '标']));
    expect(multiWord.some((token) => token.length === 2)).toBe(true);
    expect(multiWord).toContain('目标');
    // No token may span a word boundary or contain whitespace.
    expect(tokens.some((token) => /\s/.test(token))).toBe(false);
  });

  it('keeps space-delimited words whole and drops single characters', () => {
    const tokens = tokenize('Reimbursement policy a for travel');
    expect(tokens).toEqual(expect.arrayContaining(['reimbursement', 'policy', 'travel']));
    expect(tokens).not.toContain('a');
  });

  it('splits identifiers the way the text search parser does', () => {
    const tokens = tokenize('EQ-0077 PRD_2026/9 R9');
    expect(tokens).toEqual(expect.arrayContaining(['eq', '0077', 'prd', '2026', 'r9']));
    // No separator may survive inside a term: index and tsquery must agree.
    for (const token of tokens) {
      expect(token).toMatch(/^[\p{L}\p{N}]+$/u);
    }
  });

  it('never emits a term containing punctuation after normalisation', () => {
    expect(normalizeTerm('1.2')).toBe('1 2');
    expect(normalizeTerm('AB-C')).toBe('ab c');
    for (const token of tokenize('版本 v1.2.3 发布于 2026-09-19')) {
      expect(token).toMatch(/^[\p{L}\p{N}]+$/u);
    }
  });

  it('is deterministic and deduplicates', () => {
    const first = tokenize('制度 制度 管理制度');
    const second = tokenize('制度 制度 管理制度');
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });

  it('shares one term space between index and query', () => {
    const indexed = new Set(tokenize('员工报销交通费标准'));
    const query = tokenizeQuery('交通费');
    expect(query.length).toBeGreaterThan(0);
    expect(query.every((term) => indexed.has(term))).toBe(true);
  });

  it('applies a hard ceiling so a runaway document cannot explode the index', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `词${String.fromCharCode(0x4e00 + (i % 2000))}语`).join('');
    expect(tokenize(huge, { maxTokens: 64 }).length).toBe(64);
  });

  it('measures BM25 length in indexable characters', () => {
    expect(lexicalLength('交通 费')).toBe(3);
    expect(lexicalLength('')).toBe(1);
  });
});
