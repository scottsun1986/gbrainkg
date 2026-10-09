import {
  fetchParserWithBackpressure,
  parserRetryDelayMs,
  PARSER_BACKPRESSURE_MAX_ATTEMPTS,
} from './parser-backpressure';

function response(status: number, headers: Record<string, string> = {}) {
  return new Response(status === 200 ? '{"status":"completed"}' : 'busy', { status, headers });
}

describe('parser backpressure', () => {
  const init = { method: 'POST', body: new FormData(), headers: {}, timeoutMs: 1000 };

  it('derives the wait from Retry-After with a default and an upper bound', () => {
    expect(parserRetryDelayMs('2')).toBe(2000);
    expect(parserRetryDelayMs(null)).toBe(5000);
    expect(parserRetryDelayMs('0')).toBe(5000);
    expect(parserRetryDelayMs('600')).toBe(30000);
  });

  it('retries 503 responses and returns the first success', async () => {
    const statuses = [503, 503, 200];
    const fetchImpl = jest.fn(async () => response(statuses.shift()!, { 'retry-after': '1' }));
    const sleep = jest.fn(async () => undefined);
    const res = await fetchParserWithBackpressure('http://parser/parse-execute', init, { fetchImpl: fetchImpl as any, sleep });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after the maximum attempts and returns the last 503', async () => {
    const fetchImpl = jest.fn(async () => response(503));
    const sleep = jest.fn(async () => undefined);
    const res = await fetchParserWithBackpressure('http://parser/parse-execute', init, { fetchImpl: fetchImpl as any, sleep });
    expect(res.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(PARSER_BACKPRESSURE_MAX_ATTEMPTS);
  });

  it('does not retry non-503 failures', async () => {
    const fetchImpl = jest.fn(async () => response(401));
    const sleep = jest.fn(async () => undefined);
    const res = await fetchParserWithBackpressure('http://parser/parse-execute', init, { fetchImpl: fetchImpl as any, sleep });
    expect(res.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
