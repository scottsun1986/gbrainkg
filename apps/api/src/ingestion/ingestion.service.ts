import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { BrainCompilerService } from "../brain-compiler/brain-compiler.service";
import { ModelConfigService } from "../model-config.service";
import { splitMarkdownIntoChunks } from "./markdown-chunker";

@Injectable()
export class IngestionService implements OnModuleInit {
  private readonly logger = new Logger(IngestionService.name);
  private readonly prisma = new PrismaClient();
  private readonly uploadRoot =
    process.env.UPLOAD_ROOT || "/tmp/llmwiki/uploads";
  private readonly parserUrl = (
    process.env.PARSER_WORKER_URL || "http://127.0.0.1:8100"
  ).replace(/\/$/, "");

  constructor(
    @InjectQueue("ingestion-queue") private readonly ingestionQueue: Queue,
    private readonly compilerService: BrainCompilerService,
    private readonly modelConfigService: ModelConfigService,
  ) {}

  async onModuleInit() {
    const recoveryAfterMs = Math.max(
      60_000,
      Number(process.env.INGESTION_RECOVERY_AFTER_MS || 5 * 60 * 1000),
    );
    const staleBefore = new Date(Date.now() - recoveryAfterMs);
    const stale = await this.prisma.document.findMany({
      where: {
        status: { in: ["parsing", "indexing"] },
        updatedAt: { lt: staleBefore },
        rawFileOid: { not: null },
      },
      select: {
        id: true,
        kbId: true,
        title: true,
        status: true,
        _count: { select: { chunks: true } },
      },
    });
    for (const document of stale) {
      // Parsing already produced durable chunks before the compiler was
      // interrupted. Resume at the compile boundary instead of spending
      // minutes parsing a large PDF for a second time.
      if (document.status === "indexing" && document._count.chunks > 0) {
        const topic =
          document.title
            .replace(/\.[^.]+$/, "")
            .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
            .trim() || document.id;
        await this.compilerService.onKnowledgePublished(
          document.kbId,
          document.id,
          [topic],
        );
      } else {
        await this.enqueue(document.id, "restart-recovery");
      }
    }
    if (stale.length)
      this.logger.warn(`Recovered ${stale.length} stale ingestion job(s).`);
  }

