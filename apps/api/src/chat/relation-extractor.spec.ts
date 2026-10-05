import { extractRelationFromQuery, surfaceFormsForRelation, shouldProbeEvidenceHops } from './relation-extractor';

describe('relation-extractor', () => {
  const original = process.env.RELATION_SURFACE_FORMS_JSON;
  beforeEach(() => { delete process.env.RELATION_SURFACE_FORMS_JSON; });
  afterEach(() => {
    if (original === undefined) delete process.env.RELATION_SURFACE_FORMS_JSON;
    else process.env.RELATION_SURFACE_FORMS_JSON = original;
  });
  it.each([
    ['Who is the director of Blade Runner?', 'director'],
    ['他的父亲是谁', '父亲'],
    ['What is the calibration custodian of Device Q?', 'calibration custodian'],
    ["Who is Device Q's maintenance contractor?", 'maintenance contractor'],
    ['这个项目的复核单位是什么', '复核单位'],
    ['what is the weather today', null],
    ['普通的问题没有关系词', null],
  ])('extracts relation syntax without a subject dictionary: %s', (query, expected) => {
    expect(extractRelationFromQuery(query)).toBe(expected);
  });
  it('does not inject unconfigured semantic aliases', () => {
    expect(surfaceFormsForRelation('director')).toEqual(['director']);
    expect(surfaceFormsForRelation('custodian')).toEqual(['custodian']);
  });
  it('does not judge a simple attribute lookup merely because it has a relation name', () => {
    expect(extractRelationFromQuery('这个项目的复核单位是什么')).toBe('复核单位');
    expect(shouldProbeEvidenceHops('simple', [], [])).toBe(false);
  });
  it.each([
    ['multi_hop', [], []],
    ['comparative', [], []],
    ['simple', ['planned query'], []],
    ['simple', [], ['validated entity']],
  ])('keeps evidence hops for %s with planned or validated bridges', (complexity, subQueries, bridgeSeeds) => {
    expect(shouldProbeEvidenceHops(complexity as string, subQueries as string[], bridgeSeeds as string[])).toBe(true);
  });
  it('uses explicit aliases and matches complete words', () => {
    process.env.RELATION_SURFACE_FORMS_JSON = JSON.stringify({custodian:['held by']});
    expect(extractRelationFromQuery('Which component is held by Unit Q?')).toBe('custodian');
    expect(extractRelationFromQuery('Which component is withheld by Unit Q?')).toBeNull();
    expect(surfaceFormsForRelation('custodian')).toEqual(['custodian','held by']);
  });
});
