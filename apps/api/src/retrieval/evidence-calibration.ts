import { readFileSync } from 'node:fs';
export function calibrateRerankScore(score: number, route: string, model: string, revision = process.env.RERANK_DEPLOYMENT_REVISION): number | null {
  if (!revision || !process.env.RERANK_CALIBRATION_FILE || !Number.isFinite(score)) return null;
  try {
    const profile = JSON.parse(readFileSync(process.env.RERANK_CALIBRATION_FILE,'utf8'));
    if (profile.contract !== 'rerank-platt-v1' || profile.route !== route || profile.model !== model || profile.revision !== revision || !profile.validationSetHash || !profile.corpusHash || profile.sampleCount < 200 || !Number.isFinite(profile.slope) || profile.slope <= 0 || !Number.isFinite(profile.intercept)) return null;
    return 1/(1+Math.exp(-Math.max(-40,Math.min(40,profile.slope*score+profile.intercept))));
  } catch { return null; }
}
