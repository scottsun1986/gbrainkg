export interface IndexedMarkdownChunk {
  ord: number;
  content: string;
  tokenCount: number;
  charStart: number;
  charEnd: number;
  metadata: Record<string, unknown>;
}

const MAX_CHARS = 4800;
const OVERLAP_CHARS = 480;

type Section = { start: number; end: number; heading: string };

function findSections(markdown: string): Section[] {
  const sections: Section[] = [];
  const heading = /^#{1,6}\s+.+$/gm;
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
 * GBrain still receives the complete document under one canonical slug; these
 * chunks are the durable DB representation used for retrieval, ACL and sync.
 */
export function splitMarkdownIntoChunks(markdown: string): IndexedMarkdownChunk[] {
  const chunks: IndexedMarkdownChunk[] = [];
  for (const section of findSections(markdown)) {
    let start = section.start;
    let first = true;
    while (start < section.end) {
      const end = chooseBoundary(markdown, start, Math.min(start + MAX_CHARS, section.end));
      const raw = markdown.slice(start, end);
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
            chunkStrategy: 'markdown-section-window',
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
