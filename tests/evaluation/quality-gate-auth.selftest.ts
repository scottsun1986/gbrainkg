import assert from 'node:assert/strict';
import { requireResolvedScopes, resolveGateToken } from './quality-gate-auth';

async function main() {
  const requests: Array<{ url: string; method: string; body?: any }> = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method || 'GET', body: init?.body });
    if (url.endsWith('/auth/login')) {
      return new Response(JSON.stringify({ token: 'fresh-token' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  assert.equal(await resolveGateToken('http://test', { TEST_USER: 'admin', TEST_PASSWORD: 'secret' }, request), 'fresh-token');
  assert.equal(requests[0].url, 'http://test/api/v1/auth/login');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[0].body)), { username: 'admin', password: 'secret' });
  requests.length = 0;
  assert.equal(await resolveGateToken('http://test', { LLMWIKI_TOKEN: 'valid-token' }, request), 'valid-token');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/v1\/kbs\?/);
  const rejectedTokenRequest = (async (input: string | URL | Request) =>
    String(input).includes('/auth/login')
      ? new Response(JSON.stringify({ token: 'fresh-token' }), { status: 200 })
      : new Response('{}', { status: 401 })) as typeof fetch;
  await assert.rejects(
    resolveGateToken('http://test', { LLMWIKI_TOKEN: 'expired' }, rejectedTokenRequest),
    /token was rejected.*401/,
  );
  assert.equal(
    await resolveGateToken('http://test', {
      LLMWIKI_TOKEN: 'expired', TEST_USER: 'admin', TEST_PASSWORD: 'secret',
    }, rejectedTokenRequest),
    'fresh-token',
  );
  await assert.rejects(resolveGateToken('http://test', {}, request), /requires/);
  assert.throws(() => requireResolvedScopes([['kb-a', 'kb-b']], new Map([['kb-a', 'id-a']]), 'http://test'), /kb-b/);
  requireResolvedScopes([['kb-a']], new Map([['kb-a', 'id-a']]), 'http://test');
  console.log('quality-gate-auth selftest OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
