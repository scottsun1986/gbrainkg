/** Resolve a live quality-gate credential without logging its value. */
export async function resolveGateToken(
  baseUrl: string,
  env: Record<string, string | undefined>,
  request: typeof fetch = fetch,
): Promise<string> {
  const preset = env.LLMWIKI_TOKEN || env.AUTH_TOKEN || '';
  const username = env.LLMWIKI_USER || env.TEST_USER || 'admin';
  const password = env.LLMWIKI_PASS || env.TEST_PASSWORD || '';
  if (preset) {
    const response = await request(`${baseUrl}/api/v1/kbs?page=1&limit=1`, {
      headers: { Authorization: `Bearer ${preset}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return preset;
    if (!password) throw new Error(`Quality gate token was rejected (HTTP ${response.status}); provide a valid token or login credentials.`);
  }
  if (!password) throw new Error('Quality gate requires LLMWIKI_TOKEN/AUTH_TOKEN or LLMWIKI_USER/TEST_USER with LLMWIKI_PASS/TEST_PASSWORD.');
  const response = await request(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Quality gate login failed (HTTP ${response.status}).`);
  const payload: any = await response.json().catch(() => null);
  if (typeof payload?.token !== 'string' || !payload.token) {
    throw new Error('Quality gate login returned no token.');
  }
  return payload.token;
}

export function requireResolvedScopes(
  scopes: string[][],
  mapped: Map<string, string>,
  baseUrl: string,
): void {
  const missing = [...new Set(scopes.flat())].filter((scope) => !mapped.has(scope));
  if (missing.length) {
    throw new Error(`Golden Evaluation KBs missing from ${baseUrl}: ${missing.join(', ')}. Seed the matching corpus before scoring.`);
  }
}
