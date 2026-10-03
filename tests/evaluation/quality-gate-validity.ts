/**
 * Validity classification for a quality-gate run.
 *
 * The 2026-09-27 report is the reason this module exists. All 50 rows carried
 * `HTTP 401: {"message":"Invalid or missing credentials."}`, yet the report
 * printed `overallSuccessRate: 0.40`, because two scoring rules are trivially
 * satisfied by an empty answer:
 *
 *   - `success = (expected_no_answer ? noAnswer : hitRate) && permission`, and
 *     `hitRate` is true whenever `expected_document_titles` is empty, so
 *     `document_listing` and `edge_cases` "passed" with no answer at all;
 *   - the permission probe accepted `status === 401 || status === 403` as proof
 *     that scope was enforced, so a rejected credential read as a passing
 *     permission check.
 *
 * An unauthenticated run therefore manufactured a plausible pass rate, and that
 * number was then quoted downstream as a measurement of quality. The fix is a
 * verdict computed from the result rows themselves: a run in which the
 * environment never answered is INVALID, and an invalid run must not be read as
 * a quality signal no matter what its score would have been.
 *
 * Kept as a pure module (no I/O, no clock, no env reads inside the functions)
 * so the decision can be unit-tested without a live API.
 */

export type EnvErrorCategory = 'auth' | 'transport' | 'timeout' | 'missing-corpus' | 'scoring';

export interface ClassifiableResult {
  /** HTTP status when the failure was a response; omitted for client-side errors. */
  status?: number;
  /** Raw error string recorded by the harness, if any. */
  error?: string | null;
}

/**
 * Classify one result's error. Anything that means "the case was never actually
 * scored" is an environment failure; everything else is the system under test
 * genuinely scoring badly, which is exactly what the gate is for.
 */
export function classifyResultError(result: ClassifiableResult): EnvErrorCategory {
  const status = Number(result?.status);
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500 && status < 600) return 'transport';

  const error = String(result?.error ?? '');
  if (!error) return 'scoring';

  // Timeouts are reported by the client as AbortSignal timeouts, not as a
  // status code, so they have to be recognised from the message.
  if (/TimeoutError|AbortError|timed?\s*out|timeout of \d+ms exceeded/i.test(error)) return 'timeout';
  // Corpous gaps are a known, tracked condition; they are still not a quality
  // measurement, but they must stay distinguishable from an outage so fixing
  // the dataset is not confused with fixing the deployment.
  if (/corpus[_ ]?absent|missing corpus|expected documents? not (?:in|present)/i.test(error)) {
    return 'missing-corpus';
  }
  if (/ECONNREFUSED|ECONNRESET|socket hang ?up|fetch failed|network|ENOTFOUND|EAI_AGAIN/i.test(error)) {
    return 'transport';
  }
  const embedded = error.match(/HTTP (\d{3})/i);
  if (embedded) {
    const code = Number(embedded[1]);
    if (code === 401 || code === 403) return 'auth';
    if (code >= 500 && code < 600) return 'transport';
  }
  return 'scoring';
}

export function isEnvironmentError(category: EnvErrorCategory): boolean {
  return category !== 'scoring';
}

/**
 * Share of attempted cases the environment prevented from being scored.
 *
 * The denominator is `attempted`, not `results.length`: an environment failure
 * means the case produced no score, so dividing by the number of scored rows
 * would hide a run that mostly failed to run at all.
 */
export function computeEnvErrorRate(envErrors: number, attempted: number): number {
  if (!Number.isFinite(attempted) || attempted <= 0) return 1;
  return envErrors / attempted;
}

export interface ValidityInput {
  /** Cases that produced a real score. */
  scored: number;
  /** Cases the harness tried to score. */
  attempted: number;
  /** Cases that failed for environment reasons. */
  envErrors: number;
  minScoredCases: number;
  maxEnvErrorRate: number;
}

export interface ValidityVerdict {
  valid: boolean;
  invalidReason: string | null;
  envErrorRate: number;
}

/**
 * Decide whether a run may be reported as a quality result.
 *
 * Fail closed: an unreadable result is never "valid but low". The order of the
 * checks is deliberate — "nothing ran" is reported before "much of it failed",
 * because the first is the more actionable diagnosis.
 */
export function evaluateValidity(input: ValidityInput): ValidityVerdict {
  const envErrorRate = computeEnvErrorRate(input.envErrors, input.attempted);

  if (input.scored <= 0) {
    return {
      valid: false,
      invalidReason: 'no case produced a score: the environment did not answer, so this run measures nothing',
      envErrorRate,
    };
  }
  if (input.scored < input.minScoredCases) {
    return {
      valid: false,
      invalidReason: `only ${input.scored} case(s) scored, below the minimum of ${input.minScoredCases}`,
      envErrorRate,
    };
  }
  // Strictly greater: exactly the configured rate is within budget, one point
  // above it is not. Same boundary the selftest pins (5% passes, 6% fails).
  if (envErrorRate > input.maxEnvErrorRate) {
    return {
      valid: false,
      invalidReason:
        `environment error rate ${(envErrorRate * 100).toFixed(1)}% exceeds the ` +
        `${(input.maxEnvErrorRate * 100).toFixed(1)}% budget: the score reflects the environment, not the system`,
      envErrorRate,
    };
  }
  return { valid: true, invalidReason: null, envErrorRate };
}

/** Read the operator-configurable bounds, with the defaults the audit agreed. */
export function validityBounds(env: NodeJS.ProcessEnv = process.env): {
  minScoredCases: number;
  maxEnvErrorRate: number;
} {
  const minScoredCases = Number(env.GATE_MIN_SCORED_CASES ?? 10);
  const maxEnvErrorRate = Number(env.GATE_MAX_ENV_ERROR_RATE ?? 0.05);
  return {
    minScoredCases: Number.isFinite(minScoredCases) && minScoredCases >= 0 ? minScoredCases : 10,
    maxEnvErrorRate:
      Number.isFinite(maxEnvErrorRate) && maxEnvErrorRate >= 0 && maxEnvErrorRate <= 1
        ? maxEnvErrorRate
        : 0.05,
  };
}
