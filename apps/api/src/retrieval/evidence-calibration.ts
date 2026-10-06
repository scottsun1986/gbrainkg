import { readFileSync, statSync } from 'node:fs';

// Keep one bounded entry; check metadata on use so profile replacements or
// removal take effect immediately rather than serving stale confidence values.
let cachedProfile: { path: string; fingerprint: string; value: Record<string, unknown> } | undefined;
function loadProfile(path: string): Record<string, unknown> {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile() || stat.size > 1_048_576n) throw new Error('Invalid calibration profile file');
  const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  if (cachedProfile?.path === path && cachedProfile.fingerprint === fingerprint) return cachedProfile.value;
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid calibration profile');
  cachedProfile = { path, fingerprint, value: value as Record<string, unknown> };
  return cachedProfile.value;
}

export function calibrateRerankScore(score: number, route: string, model: string, revision = process.env.RERANK_DEPLOYMENT_REVISION): number | null {
  if (!revision || !process.env.RERANK_CALIBRATION_FILE || !Number.isFinite(score)) return null;
  try {
    const profile = loadProfile(process.env.RERANK_CALIBRATION_FILE);
    if (profile.contract !== 'rerank-platt-v1' || profile.route !== route || profile.model !== model || profile.revision !== revision || typeof profile.validationSetHash !== 'string' || !profile.validationSetHash.trim() || typeof profile.corpusHash !== 'string' || !profile.corpusHash.trim() || typeof profile.sampleCount !== 'number' || !Number.isInteger(profile.sampleCount) || profile.sampleCount < 200 || typeof profile.slope !== 'number' || !Number.isFinite(profile.slope) || profile.slope <= 0 || typeof profile.intercept !== 'number' || !Number.isFinite(profile.intercept)) return null;
    return 1/(1+Math.exp(-Math.max(-40,Math.min(40,profile.slope*score+profile.intercept))));
  } catch { cachedProfile = undefined; return null; }
}

/** Cache identity changes when the configured calibration file is replaced. */
export function calibrationProfileFingerprint(): string {
  const path = process.env.RERANK_CALIBRATION_FILE;
  if (!path) return 'none';
  try {
    const stat = statSync(path, { bigint: true });
    return `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch { return `${path}:unavailable`; }
}
