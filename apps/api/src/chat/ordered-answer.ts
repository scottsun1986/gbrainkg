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
  return lines.map(line => line.text).join('\n');
}
