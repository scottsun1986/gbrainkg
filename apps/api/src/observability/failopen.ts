/**
 * 检索/摄取降级计数。fail-open 路径必须打点，否则生产盲飞。
 * 延迟加载 metricsService，避免 observability 模块与业务循环依赖。
 */
import { metricsService } from './metrics.service';

export type FailChannel =
  | 'vector'
  | 'lexical'
  | 'sparse'
  | 'late_interaction'
  | 'graph'
  | 'rerank'
  | 'hybrid'
  | 'weknora'
  | 'shadow'
  | 'section_rescue'
  | 'embedding'
  | 'ingestion'
  | 'other';

export function recordFailopen(channel: FailChannel | string): void {
  try {
    metricsService.incRetrievalFailopen(channel || 'other');
  } catch {
    /* metrics must never break the request path */
  }
}

export function setIngestionQueueDepth(depth: number): void {
  try {
    metricsService.setIngestionQueueDepth(depth);
  } catch {
    /* ignore */
  }
}

export function incLlmError(provider: string): void {
  try {
    (metricsService as any).incLlmError?.(provider);
  } catch {
    /* ignore */
  }
}
