import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

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

function matchingProfile(route: string, model: string, revision = process.env.RERANK_DEPLOYMENT_REVISION): Record<string, unknown> | null {
  if (!revision || !process.env.RERANK_CALIBRATION_FILE) return null;
  try {
    const profile = loadProfile(process.env.RERANK_CALIBRATION_FILE);
    const routeMatches = profile.routeHash !== undefined
      ? typeof profile.routeHash === 'string' && /^[a-f0-9]{64}$/i.test(profile.routeHash)
        && profile.routeHash.toLowerCase() === createHash('sha256').update(route).digest('hex')
      : profile.route === route;
    if (profile.contract !== 'rerank-platt-v1' || !routeMatches || profile.model !== model || profile.revision !== revision || typeof profile.validationSetHash !== 'string' || !profile.validationSetHash.trim() || typeof profile.corpusHash !== 'string' || !profile.corpusHash.trim() || typeof profile.sampleCount !== 'number' || !Number.isInteger(profile.sampleCount) || profile.sampleCount < 200 || typeof profile.slope !== 'number' || !Number.isFinite(profile.slope) || profile.slope <= 0 || typeof profile.intercept !== 'number' || !Number.isFinite(profile.intercept)) return null;
    return profile;
  } catch { cachedProfile = undefined; return null; }
}

export function calibrateRerankScore(score: number, route: string, model: string, revision = process.env.RERANK_DEPLOYMENT_REVISION): number | null {
  if (!Number.isFinite(score)) return null;
  const profile = matchingProfile(route, model, revision);
  return profile ? 1/(1+Math.exp(-Math.max(-40,Math.min(40,Number(profile.slope)*score+Number(profile.intercept))))) : null;
}

/** Optional learned operating point, pinned to the same held-out profile as
 * its probability. Missing/invalid thresholds never acquire invented values. */
export function calibratedRefusalThreshold(route: string, model: string, revision = process.env.RERANK_DEPLOYMENT_REVISION): number | null {
  const threshold = matchingProfile(route, model, revision)?.refusalThreshold;
  return typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0 && threshold < 1 ? threshold : null;
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
