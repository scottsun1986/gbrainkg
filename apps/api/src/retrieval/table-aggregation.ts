import { parseMarkdownTableCells } from '../ingestion/markdown-table';
import { createHash } from 'node:crypto';

export interface RawTable { id: string; headers: string[]; rows: Array<{ cells: string[]; charStart: number; charEnd: number }> }

/**
 * Cell-level coordinates for one table row: the absolute character span of
 * each cell in the source Markdown. Cell boundaries are unescaped, non-code
 * pipes — the same rule the splitter in `cells()` uses.
 */
export function cellSpans(markdown: string, row: { cells: string[]; charStart: number; charEnd: number }): Array<{ column: number; charStart: number; charEnd: number }> {
  const spans: Array<{ column: number; charStart: number; charEnd: number }> = [];
  let column = 0, cellStart = -1, escaped = false, code = false, sawPipe = false;
  for (let i = row.charStart; i < row.charEnd; i++) {
    const char = markdown[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '`') code = !code;
    if (char === '|' && !code) {
      if (!sawPipe) { sawPipe = true; cellStart = i + 1; continue; } // leading border
      spans.push({ column, charStart: cellStart, charEnd: i });
      column += 1; cellStart = i + 1;
    }
  }
  if (cellStart >= 0 && column < row.cells.length) spans.push({ column, charStart: cellStart, charEnd: row.charEnd });
  return spans.slice(0, row.cells.length);
}
function cells(line: string): string[] { return parseMarkdownTableCells(line); }

export function extractRawTables(markdown: string, versionId: string): RawTable[] {
  const lines = markdown.split('\n'); const offsets: number[] = []; let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const tables: RawTable[] = []; let fenced = false;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced || !lines[i].includes('|')) continue;
    const separator = cells(lines[i + 1]);
    if (separator.length < 2 || separator.some(cell => !/^:?-{3,}:?$/.test(cell))) continue;
    const headers = cells(lines[i]);
    if (headers.length !== separator.length) throw new Error('Malformed table header');
    const id = createHash('sha256').update(`${versionId}:${offsets[i]}`).digest('hex').slice(0, 24);
    const rows: RawTable['rows'] = [];
    i += 2;
    for (; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) {
      const values = cells(lines[i]);
      if (values.length !== headers.length) throw new Error('Table row column count mismatch; incomplete table cannot be aggregated');
      rows.push({ cells: values, charStart: offsets[i], charEnd: offsets[i] + lines[i].length });
      if (rows.length > 100000) throw new Error('Table row budget exceeded');
    }
    i--; tables.push({ id, headers, rows });
  }
  return tables;
}
export function decimal(value: string) {
  const match = value.trim().match(/^([+-]?)(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)\s*([^\d\s.,+-]*)$/u);
  if (!match) throw new Error(`Non-numeric cell; cannot infer a value: ${value.slice(0, 80)}`);
  const number = match[2].replace(/,/g, ''); const [whole, fraction = ''] = number.split('.');
  if (fraction.length > 18 || whole.length > 30) throw new Error('Numeric precision budget exceeded');
  return { value: BigInt((match[1] === '-' ? '-' : '') + (whole || '0') + fraction), scale: fraction.length, unit: match[3] };
}
export function formatted(value: bigint, scale: number): string {
  const negative = value < 0n; const raw = (negative ? -value : value).toString().padStart(scale + 1, '0');
  return (negative ? '-' : '') + (scale ? `${raw.slice(0, -scale)}.${raw.slice(-scale)}`.replace(/\.?0+$/, '') : raw);
}
export function aggregateTable(table: RawTable, operation: 'count' | 'sum' | 'min' | 'max' | 'avg', column?: number) {
  if (!['count','sum','min','max','avg'].includes(operation)) throw new Error('Unsupported operation');
  const rows = table.rows;
  if (operation === 'count') return { value: String(rows.length), unit: 'rows', exact: true };
  if (!Number.isInteger(column) || column! < 0 || column! >= table.headers.length) throw new Error('A valid zero-based column is required');
  if (!rows.length) throw new Error('Empty table has no numeric aggregate');
  const numbers = rows.map(row => decimal(row.cells[column!]));
  const units = new Set(numbers.map(number => number.unit));
  if (units.size !== 1) throw new Error('Mixed units require an explicit conversion contract');
  const scale = numbers.reduce((max, number) => Math.max(max, number.scale), 0);
  const values = numbers.map(number => number.value * 10n ** BigInt(scale - number.scale));
  const sum = values.reduce((a, b) => a + b, 0n);
  if (operation === 'avg') return { numerator: formatted(sum, scale), denominator: String(values.length), unit: numbers[0].unit, exact: true };
  const result = operation === 'sum' ? sum : values.reduce((a,b) => operation === 'min' ? a < b ? a : b : a > b ? a : b);
  return { value: formatted(result, scale), unit: numbers[0].unit, exact: true };
}
