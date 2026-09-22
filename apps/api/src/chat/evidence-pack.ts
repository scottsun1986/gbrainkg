export interface EvidencePackCitation {
  subQueryOrigin?: string;
  subQueryOrigins?: string[];
  bridgeRescue?: boolean;
  floorExemptReason?: string;
  hop?: number;
  [key: string]: unknown;
}

export interface EvidenceReasoningGroup {
  kind: 'direct' | 'subquery' | 'bridge';
  label: string;
  sourceIndexes: number[];
}

export interface StructuredEvidencePlan<T extends EvidencePackCitation> {
  citations: T[];
  groups: EvidenceReasoningGroup[];
  applied: boolean;
}

export interface BoundedEvidenceResult<T extends EvidencePackCitation> {
  citations: T[];
  usedTokens: number;
  dropped: number;
  truncated: number;
  protectedEvidenceCount: number;
}

function normalize(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function originsOf(citation: EvidencePackCitation): string[] {
  const values = [citation.subQueryOrigin, ...(citation.subQueryOrigins || [])]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function isBridge(citation: EvidencePackCitation): boolean {
  return citation.bridgeRescue === true ||
    citation.floorExemptReason === 'multi_hop_bridge' ||
    (typeof citation.hop === 'number' && citation.hop >= 2);
}

function sameProbe(left: string, right: string): boolean {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  if (a === b) return true;
  // Probe planners occasionally add a short relation suffix. Containment is
  // safe here because this metadata was produced by our own query planner, not
  // by arbitrary document text.
  return a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a));
}

/**
 * Arrange a compound question's evidence so the hard context cap cannot spend
 * its entire budget on the dominant first hop before seeing the other hops.
 * The top global result remains first; one representative from every planned
 * sub-question and the bridge set follows; all remaining results retain their
 * original relative order.
 */
export function planStructuredEvidence<T extends EvidencePackCitation>(
  citations: T[],
  options: { complexity?: string; subQueries?: string[]; enabled?: boolean },
): StructuredEvidencePlan<T> {
  const original = [...(citations || [])];
  const compound = options.complexity === 'multi_hop' || options.complexity === 'comparative';
  if (options.enabled === false || !compound || original.length <= 1) {
    return { citations: original, groups: [], applied: false };
  }

  const probes = [...new Set((options.subQueries || []).map((q) => String(q || '').trim()).filter(Boolean))]
    .slice(0, 6);
  const hasStructuredMetadata = original.some((citation) => originsOf(citation).length > 0 || isBridge(citation));
  if (!hasStructuredMetadata) return { citations: original, groups: [], applied: false };

  const ordered: T[] = [];
  const used = new Set<T>();
  const add = (citation: T | undefined) => {
    if (!citation || used.has(citation)) return;
    used.add(citation);
    ordered.push(citation);
  };

  // Preserve the strongest global anchor, then guarantee one result per hop.
  add(original[0]);
  for (const probe of probes) {
    add(original.find((citation) => originsOf(citation).some((origin) => sameProbe(origin, probe))));
  }
  // Keep planner-discovered origins even when allHopProbes was shortened or a
  // provider supplied its own probe metadata.
  const observedOrigins = [...new Set(original.flatMap((citation) => originsOf(citation).map(normalize)))]
    .filter(Boolean)
    .slice(0, 6);
  for (const origin of observedOrigins) {
    add(original.find((citation) => originsOf(citation).some((value) => normalize(value) === origin)));
  }
  add(original.find((citation) => isBridge(citation)));
  for (const citation of original) add(citation);

  return {
    citations: ordered,
    groups: buildEvidenceReasoningGroups(ordered),
    applied: ordered.some((citation, index) => citation !== original[index]),
  };
}

export function buildEvidenceReasoningGroups(
  citations: EvidencePackCitation[],
): EvidenceReasoningGroup[] {
  const originGroups = new Map<string, { label: string; indexes: number[] }>();
  const direct: number[] = [];
  const bridge: number[] = [];

  citations.forEach((citation, index) => {
    const sourceIndex = index + 1;
    const origins = originsOf(citation);
    if (!origins.length) direct.push(sourceIndex);
    for (const origin of origins) {
      const key = normalize(origin);
      const group = originGroups.get(key) || { label: origin, indexes: [] };
      if (!group.indexes.includes(sourceIndex)) group.indexes.push(sourceIndex);
      originGroups.set(key, group);
    }
    if (isBridge(citation)) bridge.push(sourceIndex);
  });

  const groups: EvidenceReasoningGroup[] = [];
  if (direct.length) groups.push({ kind: 'direct', label: 'direct', sourceIndexes: direct });
  for (const group of [...originGroups.values()].slice(0, 6)) {
    groups.push({ kind: 'subquery', label: group.label, sourceIndexes: group.indexes });
  }
  if (bridge.length) groups.push({ kind: 'bridge', label: 'bridge', sourceIndexes: [...new Set(bridge)] });
  return groups;
}

