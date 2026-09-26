import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { GraphRagService } from './graph-rag.service';

export interface GraphCommunityJobData {
  kbId: string;
}

/**
 * Consumer for the coalesced per-KB community rebuild queue.
 *
 * Producers call `GraphRagService.scheduleCommunityRebuild`; BullMQ jobId
 * deduplication plus a debounce delay collapse a bulk import's worth of
 * per-document triggers into a single rebuild. The job is idempotent: running
 * it twice only re-derives the same communities.
 */
@Processor('graph-community-queue', {
  concurrency: Number(process.env.GRAPHRAG_COMMUNITY_CONCURRENCY || 1),
})
export class GraphCommunityProcessor extends WorkerHost {
  private readonly logger = new Logger(GraphCommunityProcessor.name);

  constructor(private readonly graphRagService: GraphRagService) {
    super();
  }

  async process(job: Job<GraphCommunityJobData>): Promise<{ built: number }> {
    const { kbId } = job.data;
    if (!kbId) return { built: 0 };
    const built = await this.graphRagService.buildCommunitiesForKb(kbId, {
      incremental: true,
    });
    if (built > 0) {
      this.logger.log(`Community rebuild for KB ${kbId} produced ${built} communities.`);
    }
    return { built };
  }
}
