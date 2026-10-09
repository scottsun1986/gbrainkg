import { parseMarkdownTableCells, isMarkdownTableDelimiter } from './markdown-table';
import { positiveNumber } from '../config-numbers';
import { estimateTokens } from '../chat/context-budget';
import { classifyTableRole } from '../chat/section-align';

export interface IndexedMarkdownChunk {
  ord: number;
  content: string;
  tokenCount: number;
  charStart: number;
  charEnd: number;
  metadata: {
    section: string;
    breadcrumb?: string;
    heading_hierarchy?: string[];
    parentContext?: string;
    parentChunkId?: string;
    tableRole?: 'summary' | 'detail' | 'unknown';
    chunkStrategy: string;
    overlapChars: number;
    chapter_no?: number;
    section_no?: number;
    article_no?: number;
    page_no?: number;
    [key: string]: unknown;
  };
}

// 可通过 env 覆盖（也可在调用前 setOptions 覆盖）；避免硬编码导致不同语料无法调参。
export interface ChunkSplitOptions {
  maxChars: number;
  overlapChars: number;
}

const defaultSplitOptions = (): ChunkSplitOptions => ({
  maxChars: positiveNumber(process.env.CHUNK_MAX_CHARS, 1800),
  overlapChars: positiveNumber(process.env.CHUNK_OVERLAP_CHARS, 200, 0),
});

let activeSplitOptions: ChunkSplitOptions = defaultSplitOptions();

export function setChunkSplitOptions(partial: Partial<ChunkSplitOptions>): void {
  activeSplitOptions = {
    maxChars: positiveNumber(partial.maxChars, activeSplitOptions.maxChars),
    overlapChars: positiveNumber(partial.overlapChars, activeSplitOptions.overlapChars, 0),
  };
}

export function resetChunkSplitOptions(): void {
  activeSplitOptions = defaultSplitOptions();
}

export function getChunkSplitOptions(): ChunkSplitOptions {
  return activeSplitOptions;
}

export function getHeadingHierarchyLevel(heading: string): number {
  if (!heading) return 99;
  const hMatch = heading.match(/^(#{1,6})\s+/);
  if (hMatch) return hMatch[1].length;
  if (/^第[\d一二三四五六七八九十百千万〇零两]+[编部分]/.test(heading)) return 1;
  if (/^(?:第[\d一二三四五六七八九十百千万〇零两]+章|[一二三四五六七八九十]+、)/.test(heading)) return 2;
  if (/^[（(][\d一二三四五六七八九十]+[）)]/.test(heading)) return 3;
  if (/^(?:\*\*)?\d+[\.、]|^第[\d一二三四五六七八九十]+[条节]/.test(heading)) return 4;
  return 3;
}

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


type MarkdownBlock = { start: number; end: number; kind: 'code' | 'math' | 'table' | 'list'; fence?: string; fenceInfo?: string };
type MarkdownLine = { start: number; end: number; text: string };
function sourceLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  const pattern = /[^\n]*(?:\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) && match[0].length) {
    lines.push({ start: match.index, end: match.index + match[0].length, text: match[0].replace(/\r?\n$/, '') });
  }
  return lines;
}

/** Source ranges are computed once before section discovery. Small structured
 * blocks stay atomic; large ones may split at source lines with their complete
 * parent range retained in chunk metadata. No Markdown is executed. */
function markdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = sourceLines(markdown), blocks: MarkdownBlock[] = [];
  const listMarker = /^ {0,3}(?:[-+*]|\d+[.)])\s+/;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = line.text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      let endIndex = index + 1;
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (endIndex < lines.length && !close.test(lines[endIndex].text)) endIndex++;
      const last = Math.min(endIndex, lines.length - 1);
      blocks.push({ start: line.start, end: lines[last].end, kind: 'code', fence: fence[1], fenceInfo: fence[2] });
      index = last; continue;
    }
    const math = /^ {0,3}\$\$/.test(line.text) ? '$$' : /^ {0,3}\\\[/.test(line.text) ? '\\[' : '';
    if (math) {
      const closing = math === '$$' ? '$$' : '\\]';
      let endIndex = index;
      if (!line.text.trim().slice(math.length).includes(closing)) {
        endIndex++;
        while (endIndex < lines.length && !lines[endIndex].text.trim().endsWith(closing)) endIndex++;
      }
      const last = Math.min(endIndex, lines.length - 1);
      blocks.push({ start: line.start, end: lines[last].end, kind: 'math' }); index = last; continue;
    }
    const cells = parseMarkdownTableCells(line.text);
    if (cells.length > 0 && (line.text.trim().startsWith('|') || (lines[index + 1] && isMarkdownTableDelimiter(lines[index + 1].text)))) {
      let endIndex = index + 1;
      while (endIndex < lines.length && lines[endIndex].text.trim() && parseMarkdownTableCells(lines[endIndex].text).length > 0 && (lines[endIndex].text.includes('|'))) endIndex++;
      blocks.push({ start: line.start, end: lines[endIndex - 1].end, kind: 'table' }); index = endIndex - 1; continue;
    }
    // Keep isolated numbered policy clauses as headings. Consecutive Markdown
    // ordered items and unordered lists form atomic list blocks.
    const isList = /^ {0,3}[-+*]\s+/.test(line.text) || (listMarker.test(line.text) && !!lines[index + 1] && listMarker.test(lines[index + 1].text));
    if (isList) {
      let endIndex = index + 1;
      while (endIndex < lines.length) {
        const next = lines[endIndex].text;
        if (listMarker.test(next) || /^\s{2,}\S/.test(next)) { endIndex++; continue; }
        if (!next.trim() && lines[endIndex + 1] && (listMarker.test(lines[endIndex + 1].text) || /^\s{2,}\S/.test(lines[endIndex + 1].text))) { endIndex++; continue; }
        break;
      }
      blocks.push({ start: line.start, end: lines[endIndex - 1].end, kind: 'list' }); index = endIndex - 1;
    }
  }
  return blocks;
}

function insideBlock(blocks: MarkdownBlock[], offset: number): MarkdownBlock | undefined {
  let low = 0, high = blocks.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1, block = blocks[middle];
    if (offset < block.start) high = middle - 1;
    else if (offset >= block.end) low = middle + 1;
    else return block;
  }
  return undefined;
}

function tableLines(text: string): string[] {
  const blocks = markdownBlocks(text);
  return sourceLines(text).filter(line => {
    const block = insideBlock(blocks, line.start);
    return (!block || block.kind === 'table') && line.text.includes('|') && parseMarkdownTableCells(line.text).length > 0;
  }).map(line => line.text.trim());
}

