import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { StructuredTable, SourceRow, SourceCell } from '../ingestion/source-artifacts';
import { uploadRoot } from '../storage/upload-paths';
import { decimal, formatted } from './table-aggregation';

export interface TableFilter { column: number; operator: 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'contains'; value: string|number|boolean }
export async function* structuredRows(table: StructuredTable, documentId: string): AsyncGenerator<SourceRow> {
  if (!table.artifact_path) { for (const row of table.rows || []) yield row; return; }
  const root = resolve(uploadRoot(), documentId); const path = resolve(uploadRoot(), table.artifact_path);
  if (!path.startsWith(root + sep)) throw new Error('Invalid structured source path');
  const sha = createHash('sha256'); let bytes = 0;
  const stream = createReadStream(path);
  stream.on('data', (data: Buffer) => { bytes += data.length; sha.update(data); if (bytes > 200 * 1024 * 1024) stream.destroy(new Error('Structured source exceeds calculation budget')); });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of lines) { if (line.length > 2 * 1024 * 1024) throw new Error('Table row exceeds budget'); if (line.trim()) yield JSON.parse(line); } }
  finally { lines.close(); stream.destroy(); }
  if (table.sha256 && sha.digest('hex') !== table.sha256) throw new Error('Structured source hash mismatch');
}
export function cellAt(row: SourceRow, column: number, table: StructuredTable): SourceCell | undefined {
  const letters = table.range?.match(/^([A-Z]+)\d/i)?.[1]?.toUpperCase() || 'A';
  const firstColumn = [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const absolute = table.header_columns?.[column] ?? firstColumn + column;
  return row.cells.find(cell => Number(cell.column) === absolute);
}
function formatUnit(cell: SourceCell): string {
  if (cell.unit) return cell.unit;
  const format = cell.number_format || '';
  if (format.includes('%')) return '%';
  const currency = format.match(/\[\$([^\]-]+)(?:-[^\]]+)?\]/)?.[1] || format.match(/[$€£¥￥₹₽₩]/)?.[0];
  if (currency) return currency;
  const literal = [...format.matchAll(/"([^"0#?,.]+)"/g)].map(match => match[1].trim()).filter(Boolean).join(' ');
  return literal;
}
function compare(cell: SourceCell | undefined, filter: TableFilter) {
  if (!cell || cell.inherited || cell.value === null || cell.value === undefined) return false;
  const value = cell.value;
  if (filter.operator === 'contains') { if (typeof value !== 'string') return false; return value.includes(String(filter.value)); }
  if (filter.operator === 'eq') return value === filter.value;
  if (filter.operator === 'ne') return value !== filter.value;
  if (typeof value !== typeof filter.value) throw new Error('Filter type mismatch; explicit typed value is required');
  if (typeof value !== 'number' && cell.type !== 'date' && cell.type !== 'datetime') throw new Error('Ordered filtering requires numeric/date cells');
  const a = cell.type === 'date' || cell.type === 'datetime' ? Date.parse(String(value)) : Number(value);
  const b = cell.type === 'date' || cell.type === 'datetime' ? Date.parse(String(filter.value)) : Number(filter.value);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Invalid numeric/date filter');
  return filter.operator === 'gt' ? a > b : filter.operator === 'gte' ? a >= b : filter.operator === 'lt' ? a < b : a <= b;
}

/** One pass over the complete fact source, independently of retrieval Top-K.
 * Decimal bigint accumulation keeps arithmetic deterministic and bounded. */
export async function aggregateStructuredTable(table: StructuredTable, documentId: string, operation: 'count'|'sum'|'min'|'max'|'avg', column?: number, filters: TableFilter[] = [], includeSummary = false) {
  if (!table.complete) throw new Error('Incomplete tables cannot be calculated');
  if (!['count','sum','min','max','avg'].includes(operation)) throw new Error('Unsupported operation');
  if (!Array.isArray(filters) || filters.length > 20 || filters.some(filter => !Number.isInteger(filter.column) || filter.column < 0 || filter.column >= table.headers.length || !['eq','ne','gt','gte','lt','lte','contains'].includes(filter.operator))) throw new Error('Invalid table filters');
  if (operation !== 'count' && (!Number.isInteger(column) || column! < 0 || column! >= table.headers.length)) throw new Error('A valid zero-based column is required');
  let rowsRead = 0, rowCount = 0, numericCount = 0, scale = 0, sum = 0n, min: bigint | null = null, max: bigint | null = null, unit: string | null = null;
  const unitSources=new Set<string>();
  const cellRefs: Array<{ row:number; coordinate:string; sheet:string }> = [];
  const dependency = createHash('sha256');
  for await (const row of structuredRows(table, documentId)) {
    rowsRead++;
    if (row.is_header || (!includeSummary && row.is_summary) || filters.some(filter => !compare(cellAt(row, filter.column, table), filter))) continue;
    rowCount++; dependency.update(JSON.stringify(row));
    if (operation === 'count') continue;
    const cell = cellAt(row, column!, table);
    if (cell?.inherited) continue; // display inheritance is never a second fact
    if (!cell || cell.type === 'error' || cell.value === null || cell.value === undefined || typeof cell.value === 'boolean' || (cell.formula && cell.cached === undefined && cell.value === null)) throw new Error(`Cell ${cell?.coordinate || row.row} has no calculable numeric fact`);
    const number = decimal(String(cell.value));
    const headerUnit = table.header_units?.[column!] || table.headers[column!]?.match(/[（(]([^()（）]+)[）)]\s*$/u)?.[1] || '';
    const nextUnit = formatUnit(cell) || number.unit || headerUnit;
    unitSources.add(cell.unit_source || (number.unit ? 'value' : formatUnit(cell) ? 'format' : headerUnit ? 'header-label' : 'unspecified'));
    if (unit !== null && unit !== nextUnit) throw new Error('Mixed units require explicit conversion');
    unit = nextUnit;
    if (number.scale > scale) { const factor = 10n ** BigInt(number.scale - scale); sum *= factor; if (min !== null) min *= factor; if (max !== null) max *= factor; scale = number.scale; }
    const value = number.value * 10n ** BigInt(scale - number.scale) * (nextUnit === '%' && !number.unit && typeof cell.value === 'number' && (cell.number_format?.includes('%') || (cell as any).display_scale === 100) ? 100n : 1n); sum += value;
    min = min === null || value < min ? value : min; max = max === null || value > max ? value : max; numericCount++;
    if (cellRefs.length < 2048) cellRefs.push({ row: row.row, coordinate: cell.coordinate, sheet: table.sheet });
  }
  // row_count may include only data rows on older workers; the new contract
  // retains original header rows. Verify exact totals against the artifact.
  if (rowsRead !== table.row_count) throw new Error('Structured row coverage mismatch');
  if (operation !== 'count' && !numericCount) throw new Error('Empty numeric target');
  const result = operation === 'count' ? { value: String(rowCount), unit: 'rows', exact: true } : operation === 'avg'
    ? { numerator: formatted(sum, scale), denominator: String(numericCount), unit: unit || '', exact: true }
    : { value: formatted(operation === 'sum' ? sum : operation === 'min' ? min! : max!, scale), unit: unit || '', exact: true };
  return { ...result, rowCount, numericCount, rowsRead, coverage: 1, filters, cellRefs, tableId: table.id, sheet: table.sheet, range: table.range,
    unitSources:[...unitSources], warnings:[...((table as any).warnings || []),...(operation !== 'count' && !unit ? ['未声明单位，仅按原始数值计算，不进行跨口径转换'] : [])],
    sourceHash: table.sha256 || createHash('sha256').update(JSON.stringify(table.rows)).digest('hex'), dependencyHash: dependency.digest('hex') };
}
