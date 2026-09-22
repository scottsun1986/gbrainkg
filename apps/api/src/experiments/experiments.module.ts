import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AbExperimentService } from './ab-experiment.service';
import { ShadowRetrievalService } from './shadow-retrieval.service';
import { AbMetricsController } from './ab-metrics.controller';

@Global()
@Module({
  imports: [AuthModule],
  providers: [AbExperimentService, ShadowRetrievalService],
  controllers: [AbMetricsController],
  exports: [AbExperimentService, ShadowRetrievalService],
})
export class ExperimentsModule {}
