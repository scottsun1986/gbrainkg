/**
 * Numeric grounding with unit equivalence.
 *
 * The deterministic grounding gate historically required every numeric claim to
 * appear literally in the evidence, so a correct unit conversion (evidence
 * "0.8s", answer "800毫秒") was mis-flagged as fabrication and the true answer
 * dropped. This module accepts a claim when either the literal digits appear,
 * or a unit-equivalent value/unit pair exists in the evidence.
 *
 * The unit table is generic (time/length/percent/magnitude); no document- or
 * domain-specific constants are encoded.
 */

export interface NumberUnit {
  raw: string;
  value: number;
  unit: string;
}

interface UnitSpec {
  base: string;
  factor: number;
}

const UNIT_TABLE: Record<string, UnitSpec> = {
  ms: { base: "s", factor: 0.001 },
  毫秒: { base: "s", factor: 0.001 },
  s: { base: "s", factor: 1 },
  秒: { base: "s", factor: 1 },
  分: { base: "s", factor: 60 },
  分钟: { base: "s", factor: 60 },
  min: { base: "s", factor: 60 },
  h: { base: "s", factor: 3600 },
  小时: { base: "s", factor: 3600 },
  天: { base: "day", factor: 1 },
  日: { base: "day", factor: 1 },
  周: { base: "day", factor: 7 },
  月: { base: "day", factor: 30 },
  年: { base: "day", factor: 365 },
  m: { base: "m", factor: 1 },
  米: { base: "m", factor: 1 },
  千米: { base: "m", factor: 1000 },
  公里: { base: "m", factor: 1000 },
  km: { base: "m", factor: 1000 },
  cm: { base: "m", factor: 0.01 },
  厘米: { base: "m", factor: 0.01 },
  "%": { base: "%", factor: 1 },
  万: { base: "count", factor: 1e4 },
  亿: { base: "count", factor: 1e8 },
};

const NUMBER_UNIT_RE =
  /(\d+(?:\.\d+)?)\s*(毫秒|ms|分钟|min|小时|千米|公里|km|厘米|cm|秒|分|天|日|周|月|年|米|m|%|万|亿|h|s)/gi;

export function extractNumberUnits(text: string): NumberUnit[] {
  if (!text) return [];
  const out: NumberUnit[] = [];
  for (const match of text.matchAll(NUMBER_UNIT_RE)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    out.push({ raw: match[1], value, unit: match[2] });
  }
  return out;
}

function unitSpec(unit: string): UnitSpec | undefined {
  return UNIT_TABLE[unit] ?? UNIT_TABLE[unit.toLowerCase()];
}

/**
 * Find the first number associated with a directional bound expression, for
 * example `不得低于 800` -> 800. Used to distinguish a genuine bound inversion
 * (lower bound 800 vs upper bound 100) from two compatible bounds that simply
 * straddle a range (lower bound 5万 vs upper bound 10万). Returns null when no
 * number is nearby, in which case callers keep the conservative behaviour.
 */
export function numberNearBound(text: string, bound: RegExp): number | null {
  const norm = String(text || "").replace(/\s+/g, "");
  const match = norm.match(bound);
  if (!match || match.index == null) return null;
  const start = match.index + match[0].length;
  const window = norm.slice(start, start + 14) + "|" + norm.slice(Math.max(0, match.index - 14), match.index);
  const number = window.match(/\d+(?:\.\d+)?/);
  if (!number) return null;
  const value = Number(number[0]);
  return Number.isFinite(value) ? value : null;
}

export function numericClaimsSupportedBy(statement: string, evidence: string): boolean {
  const claims = (statement.replace(/\[\d+\]/g, " ").match(/\d+(?:\.\d+)?/g) || []).filter(
    (token) => token.replace(/[.\s]/g, "").length >= 1,
  );
  if (!claims.length) return true;
  const normEvidence = evidence.replace(/\s+/g, "");

  // Map each numeric token in the statement to its trailing unit, if any.
  const unitByRaw = new Map<string, string>();
  for (const item of extractNumberUnits(statement)) {
    if (!unitByRaw.has(item.raw)) unitByRaw.set(item.raw, item.unit);
  }
  const evidenceUnits = extractNumberUnits(evidence);

  return claims.every((claim) => {
    if (normEvidence.includes(claim.replace(/\s+/g, ""))) return true;
    const unit = unitByRaw.get(claim);
    if (!unit) return false;
    const spec = unitSpec(unit);
    if (!spec) return false;
    const claimBase = Number(claim) * spec.factor;
    if (!Number.isFinite(claimBase)) return false;
    return evidenceUnits.some((item) => {
      const itemSpec = unitSpec(item.unit);
      if (!itemSpec || itemSpec.base !== spec.base) return false;
      const itemBase = item.value * itemSpec.factor;
      const tolerance = Math.max(1e-9, Math.abs(claimBase) * 1e-6);
      return Math.abs(itemBase - claimBase) <= tolerance;
    });
  });
}
