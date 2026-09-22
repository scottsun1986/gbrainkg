/**
 * 小节救援（P2-03）：当候选来自某文档但未覆盖问题点名的小节时，
 * 从同一文档补拉匹配小节/汇总表分片，避免长明细表垄断上下文。
 */
import { extractSectionAnchors, classifyTableRole, SectionAlignInput } from './section-align';

export interface RescueChunk extends SectionAlignInput {
  id: string;
  documentId: string;
  kbId: string;
  ord: number;
  content: string;
  score?: number | null;
  metadata?: any;
}

export function needsSectionRescue(
  query: string,
  citations: Array<{
    section?: string | null;
    breadcrumb?: string | null;
    evidence?: string | null;
    tableRole?: string | null;
    headingHierarchy?: string[] | null;
    heading_hierarchy?: string[] | null;
    table_role?: string | null;
  }>,
): boolean {
  const anchors = extractSectionAnchors(query).filter((a) => a.length >= 2);
  if (!anchors.length) return false;
  const queryWantsSection =
    anchors.some((a) => /汇总|合计|统计|总则|附则|附录|摘要|明细/.test(a)) ||
    /汇总|合计|统计/.test(query);
  if (!queryWantsSection) return false;
  // If a summary-role chunk is already in the pool, no rescue needed.
  const hasSummaryRole = citations.some((c) => {
    const role = c.tableRole || c.table_role;
    return role === 'summary';
  });
  if (hasSummaryRole) return false;
  // Trigger whenever the pool has no structurally matching section.
  // Contextual prefixes often mention 汇总 on every chunk, so only
  // section/breadcrumb/heading count as coverage.
  // Covered only when a citation is *structurally* in the named section
  // (section/breadcrumb/heading) or is already a summary-role table.
  // Do NOT treat body/context-prefix mentions of 汇总 as coverage — contextual
  // retrieval prefixes often mention the summary sheet on every chunk (P2-03).
  const covered = citations.some((c) => {
    const structural = `${c.section || ''} ${c.breadcrumb || ''} ${(c.headingHierarchy || c.heading_hierarchy || []).join(' ')}`;
    const role = c.tableRole || c.table_role;
    if (role === 'summary') return true;
    return anchors.some((a) => a.length >= 2 && structural.includes(a));
  });
  return !covered;
}

export function pickRescueTargets(
  query: string,
  citations: Array<{
    documentId?: string | null;
    docId?: string | null;
    kbId?: string | null;
  }>,
  limit = 3,
): Array<{ documentId: string; kbId: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ documentId: string; kbId: string | null }> = [];
  for (const c of citations) {
    const documentId = c.documentId || c.docId;
    if (!documentId || seen.has(documentId)) continue;
    seen.add(documentId);
    out.push({ documentId, kbId: c.kbId ?? null });
    if (out.length >= limit) break;
  }
  return out;
}

/** 过滤补拉结果：仅保留结构上命中锚点或 summary 表角色的块。 */
export function filterRescueHits(query: string, hits: RescueChunk[]): RescueChunk[] {
  const anchors = extractSectionAnchors(query);
  return hits.filter((h) => {
    const role = (h.tableRole ||
      classifyTableRole({ headerText: h.content, section: h.section })) as string;
    const structural = `${h.section || ''} ${h.breadcrumb || ''} ${(h.headingHierarchy || []).join(' ')}`;
    const matched = anchors.some((a) => a.length >= 2 && structural.includes(a));
    const summaryish = role === 'summary' && /汇总|合计|统计|编号|序号/.test(query + h.content.slice(0, 80));
    return matched || summaryish;
  });
}

export function toAlignInput(h: RescueChunk): SectionAlignInput {
  return {
    section: h.section,
    breadcrumb: h.breadcrumb,
    headingHierarchy: h.headingHierarchy,
    title: h.title,
    tableRole: h.tableRole,
    evidence: h.content,
  };
}
