import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { decodeDocumentText } from './text-decoder';

export interface QaRecord {
  id: string; question: string; answer: string; aliases: string[]; scope?: string; language?: string;
  effectiveFrom?: string; effectiveTo?: string; sourceDocumentId?: string; sourceVersionId?: string;
  sourceCategory?: 'manual' | 'document' | 'feedback'; maintainerId?: string; reviewStatus?: 'pending' | 'approved';
}
export type QaMapping = Partial<Record<'question'|'answer'|'aliases'|'id'|'scope'|'language'|'effectiveFrom'|'effectiveTo', string | number>>;

export function qaMarkdown(qa: QaRecord): string {
  const questions = [qa.question, ...qa.aliases].join('\n');
  return `<!-- qa-question:${Buffer.from(questions).toString('base64')} -->\n# ${qa.question}\n\n${qa.aliases.length ? `相似问题：\n${qa.aliases.map(a => `- ${a}`).join('\n')}\n\n` : ''}${qa.scope ? `适用范围：${qa.scope}\n\n` : ''}${qa.answer}`;
}

/** RFC4180 records, including escaped quotes and quoted newlines. */
export function parseQaCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  const finish = () => { row.push(field); if (row.some(v => v.length)) rows.push(row); row = []; field = ''; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"' && field === '' && !closed) quoted = true;
    else if (c === ',') { row.push(field); field = ''; closed = false; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; finish(); }
    else if (closed && c.trim()) throw new BadRequestException(`CSV 第 ${rows.length + 1} 条记录引号后存在非法字符`);
    else field += c;
  }
  if (quoted) throw new BadRequestException('CSV 存在未闭合引号');
  if (field || row.length) finish();
  return rows;
}

export function validateQa(input: any): { record: QaRecord; idProvided: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) { errors.push('QA 行必须是对象'); input = {}; }
  const value = (v: unknown) => v === undefined || v === null ? '' : String(v).trim();
  const question = value(input.question), answer = value(input.answer);
  if ((input.question !== null && typeof input.question === 'object') || (input.answer !== null && typeof input.answer === 'object')) errors.push('问题和答案必须是标量文本、数值或布尔值');
  if (!question) errors.push('问题不能为空');
  if (!answer) errors.push('答案不能为空');
  if (question.length > 2000 || answer.length > 24000) errors.push('问题或答案超过预算（2000 / 24000 字符）');
  let aliases: string[] = [];
  if (Array.isArray(input.aliases)) aliases = input.aliases.map(value).filter(Boolean);
  else if (value(input.aliases)) {
    const raw = value(input.aliases);
    try { const data = JSON.parse(raw); aliases = Array.isArray(data) ? data.map(value).filter(Boolean) : [raw]; }
    catch { aliases = raw.split(/\r?\n/).map(v => v.trim()).filter(Boolean); }
  }
  if (aliases.length > 30 || aliases.some(v => v.length > 2000)) errors.push('相似问题超过预算');
  for (const key of ['effectiveFrom', 'effectiveTo']) if (value(input[key]) && !Number.isFinite(Date.parse(value(input[key])))) errors.push(`${key} 必须是有效日期`);
  if (input.effectiveFrom && input.effectiveTo && Date.parse(input.effectiveFrom) >= Date.parse(input.effectiveTo)) errors.push('失效时间必须晚于生效时间');
  const id = value(input.id) || `qa:${createHash('sha256').update(JSON.stringify([question.normalize('NFKC').toLowerCase(),value(input.scope),value(input.language),value(input.effectiveFrom),value(input.effectiveTo)])).digest('hex')}`;
  if (id.length > 200) errors.push('QA ID 超过预算');
  for (const key of ['sourceDocumentId','sourceVersionId']) if (value(input[key]) && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value(input[key]))) errors.push(`${key} 必须为 UUID`);
  if (value(input.sourceDocumentId) !== '' && !value(input.sourceVersionId)) errors.push('派生 QA 必须绑定来源版本');
  if (value(input.sourceVersionId) && !value(input.sourceDocumentId)) errors.push('来源版本必须同时绑定来源文档');
  if (value(input.sourceCategory) && !['manual','document','feedback'].includes(value(input.sourceCategory))) errors.push('无效 QA 来源类别');
  if (value(input.scope).length > 2000 || value(input.language).length > 80) errors.push('适用范围或语言超过预算');
  // The "same question, different answer" guard must key off whether the caller
  // actually supplied an ID, never a client-reported flag: an unchecked flag
  // lets any caller silently skip the guard and overwrite a reviewed answer.
  const idProvided = value(input.id) !== '';
  return { record: { id, question, answer, aliases: [...new Set(aliases)].filter(a => a !== question),
    ...Object.fromEntries(['scope', 'language', 'effectiveFrom', 'effectiveTo', 'sourceDocumentId', 'sourceVersionId', 'sourceCategory']
      .filter(key => value(input[key])).map(key => [key, value(input[key])])), sourceCategory: input.sourceCategory || 'manual', reviewStatus: 'pending' }, idProvided, errors };
}

