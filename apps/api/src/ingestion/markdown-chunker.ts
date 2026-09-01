export interface IndexedMarkdownChunk {
  ord: number;
  content: string;
  tokenCount: number;
  charStart: number;
  charEnd: number;
  metadata: {
    section: string;
    parentContext?: string;
    chunkStrategy: string;
    overlapChars: number;
    [key: string]: unknown;
  };
}

const MAX_CHARS = 1800;
const OVERLAP_CHARS = 200;

type Section = { start: number; end: number; heading: string };

function findSections(markdown: string): Section[] {
  const sections: Section[] = [];
  // Parsed office documents often have no Markdown headings. Promote their
  // native structural boundaries (chapters, articles and enumerated clauses)
  // into sections so retrieval can localize a passage without query-specific
  // rules such as treating “第 N 条” as a special request.
  const heading = /^(#{1,6}\s+.+|第[\d一二三四五六七八九十百千万〇零两]+[章节条款项].*|[（(]?[\d一二三四五六七八九十百千万]+[）).、]\s*.+)$/gmu;
  let currentStart = 0;
  let currentHeading = '';
  let match: RegExpExecArray | null;
  while ((match = heading.exec(markdown))) {
    if (match.index > currentStart && markdown.slice(currentStart, match.index).trim()) {
      sections.push({ start: currentStart, end: match.index, heading: currentHeading });
    }
    currentStart = match.index;
    currentHeading = match[0].trim();
  }
  if (currentStart < markdown.length && markdown.slice(currentStart).trim()) {
    sections.push({ start: currentStart, end: markdown.length, heading: currentHeading });
  }
  return sections.length ? sections : [{ start: 0, end: markdown.length, heading: '' }];
}

function chooseBoundary(markdown: string, start: number, targetEnd: number): number {
  if (targetEnd >= markdown.length) return markdown.length;
  const paragraph = markdown.lastIndexOf('\n\n', targetEnd);
  if (paragraph > start + Math.floor(MAX_CHARS * 0.55)) return paragraph;
  const line = markdown.lastIndexOf('\n', targetEnd);
  return line > start + Math.floor(MAX_CHARS * 0.55) ? line : targetEnd;
}

/**
 * Split parsed Markdown on heading boundaries and paragraph-safe windows.
 * Generates child chunks with attached parent section context for high-precision retrieval.
 */
export function splitMarkdownIntoChunks(markdown: string): IndexedMarkdownChunk[] {
  const cleanMarkdown = (markdown || '').replace(/\0/g, '').replace(/\u0000/g, '');
  const chunks: IndexedMarkdownChunk[] = [];
  for (const section of findSections(cleanMarkdown)) {
    const sectionBody = cleanMarkdown.slice(section.start, section.end).trim();
    let start = section.start;
    let first = true;
    while (start < section.end) {
      const end = chooseBoundary(cleanMarkdown, start, Math.min(start + MAX_CHARS, section.end));
      const raw = cleanMarkdown.slice(start, end);
      const content = raw.trim();
      if (content) {
        const withHeading = !first && section.heading && !content.startsWith(section.heading)
          ? `${section.heading}\n\n${content}`
          : content;
        chunks.push({
          ord: chunks.length,
          content: withHeading,
          tokenCount: Math.ceil(withHeading.length / 4),
          charStart: start,
          charEnd: end,
          metadata: {
            section: section.heading || '文档正文',
            parentContext: sectionBody.length <= 4000 ? sectionBody : undefined,
            chunkStrategy: 'parent-child-section-window',
            overlapChars: first ? 0 : OVERLAP_CHARS,
          },
        });
      }
      if (end >= section.end) break;
      const nextStart = Math.max(start + 1, end - OVERLAP_CHARS);
      start = nextStart;
      first = false;
    }
  }
  return chunks;
}
