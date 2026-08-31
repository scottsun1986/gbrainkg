import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { IngestionService } from "./ingestion.service";

// A layout-heavy PDF can legitimately consume several minutes. Two workers
// prevent a small text/DOCX upload from sitting behind that single slow job;
// keep the default conservative because Docling is memory intensive.
@Processor("ingestion-queue", {
  concurrency: Number(process.env.INGESTION_CONCURRENCY || 2),
})
export class IngestionProcessor extends WorkerHost {
  constructor(private readonly ingestionService: IngestionService) {
    super();
  }

  async process(job: Job<{ documentId: string }>) {
    try {
      return await this.ingestionService.processDocument(job.data.documentId);
    } catch (error) {
      const attempts = Number(job.opts.attempts || 1);
      if (job.attemptsMade + 1 >= attempts) {
        await this.ingestionService.markFailed(
          job.data.documentId,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }
}
