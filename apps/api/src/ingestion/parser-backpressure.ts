/**
 * parser-worker 在并发容量不足时返回 503 + Retry-After（临时背压，并非解析失败）。
 * 这里对 503 做有限次重试，等待时长遵循 Retry-After 并设上限，其它状态原样返回。
 */
export const PARSER_BACKPRESSURE_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const MAX_RETRY_AFTER_SECONDS = 30;

export function parserRetryDelayMs(retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  const base = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(base, MAX_RETRY_AFTER_SECONDS) * 1000;
}

export async function fetchParserWithBackpressure(
  url: string,
  init: { method: string; body: FormData; headers: Record<string, string>; timeoutMs: number },
  options: { maxAttempts?: number; sleep?: (ms: number) => Promise<void>; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? PARSER_BACKPRESSURE_MAX_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = options.fetchImpl ?? fetch;
  for (let attempt = 1; ; attempt++) {
    const response = await fetchImpl(url, {
      method: init.method,
      body: init.body,
      headers: init.headers,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    if (response.status !== 503 || attempt >= maxAttempts) return response;
    await response.body?.cancel().catch(() => undefined);
    await sleep(parserRetryDelayMs(response.headers.get("retry-after")));
  }
}
