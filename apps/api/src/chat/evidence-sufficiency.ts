import { calibratedScoreOf } from './retrieval-arms';

export function evidenceConfidenceScores(citations: any[]): {
  maxCalibrated: number | null;
  maxSynthetic: number | null;
} {
  let maxCalibrated: number | null = null;
  let maxSynthetic: number | null = null;
  for (const citation of citations || []) {
    const calibrated = calibratedScoreOf(citation);
    if (calibrated !== null) {
      maxCalibrated = maxCalibrated === null ? calibrated : Math.max(maxCalibrated, calibrated);
      continue;
    }
    if (String(citation?.scoreSource || '') !== 'synthetic') continue;
    const synthetic = Number(citation?.relevanceScore ?? citation?.rerankScore ?? citation?.score);
    if (!Number.isFinite(synthetic)) continue;
    maxSynthetic = maxSynthetic === null ? synthetic : Math.max(maxSynthetic, synthetic);
  }
  return { maxCalibrated, maxSynthetic };
}

export interface EvidenceSufficiency {
  hasSufficientEvidence: boolean;
  maxCalibrated: number | null;  maxSynthetic: number | null;
  maxEvidenceScore: number;
  evidenceFloor: number;
  scoreCalibrated: boolean;
  thresholdSource: 'held_out' | 'configured';
  calibratedOperatingPoints: number[];
}

/**
 * Decide whether the selected evidence clears the fast-refusal floor.
 *
 * The decision is driven only by a *measured* score. A long pre-answer is not
 * evidence of relevance (the fallback arm concatenates every retrieved chunk
 * into `answer`, so text length alone would clear the gate by construction).
 * When a calibrated scorer ran, its maximum must reach the calibrated floor;
 * when none ran, the synthetic placement constant is compared against the
 * documented degraded floor so the gate still says something honest.
 */
export function decideEvidenceSufficiency(
  citations: any[],
  options: { calibratedFloor: number; syntheticFloor: number; verifyUncalibrated?: boolean },
): EvidenceSufficiency {
  const { maxCalibrated, maxSynthetic } = evidenceConfidenceScores(citations || []);
  const learnedThresholdDecisions = citations.filter(citation =>
    citation?.scoreSource !== 'synthetic' && citation?.rerankSkipped !== true &&
    typeof citation?.calibratedProbability === 'number' && Number.isFinite(citation.calibratedProbability) &&
    citation.calibratedProbability >= 0 && citation.calibratedProbability <= 1 &&
    typeof citation?.calibratedRefusalThreshold === 'number' && citation.calibratedRefusalThreshold > 0 && citation.calibratedRefusalThreshold < 1);
  const scoreCalibrated = maxCalibrated !== null || learnedThresholdDecisions.length > 0;
  const maxEvidenceScore = maxCalibrated ?? (learnedThresholdDecisions.length ? Math.max(...learnedThresholdDecisions.map(citation => citation.calibratedProbability)) : null) ?? maxSynthetic ?? 0;
  const evidenceFloor = scoreCalibrated ? options.calibratedFloor : options.syntheticFloor;

  const passesConfidence = learnedThresholdDecisions.length
    ? citations.some(citation => {
      const learned = learnedThresholdDecisions.includes(citation);
      // A learned probability operating point cannot be compared with the
      // raw provider score even when a legacy retrieval mode preserves it.
      const score = learned ? citation.calibratedProbability : calibratedScoreOf(citation);
      if (score === null) return false;
      const threshold = learned ? citation.calibratedRefusalThreshold : options.calibratedFloor;
      return score >= threshold;
    }) : maxEvidenceScore >= evidenceFloor;
  const hasSufficientEvidence =
    (citations?.length || 0) > 0 && (passesConfidence ||
      (options.verifyUncalibrated === true && !scoreCalibrated && citations.some(citation =>
        citation.docId && String(citation.context || citation.evidence || '').trim())));
  return {
    hasSufficientEvidence,
    maxCalibrated,
    maxSynthetic,
    maxEvidenceScore,
    evidenceFloor,
    scoreCalibrated,
    thresholdSource: learnedThresholdDecisions.length ? 'held_out' : 'configured',
    calibratedOperatingPoints: [...new Set<number>(learnedThresholdDecisions.map(citation => citation.calibratedRefusalThreshold))],
  };
}
