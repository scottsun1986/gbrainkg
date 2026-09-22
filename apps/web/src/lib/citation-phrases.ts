/**
 * Pure phrase extraction / ranking used by the document citation highlighter.
 * Kept DOM-free so it can be unit-tested under node:test.
 */

const BOILERPLATE = new Set([
  '属性维度', '详细内容与背景数据', '可信度', '单位全称/简称',
  '机构性质与背景', '关键领导关切', '数字化/AI现状', '痛点维度',
  '具体表现与管理挑战', '影响程度', '第一板块', '第二板块', '第三板块',
  '目标单位全景画像', '行业全景及核心痛点', '详细内容', '背景数据',
]);

/** Strip inline markdown decorations and split into candidate highlight phrases. */
export function extractCleanPhrases(snippet: string, docTitle = ''): string[] {
  if (!snippet) return [];
  const cleanText = snippet
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/^\s*[\d-]+\.?\s+/gm, '')
    .replace(/^[>\s*-]+/gm, '');

  const docTitleClean = (docTitle || '').replace(/\.[^.]+$/, '').trim();

  const parts = cleanText
    .split(/[\n。；;\t\r|，,]+/g)
    .flatMap((s) => s.split(/：(?!\d)|:(?!\d)/g))
    .map((s) => s.replace(/^[#\s\-*>`:|0-9.()（）]+/, '').replace(/[#\s\-*>`:|0-9.()（）]+$/, '').trim())
    .map((s) => s.replace(/[\s\t]+/g, ' '))
    .filter((s) => {
      if (!s || s.length < 3) return false;
      if (/^[0-9a-fA-F-]{20,}$/.test(s)) return false;
      if (/^第?\s*\d+\s*页$/.test(s)) return false;
      if (BOILERPLATE.has(s)) return false;
      if (docTitleClean && s === docTitleClean) return false;
      return true;
    });

  return Array.from(new Set(parts));
}

/** Score phrases by uniqueness/position against the full document text. */
export function rankPhrases(cleanPhrases: string[], fullText: string): string[] {
  if (!cleanPhrases.length || !fullText) return cleanPhrases.slice(0, 12);
  const scored = cleanPhrases.map((phrase) => {
    const p = String(phrase || '').trim();
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const matches = fullText.match(new RegExp(escaped, 'gi')) || [];
    const count = matches.length;
    const firstPos = fullText.search(new RegExp(escaped, 'i'));

    const uniqueScore = count === 0 ? -1000 : (count === 1 ? 100 : 60 / count);
    const lengthScore = Math.min(p.length, 30);
    const positionScore = firstPos > 0 ? (firstPos / fullText.length) * 20 : 0;
    return { phrase: p, score: uniqueScore + lengthScore + positionScore, count, firstPos };
  }).filter((item) => item.count > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 15).map((item) => item.phrase);
}

export function stripDecorations(value: unknown): string {
  return String(value || '')
    .replace(/\[上下文:[^\]]*\]/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/【第[^】]{1,6}】/g, '');
}

/** Whole-chunk anchoring: prefer phrases taken from the matched chunk itself. */
export function chunkAnchoredPhrases(
  snippet: string,
  chunks: Array<{ content?: unknown } | null | undefined> | null | undefined,
): string[] | null {
  if (!snippet || !chunks || !chunks.length) return null;
  const norm = (s: unknown) => stripDecorations(s).replace(/\s+/g, '').toLowerCase();
  const target = norm(snippet).slice(0, 400);
  if (target.length < 12) return null;

  let best: { content?: unknown } | null = null;
  let bestScore = 0;
  for (const chunk of chunks) {
    if (!chunk) continue;
    const c = norm(chunk.content);
    if (!c) continue;
    let score = 0;
    if (c.includes(target)) {
      score = 2 + target.length / Math.max(1, c.length);
    } else {
      const w = Math.min(60, target.length);
      if (w >= 20) {
        for (let i = 0; i + w <= target.length; i += 20) {
          if (c.includes(target.slice(i, i + w))) {
            score = Math.max(score, 1 + w / target.length);
            break;
          }
        }
      }
    }
    if (score > bestScore) { bestScore = score; best = chunk; }
  }
  if (!best || bestScore < 0.8) return null;

  const lines = stripDecorations(best.content)
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！？；;])/))
    .map((line) => line
      .replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^[#\s\-*>`:|0-9.()（）【】]+/, '')
      .replace(/[#\s\-*>`:|]+$/, '')
      .replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 6 && line.length <= 160);
  const unique = Array.from(new Set(lines));
  return unique.length >= 2 ? unique.slice(0, 60) : null;
}

/** Final phrase list: chunk anchor → ranked → cleaned. */
export function resolveHighlightPhrases(
  snippet: string,
  chunks: Array<{ content?: unknown } | null | undefined> | null | undefined,
  fullText: string,
  docTitle = '',
): string[] {
  const clean = extractCleanPhrases(snippet, docTitle);
  const anchored = chunkAnchoredPhrases(snippet, chunks);
  if (anchored && anchored.length) return anchored;
  const ranked = rankPhrases(clean, fullText);
  if (ranked.length) return ranked;
  return clean;
}
