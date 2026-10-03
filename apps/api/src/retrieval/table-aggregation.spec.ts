import { extractRawTables, aggregateTable, cellSpans } from './table-aggregation';
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

describe('cellSpans (cell-level coordinates)', () => {
  const markdown = '| Item | Amount |\n| --- | --- |\n| A | 0.1元 |\n| B | 0.2元 |';
  it('returns absolute character spans for each cell of a row', () => {
    const table = extractRawTables(markdown, 'v')[0];
    const spans = cellSpans(markdown, table.rows[0]);
    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.column)).toEqual([0, 1]);
    for (const span of spans) {
      expect(markdown.slice(span.charStart, span.charEnd).trim()).toBe(
        span.column === 0 ? 'A' : '0.1元',
      );
    }
  });

  it('respects escaped and code-fence pipes inside a cell', () => {
    const md = '| A\\|B | `x|y` |\n| --- | --- |\n| 1 | 2 |';
    const table = extractRawTables(md, 'v')[0];
    const spans = cellSpans(md, table.rows[0]);
    expect(spans).toHaveLength(2);
    expect(md.slice(spans[0].charStart, spans[0].charEnd).trim()).toBe('1');
    expect(md.slice(spans[1].charStart, spans[1].charEnd).trim()).toBe('2');
  });
});
