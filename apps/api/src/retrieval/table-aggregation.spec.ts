import { extractRawTables, aggregateTable } from './table-aggregation';
it('aggregates every row with exact decimal arithmetic and immutable source spans', () => {
  const tables = extractRawTables('| Item | Amount |\n| --- | --- |\n| A | 0.1元 |\n| B | 0.2元 |\n| C | -0.05元 |', 'version1');
  expect(aggregateTable(tables[0], 'sum', 1)).toEqual({ value: '0.25', unit: '元', exact: true });
  expect(aggregateTable(tables[0], 'avg', 1)).toEqual({ numerator: '0.25', denominator: '3', unit: '元', exact: true });
  expect(aggregateTable(tables[0], 'count').value).toBe('3');
  expect(tables[0].rows[2].charStart).toBeGreaterThan(tables[0].rows[1].charStart);
});
it('refuses malformed, missing and incompatible numeric evidence', () => {
  expect(() => extractRawTables('| A | B |\n| --- | --- |\n| 1 |', 'v')).toThrow(/column/);
  const table = extractRawTables('| A | B |\n| --- | --- |\n| 1 | 2元 |\n| 2 | 3万元 |', 'v')[0];
  expect(() => aggregateTable(table, 'sum', 1)).toThrow(/Mixed units/);
});
