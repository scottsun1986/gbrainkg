import { extractRawTables, RawTable } from '../retrieval/table-aggregation';

export interface CountFilter { column: number; operator: 'eq'|'gt'|'gte'|'lt'|'lte'; value: string }
export interface CountPlan { table: number; filters: CountFilter[] }

export function countDocumentNeedle(question: string): string | null {
  if (!/(?:有几|多少|数量|几支|几个|how many|\bcount\b)/i.test(question)) return null;
  const quoted = question.match(/《([^》]+)》|[“"]([^”"]+)[”"]/);
  const first = (quoted?.[1] || quoted?.[2] || question)
    .replace(/^(?:请问|请统计|统计|根据|在)/, '').trim();
  return first.length >= 4 && first.length <= 80 ? first : null;
}
/** Bounded title candidates, including queries that join the title and predicates. */
export function countDocumentTitleTerms(needle: string): string[] {
  return [...new Set(Array.from({length: needle.length - 3}, (_, i) => needle.slice(i, i + 4)))];
}
export function countDocumentTitleMatches(title: string, needle: string): boolean {
  const name = title.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  const query = needle.toLowerCase();
  if (name.length < 4 || name.length > 160) return false;
  // Longest literal shared span; predicates need not be separated by punctuation.
  let previous = new Array(query.length + 1).fill(0), longest = 0;
  for (const character of name) {
    const next = new Array(query.length + 1).fill(0);
    for (let j = 1; j <= query.length; j++) {
      if (character === query[j - 1]) {
        next[j] = previous[j - 1] + 1;
        longest = Math.max(longest, next[j]);
      }
    }
    previous = next;
  }
  return longest >= 4 && longest / name.length >= 0.6;
}
export function countTables(markdown: string): RawTable[] {
  return extractRawTables(markdown, 'complete-authorized-document');
}
export function countSchema(tables: RawTable[]) {
  return tables.map((table, tableIndex) => ({ table: tableIndex, headers: table.headers,
    columns: table.headers.map((header, column) => {
      const distinct = [...new Set(table.rows.map(r => r.cells[column]))].filter(Boolean);
      return { column, header,
        values: distinct.slice(0, 100),
        // Preview rows are only a sample of the source. A value that exists
        // solely past the preview would otherwise be inexpressible, and the
        // planner must know the domain it is shown is bounded.
        value_domain_is_sample: distinct.length > 100 };
    }) }));
}
/** Accept equivalent JSON representations without relaxing predicate semantics. */
export function normalizeCountPlan(raw: unknown, tables: RawTable[]): CountPlan {
  const input = raw as any;
  const index = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  const table = index(input?.table);
  if (!Number.isInteger(table) || !tables[table as number] || !Array.isArray(input?.filters)) throw new Error('Incomplete count plan');
  const operators: Record<string, CountFilter['operator']> = {'=':'eq','==':'eq','>':'gt','>=':'gte','≥':'gte','<':'lt','<=':'lte','≤':'lte',eq:'eq',gt:'gt',gte:'gte',lt:'lt',lte:'lte'};
  return { table: table as number, filters: input.filters.map((f: any) => {
    let column = index(f?.column);
    if (typeof column === 'string') {
      const matches = tables[table as number].headers.flatMap((h, i) => h === column ? [i] : []);
      column = matches.length === 1 ? matches[0] : -1;
    }
    const value = typeof f?.value === 'number' && Number.isFinite(f.value)
      && (!Number.isInteger(f.value) || Number.isSafeInteger(f.value)) ? String(f.value) : f?.value;
    return {column: column as number, operator: operators[f?.operator], value};
  }) };
}
const acceptedPlans = new Map<string, {plan: CountPlan; expires: number}>();
export function cachedCountPlan(key: string): CountPlan | undefined {
  const entry = acceptedPlans.get(key);
  if (!entry || entry.expires < Date.now()) { acceptedPlans.delete(key); return undefined; }
  return structuredClone(entry.plan);
}
export function rememberCountPlan(key: string, plan: CountPlan): void {
  acceptedPlans.delete(key); acceptedPlans.set(key, {plan:structuredClone(plan),expires:Date.now()+600000});
  while (acceptedPlans.size > 200) acceptedPlans.delete(acceptedPlans.keys().next().value!);
}
function compareDecimal(left: string, right: string): number {
  const parse = (value: string) => {
    const match = value.trim().match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
    if (!match || match[2].length > 30 || (match[3] || '').length > 18) throw new Error('Numeric precision budget exceeded');
    return { value: BigInt((match[1] === '-' ? '-' : '') + match[2] + (match[3] || '')), scale: (match[3] || '').length };
  };
  const a = parse(left), b = parse(right), scale = Math.max(a.scale, b.scale);
  const x = a.value * 10n ** BigInt(scale - a.scale), y = b.value * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
/** The model selects typed predicates; it never counts rows or writes the answer. */
export function executeCount(tables: RawTable[], raw: unknown, question: string, allowUnseenEquality = false) {
  const plan = normalizeCountPlan(raw, tables);
  if (!Number.isInteger(plan?.table) || !tables[plan.table] || !Array.isArray(plan.filters)
      || !plan.filters.length || plan.filters.length > 8) throw new Error('Incomplete count plan');
  const table = tables[plan.table];
  const ops = new Set(['eq','gt','gte','lt','lte']);
  for (const filter of plan.filters) {
    if (!Number.isInteger(filter.column) || filter.column < 0 || filter.column >= table.headers.length
        || !ops.has(filter.operator) || typeof filter.value !== 'string' || !filter.value.trim()) throw new Error('Invalid predicate');
    if (filter.operator === 'eq') {
      if (!table.rows.some(r => r.cells[filter.column] === filter.value) && !(allowUnseenEquality && question.includes(filter.value))) throw new Error('Text filter must use an actual cell value or a literal value from the question');
    } else {
      if (!/^[+-]?\d+(?:\.\d+)?$/.test(filter.value) || !Number.isFinite(Number(filter.value))) throw new Error('Invalid numeric threshold');
      const threshold = filter.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // A strict boundary must never silently become inclusive (or vice versa).
      const relations: Array<[CountFilter['operator'], RegExp]> = [
        ['gte', new RegExp(`(?:至少|不低于|大于等于|>=|≥)\\s*${threshold}|${threshold}\\s*(?:分)?(?:及以上|以上)`)],
        ['lte', new RegExp(`(?:不超过|不高于|小于等于|<=|≤)\\s*${threshold}|${threshold}\\s*(?:分)?(?:及以下|以下)`)],
        ['gt', new RegExp(`(?:超过|高于|大于|>)\\s*${threshold}`)],
        ['lt', new RegExp(`(?:低于|小于|<)\\s*${threshold}`)],
      ];
      const explicit = relations.find(([, pattern]) => pattern.test(question));
      if (explicit && explicit[0] !== filter.operator) throw new Error('Predicate disagrees with explicit comparison');
      if (!new RegExp(`(^|[^\\d.])${threshold}([^\\d.]|$)`).test(question)) throw new Error('Threshold absent from question');
    }
  }
  const matched = table.rows.filter(row => plan.filters.every(filter => {
    const cell = row.cells[filter.column];
    if (filter.operator === 'eq') return cell === filter.value;
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(cell.trim())) return false;
    const comparison = compareDecimal(cell, filter.value);
    return filter.operator === 'gt' ? comparison > 0 : filter.operator === 'gte' ? comparison >= 0 : filter.operator === 'lt' ? comparison < 0 : comparison <= 0;
  }));
  return { count: matched.length, table, filters: plan.filters, matched,
    conditions: plan.filters.map(f => `${table.headers[f.column]} ${f.operator === 'eq' ? '=' : ({gt:'>',gte:'≥',lt:'<',lte:'≤'}[f.operator])} ${f.value}`).join('；') };
}
