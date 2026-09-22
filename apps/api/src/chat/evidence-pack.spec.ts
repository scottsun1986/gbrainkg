import {
  buildEvidenceReasoningGroups,
  fitStructuredEvidenceToBudget,
  formatEvidenceReasoningMap,
  planStructuredEvidence,
} from './evidence-pack';

describe('structured evidence pack', () => {
  it('keeps the global top result and moves one representative per sub-question ahead of duplicates', () => {
    const citations = [
      { id: 'top', subQueryOrigin: 'first hop' },
      { id: 'first-duplicate', subQueryOrigin: 'first hop' },
      { id: 'noise' },
      { id: 'second', subQueryOrigin: 'second hop' },
      { id: 'bridge', bridgeRescue: true, hop: 2 },
    ];
    const plan = planStructuredEvidence(citations, {
      complexity: 'multi_hop',
      subQueries: ['first hop', 'second hop'],
    });
    expect(plan.citations.map((citation) => citation.id)).toEqual([
      'top', 'second', 'bridge', 'first-duplicate', 'noise',
    ]);
    expect(plan.applied).toBe(true);
  });

  it('keeps provider-originated probe groups even when absent from the explicit probe list', () => {
    const citations = [
      { id: 'top', subQueryOrigin: 'first hop' },
      { id: 'duplicate', subQueryOrigin: 'first hop' },
      { id: 'provider-hop', subQueryOrigin: 'provider discovered hop' },
    ];
    const plan = planStructuredEvidence(citations, {
      complexity: 'multi_hop',
      subQueries: ['first hop'],
    });
    expect(plan.citations.map((citation) => citation.id)).toEqual([
      'top', 'provider-hop', 'duplicate',
    ]);
  });

  it('does not perturb simple questions', () => {
    const citations = [
      { id: 'a', subQueryOrigin: 'one' },
      { id: 'b', subQueryOrigin: 'two' },
    ];
    const plan = planStructuredEvidence(citations, {
      complexity: 'simple',
      subQueries: ['one', 'two'],
    });
    expect(plan.citations).toEqual(citations);
    expect(plan.applied).toBe(false);
    expect(plan.groups).toEqual([]);
  });

  it('preserves every origin when a stitched citation covers multiple probes', () => {
    const groups = buildEvidenceReasoningGroups([
      { subQueryOrigin: 'first hop', subQueryOrigins: ['first hop', 'second hop'] },
      { bridgeRescue: true },
    ]);
    expect(groups.find((group) => group.label === 'first hop')?.sourceIndexes).toEqual([1]);
    expect(groups.find((group) => group.label === 'second hop')?.sourceIndexes).toEqual([1]);
    expect(groups.find((group) => group.kind === 'bridge')?.sourceIndexes).toEqual([2]);
  });

  it('formats source routing without adding factual claims', () => {
    const map = formatEvidenceReasoningMap([
      { kind: 'direct', label: 'direct', sourceIndexes: [1] },
      { kind: 'subquery', label: 'Who directed the film?', sourceIndexes: [2, 4] },
      { kind: 'bridge', label: 'bridge', sourceIndexes: [3] },
    ], true);
    expect(map).toContain('Sub-question "Who directed the film?": [2][4]');
    expect(map).toContain('routing metadata, not factual evidence');
  });

  it('keeps one representative from every hop under a tight four-hop budget', () => {
    const citations = ['one', 'two', 'three', 'four', 'one'].map((origin, index) => ({
      id: `c${index + 1}`,
      subQueryOrigin: origin,
      context: `${origin}:${'证据'.repeat(1000)}`,
    }));
    const plan = planStructuredEvidence(citations, {
      complexity: 'multi_hop',
      subQueries: ['one', 'two', 'three', 'four'],
    });
    const groups = buildEvidenceReasoningGroups(plan.citations);
    const fitted = fitStructuredEvidenceToBudget(plan.citations, groups, {
      hardCap: 800,
      structured: true,
      textOf: (citation) => String(citation.context || ''),
      normalizeText: (text) => text,
      truncate: (text, tokenBudget) => text.slice(0, tokenBudget),
    });
    const retainedOrigins = new Set(fitted.citations.map((citation) => citation.subQueryOrigin));
    expect(retainedOrigins).toEqual(new Set(['one', 'two', 'three', 'four']));
    expect(fitted.usedTokens).toBeLessThanOrEqual(800);
    expect(fitted.truncated).toBeGreaterThanOrEqual(4);
    const map = formatEvidenceReasoningMap(buildEvidenceReasoningGroups(fitted.citations), false);
    expect(map).toContain('子问题“four”');
  });
});
