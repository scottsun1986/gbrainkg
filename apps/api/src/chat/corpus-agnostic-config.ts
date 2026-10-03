/**
 * Corpus-Agnostic 检索提示配置。
 * 禁止在业务代码硬编码行业词表/场景示例；结构启发式（法条/章条）可按语料开关。
 * 禁词清单与扫描逻辑放在 corpus-agnostic-policy.spec.ts / corpus-agnostic-config.spec.ts。
 */
export interface CorpusAgnosticConfig {
  /** 法条/章条结构加权（中文法规类语料默认开；技术文档/英文合同可关） */
  enableLegalStructureBoost: boolean;
  /** 关系词表：默认空 = 交由 LLM 判别；可由 KB domainTerms 注入 */
  relationSurfaceForms: Record<string, string[]>;
  /** 提示词场景示例：默认通用，禁止业务场景泄漏 */
  promptDomainExamples: string[];
}

const GENERIC_EXAMPLES = [
  '时间范围与生效日期以现行有效版本为准',
  '跨文档冲突时并列呈现各方说法并标注来源',
  '清单/统计类问题需要完整枚举而非抽样',
];

export function loadCorpusConfig(env: NodeJS.ProcessEnv = process.env): CorpusAgnosticConfig {
  const relation = resolveRelationSurfaceForms(env);
  return {
    enableLegalStructureBoost:
      String(env.ENABLE_LEGAL_STRUCTURE_BOOST ?? '1').toLowerCase() !== '0',
    relationSurfaceForms: relation,
    promptDomainExamples: GENERIC_EXAMPLES,
  };
}

/** Relation aliases are explicitly supplied by deployment configuration. */
export function resolveRelationSurfaceForms(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string[]> {
  if (!env.RELATION_SURFACE_FORMS_JSON) return {};
  try {
    const raw: unknown = JSON.parse(env.RELATION_SURFACE_FORMS_JSON);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).slice(0, 100).flatMap(([key, value]) => {
      if (!key.trim() || key.length > 80 || !Array.isArray(value)) return [];
      const forms = [...new Set(value.filter((v): v is string => typeof v === 'string' && !!v.trim() && v.length <= 80).map(v => v.trim()))].slice(0, 64);
      return forms.length ? [[key.trim().toLowerCase(), forms]] : [];
    }));
  } catch { return {}; }
}
