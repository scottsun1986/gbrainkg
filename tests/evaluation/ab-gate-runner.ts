/**
 * A/B 门禁 runner：登录 API → 拉 /api/v1/experiments/summary → evaluateAbSummaries。
 * 报告模式允许无凭据/无样本跳过；严格模式对缺数据、服务异常 fail closed。
 */
import { evaluateAbSummaries, ArmSummary } from '../../apps/api/src/experiments/ab-gate';

async function main() {
  const strict = process.env.GATE_STRICT === '1';
  const base = process.env.API_BASE || 'http://127.0.0.1:3202';
  const user = process.env.TEST_USER || process.env.LLMWIKI_USER || 'admin';
  const password = process.env.TEST_PASSWORD || process.env.LLMWIKI_PASS;
  if (!password) {
    console.log('[ab-gate-runner] no TEST_PASSWORD, skipping');
    return strict ? 1 : 2;
  }
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password }),
  }).catch(() => null);
  if (!login || !login.ok) {
    console.error('[ab-gate-runner] login failed or API down');
    return 1;
  }
  const loginJson = (await login.json()) as { token?: string; accessToken?: string };
  const token = loginJson.token || loginJson.accessToken || '';
  const res = await fetch(`${base}/api/v1/experiments/summary`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }).catch(() => null);
  if (!res || !res.ok) {
    console.error('[ab-gate-runner] summary fetch failed');
    return 1;
  }
  const summaries = (await res.json()) as ArmSummary[];
  const result = evaluateAbSummaries(summaries, {
    tolerance: Number(process.env.AB_TOLERANCE || 0.05),
    minSamples: Number(process.env.AB_MIN_SAMPLES || 30),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.skipped) return strict ? 1 : 2;
  return result.pass ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[ab-gate-runner] error', err);
    process.exit(1);
  });
