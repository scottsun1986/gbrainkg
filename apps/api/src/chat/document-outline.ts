/** Structural task parsing only; no corpus or business vocabulary. */
export function outlineDocumentTitle(query: string): string | null {
  if (!/(?:全部|所有|哪些|列出|列举).*(?:章名|章节|目录)|(?:全部|所有)章名|(?:list|enumerate)\s+(?:all\s+)?chapters/i.test(query)) return null;
  const titles = [...query.matchAll(/《([^》]+)》|["“]([^"”]+)["”]/g)].map(m => (m[1] || m[2]).trim());
  return titles.length === 1 ? titles[0] : null;
}

export function normalizeDocumentTitle(title: string): string {
  return title.normalize('NFKC').replace(/\.(?:docx?|pdf|md|txt|html?)$/i, '').trim().toLowerCase();
}

/** Keep source order, including escaped Markdown produced by office parsers. */
export function chapterHeadings(text: string): string[] {
  const headings: string[] = [];
  let inCode = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\\([#*_])/g, '$1').trim();
    if (/^```|^~~~/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const body = line.replace(/^#{1,6}\s*/, '').replace(/^\*\*(.*?)\*\*$/, '$1').replace(/\s+#+$/, '').trim();
    if (/^第[〇零一二三四五六七八九十百千0-9]+章(?:\s|[：:、]|$)/.test(body)
      || /^chapter\s+(?:[0-9]+|[ivxlcdm]+)\b/i.test(body)) headings.push(body);
  }
  return [...new Set(headings)];
}

export function renderDocumentOutline(citations: any[]): string {
  const docs = new Map<string, { title: string; kb: string; headings: Map<string, number> }>();
  citations.forEach((c, index) => {
    let doc = docs.get(c.docId);
    if (!doc) { doc = { title: c.docTitle, kb: c.kbName || '', headings: new Map() }; docs.set(c.docId, doc); }
    for (const heading of chapterHeadings(String(c.context || c.evidence || ''))) {
      if (!doc.headings.has(heading)) doc.headings.set(heading, index + 1);
    }
  });
  return [...docs.values()].filter(d => d.headings.size).map(d =>
    `### 《${d.title}》${docs.size > 1 ? `（${d.kb}）` : ''}\n\n` +
    [...d.headings].map(([heading, index]) => `- ${heading} [${index}]`).join('\n'),
  ).join('\n\n');
}
