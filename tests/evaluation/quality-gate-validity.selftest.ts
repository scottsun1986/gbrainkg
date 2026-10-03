/**
 * Self-test for the quality-gate validity verdict.
 *
 * Regressions here are silent and expensive: a gate that reports a number for a
 * run that never executed is worse than a gate that fails, because the number
 * gets quoted as a measurement (see the 2026-09-27 report, where 50/50 rows
 * were HTTP 401 and the summary still printed 0.40).
 *
 * Run: npx --yes tsx@4.23.13 tests/evaluation/quality-gate-validity.selftest.ts
 */

import {
  classifyResultError,
  computeEnvErrorRate,
  evaluateValidity,
  isEnvironmentError,
} from './quality-gate-validity';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
}

function equal<T>(name: string, actual: T, expected: T): void {
  check(name, actual === expected, `expected ${String(expected)}, got ${String(actual)}`);
}

console.log('classifyResultError');
equal('401 is an auth environment error', classifyResultError({ status: 401 }), 'auth');
equal('403 is an auth environment error', classifyResultError({ status: 403 }), 'auth');
equal('500 is a transport error', classifyResultError({ status: 500 }), 'transport');
equal('a TimeoutError is a timeout', classifyResultError({ error: 'TimeoutError: signal timed out' }), 'timeout');
equal('a corpus gap stays its own category', classifyResultError({ error: 'corpus_absent: documents missing' }), 'missing-corpus');
equal('ECONNREFUSED is a transport error', classifyResultError({ error: 'connect ECONNREFUSED 127.0.0.1:3202' }), 'transport');
equal('a low score with no error is a scoring failure', classifyResultError({}), 'scoring');
equal('an embedded HTTP 401 in the message is still auth', classifyResultError({ error: 'HTTP 401: Invalid credentials' }), 'auth');
equal('an embedded HTTP 503 in the message is transport', classifyResultError({ error: 'HTTP 503: upstream down' }), 'transport');

console.log('isEnvironmentError');
check('auth is an environment error', isEnvironmentError('auth'));
check('missing-corpus is an environment error', isEnvironmentError('missing-corpus'));
check('scoring is NOT an environment error', !isEnvironmentError('scoring'));

console.log('computeEnvErrorRate');
check('uses attempted as the denominator', computeEnvErrorRate(5, 50) === 0.1);
check('treats zero attempted as fully failed', computeEnvErrorRate(0, 0) === 1);

console.log('evaluateValidity');
const bounds = { minScoredCases: 10, maxEnvErrorRate: 0.05 };

// The exact failure the audit found: every case 401, so nothing was scored.
{
  const verdict = evaluateValidity({ scored: 0, attempted: 50, envErrors: 50, ...bounds });
  check('an all-401 run is invalid', !verdict.valid);
  check('an all-401 run explains why', /did not answer|measures nothing/i.test(verdict.invalidReason || ''));
}

// 6% environment errors: over budget, must fail even though 94% scored.
{
  const verdict = evaluateValidity({ scored: 94, attempted: 100, envErrors: 6, ...bounds });
  check('a 6% environment error rate is invalid', !verdict.valid);
}

// 4% environment errors: within budget, a real result.
{
  const verdict = evaluateValidity({ scored: 96, attempted: 100, envErrors: 4, ...bounds });
  check('a 4% environment error rate is valid', verdict.valid);
  check('a valid run has no reason', verdict.invalidReason === null);
}

// Exactly at the boundary: not over budget.
{
  const verdict = evaluateValidity({ scored: 95, attempted: 100, envErrors: 5, ...bounds });
  check('exactly the budget is valid', verdict.valid);
}

// Too few scored cases to draw any conclusion.
{
  const verdict = evaluateValidity({ scored: 3, attempted: 100, envErrors: 0, ...bounds });
  check('a run below the minimum scored count is invalid', !verdict.valid);
  check('the shortfall is named', /below the minimum/.test(verdict.invalidReason || ''));
}

// Full, healthy run.
{
  const verdict = evaluateValidity({ scored: 50, attempted: 50, envErrors: 0, ...bounds });
  check('a clean full run is valid', verdict.valid);
}

console.log('');
if (failures > 0) {
  console.error(`quality-gate-validity self-test FAILED (${failures} check(s))`);
  process.exit(1);
}
console.log('quality-gate-validity self-test passed');
