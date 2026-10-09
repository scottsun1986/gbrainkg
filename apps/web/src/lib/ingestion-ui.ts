import { API_BASE_URL, apiHeaders } from './api';
import { apiMessage } from './errors';

export interface QaRow {
  line?: number; id?: string; idProvided?: boolean; question: string; answer: string | number | boolean;
  aliases: string[]; scope?: string; language?: string; effectiveFrom?: string; effectiveTo?: string;
  sourceDocumentId?: string; sourceVersionId?: string; sourceCategory?: 'manual' | 'document' | 'feedback'; reviewStatus?: 'pending' | 'approved'; errors?: string[]; conflict?: boolean;
}
export interface QaItem {
  id: string; title: string; status: string; version: number;
  effectiveFrom?: string; effectiveTo?: string; qa?: QaRow | null;
  activeQa?: QaRow | null; pendingQa?: QaRow | null; qaState?: string; displayVersion?: number; ingestVersion?: number;
  displayEffectiveFrom?: string | null; displayEffectiveTo?: string | null;
}

/** Candidate content and dates belong to the candidate, never to the active
 * document's old metadata. This also safely labels older server responses. */
export function qaVersions(item: QaItem) {
  const explicit = 'activeQa' in item || 'pendingQa' in item;
  const pending = explicit ? item.pendingQa || null : item.qa?.reviewStatus === 'pending' || item.status !== 'published' ? item.qa || null : null;
  const active = explicit ? item.activeQa || null : !pending && item.status === 'published' ? item.qa || null : null;
  return {
    active, pending, displayed: pending || active,
    state: pending ? item.qaState || (pending.reviewStatus === 'approved' ? 'indexing' : 'needs_review') : item.qaState || item.status,
    activeVersion: item.version,
    displayVersion: item.displayVersion ?? (pending ? item.ingestVersion || item.version : item.version),
  };
}

export interface QaPreview { fields: string[]; rows: QaRow[]; errors: Array<string | { line: number; error: string }>; warnings?: string[]; validCount: number }
export interface ImportItem { path: string; hash?: string; documentId?: string; status: string; reason?: string }
export interface ImportBatch { id: string; archiveName: string; items: ImportItem[] }
export type QaMapping = Partial<Record<'question' | 'answer' | 'aliases' | 'id' | 'scope' | 'language' | 'effectiveFrom' | 'effectiveTo', string>>;

export async function ingestionRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/api/v1${path}`, { ...init, headers: { ...apiHeaders(), ...init.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiMessage(data) || `请求失败 (${response.status})`);
  return data as T;
}
export function qaValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}
export function validateQa(row: QaRow): string[] {
  const errors: string[] = [];
  if (!qaValue(row.question).trim()) errors.push('标准问题不能为空');
  if (!qaValue(row.answer).trim()) errors.push('标准答案不能为空');
  if (qaValue(row.question).length > 2000 || qaValue(row.answer).length > 24000) errors.push('问题 / 答案超过 2000 / 24000 字符');
  const aliases = (row.aliases || []).map(alias => alias.trim()).filter(Boolean);
  if (aliases.length > 30 || aliases.some(alias => alias.length > 2000)) errors.push('相似问题超过 30 条或 2000 字符预算');
  if (row.effectiveFrom && !Number.isFinite(Date.parse(row.effectiveFrom))) errors.push('生效时间格式无效');
  if (row.effectiveTo && !Number.isFinite(Date.parse(row.effectiveTo))) errors.push('失效时间格式无效');
  if (row.effectiveFrom && row.effectiveTo && Date.parse(row.effectiveFrom) >= Date.parse(row.effectiveTo)) errors.push('失效时间必须晚于生效时间');
  return errors;
}
export function prepareQaRows(rows: QaRow[]): QaRow[] {
  return rows.filter(row => !row.errors?.length && !validateQa(row).length && !row.conflict)
    .map(row => { const prepared = { ...row, answer: qaValue(row.answer), aliases: row.aliases || [] }; delete prepared.line; delete prepared.errors; delete prepared.conflict; return prepared; });
}
export function canRetryImport(item: ImportItem): boolean {
  return Boolean(item.documentId) && ['failed', 'needs_review'].includes(item.status);
}
