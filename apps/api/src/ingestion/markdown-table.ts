/** Split a Markdown table row at structural pipes only. Escaped pipes and
 * matched backtick spans belong to a cell, including spans with several ticks. */
export function parseMarkdownTableCells(line: string): string[] {
  const text = String(line || '').trim();
  if (!text) return [];
  const cells: string[] = [];
  let value = '', codeTicks = 0, lastSeparator = -1;
  const runLength = (offset: number) => { let end = offset; while (text[end] === '`') end++; return end - offset; };
  const hasClosing = (offset: number, size: number) => {
    for (let index = offset; index < text.length; index++) {
      if (text[index] !== '`') continue;
      const count = runLength(index);
      if (count === size) return true;
      index += count - 1;
    }
    return false;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!codeTicks && char === '\\' && text[index + 1] === '`') { value += '`'; index++; continue; }
    if (char === '\\' && text[index + 1] === '|' ) { value += '|'; index++; continue; }
    if (!codeTicks && char === '\\' && text[index + 1] === '\\') { value += '\\'; index++; continue; }
    if (char === '`') {
      const count = runLength(index);
      if (codeTicks === count) codeTicks = 0;
      else if (!codeTicks && hasClosing(index + count, count)) codeTicks = count;
      value += '`'.repeat(count); index += count - 1; continue;
    }
    if (char === '|' && !codeTicks) { cells.push(value.trim()); value = ''; lastSeparator = index; }
    else value += char;
  }
  cells.push(value.trim());
  if (text.startsWith('|')) cells.shift();
  if (lastSeparator === text.length - 1) cells.pop();
  return cells;
}

export function isMarkdownTableDelimiter(line: string): boolean {
  const cells = parseMarkdownTableCells(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}
