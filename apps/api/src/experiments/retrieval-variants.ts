/**
 * 检索变体的 shadow 对比工具：给 control/treatment 两套 RETRIEV AL_* 参数，
 * 跑双路检索并 diff 命中集合，供 AbExperimentService.runWithShadow 使用。
 */
export interface RetrievalVariantParams {
  rrfK?: number;
  graphWeight?: number;
  sparseWeight?: number;
  lateWeight?: number;
  rerankMaxDocs?: number;
  subqueryProbesMax?: number;
}

export const CONTROL_VARIANT: RetrievalVariantParams = {
  rrfK: Number(process.env.RETRIEVAL_RRF_K || 60),
  graphWeight: Number(process.env.RETRIEVAL_GRAPH_RRF_WEIGHT || 0.8),
  sparseWeight: Number(process.env.RETRIEVAL_BGE_M3_SPARSE_RRF_WEIGHT || 0.9),
  lateWeight: Number(process.env.RETRIEVAL_BGE_M3_LATE_RRF_WEIGHT || 1.0),
  rerankMaxDocs: Number(process.env.RERANK_MAX_DOCS || 60),
  subqueryProbesMax: Number(process.env.RETRIEVAL_SUBQUERY_PROBES_MAX || 4),
};

/** treatment 候选：加权图谱/稀疏通道，多探针，不改默认部署行为。 */
export const TREATMENT_VARIANT: RetrievalVariantParams = {
  ...CONTROL_VARIANT,
  rrfK: 40,
  graphWeight: 1.0,
  sparseWeight: 1.0,
  subqueryProbesMax: 6,
};

export interface CitationHit {
  documentId?: string | null;
  kbId?: string | null;
  evidence?: string;
  score?: number;
  [key: string]: unknown;
}

export function diffCitationSets(
  control: CitationHit[],
  treatment: CitationHit[],
): Record<string, unknown> {
  const keyOf = (c: CitationHit) =>
    `${c.documentId || ''}:${(c.evidence || '').slice(0, 40)}`;
  const a = new Set(control.map(keyOf));
  const b = new Set(treatment.map(keyOf));
  const onlyControl = [...a].filter((k) => !b.has(k));
  const onlyTreatment = [...b].filter((k) => !a.has(k));
  const overlap = [...a].filter((k) => b.has(k));
  const rankCorrelation = overlap.length / Math.max(1, Math.max(a.size, b.size));
  return {
    controlSize: control.length,
    treatmentSize: treatment.length,
    overlap: overlap.length,
    onlyControl: onlyControl.slice(0, 10),
    onlyTreatment: onlyTreatment.slice(0, 10),
    jaccard: overlap.length / Math.max(1, a.size + b.size - overlap.length),
    rankCorrelation,
  };
}

export function applyVariantParams(
  base: RetrievalVariantParams,
): Record<string, string> {
  return {
    RETRIEVAL_RRF_K: String(base.rrfK ?? 60),
    RETRIEVAL_GRAPH_RRF_WEIGHT: String(base.graphWeight ?? 0.8),
    RETRIEVAL_BGE_M3_SPARSE_RRF_WEIGHT: String(base.sparseWeight ?? 0.9),
    RETRIEVAL_BGE_M3_LATE_RRF_WEIGHT: String(base.lateWeight ?? 1.0),
    RERANK_MAX_DOCS: String(base.rerankMaxDocs ?? 60),
    RETRIEVAL_SUBQUERY_PROBES_MAX: String(base.subqueryProbesMax ?? 4),
  };
}
