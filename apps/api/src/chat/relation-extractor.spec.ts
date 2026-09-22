import { extractRelationFromQuery, surfaceFormsForRelation } from './relation-extractor';

describe('relation-extractor', () => {
  it('extracts generic relation words from queries', () => {
    expect(extractRelationFromQuery('Who is the director of Blade Runner?')).toBe('director');
    expect(extractRelationFromQuery('他的父亲是谁')).toBe('父亲');
    expect(extractRelationFromQuery('what is the weather today')).toBeNull();
  });

  it('resolves surface forms including defaults + env extension', () => {
    const forms = surfaceFormsForRelation('director');
    expect(forms).toContain('director');
    expect(forms).toContain('directed');
  });
});
