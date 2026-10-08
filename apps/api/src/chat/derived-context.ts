import { tokenizeQuery } from '../retrieval/lexical-tokenizer';

export function selectDerivedContext(content: string, question: string, maxChars = 4000): string {
  if (content.length <= maxChars) return content;
  const terms = [...new Set(tokenizeQuery(question))];
  const sections = content.split(/\n(?=#{1,6}\s)|\n\n/).filter(Boolean).map((text, index) => ({
    text, index, score: terms.reduce((sum, term) => sum + (text.toLowerCase().includes(term.toLowerCase()) ? 1 : 0), 0),
  }));
  const ranked = [...sections].sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: typeof sections = [];
  let remaining = maxChars;
  for (const section of ranked) {
    if (remaining <= 0) break;
    const text = section.text.slice(0, remaining);
    selected.push({ ...section, text });
    remaining -= text.length + 2;
  }
  return selected.sort((a, b) => a.index - b.index).map(s => s.text).join('\n\n');
}
