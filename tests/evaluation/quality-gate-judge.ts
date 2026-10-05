/** Judge configuration and scoring shared by the live gate and offline proofs. */
export function judgeConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.GATE_LLM_JUDGE === 'true';
  const minimum = Number(env.GATE_LLM_JUDGE_MIN ?? 0);
  const samples = Number(env.GATE_LLM_JUDGE_SAMPLES ?? 1);
  const strict = env.GATE_STRICT === '1';
  const problems: string[] = [];
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1) {
    problems.push('GATE_LLM_JUDGE_MIN must be a finite number in [0, 1]');
  }
  if (!Number.isInteger(samples) || samples < 1 || samples > 5) {
    problems.push('GATE_LLM_JUDGE_SAMPLES must be an integer in [1, 5]');
  }
  if ((strict || minimum > 0) && !enabled) problems.push('GATE_LLM_JUDGE=true is required');
  if (strict && !(minimum > 0)) problems.push('GATE_LLM_JUDGE_MIN must be greater than 0');
  if (strict && samples < 3) problems.push('GATE_LLM_JUDGE_SAMPLES must be at least 3');
  if (problems.length) throw new Error(`Quality gate configuration invalid: ${problems.join('; ')}`);
  return { enabled, minimum, samples };
}

/** Malformed assertions cannot become a valid score through a scalar fallback. */
export function judgeResponseScore(parsed: unknown, expectedNoAnswer: boolean): number {
  if (!parsed || typeof parsed !== 'object') return -1;
  const { assertions, score } = parsed as { assertions?: unknown; score?: unknown };
  if (Array.isArray(assertions) && assertions.length > 0) {
    if (!assertions.every((a) => a && typeof a.text === 'string' && a.text.trim()
      && typeof a.supported === 'boolean')) return -1;
    return assertions.filter((a) => a.supported).length / assertions.length;
  }
  // A correct refusal can contain no factual assertions. Answerable questions
  // need an assertion table; a bare model-supplied score is not grounding proof.
  if (expectedNoAnswer && Array.isArray(assertions) && assertions.length === 0
    && typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1) return score;
  return -1;
}

/** Every requested pass must complete; averaging survivors hides judge outages. */
export function summarizeJudgeSamples(scores: number[], expectedSamples: number) {
  if (scores.length !== expectedSamples || !scores.every((s) => Number.isFinite(s) && s >= 0 && s <= 1)) {
    return { score: -1, spread: null };
  }
  return {
    score: scores.reduce((a, b) => a + b, 0) / scores.length,
    spread: scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : null,
  };
}
