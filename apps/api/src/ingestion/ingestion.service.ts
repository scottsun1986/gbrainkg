import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { getPrismaClient } from "../prisma";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { BrainCompilerService } from "../brain-compiler/brain-compiler.service";
import { ModelConfigService } from "../model-config.service";
import { splitMarkdownIntoChunks } from "./markdown-chunker";
import { assessContentQuality } from "./content-quality";
import { parserPollBudget } from "./parser-budget";
import { ANYDOC_UPLOAD_EXTENSIONS } from './parser-capabilities';
import { enrichChunksWithContext } from './contextual-retrieval';

@Injectable()
export class IngestionService implements OnModuleInit {
  private readonly logger = new Logger(IngestionService.name);
  private readonly prisma = getPrismaClient();
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
        version: true,
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
        await this.enqueue(document.id, "restart-recovery", document.version);
      }
    }
    if (stale.length)
      this.logger.warn(`Recovered ${stale.length} stale ingestion job(s).`);
  }

  async enqueue(documentId: string, reason = "upload", expectedVersion?: number) {
    try {
      const version = expectedVersion ?? (await this.prisma.document.findUnique({
        where: { id: documentId },
        select: { version: true },
      }))?.version;
      if (!version) throw new Error(`Document ${documentId} no longer exists.`);
      await this.ingestionQueue.add(
        "parse-document",
        { documentId, reason, expectedVersion: version },
        {
          jobId: `ingest-${documentId}-v${version}`,
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

  async processDocument(documentId: string, expectedVersion?: number) {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        kbId: true,
        title: true,
        rawFileOid: true,
        status: true,
        version: true,
      },
    });
    if (!document) throw new Error(`Document ${documentId} no longer exists.`);
    if (expectedVersion !== undefined && document.version !== expectedVersion) {
      return { documentId, status: document.status, skipped: true, reason: "superseded-version" };
    }
    if (document.status === "published")
      return { documentId, status: "published", skipped: true };
    if (!document.rawFileOid)
      throw new Error("Original upload is no longer available.");
    const content = await readFile(document.rawFileOid);
    await this.prisma.document.update({
      where: { id: documentId },
      data: { status: "parsing" },
    });

    let parsed: any = null;
    const conversionMetadata: Record<string, unknown> = {};
    const ext = extname(document.title).toLowerCase();

    // L1 Fast-Path: Plaintext files (.txt, .md) read directly in zero milliseconds
    if ([".txt", ".md"].includes(ext)) {
      const rawText = content.toString("utf8");
      if (rawText.trim()) {
        parsed = {
          markdown: rawText,
          engine: "plaintext-fastpath",
          classification: ext.slice(1),
          status: "completed",
        };
      }
    } else if (ANYDOC_UPLOAD_EXTENSIONS.has(ext)) {
      try {
        // @ts-ignore
        const anydoc: any = await import("@firecrawl/anydoc" as any).catch(() => null);
        if (typeof anydoc?.toMarkdown === "function") {
          const md = await anydoc.toMarkdown(document.rawFileOid);
          if (md && md.trim().length > 0) {
              parsed = {
                markdown: md,
                engine: "anydoc",
                classification: ext.slice(1),
                status: "completed",
              };
              this.logger.log(
                `AnyDoc converted document ${documentId}; publication quality is assessed separately.`,
              );
          }
        }
      } catch (err: any) {
        const code = typeof err?.code === 'string' ? err.code : 'unknown';
        // Never route a security-limit rejection to a less constrained parser.
        if (code === 'encrypted' || code === 'resourceLimit') {
          throw new Error(`ANYDOC_${code === 'encrypted' ? 'ENCRYPTED' : 'RESOURCE_LIMIT'}`);
        }
        conversionMetadata.anydoc_error_code = ['unsupported', 'needsOcr', 'malformed', 'missingPart', 'io', 'hosted'].includes(code) ? code : 'unknown';
        if (code === 'needsOcr' && Number.isInteger(err.pageCount) && err.pageCount > 0) {
          conversionMetadata.anydoc_page_count = err.pageCount;
          conversionMetadata.anydoc_ocr_pages = Array.isArray(err.pages)
            ? [...new Set(err.pages.filter((page: unknown) => Number.isInteger(page) && Number(page) > 0 && Number(page) <= err.pageCount))].slice(0, 10000)
            : [];
        }
        this.logger.warn(
          `AnyDoc conversion ${conversionMetadata.anydoc_error_code} for document ${documentId}; using configured parser fallback.`,
        );
      }
    }

    if (!parsed) {
      const form = new FormData();
      const fileBytes = content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer;
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
      const response = await fetch(`${this.parserUrl}/parse-execute?parser_type=auto`, {
        method: "POST",
        body: form,
        headers,
        signal: AbortSignal.timeout(parserPollBudget(process.env) + 30_000),
      });
      if (!response.ok) throw new Error(`Parser execution failed: ${response.status}`);
      parsed = await response.json();
      if (!parsed || parsed.status !== "completed")
        throw new Error(parsed?.error || "Parser timed out.");
    }

    // Inspect original output before control-character normalization can hide damage.
    const quality = assessContentQuality(String(parsed.markdown || ""), ext, parsed);
    parsed = { ...parsed, ...quality };
    const markdown = String(parsed.markdown || "")
      .replace(/\0/g, "")
      .replace(/\u0000/g, "")
      .trim();
    if (!markdown) throw new Error("Parser returned empty Markdown.");
    const chunks = splitMarkdownIntoChunks(markdown);
    if (!chunks.length)
      throw new Error("Parser returned no indexable content.");

    // --- Contextual Retrieval: enrich chunks with document-level context ---
    let enrichedChunks = chunks;
    const contextualEnabled = process.env.CONTEXTUAL_RETRIEVAL_ENABLED !== 'false';
    if (contextualEnabled && chunks.length > 1 && markdown.length >= 500) {
      try {
        const llmConfig = await this.modelConfigService.getDefault('llm');
        if (llmConfig) {
          enrichedChunks = await enrichChunksWithContext(
            markdown,
            chunks,
            {
              baseUrl: (llmConfig.provider.baseUrl || process.env.LLM_BASE_URL || '').replace(/\/$/, ''),
              apiKey: llmConfig.provider.apiKey || process.env.DEEPSEEK_API_KEY || '',
              modelName: llmConfig.modelName || process.env.LLM_MODEL || 'deepseek-chat',
            },
            {
              concurrency: Number(process.env.CONTEXTUAL_RETRIEVAL_CONCURRENCY || 5),
              documentTitle: document.title,
            },
          );
          this.logger.log(
            `Contextual Retrieval enriched ${enrichedChunks.filter(c => c.metadata.contextual_prefix).length}/${chunks.length} chunks for document ${documentId}`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `Contextual Retrieval failed for document ${documentId}, using original chunks: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const qualityStatus = quality.quality_status;
    const qualityScore = quality.quality_score;
    const qualityIssues = quality.quality_issues;
    // Persist parser facts, but never persist request credentials or the full
    // parser response. This lets operators explain a failed/uncertain import
    // and lets the UI distinguish "parsed" from "safe to publish".
    const parserMetadata: Record<string, unknown> = { ...conversionMetadata };
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
      "ocr_original_pages",
      "ocr_routed_pages",
      "ocr_page_count",
      "ocr_model",
      "slide_count",
      "embedded_image_count",
      "quality_metrics",
      "quality_rule_version",
      "docling_error",
      "ocr_error",
    ]) {
      if (parsed[key] !== undefined && parsed[key] !== null) {
        parserMetadata[key] = parsed[key];
      }
    }
    parserMetadata["parsed_at"] = new Date().toISOString();
    await writeFile(
      join(this.uploadRoot, documentId, "content.md"),
      markdown,
      "utf8",
    );
    await this.prisma.$transaction([
      this.prisma.chunk.deleteMany({ where: { documentId } }),
      this.prisma.chunk.createMany({
        data: enrichedChunks.map((chunk) => ({
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
