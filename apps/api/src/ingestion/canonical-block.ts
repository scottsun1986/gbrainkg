import { createHash } from 'node:crypto';
import { indexableChunkText } from './chunk-text';

export type CanonicalBlockKind = 'text' | 'table' | 'mixed';

export interface CanonicalBlockV1 {
  schema: 'canonical-block/v1';
  id: string;
  document: {
    id: string;
    kbId: string;
    title: string;
    version: number;
    sourceType: string;
  };
  position: {
    ord: number;
    charStart: number;
    charEnd: number;
    page?: number;
    section?: string;
    breadcrumb?: string;
    article?: number;
  };
  structure: {
    kind: CanonicalBlockKind;
    headingHierarchy: string[];
    tableHeaders: string[];
    tableRows?: number;
    bboxes: Array<{ x: number; y: number; w: number; h: number; page?: number }>;
    previousOrd?: number;
    nextOrd?: number;
  };
  content: {
    sha256: string;
    indexableSha256: string;
    tokenCount: number;
  };
  retrieval: {
    dense: boolean;
    sparse: boolean;
    multiVector: boolean;
    contextualized: boolean;
  };
}

export function buildCanonicalBlock(input: {
  document: { id: string; kbId: string; title: string; version: number; sourceType: string };
  chunk: {
    ord: number;
    content: string;
    tokenCount: number;
    charStart: number;
    charEnd: number;
    metadata?: Record<string, any> | null;
  };
}): CanonicalBlockV1 {
  const metadata = input.chunk.metadata || {};
  const hasTable = metadata.has_table === true || /(?:^|\n)\s*\|[^\n]+\|/u.test(input.chunk.content);
  const hasText = input.chunk.content
    .split(/\r?\n/)
    .some((line) => line.trim() && !line.trim().startsWith('|') && !line.trim().startsWith('<!--'));
  const kind: CanonicalBlockKind = hasTable && hasText ? 'mixed' : hasTable ? 'table' : 'text';
  const indexable = indexableChunkText(input.chunk.content);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');

  return {
    schema: 'canonical-block/v1',
    id: `${input.document.id}:v${input.document.version}:${input.chunk.ord}`,
    document: { ...input.document },
    position: {
      ord: input.chunk.ord,
      charStart: input.chunk.charStart,
      charEnd: input.chunk.charEnd,
      ...(Number.isFinite(Number(metadata.page_no)) ? { page: Number(metadata.page_no) } : {}),
      ...(metadata.section ? { section: String(metadata.section) } : {}),
      ...(metadata.breadcrumb ? { breadcrumb: String(metadata.breadcrumb) } : {}),
      ...(Number.isFinite(Number(metadata.article_no)) ? { article: Number(metadata.article_no) } : {}),
    },
    structure: {
      kind,
      headingHierarchy: Array.isArray(metadata.heading_hierarchy)
        ? metadata.heading_hierarchy.map(String).filter(Boolean)
        : [],
      tableHeaders: Array.isArray(metadata.table_headers)
        ? metadata.table_headers.map(String).filter(Boolean)
        : [],
      ...(Number.isFinite(Number(metadata.table_rows_count)) ? { tableRows: Number(metadata.table_rows_count) } : {}),
      bboxes: Array.isArray(metadata.bboxes)
        ? metadata.bboxes.filter((bbox: any) => bbox && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(Number(bbox[key]))))
        : metadata.bbox ? [metadata.bbox] : [],
      ...(Number.isFinite(Number(metadata.prev_chunk_ord)) ? { previousOrd: Number(metadata.prev_chunk_ord) } : {}),
      ...(Number.isFinite(Number(metadata.next_chunk_ord)) ? { nextOrd: Number(metadata.next_chunk_ord) } : {}),
    },
    content: {
      sha256: hash(input.chunk.content),
      indexableSha256: hash(indexable),
      tokenCount: input.chunk.tokenCount,
    },
    retrieval: {
      dense: false,
      sparse: false,
      multiVector: false,
      contextualized: Boolean(metadata.contextual_prefix),
    },
  };
}

export function canonicalBlockFromMetadata(metadata: unknown): CanonicalBlockV1 | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const block = (metadata as any).canonical_block;
  return block?.schema === 'canonical-block/v1' ? block as CanonicalBlockV1 : null;
}