  async enqueue(documentId: string, reason = "upload") {
    try {
      await this.ingestionQueue.add(
        "parse-document",
        { documentId, reason },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 3_000 },
          removeOnComplete: 200,
          removeOnFail: 500,
        },
      );
    } catch (error) {
      await this.markFailed(
        documentId,
        `Unable to persist ingestion job: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async processDocument(documentId: string) {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        kbId: true,
        title: true,
        rawFileOid: true,
        status: true,
      },
    });
    if (!document) throw new Error(`Document ${documentId} no longer exists.`);
    if (document.status === "published")
      return { documentId, status: "published", skipped: true };
    if (!document.rawFileOid)
      throw new Error("Original upload is no longer available.");
    const content = await readFile(document.rawFileOid);
    await this.prisma.document.update({
      where: { id: documentId },
      data: { status: "parsing" },
    });

    const form = new FormData();
    const fileBytes = content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
    const ext = extname(document.title);
    form.append(
      "file",
      new Blob([fileBytes]),
      ext ? document.title : `${document.title}.md`,
    );
    const ocrConfig = await this.modelConfigService.getOcrConfig();
    if (ocrConfig) {
      form.append("ocr_provider", ocrConfig.provider);
      form.append("ocr_endpoint", ocrConfig.baseUrl);
      form.append("ocr_api_key", ocrConfig.apiKey);
      form.append("ocr_secret_key", ocrConfig.secretKey);
    }
    const headers: Record<string, string> = {};
    const authToken = process.env.PARSER_AUTH_TOKEN || process.env.AUTH_TOKEN;
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const queued = await fetch(`${this.parserUrl}/parse?parser_type=auto`, {
      method: "POST",
      body: form,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!queued.ok) throw new Error(`Parser rejected upload: ${queued.status}`);
    const { task_id: taskId } = (await queued.json()) as { task_id: string };

    const timeoutMs = Math.max(
      30_000,
      Number(process.env.PARSER_POLL_TIMEOUT_MS || 5 * 60 * 1000),
    );
    const deadline = Date.now() + timeoutMs;
    let parsed: any;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const response = await fetch(`${this.parserUrl}/parse/${taskId}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404)
        throw new Error(
          "Parser task was lost; retrying from the preserved original file.",
        );
      if (!response.ok)
        throw new Error(`Parser status failed: ${response.status}`);
      parsed = await response.json();
      if (parsed.status === "completed" || parsed.status === "failed") break;
    }
    if (!parsed || parsed.status !== "completed")
      throw new Error(parsed?.error || "Parser timed out.");

    const markdown = String(parsed.markdown || "")
      .replace(/\0/g, "")
      .replace(/\u0000/g, "")
      .trim();
    if (!markdown) throw new Error("Parser returned empty Markdown.");
    const chunks = splitMarkdownIntoChunks(markdown);
    if (!chunks.length)
      throw new Error("Parser returned no indexable content.");
    const qualityStatus = ["passed", "needs_review", "rejected"].includes(
      String(parsed.quality_status),
    )
      ? String(parsed.quality_status)
      : "passed";
    const qualityScore =
      typeof parsed.quality_score === "number" ? parsed.quality_score : null;
    const qualityIssues = Array.isArray(parsed.quality_issues)
      ? parsed.quality_issues.map((issue: unknown) => String(issue)).slice(0, 20)
      : [];
    // Persist parser facts, but never persist request credentials or the full
    // parser response. This lets operators explain a failed/uncertain import
    // and lets the UI distinguish "parsed" from "safe to publish".
    const parserMetadata: Record<string, unknown> = {};
    for (const key of [
      "page_count",
      "text_pages",
      "native_chars",
      "native_page_ratio",
      "native_quality",
      "ocr_provider",
      "ocr_endpoint",
      "ocr_task_id",
      "ocr_words_result_num",
      "ocr_average_confidence",
      "ocr_cost_pages",
      "slide_count",
      "embedded_image_count",
      "quality_metrics",
      "docling_error",
      "ocr_error",
    ]) {
      if (parsed[key] !== undefined && parsed[key] !== null) {
        parserMetadata[key] = parsed[key];
      }
    }
    await writeFile(
      join(this.uploadRoot, documentId, "content.md"),
      markdown,
      "utf8",
    );
    await this.prisma.$transaction([
      this.prisma.chunk.deleteMany({ where: { documentId } }),
      this.prisma.chunk.createMany({
        data: chunks.map((chunk) => ({
          documentId,
          kbId: document.kbId,
          ord: chunk.ord,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
          metadata: chunk.metadata as any,
        })),
      }),
      this.prisma.document.update({
        where: { id: documentId },
        data: {
          status: qualityStatus === "passed" ? "indexing" : "needs_review",
          parserEngine: parsed.engine || null,
          parserClassification: parsed.classification || null,
          parserMetadata: parserMetadata as any,
          qualityStatus,
          qualityScore,
          qualityIssues: qualityIssues as any,
        },
      }),
    ]);

    if (qualityStatus !== "passed") {
      this.logger.warn(
        `Document ${documentId} parsed but was held for review: ${qualityIssues.join("; ") || qualityStatus}`,
      );
      return {
        documentId,
        status: "needs_review",
        chunks: chunks.length,
        parser: parsed.engine || "unknown",
        qualityStatus,
        qualityScore,
        qualityIssues,
      };
    }

    const topic =
      document.title
        .replace(/\.[^.]+$/, "")
        .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
        .trim() || documentId;
    const queuedJobs = await this.compilerService.onKnowledgePublished(
      document.kbId,
      documentId,
      [topic],
    );
    if (!queuedJobs)
      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: "published" },
      });
    return {
      documentId,
      status: queuedJobs ? "indexing" : "published",
      chunks: chunks.length,
      parser: parsed.engine || "unknown",
      qualityStatus,
      qualityScore,
      qualityIssues,
    };
  }

  async markFailed(documentId: string, reason: string) {
    await this.prisma.document
      .update({
        where: { id: documentId },
        data: {
          status: "failed",
          qualityStatus: "rejected",
          qualityIssues: [reason] as any,
          parserMetadata: { error: reason } as any,
        },
      })
      .catch(() => undefined);
    this.logger.error(`Document ${documentId} ingestion failed: ${reason}`);
  }
}
