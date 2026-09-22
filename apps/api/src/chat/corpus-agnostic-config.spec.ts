import { loadCorpusConfig } from './corpus-agnostic-config';

describe('corpus-agnostic-config', () => {
  it('defaults to empty relation table and generic examples', () => {
    const cfg = loadCorpusConfig({});
    expect(cfg.relationSurfaceForms).toEqual({});
    expect(cfg.promptDomainExamples.length).toBeGreaterThan(0);
    // 通用示例不得出现行业场景词（由 policy spec 全量扫描，这里做语义断言）
    expect(cfg.promptDomainExamples.join('')).toMatch(/生效版本|冲突|枚举/);
    expect(cfg.enableLegalStructureBoost).toBe(true);
  });

  it('loads relation surface forms from env JSON', () => {
    const cfg = loadCorpusConfig({
      RELATION_SURFACE_FORMS_JSON: '{"relates_to":["关联","相关"]}',
    } as NodeJS.ProcessEnv);
    expect(cfg.relationSurfaceForms.relates_to).toContain('关联');
  });

  it('can disable legal structure boost', () => {
    const cfg = loadCorpusConfig({ ENABLE_LEGAL_STRUCTURE_BOOST: '0' } as NodeJS.ProcessEnv);
    expect(cfg.enableLegalStructureBoost).toBe(false);
  });
});
