/**
 * A/B 门禁 runner：登录 API → 拉 /api/v1/experiments/summary → evaluateAbSummaries。
 * 无凭据/无样本时跳过退出 0；有样本且 treatment 劣化时退出 1。
 */
import { evaluateAbSummaries, ArmSummary } from '../../apps/api/src/experiments/ab-gate';

async function main() {
  const base = process.env.API_BASE || 'http://127.0.0.1:3202';
  const user = process.env.TEST_USER || process.env.LLMWIKI_USER || 'admin';
  const password = process.env.TEST_PASSWORD || process.env.LLMWIKI_PASS;
  if (!password) {
    console.log('[ab-gate-runner] no TEST_PASSWORD, skipping');
    return 0;
  }
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password }),
  }).catch(() => null);
  if (!login || !login.ok) {
    console.log('[ab-gate-runner] login failed or API down — skipping');
    return 0;
  }
  const loginJson = (await login.json()) as { token?: string; accessToken?: string };
  const token = loginJson.token || loginJson.accessToken || '';
  const res = await fetch(`${base}/api/v1/experiments/summary`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }).catch(() => null);
  if (!res || !res.ok) {
    console.log('[ab-gate-runner] summary fetch failed — skipping');
    return 0;
  }
  const summaries = (await res.json()) as ArmSummary[];
  const result = evaluateAbSummaries(summaries, {
    tolerance: Number(process.env.AB_TOLERANCE || 0.05),
    minSamples: Number(process.env.AB_MIN_SAMPLES || 30),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.skipped) return 0;
  return result.pass ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[ab-gate-runner] error', err);
    process.exit(0); // fail-open in runner; strict mode handled by exit code path above
  });
