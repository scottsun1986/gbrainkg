import { runAsService } from '../db/service-principal';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EnrichmentJobData, EnrichmentProcessor } from './enrichment.processor';

// LLM summaries and graph extraction cannot occupy retrieval-critical slots.
@Processor('aux-enrichment-queue', { concurrency: Number(process.env.AUX_ENRICHMENT_CONCURRENCY || 4) })
export class AuxiliaryEnrichmentProcessor extends WorkerHost {
  constructor(private readonly enrichment: EnrichmentProcessor) { super(); }

  async process(job: Job<EnrichmentJobData>): Promise<void> {
    await runAsService('auxiliary-enrichment', () => this.enrichment.processAuxiliary(job), job.data.kbId);
  }
}
