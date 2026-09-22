/** Narrowing helpers for loosely-typed API / catch payloads. */

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && name === 'AbortError') return 'AbortError';
  }
  return typeof err === 'string' ? err : '';
}

export function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  if (typeof err === 'object' && err !== null) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function bool(value: unknown): boolean {
  return Boolean(value);
}

/** Message field commonly returned by the HTTP API on failures. */
export function apiMessage(value: unknown): string {
  const rec = asRecord(value);
  return str(rec.message) || str(rec.error);
}