export function previewQaText(bytes: Buffer, extension: string, mapping: QaMapping) {
  const decoded = decodeDocumentText(bytes);
  let fields: string[] = [], sources: Array<{ line: number; data: any; parseError?: string }> = [];
  if (extension === '.jsonl') {
    const lines = decoded.text.split(/\r?\n/);
    sources = lines.flatMap((line, index) => {
      if (!line.trim()) return [];
      try { const data = JSON.parse(line); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(); return [{ line: index + 1, data }]; }
      catch { return [{ line: index + 1, data: {}, parseError: 'JSONL 行不是有效对象' }]; }
    });
    fields = [...new Set(sources.flatMap(row => Object.keys(row.data)))];
  } else {
    const csv = parseQaCsv(decoded.text); fields = csv.shift() || [];
    sources = csv.map((data, i) => ({ line: i + 2, data }));
  }
  return previewQaRows(fields, sources, mapping, decoded.warnings);
}

export function previewQaRows(fields: string[], sources: Array<{ line: number; data: any; parseError?: string }>, mapping: QaMapping, warnings: string[] = []) {
  if (sources.length > 500) throw new BadRequestException('一次 QA 导入最多 500 条，请分批导入');
  const mapped = (row: any, column: string | number | undefined) => column === undefined ? undefined :
    Array.isArray(row) ? row[typeof column === 'number' ? column : fields.indexOf(column)] : row[typeof column === 'number' ? fields[column] : column];
  const rows = sources.map(source => {
    const input = Object.fromEntries(Object.entries(mapping).map(([key, column]) => [key, mapped(source.data, column)]));
    const result = validateQa(input);
    return { ...result.record, idProvided: result.idProvided, line: source.line, errors: [...(source.parseError ? [source.parseError] : []), ...result.errors] };
  });
  const conflicts = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = qaConflictKey(row);
    const group = conflicts.get(key) || []; group.push(row); conflicts.set(key, group);
  }
  for (const group of conflicts.values()) if (new Set(group.map(row => row.answer)).size > 1) {
    for (const row of group) { row.errors.push('同一问题存在不同答案，需要处理冲突'); (row as any).conflict = true; }
  }
  return { fields, rows, warnings, errors: rows.flatMap(row => row.errors.map(error => ({ line: row.line, error }))), validCount: rows.filter(row => !row.errors.length).length };
}

export function qaConflictKey(qa: Pick<QaRecord,'question'|'scope'|'language'|'effectiveFrom'|'effectiveTo'>): string {
  return JSON.stringify([qa.question.normalize('NFKC').toLowerCase(), qa.scope || '', qa.language || '', qa.effectiveFrom || '', qa.effectiveTo || '']);
}