function compactLabel(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > 100 ? `${clean.slice(0, 97)}...` : clean;
}

/** A compact routing guide. It contains source indexes only and adds no facts. */
export function formatEvidenceReasoningMap(
  groups: EvidenceReasoningGroup[],
  isEnglish: boolean,
): string {
  const useful = groups.filter((group) => group.sourceIndexes.length > 0);
  const subqueryCount = useful.filter((group) => group.kind === 'subquery').length;
  if (subqueryCount === 0 && !useful.some((group) => group.kind === 'bridge')) return '';

  const lines = useful.map((group) => {
    const refs = group.sourceIndexes.map((index) => `[${index}]`).join('');
    if (isEnglish) {
      if (group.kind === 'direct') return `- Direct evidence: ${refs}`;
      if (group.kind === 'bridge') return `- Bridge evidence: ${refs}`;
      return `- Sub-question "${compactLabel(group.label)}": ${refs}`;
    }
    if (group.kind === 'direct') return `- 原问题直接证据：${refs}`;
    if (group.kind === 'bridge') return `- 桥接证据：${refs}`;
    return `- 子问题“${compactLabel(group.label)}”：${refs}`;
  });

  if (isEnglish) {
    return `【Evidence reasoning map (routing metadata, not factual evidence)】\n${lines.join('\n')}\nResolve each sub-question with its mapped sources, then combine the supported conclusions. Cite only the source indexes.`;
  }
  return `【证据推理图（仅为路由元数据，不构成事实证据）】\n${lines.join('\n')}\n请先用各组来源逐项解决对应子问题，再合并已有证据支持的结论；引用只能使用来源编号。`;
}

/**
 * Apply the final answer-context cap with a per-reasoning-group reservation.
 * `truncate` and `normalizeText` are injected so this policy stays independent
 * from Markdown/table formatting details.
 */
export function fitStructuredEvidenceToBudget<T extends EvidencePackCitation>(
  citations: T[],
  groups: EvidenceReasoningGroup[],
  options: {
    hardCap: number;
    structured: boolean;
    textOf: (citation: T) => string;
    normalizeText: (text: string) => string;
    truncate: (text: string, tokenBudget: number) => string;
  },
): BoundedEvidenceResult<T> {
  const protectedIndexes = new Set<number>(citations.length ? [1] : []);
  for (const group of groups) {
    if (group.sourceIndexes[0]) protectedIndexes.add(group.sourceIndexes[0]);
  }
  const protectedTokenCap = options.structured && protectedIndexes.size
    ? Math.max(80, Math.floor((options.hardCap * 0.8) / protectedIndexes.size))
    : options.hardCap;
  const evidenceHardCap = Math.max(80, Math.floor(options.hardCap * 0.92));
  const kept: T[] = [];
  let usedTokens = 0;
  let dropped = 0;
  let truncated = 0;

  for (let index = 0; index < citations.length; index += 1) {
    const citation = citations[index];
    const rawText = options.normalizeText(options.textOf(citation));
    const protectedEvidence = options.structured && protectedIndexes.has(index + 1);
    const promptText = options.truncate(rawText, protectedEvidence ? protectedTokenCap : evidenceHardCap);
    const size = estimateTokens(promptText);
    if (!protectedEvidence && kept.length > 0 && usedTokens + size > evidenceHardCap) {
      dropped += 1;
      continue;
    }
    if (promptText !== rawText) truncated += 1;
    kept.push({
      ...citation,
      context: promptText,
      snippet: promptText,
      evidence: promptText,
      ...(promptText !== rawText ? { answerContextTruncated: true } : {}),
    });
    usedTokens += size;
  }

  return {
    citations: kept,
    usedTokens,
    dropped,
    truncated,
    protectedEvidenceCount: protectedIndexes.size,
  };
}
import { estimateTokens } from './context-budget';
