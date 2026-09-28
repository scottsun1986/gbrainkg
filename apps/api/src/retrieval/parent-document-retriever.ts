/**
 * Parent-Document Retriever：命中子块后回填父块/兄弟邻域，供 rerank 与生成使用。
 * parentChunkId 指向父块；同 documentId + 邻接 ord 作兄弟扩展。
 */
export interface ChildHit {
  id: string;
  documentId: string;
  kbId: string;
  ord: number;
  content: string;
  parentChunkId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ParentBundle {
  parentId: string;
  parentContent: string;
  childIds: string[];
  mergedContent: string;
  documentId: string;
  kbId: string;
}

export function groupByParent(hits: ChildHit[]): Map<string, ChildHit[]> {
  const groups = new Map<string, ChildHit[]>();
  for (const hit of hits) {
    const key = hit.parentChunkId || `__child__:${hit.id}`;
    const list = groups.get(key) ?? [];
    list.push(hit);
    groups.set(key, list);
  }
  return groups;
}

/**
 * 合并策略：父块文本优先（更完整）；无父块时按 ord 排序拼接子块并去重重叠尾部。
 */
export function buildParentBundle(
  parentKey: string,
  children: ChildHit[],
  parentContentById: Map<string, string>,
): ParentBundle {
  const sorted = [...children].sort((a, b) => a.ord - b.ord);
  const first = sorted[0];
  const parentContent = parentContentById.get(parentKey) ?? '';
  const mergedChild = sorted.map((c) => c.content).join('\n');
  const mergedContent =
    parentContent && parentContent.length >= mergedChild.length
      ? parentContent
      : parentContent
        ? dedupeOverlap(parentContent, mergedChild)
        : mergedChild;
  return {
    parentId: parentKey,
    parentContent,
    childIds: sorted.map((c) => c.id),
    mergedContent,
    documentId: first.documentId,
    kbId: first.kbId,
  };
}

/**
 * 若 child 内容几乎包含于 parent，返回 parent；否则 parent+child 拼接去掉重复后缀/前缀。
 * 重叠窗口上限 4096 字符：100KB 级 parent/child 下朴素循环每 bundle 约 10^8 次字符拷贝，
 * 超过 4096 的重叠本质是整段包含，由调用方的父块优先分支处理。
 */
export function dedupeOverlap(parent: string, child: string): string {
  const max = Math.min(parent.length, child.length, 4096);
  for (let i = max; i > 12; i--) {
    if (parent.endsWith(child.slice(0, i))) {
      return parent + child.slice(i);
    }
    if (child.endsWith(parent.slice(0, i))) {
      return child + parent.slice(i);
    }
  }
  return `${parent}\n${child}`;
}

export type SiblingFetcher = (
  documentId: string,
  ordFrom: number,
  ordTo: number,
) => Promise<ChildHit[]>;

/**
 * 按 ord ±window 拉取兄弟块（缺失的邻块从库中补齐）。
 * 同 documentId 的命中合并为一个区间查询（每文档一次，而非每命中一次），
 * 避免 N+1；各文档的查询并发执行。
 */
export async function expandSiblings(
  hits: ChildHit[],
  fetchRange: SiblingFetcher,
  window = 1,
): Promise<ChildHit[]> {
  const out = new Map<string, ChildHit>();
  for (const h of hits) out.set(h.id, h);
  const rangesByDoc = new Map<string, { from: number; to: number }>();
  for (const h of hits) {
    const range = rangesByDoc.get(h.documentId);
    if (!range) {
      rangesByDoc.set(h.documentId, { from: h.ord - window, to: h.ord + window });
    } else {
      range.from = Math.min(range.from, h.ord - window);
      range.to = Math.max(range.to, h.ord + window);
    }
  }
  await Promise.all(
    [...rangesByDoc.entries()].map(async ([documentId, range]) => {
      const extras = await fetchRange(documentId, range.from, range.to);
      for (const e of extras) out.set(e.id, e);
    }),
  );
  return [...out.values()];
}
