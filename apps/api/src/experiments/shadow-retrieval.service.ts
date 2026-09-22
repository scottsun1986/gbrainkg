/**
 * 影子检索对比服务：在 chat 检索热路径旁路跑 treatment 变体，
 * 只写 A/B 事件，不影响主回答。由 ChatService 在 RRF 前后调用。
 */
import { Logger } from '@nestjs/common';
import { AbExperimentService } from '../experiments/ab-experiment.service';
import {
  CONTROL_VARIANT,
  TREATMENT_VARIANT,
  applyVariantParams,
  diffCitationSets,
  RetrievalVariantParams,
  CitationHit,
} from '../experiments/retrieval-variants';

export class ShadowRetrievalService {
  private readonly logger = new Logger(ShadowRetrievalService.name);

  constructor(private readonly ab: AbExperimentService) {}

  /** Sticky experiment assignment; null when experiment disabled/unknown. */
  assign(experimentKey: string, userId: string, sessionId?: string) {
    return this.ab.assign(experimentKey, userId, sessionId);
  }

  /**
   * 若用户被分到 shadow 臂，则用 treatment 参数再跑一次 retrievalFn，
   * 对比命中集合并写事件。主路径仍返回 control 结果。
   */
  async compare<T extends { citations?: CitationHit[] }>(
    experimentKey: string,
    userId: string,
    sessionId: string | undefined,
    question: string,
    controlParams: RetrievalVariantParams,
    retrievalFn: (
      params: RetrievalVariantParams,
      question: string,
    ) => Promise<T>,
  ): Promise<{ result: T; shadowDiff?: Record<string, unknown> }> {
    const assignment = this.ab.assign(experimentKey, userId, sessionId);
    if (!assignment) {
      return { result: await retrievalFn(controlParams, question) };
    }
    return this.ab.runWithShadow(
      assignment,
      () => retrievalFn(controlParams, question),
      () => retrievalFn(TREATMENT_VARIANT, question),
      (a, b) => {
        const diff = diffCitationSets(a.citations || [], b.citations || []);
        this.logger.debug(
          `shadow diff exp=${experimentKey} jaccard=${String(diff.jaccard)} onlyT=${String((diff.onlyTreatment as string[] | undefined)?.length ?? 0)}`,
        );
        return { ...diff, variant: applyVariantParams(TREATMENT_VARIANT) };
      },
    );
  }

  /** 记录命中率类指标（hit@1 / mrr）供 summarize 聚合。 */
  recordHit(
    experimentKey: string,
    userId: string,
    arm: 'control' | 'treatment' | 'shadow',
    hitAt1: number,
    mrr: number,
    sessionId?: string,
  ) {
    this.ab.record({
      experimentKey,
      userId,
      sessionId,
      arm,
      eventName: 'hit_at_1',
      value: hitAt1,
      ts: new Date().toISOString(),
    });
    this.ab.record({
      experimentKey,
      userId,
      sessionId,
      arm,
      eventName: 'mrr',
      value: mrr,
      ts: new Date().toISOString(),
    });
  }
}

export { CONTROL_VARIANT, TREATMENT_VARIANT };
