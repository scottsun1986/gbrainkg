import { estimateTokens } from '../chat/context-budget';

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
    chapter_no?: number;
    section_no?: number;
    article_no?: number;
    page_no?: number;
    [key: string]: unknown;
  };
}

const MAX_CHARS = 1800;
const OVERLAP_CHARS = 200;

type Section = { start: number; end: number; heading: string };

function parseChineseNumber(str: string): number | null {
  const match = str.match(/\d+/);
  if (match) return parseInt(match[0], 10);

  const numMap: Record<string, number> = {
    '零': 0, '〇': 0, '○': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9
  };
  
  let total = 0;
  let current = 0;
  let hasDigit = false;
  
  for (const char of str) {
    if (numMap[char] !== undefined) {
      if (current === 0 && total === 0 && numMap[char] === 0) continue;
      current = numMap[char];
      hasDigit = true;
    } else if (char === '十') {
      if (current === 0) current = 1;
      total += current * 10;
      current = 0;
      hasDigit = true;
    } else if (char === '百') {
      if (current === 0) current = 1;
      total += current * 100;
      current = 0;
      hasDigit = true;
    } else if (char === '千') {
      if (current === 0) current = 1;
      total += current * 1000;
      current = 0;
      hasDigit = true;
    }
  }
  total += current;
  return hasDigit ? total : null;
}

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

function extractTableHeader(text: string): string | null {
  const match = text.match(/(?:^|\n)(\|[^\n]+\|\r?\n\|[-\s:|]+\|)(?:\r?\n|$)/);
  return match ? match[1].trim() : null;
}

export function parseTableRowsToKeyValues(tableText: string): { headers: string[]; rowsKv: string[] } {
  const lines = tableText.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('|') && l.endsWith('|'));
  if (lines.length < 3) return { headers: [], rowsKv: [] };
  
  const headerLine = lines[0];
  const separatorLine = lines[1];
  if (!separatorLine.includes('---')) return { headers: [], rowsKv: [] };
  
  const headers = headerLine.slice(1, -1).split('|').map(c => c.trim().replace(/\*\*/g, ''));
  const rowsKv: string[] = [];
  
  for (let i = 2; i < lines.length; i++) {
    const row = lines[i];
    const cells = row.slice(1, -1).split('|').map(c => c.trim().replace(/\*\*/g, ''));
    if (cells.length === 0 || cells.every(c => !c)) continue;
    
    const kvParts: string[] = [];
    for (let j = 0; j < Math.min(headers.length, cells.length); j++) {
      if (headers[j] && cells[j]) {
        kvParts.push(`${headers[j]}: ${cells[j]}`);
      }
    }
    if (kvParts.length > 0) {
      rowsKv.push(kvParts.join(' | '));
    }
  }
  
  return { headers, rowsKv };
}

/**
 * Split parsed Markdown on heading boundaries and paragraph-safe windows.
 * Generates child chunks with attached parent section context for high-precision retrieval.
 */
