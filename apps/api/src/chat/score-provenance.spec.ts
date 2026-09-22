import { calibratedScoreOf, evidenceConfidenceScores, resolveArmPolicy, resolveGbrainRaceMs } from './chat.service';

describe('citation score provenance', () => {
  it('treats rerank and native engine scores as calibrated', () => {
    expect(calibratedScoreOf({ score: 0.42, scoreSource: 'rerank' })).toBe(0.42);
    expect(calibratedScoreOf({ rerankScore: 0.11, scoreSource: 'native' })).toBe(0.11);
    // Unmarked citations come straight from an engine that scored them.
    expect(calibratedScoreOf({ score: 0.3 })).toBe(0.3);
  });

  it('never treats a synthetic placement constant as a measurement', () => {
    expect(calibratedScoreOf({ score: 0.95, scoreSource: 'synthetic' })).toBeNull();
    expect(calibratedScoreOf({ score: 0.999, scoreSource: 'synthetic' })).toBeNull();
    expect(calibratedScoreOf(null)).toBeNull();
    expect(calibratedScoreOf({ score: 0 })).toBeNull();
  });

  it('keeps the min-max fallback arm out of the calibrated maximum', () => {
    // A weak retrieval set where the only high number is the fallback arm's
    // self-normalised 0.95. Before the split this cleared the 0.25 refusal
    // floor and made the gate unfalsifiable.
    const scores = evidenceConfidenceScores([
      { score: 0.95, scoreSource: 'synthetic' },
      { score: 0.05, scoreSource: 'rerank' },
    ]);
    expect(scores.maxCalibrated).toBe(0.05);
    expect(scores.maxSynthetic).toBe(0.95);
  });

  it('reports the synthetic maximum when no calibrated scorer ran', () => {
    const scores = evidenceConfidenceScores([{ score: 0.95, scoreSource: 'synthetic' }]);
    expect(scores.maxCalibrated).toBeNull();
    expect(scores.maxSynthetic).toBe(0.95);
  });

  it('ignores citations with no score at all instead of assuming perfect evidence', () => {
    const scores = evidenceConfidenceScores([{ score: undefined }, { scoreSource: 'synthetic' }]);
    expect(scores.maxCalibrated).toBeNull();
    expect(scores.maxSynthetic).toBeNull();
  });
});

describe('resolveGbrainRaceMs', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('defaults to a budget large enough for a healthy GBrain answer', () => {
    delete process.env.GBRAIN_SEARCH_RACE_TIMEOUT_MS;
    delete process.env.GBRAIN_RACE_TIMEOUT_MS;
    // Multi-hop bridge evidence comes only from this arm; the old hardcoded 2s
    // was measured to expire under load (GBRAIN_CANCELLED).
    expect(resolveGbrainRaceMs()).toBeGreaterThanOrEqual(4000);
  });

  it('honours an explicit override and clamps nonsense values', () => {
    process.env.GBRAIN_SEARCH_RACE_TIMEOUT_MS = '9000';
    expect(resolveGbrainRaceMs()).toBe(9000);
    process.env.GBRAIN_SEARCH_RACE_TIMEOUT_MS = '0';
    expect(resolveGbrainRaceMs()).toBeGreaterThanOrEqual(4000);
    process.env.GBRAIN_SEARCH_RACE_TIMEOUT_MS = '10';
    expect(resolveGbrainRaceMs()).toBe(500);
  });

  it('keeps the legacy GBRAIN_RACE_TIMEOUT_MS alias working', () => {
    delete process.env.GBRAIN_SEARCH_RACE_TIMEOUT_MS;
    process.env.GBRAIN_RACE_TIMEOUT_MS = '7500';
    expect(resolveGbrainRaceMs()).toBe(7500);
  });
});

describe('resolveArmPolicy', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('defaults to chunks_only (measured best on the multi-hop benchmarks)', () => {
    // Measured 2026-09-20 with per-probe reranking, n=100: 2Wiki 0.810 / Hotpot 0.955 /
    // MuSiQue 0.765, versus 0.790/0.910/0.667 with the engine arm retained.
    delete process.env.RETRIEVAL_ARM_POLICY;
    expect(resolveArmPolicy()).toBe('chunks_only');
  });

  it('accepts explicit engine_first / chunks_only and ignores junk', () => {
    process.env.RETRIEVAL_ARM_POLICY = 'engine_first';
    expect(resolveArmPolicy()).toBe('engine_first');
    process.env.RETRIEVAL_ARM_POLICY = 'chunk_first';
    expect(resolveArmPolicy()).toBe('chunk_first');
    process.env.RETRIEVAL_ARM_POLICY = 'whatever';
    expect(resolveArmPolicy()).toBe('chunks_only');
  });
});
