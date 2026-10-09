import { countDocumentNeedle, countDocumentTitleTerms, countDocumentTitleMatches, countTables, executeCount, cachedCountPlan, rememberCountPlan, normalizeCountPlan, countSchema } from './table-count';
const table = countTables('| 编号 | 团队名称 | 部门 | 得分 |\n| --- | --- | --- | --- |\n| 1 | 甲 | 研发组 | 90 |\n| 2 | 乙 | 研发组 | 95 |\n| 3 | 丙 | 运维组 | 99 |\n| 4 | 丁 | 研发组 | 80 |');
const plan = (operator: 'gt'|'gte', value = '90') => ({ table: 0, filters: [
  {column:2,operator:'eq',value:'研发组'}, {column:3,operator,value},
] });
describe('complete table conditional counts', () => {
  it('counts intersections, excludes a score equal to a strict boundary', () => {
    const r = executeCount(table, plan('gt'), '研发组超过90的有几支');
    expect(r.count).toBe(1); expect(r.matched[0].cells[1]).toBe('乙');
  });
  it('includes the boundary only when requested', () => {
    expect(executeCount(table, plan('gte'), '研发组90分及以上的数量').count).toBe(2);
    expect(() => executeCount(table, plan('gte'), '研发组超过90的有几支')).toThrow('explicit comparison');
  });
  it('rejects invented values and thresholds', () => {
    const p = plan('gt'); p.filters[0].value='虚构组';
    expect(() => executeCount(table,p,'超过90')).toThrow('actual cell');
    expect(() => executeCount(table,plan('gt','89'),'超过90')).toThrow('absent');
  });
  it('compares large decimal values without floating point rounding', () => {
    const t = countTables('| 得分 | 名称 |\n| --- | --- |\n| 9007199254740993 | A |\n| 9007199254740992 | B |');
    expect(executeCount(t, {table:0,filters:[{column:0,operator:'gt',value:'9007199254740992'}]}, '超过9007199254740992的数量').count).toBe(1);
  });
  it('accepts numeric JSON values and equivalent typed column/operator representations', () => {
    const p = {table:'0',filters:[{column:'部门',operator:'=',value:'研发组'},{column:'3',operator:'>',value:90}]};
    expect(executeCount(table,p,'研发组超过90的有几支').count).toBe(1);
    expect(() => executeCount(table,{table:0,filters:[{column:3,operator:'>=',value:90}]},'超过90')).toThrow('explicit comparison');
    expect(() => executeCount(table,{table:0,filters:[{column:3,operator:'gt',value:NaN}]},'超过90')).toThrow('Invalid predicate');
    expect(() => executeCount(table,{table:0,filters:[{column:3,operator:'gt',value:9007199254740993}]},'超过9007199254740993')).toThrow('Invalid predicate');
  });
  it('isolates validated cached plans and does not expose mutable references', () => {
    const p = normalizeCountPlan(plan('gt'),table);
    rememberCountPlan('user-a/source-a/question-a',p);
    const cached = cachedCountPlan('user-a/source-a/question-a')!;cached.filters[0].value='其他';
    expect(cachedCountPlan('user-a/source-a/question-a')!.filters[0].value).toBe('研发组');
    expect(cachedCountPlan('user-b/source-a/question-a')).toBeUndefined();
  });
  it('returns zero without guessing or counting another department', () => {
    expect(executeCount(table,plan('gt','99'),'研发组超过99').count).toBe(0);
  });
  it('identifies a named count, leaves ordinary retrieval and chapter requests alone', () => {
    expect(countDocumentNeedle('示例团队打分，研发组超过90的有几支队伍。')).toBe('示例团队打分，研发组超过90的有几支队伍。');
    expect(countDocumentNeedle('列出《示例手册》全部章节')).toBeNull();
    expect(countDocumentNeedle('介绍评分规则')).toBeNull();
  });
  it('refuses malformed full tables', () => {
    expect(() => countTables('| A | B |\n| --- | --- |\n| one |')).toThrow('column count');
  });
  it('resolves title spans independently of commas, predicates and word order', () => {
    for (const question of ['示例杯团队相关研发组打分超过90的有几支队伍。', '研发组在示例杯团队打分超过90的有几支队伍。', '研发组超过90的有几支队伍，统计示例杯团队打分表。', '示例杯团队打分，研发组超过90的有几支队伍。']) {
      const needle = countDocumentNeedle(question)!;
      expect(countDocumentTitleTerms(needle)).toContain('示例杯团');
      expect(countDocumentTitleMatches('示例杯团队打分表.xlsx', needle)).toBe(true);
      expect(countDocumentTitleMatches('示例杯团队赛事组织方案.docx', needle)).toBe(false);
      expect(countDocumentTitleMatches('研发组绩效管理办法.doc', needle)).toBe(false);
    }
    expect(countDocumentTitleMatches('打分表.xlsx', '超过90的队伍有几支')).toBe(false);
  });
  it('marks a truncated value domain so the planner knows it sees a sample', () => {
    const rows = Array.from({length: 120}, (_, i) => ({cells: [`v${i}`], charStart: 0, charEnd: 1}));
    const [schema] = countSchema([{id: 't', headers: ['状态'], rows}] as any);
    expect(schema.columns[0].values).toHaveLength(100);
    // Without this the planner treats the 100 shown values as the whole domain
    // and a filter on a later value becomes an impossible predicate.
    expect(schema.columns[0].value_domain_is_sample).toBe(true);
    expect(countSchema([{id: 't', headers: ['状态'], rows: rows.slice(0, 5)} as any])[0].columns[0].value_domain_is_sample).toBe(false);
  });
});
