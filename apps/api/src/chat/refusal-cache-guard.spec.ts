import { isRefusalAnswerText } from './chat.service';

/**
 * The semantic cache must never store a refusal.
 *
 * Regression: the detector only matched Chinese phrases, so English "not recorded in
 * the provided reference materials" answers were cached and replayed for the whole TTL
 * — to later users and to the international benchmarks, where a question that a
 * retrieval improvement later answered kept returning the stale refusal.
 */
describe('isRefusalAnswerText', () => {
  it('detects Chinese refusals', () => {
    expect(isRefusalAnswerText('已知知识库资料中未包含相关信息，无法回答该问题。')).toBe(true);
    expect(isRefusalAnswerText('无法根据知识库回答')).toBe(true);
  });

  it('detects English refusals', () => {
    for (const text of [
      'Based on the provided reference materials, the relevant information is not available.',
      'The first president is not recorded in the provided reference materials.',
      'The materials do not contain this information.',
      'Insufficient information to answer.',
      'I am unable to answer this question from the given documents.',
    ]) {
      expect(isRefusalAnswerText(text)).toBe(true);
    }
  });

  it('does not treat a real answer as a refusal', () => {
    expect(isRefusalAnswerText('Sleep, My Love was directed by Douglas Sirk [1].')).toBe(false);
    expect(isRefusalAnswerText('Yeltsin was the first president of the Russian Federation [2].')).toBe(false);
    expect(isRefusalAnswerText('')).toBe(true);
  });

  // Every phrasing below was taken from an actual benchmark answer that the
  // pipeline failed to recognise as a refusal, which silently disabled the
  // refusal re-check (measured 2026-09-21: 1 trigger across 9 refusal-shaped
  // multi-hop failures).
  it('detects the refusals the international benchmarks actually produce', () => {
    for (const text of [
      'The year of the Tunisian national team\'s first World Cup appearance is not specified in the provided sources [1].',
      'The reference materials do not state the place of death of Francesco Maria Marescotti Ruspoli.',
      'The 2017 population of Pakistan is not recorded in the provided materials.',
      'There is no record of a 1940 film starring John Arledge.',
      'The documents do not mention any siblings of Mara Wilson.',
      'The place of birth is not documented in the sources.',
    ]) {
      expect(isRefusalAnswerText(text)).toBe(true);
    }
  });

  it('still keeps ordinary answers that merely contain "not" out of the refusal bucket', () => {
    expect(isRefusalAnswerText('The film was not directed by Douglas Sirk but by George Sherman [1].')).toBe(false);
    expect(isRefusalAnswerText('The treaty was signed in 1920 [1]; it was not ratified until 1922 [2].')).toBe(false);
  });
});
