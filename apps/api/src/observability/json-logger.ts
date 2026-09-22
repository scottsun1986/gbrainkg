import type { LoggerService, LogLevel } from '@nestjs/common';
import { getRequestContext } from './request-context';

export type JsonLogLevel = 'info' | 'error' | 'warn' | 'debug' | 'verbose';

export interface JsonLogRecord {
  ts: string;
  level: JsonLogLevel;
  msg: string;
  requestId?: string;
  userId?: string;
  route?: string;
  durationMs?: number;
  status?: number;
  context?: string;
  stack?: string;
  [key: string]: unknown;
}

/** Field names whose values must never appear in logs. */
const SENSITIVE_KEY_PATTERN =
  /^(password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|authorization|auth|cookie|set[_-]?cookie|secret|client[_-]?secret|credential|credentials|private[_-]?key|session[_-]?id|sessionid)$/i;

/**
 * Inline `password=...` / `authorization: Bearer ...` style leaks in free text.
 * Consumes an optional auth scheme (`Bearer`/`Basic`/`Token`) so the credential
 * itself — not just the scheme word — is replaced.
 */
const SENSITIVE_TEXT_PATTERN =
  /\b(password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|authorization|cookie|set-cookie|secret|client[_-]?secret)(\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;)]+)/gi;

export const REDACTED = '[REDACTED]';

/** Deep-redact sensitive keys and scrub common secret-bearing text patterns. */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'function') return '[Function]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
    };
  }
  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);
    if (Array.isArray(value)) return value.map((item) => redact(item, seen));
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(val, seen);
    }
    return out;
  }
  return String(value);
}

export function redactText(text: string): string {
  return text.replace(SENSITIVE_TEXT_PATTERN, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`);
}

/** Convenience for logging arbitrary objects safely. */
export function sanitizeLogFields<T>(value: T): unknown {
  return redact(value);
}

function isErrorStack(value: unknown): value is string {
  return typeof value === 'string' && value.includes('\n    at ');
}

function coerceMessage(message: unknown): string {
  if (typeof message === 'string') return redactText(message);
  if (message instanceof Error) return redactText(message.message);
  if (message !== null && typeof message === 'object') {
    const safe = redact(message) as Record<string, unknown>;
    try {
      return JSON.stringify(safe);
    } catch {
      return '[unserializable]';
    }
  }
  return String(message);
}

export interface HttpAccessFields {
  requestId?: string;
  userId?: string;
  route?: string;
  method?: string;
  durationMs?: number;
  status?: number;
  msg?: string;
}

/**
 * Structured JSON logger (one object per line). Carries request correlation
 * fields from AsyncLocalStorage and never emits password/token/authorization/
 * cookie values.
 */
export class JsonLogger implements LoggerService {
  constructor(private readonly sink: (line: string) => void = (line) => process.stdout.write(line + '\n')) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams, true);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }

  setLogLevels?(_levels: LogLevel[]): void {
    // Level filtering is left to the runtime log pipeline.
  }

  /** One structured line for a completed HTTP request. */
  logHttpAccess(fields: HttpAccessFields): void {
    const record: JsonLogRecord = {
      ts: new Date().toISOString(),
      level: 'info',
      msg: fields.msg || 'http_request',
      requestId: fields.requestId ?? getRequestContext()?.requestId,
      userId: fields.userId ?? getRequestContext()?.userId,
      route: fields.route,
      durationMs: fields.durationMs,
      status: fields.status,
    };
    if (fields.method) record.method = fields.method;
    this.emit(record);
  }

  private write(level: JsonLogLevel, message: unknown, optionalParams: unknown[], isError = false): void {
    let stack: string | undefined;
    let context: string | undefined;
    const rest: unknown[] = [];

    for (const param of optionalParams) {
      if (param instanceof Error) {
        stack = stack ?? redactText(param.stack || param.message);
        rest.push(redact(param));
      } else if (isErrorStack(param)) {
        stack = stack ?? redactText(param);
      } else if (typeof param === 'string' && /^[A-Za-z0-9_./-]{1,64}$/.test(param) && context === undefined) {
        context = param;
      } else if (param !== undefined) {
        rest.push(redact(param));
      }
    }

    if (isError && !stack && message instanceof Error) {
      stack = redactText(message.stack || message.message);
    }

    const ctx = getRequestContext();
    const record: JsonLogRecord = {
      ts: new Date().toISOString(),
      level,
      msg: coerceMessage(message),
      requestId: ctx?.requestId,
      userId: ctx?.userId,
      route: ctx?.route,
    };
    if (context) record.context = context;
    if (stack) record.stack = stack;
    if (rest.length) record.params = rest;
    this.emit(record);
  }

  private emit(record: JsonLogRecord): void {
    const safe = redact(record) as JsonLogRecord;
    let line: string;
    try {
      line = JSON.stringify(safe);
    } catch {
      line = JSON.stringify({ ts: record.ts, level: record.level, msg: record.msg, error: 'log_serialize_failed' });
    }
    this.sink(line);
  }
}

export type LogFormat = 'json' | 'pretty';

/**
 * `LOG_FORMAT=json` (default) → JsonLogger.
 * `LOG_FORMAT=pretty` → undefined so Nest keeps its default colored logger.
 */
export function resolveLogFormat(raw: string | undefined): LogFormat {
  return (raw || 'json').trim().toLowerCase() === 'pretty' ? 'pretty' : 'json';
}

export function createLogger(format: LogFormat): LoggerService | undefined {
  return format === 'pretty' ? undefined : new JsonLogger();
}
