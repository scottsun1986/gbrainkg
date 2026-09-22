import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { AbExperimentService } from './ab-experiment.service';

/**
 * A/B 指标回流只读端点。发布门禁与运营看板消费 summarize 结果。
 * 事件写入由 runWithShadow / record 在主路径完成。
 */
@UseGuards(AuthGuard)
@Controller('api/v1/experiments')
export class AbMetricsController {
  constructor(private readonly ab: AbExperimentService) {}

  @Get('summary')
  summary(@Query('key') key?: string) {
    return this.ab.summarize(key);
  }

  @Get('events')
  events(@Query('limit') limit = '100') {
    // drain-free peek: summarize already exposes aggregates; raw events are
    // in-memory for now and intentionally not persisted to avoid leaking PII.
    const n = Math.min(Number(limit) || 100, 1000);
    return { limit: n, note: 'raw events are in-memory; use /summary for aggregates' };
  }
}
