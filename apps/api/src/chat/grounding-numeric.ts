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
  /(\d+(?:\.\d+)?)\s*(毫秒|ms|分钟|min|小时|千米|公里|km|厘米|cm|秒|分|天|日|周|月|年|米|m|%|万|亿|h|s)(?![A-Za-z])/gi;

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
    const claimNorm = claim.replace(/\s+/g, "");
    const boundaryRe = new RegExp(`(?<![\\d.])${claimNorm}(?![\\d.])`);
    if (boundaryRe.test(normEvidence)) return true;
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

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
];

/**
 * Decisive-value attribution for cited factual claims.
 *
 * Character/token overlap grounding passes a parametric-memory answer whose
 * topical words all occur in same-topic documents while the decisive value
 * appears nowhere in the evidence: measured on the RGB negative-rejection
 * probes, every content word of "The 2022 Winter Paralympic Games started on
 * March 4, 2022" except the date itself occurred in the retrieved noise, so the
 * overlap bar cleared and the memory-based answer shipped with a citation.
 *
 * This gate checks only the *decisive* tokens of a cited claim:
 *   - full dates (EN "March 4, 2022" / "4 March 2022"; CN "3月4日") — the
 *     month-day combination must occur in the evidence in either order;
 *   - proper-noun tokens that the question itself does not contain — for short
 *     headline-style factoid sentences every one of them must occur in the
 *     evidence (a synthesis names its entities; a memory guess invents one).
 *
 * Deliberately narrow: unit conversions and paraphrase keep flowing through
 * numericClaimsSupportedBy / the NLI judge; sentences without citation markers
 * are not this gate's business.
 */
export function decisiveValueSupportedBy(
  sentence: string,
  evidenceTexts: string[],
  question: string,
): boolean {
  const body = String(sentence || '').replace(/\[\d+\]/g, ' ');
  const evidence = (evidenceTexts || []).join('\n');
  if (!evidence.trim()) return false;
  const normEvidence = evidence.replace(/\s+/g, '').toLowerCase();
  const normEvidenceSpaced = evidence.toLowerCase();

  // ---- full dates: month-day combo in either order ----
  const dateFail = (() => {
    for (const match of body.matchAll(
      new RegExp(`\\b(${MONTH_NAMES.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?\\b`, 'gi'),
    )) {
      const month = match[1].toLowerCase();
      const day = String(Number(match[2]));
      if (!dateComboInEvidence(normEvidence, month, day)) return true;
    }
    for (const match of body.matchAll(
      new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES.join('|')})(?:,?\\s*\\d{4})?\\b`, 'gi'),
    )) {
      const day = String(Number(match[1]));
      const month = match[2].toLowerCase();
      if (!dateComboInEvidence(normEvidence, month, day)) return true;
    }
    for (const match of body.matchAll(/(\d{1,2})月(\d{1,2})日/g)) {
      const month = String(Number(match[1]));
      const day = String(Number(match[2]));
      if (!normEvidence.includes(`${month}月${day}日`)) return true;
    }
    return false;
  })();
  if (dateFail) return false;

  // ---- decisive proper nouns on short factoid sentences ----
  const isEnglish = !/[\u4e00-\u9fff]/.test(body);
  if (!isEnglish) return true;
  const compact = body.replace(/\s+/g, ' ').trim();
  if (compact.length > 90) return true; // synthesis paragraphs: NLI's job
  const questionTokens = new Set(
    (question || '').toLowerCase().match(/[a-z0-9'-]+/g) || [],
  );
  const words = compact.split(/\s+/);
  const decisive: string[] = [];
  words.forEach((word, index) => {
    const clean = word.replace(/[^A-Za-z'-]/g, '');
    if (clean.length < 3) return;
    if (!/^[A-Z]/.test(word)) return;
    if (index === 0 && words.length > 1) return; // sentence-initial capitalisation
    if (MONTH_NAMES.includes(clean.toLowerCase())) return;
    if (questionTokens.has(clean.toLowerCase())) return;
    decisive.push(clean.toLowerCase());
  });
  if (decisive.length < 1) return true;
  const allPresent = decisive.every((token) => normEvidenceSpaced.includes(token));
  return allPresent;
}

const MONTH_NUMBERS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

function dateComboInEvidence(normEvidence: string, month: string, day: string): boolean {
  if (normEvidence.includes(`${month}${day}`)) return true;
  if (normEvidence.includes(`${day}${month}`)) return true;
  // tolerate an ordinal suffix or comma between day and month in the source
  if (new RegExp(`${month}.{0,3}${day}`).test(normEvidence)) return true;
  if (new RegExp(`${day}.{0,3}${month}`).test(normEvidence)) return true;
  // ISO / numeric dates in the evidence (Wikidata emits 1957-04-29): match the
  // month-day pair in zero-padded numeric form so a correct "April 29" is not
  // mis-flagged against an ISO source. Both month-day and day-month orders.
  const mnum = MONTH_NUMBERS[month];
  if (mnum) {
    const dd = day.padStart(2, '0');
    if (dd === day && normEvidence.includes(`${mnum}-${dd}`)) return true;
    if (normEvidence.includes(`${dd}-${mnum}`)) return true;
    if (normEvidence.includes(`${dd}.${mnum}`)) return true;
    if (normEvidence.includes(`${dd}/${mnum}`)) return true;
  }
  return false;
}
