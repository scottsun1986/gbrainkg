import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Optional } from "@nestjs/common";
import { Job, Queue } from "bullmq";
import { setIngestionQueueDepth } from "../observability/failopen";
import { IngestionService } from "./ingestion.service";

// A layout-heavy PDF can legitimately consume several minutes. Two workers
// prevent a small text/DOCX upload from sitting behind that single slow job;
// keep the default conservative because Docling is memory intensive.
@Processor("ingestion-queue", {
  concurrency: Number(process.env.INGESTION_CONCURRENCY || 2),
})
export class IngestionProcessor extends WorkerHost {
  constructor(
    private readonly ingestionService: IngestionService,
    @Optional() @InjectQueue("ingestion-queue") private readonly queue?: Queue,
  ) {
    super();
  }

  /** Report waiting+active as ingestion_queue_depth (metrics must never break the job). */
  private async reportQueueDepth(): Promise<void> {
    try {
      if (!this.queue || typeof this.queue.getJobCounts !== "function") return;
      const counts = await this.queue.getJobCounts("waiting", "active", "delayed");
      setIngestionQueueDepth(
        Number(counts.waiting || 0) + Number(counts.active || 0) + Number(counts.delayed || 0),
      );
    } catch {
      /* ignore */
    }
  }

  async process(job: Job<{ documentId: string; expectedVersion: number }>) {
    await this.reportQueueDepth();
    try {
      return await this.ingestionService.processDocument(
        job.data.documentId,
        job.data.expectedVersion,
      );
    } catch (error) {
      const attempts = Number(job.opts.attempts || 1);
      if (job.attemptsMade + 1 >= attempts) {
        await this.ingestionService.markFailed(
          job.data.documentId,
          error instanceof Error ? error.message : String(error),
          job.data.expectedVersion,
        );
      }
      throw error;
    } finally {
      await this.reportQueueDepth();
    }
  }
}
