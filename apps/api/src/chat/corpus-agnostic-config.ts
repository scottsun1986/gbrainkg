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
  let relation: Record<string, string[]> = {};
  if (env.RELATION_SURFACE_FORMS_JSON) {
    try {
      relation = JSON.parse(env.RELATION_SURFACE_FORMS_JSON);
    } catch {
      relation = {};
    }
  }
  return {
    enableLegalStructureBoost:
      String(env.ENABLE_LEGAL_STRUCTURE_BOOST ?? '1').toLowerCase() !== '0',
    relationSurfaceForms: relation,
    promptDomainExamples: GENERIC_EXAMPLES,
  };
}

/**
 * 通用（非业务）关系词表：亲属/创作者/地点等多跳桥接常用关系。
 * 可通过 RELATION_SURFACE_FORMS_JSON 扩展或覆盖；禁止加入部署方业务词。
 */
export const DEFAULT_RELATION_SURFACE_FORMS: Record<string, string[]> = {
  director: ['director', 'directed', 'directs', 'direct'],
  author: ['author', 'authored', 'writer', 'written', 'wrote'],
  writer: ['writer', 'written', 'wrote', 'author'],
  creator: ['creator', 'created', 'founded'],
  founder: ['founder', 'founded'],
  composer: ['composer', 'composed'],
  producer: ['producer', 'produced'],
  husband: ['husband', 'married', 'spouse'],
  wife: ['wife', 'married', 'spouse'],
  spouse: ['spouse', 'married', 'husband', 'wife'],
  father: ['father', 'son of', 'daughter of'],
  mother: ['mother', 'son of', 'daughter of'],
  born: ['born', 'birth', 'birthplace'],
  birthplace: ['born', 'birth', 'birthplace'],
  died: ['died', 'death', 'buried'],
  publisher: ['publisher', 'published by'],
  employer: ['employer', 'employed by'],
};

export function resolveRelationSurfaceForms(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string[]> {
  const base = { ...DEFAULT_RELATION_SURFACE_FORMS };
  if (env.RELATION_SURFACE_FORMS_JSON) {
    try {
      const extra = JSON.parse(env.RELATION_SURFACE_FORMS_JSON) as Record<string, string[]>;
      for (const [k, v] of Object.entries(extra)) {
        base[k] = Array.from(new Set([...(base[k] || []), ...v]));
      }
    } catch {
      /* keep defaults */
    }
  }
  return base;
}