function findSections(markdown: string, blocks: MarkdownBlock[]): Section[] {
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
    if (insideBlock(blocks, match.index)) continue;
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

function chooseBoundary(markdown: string, start: number, targetEnd: number, sectionEnd: number, blocks: MarkdownBlock[]): number {
  const block = insideBlock(blocks, targetEnd);
  if (block && targetEnd > block.start) {
    if (block.end - block.start <= activeSplitOptions.maxChars) {
      return block.start > start ? block.start : Math.min(block.end, sectionEnd);
    }
    const line = markdown.lastIndexOf('\n', targetEnd - 1);
    return line >= start ? line + 1 : targetEnd;
  }
  if (targetEnd >= markdown.length) return markdown.length;
  const paragraph = markdown.lastIndexOf('\n\n', targetEnd);
  if (paragraph > start + Math.floor(activeSplitOptions.maxChars * 0.55) && !insideBlock(blocks, paragraph)) return paragraph;
  const line = markdown.lastIndexOf('\n', targetEnd);
  if (line > start + Math.floor(activeSplitOptions.maxChars * 0.55) && !insideBlock(blocks, line)) return line;

  // Adaptive Semantic Boundary: search for sentence punctuation (。！？； or .!? followed by space)
  const minPos = start + Math.floor(activeSplitOptions.maxChars * 0.50);
  const slice = markdown.slice(minPos, targetEnd);
  const sentenceMatches = Array.from(slice.matchAll(/[。！？；]|(?<=[.!?])\s+/gu));
  if (sentenceMatches.length > 0) {
    const lastMatch = sentenceMatches[sentenceMatches.length - 1];
    const sentenceEnd = minPos + (lastMatch.index ?? 0) + lastMatch[0].length;
    if (sentenceEnd > minPos && sentenceEnd <= targetEnd && !insideBlock(blocks, sentenceEnd)) {
      return sentenceEnd;
    }
  }

  return targetEnd;
}

function extractTableHeader(text: string): string | null {
  const lines = tableLines(text);
  for (let index = 1; index < lines.length; index++) {
    if (isMarkdownTableDelimiter(lines[index])) return `${lines[index - 1]}\n${lines[index]}`;
  }
  return null;
}

export function getTableColumnCount(headerOrRow: string): number {
  const line = tableLines(headerOrRow)[0];
  return line ? parseMarkdownTableCells(line).length : 0;
}

export function parseTableRowsToKeyValues(tableText: string): { headers: string[]; rowsKv: string[] } {
  const lines = tableLines(tableText);
  const delimiter = lines.findIndex(isMarkdownTableDelimiter);
  if (delimiter < 1) return { headers: [], rowsKv: [] };
  const headers = parseMarkdownTableCells(lines[delimiter - 1]).map(cell => cell.replace(/\*\*/g, ''));
  const rowsKv: string[] = [];
  for (const row of lines.slice(delimiter + 1)) {
    if (isMarkdownTableDelimiter(row)) break;
    const cells = parseMarkdownTableCells(row).map(cell => cell.replace(/\*\*/g, ''));
    if (cells.every(cell => !cell)) continue;
    const parts = headers.flatMap((header, index) => header && cells[index] ? [`${header}: ${cells[index]}`] : []);
    if (parts.length) rowsKv.push(parts.join(' | '));
  }
  return { headers, rowsKv };
}

/**
 * Split parsed Markdown on heading boundaries and paragraph-safe windows.
 * Generates child chunks with attached parent section context for high-precision retrieval.
 */
export function splitMarkdownIntoChunks(markdown: string): IndexedMarkdownChunk[] {
  const cleanMarkdown = (markdown || '').replace(/\0/g, '').replace(/\u0000/g, '');
  
  const blocks = markdownBlocks(cleanMarkdown);

  // 1. Detect page markers
  type PageMarker = { index: number; pageNo: number };
  const pageMarkers: PageMarker[] = [];
  const pageRegex = /<!--\s*page\s+(\d+)\s*-->|---\s*page\s+(\d+)\s*---|(?:^|\n)##\s*第\s*(\d+)\s*页|\f/gi;
  let pMatch: RegExpExecArray | null;
  let autoPage = 1;
  while ((pMatch = pageRegex.exec(cleanMarkdown))) {
    if (insideBlock(blocks, pMatch.index)?.kind === 'code' || insideBlock(blocks, pMatch.index)?.kind === 'math') continue;
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
  const clauseMarkersCount = Array.from(cleanMarkdown.matchAll(clauseMarkerRegex)).filter(match => !insideBlock(blocks, match.index ?? 0)).length;
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
  const headingStack: Array<{ level: number; text: string }> = [];
  
  for (const section of findSections(cleanMarkdown, blocks)) {
    const sectionBody = cleanMarkdown.slice(section.start, section.end).trim();
    const isPageSection = !section.heading || /^#{1,6}\s*第\s*\d+\s*页/.test(section.heading);
    
    if (section.heading && !isPageSection) {
      const cleanHeading = section.heading.replace(/^#{1,6}\s+/, '').trim();
      const level = getHeadingHierarchyLevel(section.heading);
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text: cleanHeading });
      // If entering a major new section/chapter and this section has no table rows, reset carriedTableHeader
      if (level <= 2 && !/(?:^|\n)\s*\|[^\n]+\|/.test(sectionBody)) {
        carriedTableHeader = null;
      }
    }
    const currentBreadcrumb = headingStack.map((h) => h.text).join(' > ');
    const currentHeadingHierarchy = headingStack.map((h) => h.text);

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
    let lastTableHeader: string | null = ownTableHeader ?? carriedTableHeader;

    let start = section.start;
    let first = true;
    let actualOverlap = 0;
    while (start < section.end) {
      let end = section.end;
      if (!hasClauseStructure || (section.end - start > 5000)) {
        end = chooseBoundary(cleanMarkdown, start, Math.min(start + activeSplitOptions.maxChars, section.end), section.end, blocks);
        // If the remaining fragment after this split is tiny (< 150 chars, e.g. 1-2 table rows or half a sentence),
        // absorb it into the current chunk rather than creating an isolated orphaned fragment.
        if (section.end - end < 150) {
          end = section.end;
        }
      }
      
      const raw = cleanMarkdown.slice(start, end);
      let content = insideBlock(blocks, start)?.kind === 'code' ? raw : raw.trim();
      let syntheticFences = false;
      // Long fenced blocks retain valid Markdown in each fragment; synthetic
      // delimiters are projections, while charStart/End still identify source.
      for (const block of blocks.filter(block => block.kind === 'code' && block.start < end && block.end > start)) {
        if (start > block.start) { content = `${block.fence}${block.fenceInfo || ''}\n${content}`; syntheticFences = true; }
        if (end < block.end) { content = `${content}\n${block.fence}`; syntheticFences = true; }
      }
      // Extract OCR bounding boxes (emitted by the parser as hidden HTML
      // comments) and strip them from the indexed text so visual grounding
      // metadata never pollutes keyword/BM25 matching.
      const bboxes: Array<{ x: number; y: number; w: number; h: number; page?: number }> = [];
      const contentBlocks = markdownBlocks(content);
      content = content.replace(/<!--\s*bbox:(\d+),(\d+),(\d+),(\d+)\s*-->/g, (_full, x, y, w, h, offset) => {
        if (insideBlock(contentBlocks, offset)?.kind === 'code') return _full;
        bboxes.push({ x: Number(x), y: Number(y), w: Number(w), h: Number(h), page: getPageNo(start) });
        return '';
      }).trim();
      if (content) {
        // Table header propagation & fidelity (TAT-QA / MultiHiertt / TabFact optimization):
        // Automatically injects table headers into continuation chunks that contain orphan table rows.
        const containsHeader = !!extractTableHeader(content);
        let tableHeaderAdded = false;

        if (containsHeader) {
          const newHeader = extractTableHeader(content);
          if (newHeader) {
            lastTableHeader = newHeader;
            carriedTableHeader = newHeader;
          }
        } else if (lastTableHeader) {
          const headerColCount = getTableColumnCount(lastTableHeader);
          const lines = content.split(/\r?\n/);
          const availableTableRows = new Set(tableLines(content));
          const firstTableRowIdx = lines.findIndex((l) => {
            const trimmed = l.trim();
            return availableTableRows.has(trimmed) && !isMarkdownTableDelimiter(trimmed);
          });
          if (firstTableRowIdx >= 0) {
            const rowColCount = getTableColumnCount(lines[firstTableRowIdx]);
            if (headerColCount > 0 && Math.abs(rowColCount - headerColCount) <= 1) {
              lines.splice(firstTableRowIdx, 0, lastTableHeader);
              content = lines.join('\n');
              tableHeaderAdded = true;
            }
          }
        }

        let withHeading = !first && section.heading && !content.startsWith(section.heading)
          ? `${section.heading}\n\n${content}`
          : content;
          
        const hasTableContent = containsHeader || tableHeaderAdded || tableLines(content).length > 0;
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
            const rowsToInject = tableInfo.rowsKv.slice(0, 40);
            // Table-level summary: row/column shape makes cross-row / cross-column
            // comparison questions ("A 部门 Q1 比 B 部门高多少") answerable even
            // though the per-row key/value comments alone flatten the 2D structure.
            const columnList = tableInfo.headers.length > 0 ? `，列: ${tableInfo.headers.join(' / ')}` : '';
            const tableSummary = `<!-- 表格结构摘要: 共 ${tableInfo.rowsKv.length} 行${columnList}；下表为行级语义 -->`;
            const tableSemantics = `\n\n${tableSummary}\n<!-- 表格结构化行语义:\n${rowsToInject.join('\n')}\n-->`;
            withHeading += tableSemantics;
          }
        }

        // Heading hierarchy breadcrumb inheritance: if chunk has parent headings (e.g. Chapter > Section > Article),
        // record and inject hierarchy tag so search and LLM context retain complete structural lineage even across chunk splits.
        if (currentHeadingHierarchy.length >= 2) {
          const breadcrumbTag = `<!-- 大纲层级: ${currentBreadcrumb} -->`;
          if (!withHeading.includes(breadcrumbTag)) {
            withHeading = `${breadcrumbTag}\n${withHeading}`;
          }
        }

        const metadata: IndexedMarkdownChunk['metadata'] = {
          section: section.heading || '文档正文',
          breadcrumb: currentBreadcrumb || section.heading || '文档正文',
          heading_hierarchy: currentHeadingHierarchy,
          parentContext: sectionBody.length <= 4000 ? sectionBody : undefined,
          parentChunkId: typeof section.start === "number" ? `section:${section.start}` : undefined,
          tableRole: hasTableContent
            ? classifyTableRole({
                rowCount: tableRowsCount,
                headerText: withHeading.slice(0, 400),
                section: section.heading,
              })
            : undefined,
          chunkStrategy: hasClauseStructure ? 'clause-based' : 'parent-child-section-window',
          overlapChars: actualOverlap,
          ...(syntheticFences ? { synthetic_code_fences: true } : {}),
          source_blocks: blocks.filter(block => block.start < end && block.end > start).map(block => ({ kind: block.kind, char_start: block.start, char_end: block.end, fragment_start: Math.max(start, block.start), fragment_end: Math.min(end, block.end), continued: start > block.start || end < block.end })),
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
      let nextStart = Math.max(start + 1, end - activeSplitOptions.overlapChars);
      const overlapBlock = insideBlock(blocks, nextStart);
      if (overlapBlock) {
        if (overlapBlock.end - overlapBlock.start <= activeSplitOptions.maxChars) nextStart = overlapBlock.start > start ? overlapBlock.start : end;
        else { const newline = cleanMarkdown.indexOf('\n', nextStart); if (newline >= 0 && newline < end) nextStart = newline + 1; }
      }
      actualOverlap = Math.max(0, end - nextStart);
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