export function splitMarkdownIntoChunks(markdown: string): IndexedMarkdownChunk[] {
  const cleanMarkdown = (markdown || '').replace(/\0/g, '').replace(/\u0000/g, '');
  
  // 1. Detect page markers
  type PageMarker = { index: number; pageNo: number };
  const pageMarkers: PageMarker[] = [];
  const pageRegex = /<!--\s*page\s+(\d+)\s*-->|---\s*page\s+(\d+)\s*---|(?:^|\n)##\s*第\s*(\d+)\s*页|\f/gi;
  let pMatch: RegExpExecArray | null;
  let autoPage = 1;
  while ((pMatch = pageRegex.exec(cleanMarkdown))) {
    let pageNo = autoPage + 1;
    if (pMatch[1]) pageNo = parseInt(pMatch[1], 10);
    else if (pMatch[2]) pageNo = parseInt(pMatch[2], 10);
    else if (pMatch[3]) pageNo = parseInt(pMatch[3], 10);
    
    pageMarkers.push({ index: pMatch.index, pageNo });
    autoPage = pageNo;
  }
  
  function getPageNo(index: number): number | undefined {
    if (pageMarkers.length === 0) return undefined;
    let page = 1;
    for (const marker of pageMarkers) {
      if (marker.index <= index) {
        page = marker.pageNo;
      } else {
        break;
      }
    }
    return page;
  }

  // 2. Detect clause structure
  const clauseMarkerRegex = /第[\d一二三四五六七八九十百千万〇零两]+[章节条]/g;
  const clauseMarkersCount = (cleanMarkdown.match(clauseMarkerRegex) || []).length;
  const hasClauseStructure = clauseMarkersCount >= 3;

  const chunks: IndexedMarkdownChunk[] = [];
  
  let currentChapter: number | undefined;
  let currentSection: number | undefined;
  let currentArticle: number | undefined;
  // Cross-page table stitching: when a wide table is split by a page break,
  // the continuation section must inherit the header from the previous page.
  // The header is carried only across page-boundary sections (not arbitrary
  // headings) so it never leaks onto unrelated content.
  let carriedTableHeader: string | null = null;
  
  for (const section of findSections(cleanMarkdown)) {
    const sectionBody = cleanMarkdown.slice(section.start, section.end).trim();
    const isPageSection = !section.heading || /^#{1,6}\s*第\s*\d+\s*页/.test(section.heading);
    
    if (hasClauseStructure && section.heading) {
      const chapterMatch = section.heading.match(/第([\d一二三四五六七八九十百千万〇零两]+)章/);
      if (chapterMatch) {
        currentChapter = parseChineseNumber(chapterMatch[1]) ?? currentChapter;
        currentSection = undefined;
      }
      const sectionMatch = section.heading.match(/第([\d一二三四五六七八九十百千万〇零两]+)节/);
      if (sectionMatch) {
        currentSection = parseChineseNumber(sectionMatch[1]) ?? currentSection;
      }
      const articleMatch = section.heading.match(/第([\d一二三四五六七八九十百千万〇零两]+)条/);
      if (articleMatch) {
        currentArticle = parseChineseNumber(articleMatch[1]) ?? currentArticle;
      }
    }

    const ownTableHeader = extractTableHeader(sectionBody);
    let lastTableHeader: string | null = ownTableHeader ?? (isPageSection ? carriedTableHeader : null);

    let start = section.start;
    let first = true;
    while (start < section.end) {
      let end = section.end;
      if (!hasClauseStructure || (section.end - start > 5000)) {
        end = chooseBoundary(cleanMarkdown, start, Math.min(start + MAX_CHARS, section.end));
      }
      
      const raw = cleanMarkdown.slice(start, end);
      let content = raw.trim();
      // Extract OCR bounding boxes (emitted by the parser as hidden HTML
      // comments) and strip them from the indexed text so visual grounding
      // metadata never pollutes keyword/BM25 matching.
      const bboxes: Array<{ x: number; y: number; w: number; h: number; page?: number }> = [];
      content = content.replace(/<!--\s*bbox:(\d+),(\d+),(\d+),(\d+)\s*-->/g, (_full, x, y, w, h) => {
        bboxes.push({ x: Number(x), y: Number(y), w: Number(w), h: Number(h), page: getPageNo(start) });
        return '';
      }).replace(/[ \t]+\n/g, '\n').trim();
      if (content) {
        // Table header propagation (inspired by WeKnora table processing):
        // If chunk begins with table rows but lacks header delimiter, prepend preceding header
        // A page break may be represented as a heading line ("## 第 N 页")
        // followed by the continuation rows, so allow an optional leading
        // heading before the first table row.
        const beginsWithTableRow = /^(?:#{1,6}[^\n]*\n+)?\s*\|[^\n]+\|/.test(content);
        const containsHeader = /(?:^|\n)\|[^\n]+\|\r?\n\s*\|[-\s:|]+\|/.test(content);
        let tableHeaderAdded = false;

        if (beginsWithTableRow && !containsHeader && lastTableHeader) {
          content = `${lastTableHeader}\n${content}`;
          tableHeaderAdded = true;
        }
        if (containsHeader) {
          const newHeader = extractTableHeader(content);
          if (newHeader) lastTableHeader = newHeader;
        }

        let withHeading = !first && section.heading && !content.startsWith(section.heading)
          ? `${section.heading}\n\n${content}`
          : content;
          
        const hasTableContent = containsHeader || beginsWithTableRow || tableHeaderAdded || /(?:^|\n)\|[^\n]+\|/.test(content);
        let tableHeaders: string[] | undefined;
        let tableRowsCount: number | undefined;

        if (hasTableContent) {
          const tableInfo = parseTableRowsToKeyValues(content);
          if (tableInfo.headers.length > 0) {
            tableHeaders = tableInfo.headers;
          }
          if (tableInfo.rowsKv.length > 0) {
            tableRowsCount = tableInfo.rowsKv.length;
            // Inject structured row semantics (invisible in HTML/purified render, fully indexed by BM25/search)
            const tableSemantics = `\n\n<!-- 表格结构化行语义:\n${tableInfo.rowsKv.join('\n')}\n-->`;
            withHeading += tableSemantics;
          }
        }

        const metadata: IndexedMarkdownChunk['metadata'] = {
          section: section.heading || '文档正文',
          parentContext: sectionBody.length <= 4000 ? sectionBody : undefined,
          chunkStrategy: hasClauseStructure ? 'clause-based' : 'parent-child-section-window',
          overlapChars: first ? 0 : OVERLAP_CHARS,
          has_table: hasTableContent,
          ...(tableHeaders ? { table_headers: tableHeaders } : {}),
          ...(tableRowsCount ? { table_rows_count: tableRowsCount } : {}),
          ...(tableHeaderAdded ? { table_header_injected: true } : {}),
          ...(bboxes.length ? { bboxes: bboxes.slice(0, 50), bbox: bboxes[0] } : {}),
        };
        
        if (hasClauseStructure) {
          if (currentChapter !== undefined) metadata.chapter_no = currentChapter;
          if (currentSection !== undefined) metadata.section_no = currentSection;
          if (currentArticle !== undefined) metadata.article_no = currentArticle;
        }
        
        const pageNo = getPageNo(start);
        if (pageNo !== undefined) {
          metadata.page_no = pageNo;
        }

        chunks.push({
          ord: chunks.length,
          content: withHeading,
          tokenCount: estimateTokens(withHeading),
          charStart: start,
          charEnd: end,
          metadata,
        });
      }
      if (end >= section.end) break;
      const nextStart = Math.max(start + 1, end - OVERLAP_CHARS);
      start = nextStart;
      first = false;
    }
    carriedTableHeader = lastTableHeader;
  }

  // Link neighbor chunks (inspired by WeKnora chunk neighbor graph)
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) chunks[i].metadata.prev_chunk_ord = chunks[i - 1].ord;
    if (i < chunks.length - 1) chunks[i].metadata.next_chunk_ord = chunks[i + 1].ord;
  }

  return chunks;
}
