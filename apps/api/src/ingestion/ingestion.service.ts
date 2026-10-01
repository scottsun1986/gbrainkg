import { runAsService } from '../db/service-principal';
import { Injectable, Logger, OnModuleInit, Optional, Inject } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { getPrismaClient } from "../prisma";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import { BrainCompilerService } from "../brain-compiler/brain-compiler.service";
import { ModelConfigService } from "../model-config.service";
import { splitMarkdownIntoChunks } from "./markdown-chunker";
import { assessContentQuality, assessExtendedQuality } from "./content-quality";
import { isNearDuplicate, simhash64 } from "./content-dedupe";
import { parserPollBudget } from "./parser-budget";
import { ANYDOC_UPLOAD_EXTENSIONS, SUPPORTED_UPLOAD_EXTENSIONS } from './parser-capabilities';
import { enrichChunksWithContext } from './contextual-retrieval';
import { PrismaContextualPrefixCache } from './contextual-prefix-cache';
import { GraphRagService } from "../graph-rag/graph-rag.service";
import { RaptorService } from "../raptor/raptor.service";
import { ChunkEmbeddingService } from "../embedding/chunk-embedding.service";
import { LexicalIndexService } from "../retrieval/lexical-index.service";
import { buildCanonicalBlock } from './canonical-block';
import { withServiceContext } from '../db/tenant-context.service';
import { DocumentVersionStore, immutableVersionsEnabled } from './document-version-store';
import { instanceIdentity } from '../observability/instance-identity';

// Thrown inside the save transaction when the document was re-ingested while
// this run was parsing, so the caller can return instead of marking failed.
class SupersededVersionError extends Error {
  constructor(documentId: string, expected: number, actual: number) {
    super(`Document ${documentId} version changed during ingestion: expected ${expected}, found ${actual}.`);
    this.name = 'SupersededVersionError';
  }
}

@Injectable()
export class IngestionService implements OnModuleInit {
  private readonly logger = new Logger(IngestionService.name);
  private readonly prisma = getPrismaClient();
  private readonly uploadRoot =
    process.env.UPLOAD_ROOT || "/tmp/llmwiki/uploads";
  private readonly parserUrl = (
    process.env.PARSER_WORKER_URL || "http://127.0.0.1:8100"
  ).replace(/\/$/, "");
  // Durable Contextual Retrieval prefix memo, shared by every worker and
  // instance: re-ingestion of unchanged chunks must not re-pay the LLM.
  // Lazily constructed: instantiating it at module load would open a database
  // client before Nest (or a test harness) has configured anything.
  private static contextualPrefixCacheInstance?: PrismaContextualPrefixCache;
  private static get contextualPrefixCache(): PrismaContextualPrefixCache {
    return (IngestionService.contextualPrefixCacheInstance ??= new PrismaContextualPrefixCache());
  }
  private static readonly parseCache = new Map<string, { parsed: any; conversionMetadata: Record<string, unknown> }>();

  constructor(
    @InjectQueue("ingestion-queue") private readonly ingestionQueue: Queue,
    private readonly compilerService: BrainCompilerService,
    private readonly modelConfigService: ModelConfigService,
    @Optional() private readonly graphRagService?: GraphRagService,
    @Optional() private readonly raptorService?: RaptorService,
    @Optional() private readonly chunkEmbeddingService?: ChunkEmbeddingService,
    @Optional() @InjectQueue("enrichment-queue") private readonly enrichmentQueue?: Queue,
    @Optional() private readonly lexicalIndexService?: LexicalIndexService,
  ) {}

  async onModuleInit() {
    await this.recoverStaleIngestions();
    // A stuck document must not wait for the next API restart to be noticed:
    // the startup-only recovery left docs hanging in `indexing` indefinitely
    // when the worker died while the API stayed up (observed: one eval-ingested
    // document sat in `indexing` for 10+ minutes with no retry path, because
    // the retry endpoint refuses non-failed states). The same recovery now
    // runs periodically; the 5-minute staleness floor makes it idempotent and
    // keeps it away from in-flight jobs.
    const intervalMs = Math.max(
      300_000,
      Number(process.env.INGESTION_RECOVERY_INTERVAL_MS || 10 * 60 * 1000),
    );
    if (process.env.INGESTION_RECOVERY_WATCHDOG !== "false") {
      this.recoveryTimer = setInterval(() => {
        this.recoverStaleIngestions().catch((err) => {
          this.logger.warn(`Stale-ingestion watchdog failed: ${err.message}`);
        });
      }, intervalMs);
      this.recoveryTimer.unref?.();
    }
  }

  private recoveryTimer?: ReturnType<typeof setInterval>;

  private async recoverStaleIngestions(): Promise<void> { return runAsService('ingestion-recovery', () => this.recoverStaleInternal()); }

  private async recoverStaleInternal(): Promise<void> {
    const recoveryAfterMs = Math.max(
      60_000,
      Number(process.env.INGESTION_RECOVERY_AFTER_MS || 5 * 60 * 1000),
    );
    const staleBefore = new Date(Date.now() - recoveryAfterMs);
    if (process.env.CORE_VERSIONING_ENABLED === '1') {
      await this.prisma.$executeRaw`DELETE FROM "ModelArtifactCache" WHERE key IN (SELECT key FROM "ModelArtifactCache" WHERE "expiresAt"<now() LIMIT 1000)`;
      await this.prisma.$executeRaw`DELETE FROM "ModelQuotaBucket" WHERE period<floor(extract(epoch FROM now())/60)-120`;
    }
    if (immutableVersionsEnabled()) {
      const unparsed = await this.prisma.document.findMany({ where: {
        status: 'published', activeVersionId: { not: null }, buildingVersionId: null,
        pendingRawFileOid: { not: null }, updatedAt: { lt: staleBefore }, kb: { status: 'active' },
      }, select: { id: true, ingestVersion: true }, take: 100 });
      for (const doc of unparsed) await this.enqueue(doc.id, 'upload', doc.ingestVersion ?? undefined);
      const pending = await this.prisma.documentVersion.findMany({
        where: { state: 'indexing', createdAt: { lt: staleBefore }, document: { kb: { status: 'active' } } },
        include: { document: { select: { buildingVersionId: true, ingestVersion: true, kbId: true } } }, take: 100,
      });
      for (const version of pending) {
        if (version.document.buildingVersionId !== version.id || version.document.ingestVersion !== version.number) {
          await this.prisma.documentVersion.update({ where: { id: version.id }, data: { state: 'superseded' } }); continue;
        }
        const intent = await this.prisma.brainChangeEvent.findFirst({ where: {
          resourceId: version.documentId, eventType: 'enrichment_request', payload: { path: ['versionId'], equals: version.id },
        } });
        if (!intent) await this.prisma.brainChangeEvent.create({ data: {
          eventType: 'enrichment_request', resourceType: 'document', resourceId: version.documentId, status: 'pending',
          payload: { kbId: version.document.kbId, version: version.number, versionId: version.id },
        } });
      }
    }
    const stale = await this.prisma.document.findMany({
      where: {
        status: { in: ["parsing", "indexing"] },
        updatedAt: { lt: staleBefore },
        rawFileOid: { not: null },
        kb: { status: 'active' },
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
        // The transactional outbox already owns enrichment delivery. Re-enqueue
        // only legacy documents which have no durable request for this version.
        const pendingRequest = await this.prisma.brainChangeEvent.findFirst({
          where: {
            eventType: 'enrichment_request', resourceId: document.id,
            payload: { path: ['version'], equals: document.version },
            status: { in: ['pending', 'processing', 'failed'] },
          },
          select: { id: true },
        });
        if (this.enrichmentQueue && !pendingRequest) {
          await this.enrichmentQueue.add(
            `enrich-${document.id}-v${document.version}`,
            {
              documentId: document.id,
              kbId: document.kbId,
              expectedVersion: document.version,
            },
            {
              jobId: `enrich-${document.id}-v${document.version}`,
              removeOnComplete: true,
            },
          ).catch((err) => {
            this.logger.warn(`Failed to re-enqueue enrichment for ${document.id}: ${err.message}`);
          });
        }
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

  onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  async enqueue(
    documentId: string,
    reason = "upload",
    expectedVersion?: number,
    priority = 5,
  ) {
    let version = expectedVersion;
    try {
      const current = version === undefined ? await this.prisma.document.findUnique({
        where: { id: documentId },
        select: { version: true, ...(immutableVersionsEnabled() ? { ingestVersion: true } : {}) },
      }) : null;
      version = version ?? current?.ingestVersion ?? current?.version;
      if (!version) throw new Error(`Document ${documentId} no longer exists.`);
      const jobId = `ingest-${documentId}-v${version}`;
      if (typeof this.ingestionQueue?.getJob === "function") {
        try {
          const existing = await this.ingestionQueue.getJob(jobId);
          if (existing) {
            const state = await existing.getState().catch(() => "unknown");
            if (["failed", "completed"].includes(state)) {
              await existing.remove().catch(() => {});
            }
          }
        } catch {
          // Non-fatal if queue check fails
        }
      }
      await this.ingestionQueue.add(
        "parse-document",
        { documentId, reason, expectedVersion: version },
        {
          jobId,
          attempts: 3,
          backoff: { type: "exponential", delay: 3_000 },
          removeOnComplete: 200,
          removeOnFail: 500,
          // BullMQ: lower value = scheduled earlier. Small/quick jobs (e.g.
          // negatives and light documents) use priority 1 so they are not
          // head-of-line blocked behind long parses of large documents.
          priority,
        },
      );
    } catch (error) {
      await this.markFailed(
        documentId,
        `Unable to persist ingestion job: ${error instanceof Error ? error.message : String(error)}`,
        version,
      );
      throw error;
    }
  }

  async processDocument(documentId: string, expectedVersion?: number) {
    const storedDocument = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        kbId: true,
        title: true,
        rawFileOid: true,
        sourceType: true,
        status: true,
        version: true,
        ...(immutableVersionsEnabled() ? { ingestVersion: true, activeVersionId: true, pendingRawFileOid: true, pendingTitle: true } : {}),
        kb: { select: { status: true } },
      },
    });
    const document = storedDocument && { ...storedDocument,
      version: immutableVersionsEnabled() ? storedDocument.ingestVersion ?? storedDocument.version : storedDocument.version,
      ...(immutableVersionsEnabled() ? { rawFileOid: storedDocument.pendingRawFileOid || storedDocument.rawFileOid, title: storedDocument.pendingTitle || storedDocument.title } : {}) };
    if (!document) throw new Error(`Document ${documentId} no longer exists.`);
    if (document.kb?.status && document.kb.status !== 'active')
      return { documentId, status: document.status, skipped: true, reason: 'knowledge-base-archived' };
    if (expectedVersion !== undefined && document.version !== expectedVersion) {
      return { documentId, status: document.status, skipped: true, reason: "superseded-version" };
    }
    if (document.status === "published" && (!immutableVersionsEnabled() || storedDocument?.version === document.version))
      return { documentId, status: "published", skipped: true };
    if (!document.rawFileOid)
      throw new Error("Original upload is no longer available.");
    const targetVersion = expectedVersion ?? document.version;
    const content = await readFile(document.rawFileOid);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const parsingClaim = await this.prisma.document.updateMany({
      where: { id: documentId, ...(immutableVersionsEnabled() ? { ingestVersion: targetVersion } : { version: targetVersion }) },
      data: { ...(immutableVersionsEnabled() && document.activeVersionId ? { ingestVersion: targetVersion } : { status: 'parsing' }) },
    });
    if (parsingClaim.count === 0) {
      return { documentId, status: document.status, skipped: true, reason: "superseded-version" };
    }

    try {
      let parsed: any = null;
    let conversionMetadata: Record<string, unknown> = {};
    const ext = extname(document.rawFileOid).toLowerCase();
    const pinnedOcrConfig = await this.modelConfigService.getOcrConfig?.();
    const parserFingerprint = createHash('sha256').update(JSON.stringify({
      instance: instanceIdentity(), format: ext, native: process.env.NATIVE_PARSER_REVISION || 'anydoc-v1',
      worker: this.parserUrl, revision: process.env.PARSER_DEPLOYMENT_REVISION || 'unversioned',
      ocr: [pinnedOcrConfig?.provider, pinnedOcrConfig?.baseUrl, process.env.OCR_DEPLOYMENT_REVISION || 'unversioned'],
      vlm: process.env.VLM_DEPLOYMENT_REVISION || 'unversioned', rules: 'canonical-quality-v1',
    })).digest('hex');
    const parseCacheKey = `${parserFingerprint}:${contentHash}`;

    const cacheReusable = Boolean(process.env.PARSER_DEPLOYMENT_REVISION &&
      (!pinnedOcrConfig || process.env.OCR_DEPLOYMENT_REVISION) && process.env.VLM_DEPLOYMENT_REVISION);
    let cachedParse = cacheReusable ? IngestionService.parseCache.get(parseCacheKey) : undefined;
    if (cachedParse && cachedParse.parsed) {
      this.logger.log(`Document ${documentId} hit parse cache (hash ${contentHash.slice(0, 10)}); reusing parsed Markdown.`);
      parsed = { ...cachedParse.parsed };
      conversionMetadata = { ...cachedParse.conversionMetadata };
    } else {
      // L2 Persistent cross-process deduplication cache
      try {
        // Containment (`@>`) instead of a JSON path comparison: the table only
        // has a GIN jsonb_path_ops index, which supports `@>`/`?`/`@@` but not
        // the `#>`/`#>>` extraction predicate Prisma generates for
        // `parserMetadata: { path: [...], equals: ... }`. Measured with
        // EXPLAIN, that form degraded to a sequential scan of "Document" even
        // with seq scan disabled, so every cache miss paid a full table scan.
        const matchingRows = cacheReusable ? await withServiceContext(this.prisma, (tx) =>
          tx.$queryRaw<Array<{
          mdPath: string | null;
          parserEngine: string | null;
          parserClassification: string | null;
          parserMetadata: any;
        }>>`
          SELECT "mdPath", "parserEngine", "parserClassification", "parserMetadata"
          FROM "Document"
          WHERE "id" <> ${documentId}::uuid
            AND "status" = 'published'
            AND "parserMetadata" @> ${JSON.stringify({ contentHash, parserFingerprint })}::jsonb
          LIMIT 1
        `) : [];
        const matchingDoc = Array.isArray(matchingRows) ? matchingRows[0] : undefined;
        if (matchingDoc && matchingDoc.mdPath) {
          const mdText = await readFile(join(this.uploadRoot, matchingDoc.mdPath), "utf8").catch(() => null);
          if (mdText && mdText.trim()) {
            parsed = {
              markdown: mdText,
              engine: `${matchingDoc.parserEngine || "cached"}-dedup`,
              classification: matchingDoc.parserClassification || ext.slice(1),
              status: "completed",
            };
            conversionMetadata = {
              ...((matchingDoc.parserMetadata as any) || {}),
              dedupSource: matchingDoc.mdPath,
            };
            if (cacheReusable) IngestionService.parseCache.set(parseCacheKey, {
              parsed: { ...parsed },
              conversionMetadata: { ...conversionMetadata },
            });
            this.logger.log(`Document ${documentId} hit persistent DB content-hash cache (hash ${contentHash.slice(0, 10)}); skipping expensive re-parse.`);
          }
        }
      } catch {
        // Fall back gracefully
      }
    }

    // Only invoke a parser when neither the process-local nor persistent
    // content-hash cache produced a result. Previously the AnyDoc branch ran
    // even after a cache hit and re-parsed every duplicate PDF/Office upload,
    // defeating both cache layers and multiplying ingestion cost.
    if (!parsed && [".txt", ".md"].includes(ext)) {
      const rawText = content.toString("utf8");
      if (rawText.trim()) {
        parsed = {
          markdown: rawText,
          engine: "plaintext-fastpath",
          classification: ext.slice(1),
          status: "completed",
        };
      }
    } else if (!parsed && ANYDOC_UPLOAD_EXTENSIONS.has(ext)) {
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
      form.append("instance_id", instanceIdentity());
      const fileBytes = content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer;
      const rawExt = extname(document.rawFileOid || "").toLowerCase();
      const titleExt = extname(document.title || "").toLowerCase();
      const effectiveExt =
        SUPPORTED_UPLOAD_EXTENSIONS.has(titleExt) || ANYDOC_UPLOAD_EXTENSIONS.has(titleExt)
          ? titleExt
          : SUPPORTED_UPLOAD_EXTENSIONS.has(rawExt) || ANYDOC_UPLOAD_EXTENSIONS.has(rawExt)
            ? rawExt
            : ".md";
      const baseTitle = titleExt ? document.title.slice(0, -titleExt.length) : document.title;
      const parseFilename = `${baseTitle}${effectiveExt}`;
      form.append(
        "file",
        new Blob([fileBytes]),
        parseFilename,
      );
      const ocrConfig = pinnedOcrConfig;
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

    // AnyDoc (and its content-hash dedup) extracts document text but never
    // OCRs pictures inside Office/PDF files. Parser-worker paths already do
    // image OCR internally. Enrich the AnyDoc path so figure labels enter
    // the hybrid index instead of being silently dropped.
    const engineName = String(parsed?.engine || "");
    const missingImageOcr =
      parsed?.ocr_image_count === undefined || parsed?.ocr_image_count === null;
    if (
      parsed &&
      [".docx", ".pptx", ".pdf"].includes(ext) &&
      missingImageOcr &&
      (engineName.startsWith("anydoc") || engineName.endsWith("-dedup"))
    ) {
      try {
        const imageForm = new FormData();
        const rawExt = extname(document.rawFileOid || "").toLowerCase();
        const titleExt = extname(document.title || "").toLowerCase();
        const imageExt =
          SUPPORTED_UPLOAD_EXTENSIONS.has(titleExt) || ANYDOC_UPLOAD_EXTENSIONS.has(titleExt)
            ? titleExt
            : SUPPORTED_UPLOAD_EXTENSIONS.has(rawExt) || ANYDOC_UPLOAD_EXTENSIONS.has(rawExt)
              ? rawExt
              : ext;
        const baseTitle = titleExt
          ? document.title.slice(0, -titleExt.length)
          : document.title;
        imageForm.append(
          "file",
          new Blob([content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer]),
          `${baseTitle}${imageExt}`,
        );
        const ocrCfg = await this.modelConfigService.getOcrConfig();
        if (ocrCfg) {
          imageForm.append("ocr_provider", ocrCfg.provider);
          imageForm.append("ocr_endpoint", ocrCfg.baseUrl);
          imageForm.append("ocr_api_key", ocrCfg.apiKey);
          imageForm.append("ocr_secret_key", ocrCfg.secretKey);
        }
        const imageHeaders: Record<string, string> = {};
        const imageAuthToken = process.env.PARSER_AUTH_TOKEN || process.env.AUTH_TOKEN;
        if (imageAuthToken) imageHeaders.Authorization = `Bearer ${imageAuthToken}`;
        const imageResp = await fetch(`${this.parserUrl}/ocr-embedded-images`, {
          method: "POST",
          body: imageForm,
          headers: imageHeaders,
          signal: AbortSignal.timeout(parserPollBudget(process.env) + 30_000),
        });
        if (imageResp.ok) {
          const imageResult = await imageResp.json();
          const imageMd = String(imageResult?.markdown || "").trim();
          if (imageMd) {
            parsed.markdown = `${String(parsed.markdown || "").trim()}\n\n## 图片文字（OCR）\n\n${imageMd}`;
          }
          for (const key of [
            "embedded_image_count",
            "ocr_image_count",
            "ocr_provider",
            "ocr_words_result_num",
            "ocr_average_confidence",
          ]) {
            if (imageResult?.[key] !== undefined && imageResult?.[key] !== null) {
              parsed[key] = imageResult[key];
              conversionMetadata[key] = imageResult[key];
            }
          }
          this.logger.log(
            `Embedded-image OCR enriched document ${documentId}: images=${imageResult?.embedded_image_count ?? 0} ocr=${imageResult?.ocr_image_count ?? 0}`,
          );
        } else {
          this.logger.warn(
            `Embedded-image OCR endpoint failed for ${documentId}: HTTP ${imageResp.status}`,
          );
        }
      } catch (imageErr) {
        this.logger.warn(
          `Embedded-image OCR enrichment failed for ${documentId}: ${imageErr instanceof Error ? imageErr.message : imageErr}`,
        );
      }
    }

    // Inspect original output before control-character normalization can hide damage.
    const quality = assessContentQuality(String(parsed.markdown || ""), ext, parsed);
    // content-v2.1: language detection + PII scan + SimHash for near-dup gate.
    // PII is recorded as metadata only and never blocks publication.
    const extended = assessExtendedQuality(String(parsed.markdown || ""));
    parsed = {
      ...parsed,
      ...quality,
      language: extended.language,
      simhash: extended.simhash,
      pii_count: extended.piiFindings.length,
    };
    const markdown = String(parsed.markdown || "")
      .replace(/\0/g, "")
      .replace(/\u0000/g, "")
      .trim();
    if (!markdown) throw new Error("Parser returned empty Markdown.");
    if (parsed && parsed.markdown && !cachedParse) {
      if (cacheReusable) IngestionService.parseCache.set(parseCacheKey, {
        parsed: { ...parsed },
        conversionMetadata: { ...conversionMetadata },
      });
      if (IngestionService.parseCache.size > 200) {
        const oldest = IngestionService.parseCache.keys().next().value;
        if (oldest) IngestionService.parseCache.delete(oldest);
      }
    }
    // Near-duplicate gate (SimHash): flag same-KB documents within Hamming<=3
    // unless the content hash is identical (exact dedupe already handles that).
    try {
      const currentSim = simhash64(markdown);
      const siblings = await this.prisma.document.findMany({
        where: { kbId: document.kbId, id: { not: documentId }, status: 'published' },
        select: { id: true, title: true, contentHash: true, parserMetadata: true },
        take: 500,
      });
      const near = siblings.filter((s: any) => {
        const other = s.parserMetadata?.simhash;
        if (!other || s.contentHash === contentHash) return false;
        try {
          return isNearDuplicate(currentSim, BigInt(other));
        } catch {
          return false;
        }
      });
      if (near.length > 0) {
        parsed.near_duplicates = near.slice(0, 5).map((s: any) => ({ id: s.id, title: s.title }));
        this.logger.warn(
          `Document ${documentId} is near-duplicate of ${near.length} existing doc(s) in KB ${document.kbId}`,
        );
      }
    } catch (dupErr) {
      this.logger.debug(`near-dup check skipped: ${dupErr instanceof Error ? dupErr.message : String(dupErr)}`);
    }
    const chunks = splitMarkdownIntoChunks(markdown);
    if (!chunks.length)
      throw new Error("Parser returned no indexable content.");

    // --- Contextual Retrieval: enrich chunks with document-level context ---
    let enrichedChunks = chunks;
    const contextualEnabled = immutableVersionsEnabled()
      ? process.env.CONTEXTUAL_RETRIEVAL_ENABLED === 'true'
      : process.env.CONTEXTUAL_RETRIEVAL_ENABLED !== 'false';
    if (contextualEnabled && chunks.length > 1 && markdown.length >= 500) {
      try {
        const llmConfig = (await this.modelConfigService.getDefault('fast_llm')) ??
          (await this.modelConfigService.getDefault('llm'));
        if (llmConfig) {
          enrichedChunks = await enrichChunksWithContext(
            markdown,
            chunks,
            {
              baseUrl: (llmConfig.provider.baseUrl || process.env.FAST_LLM_BASE_URL || process.env.LLM_BASE_URL || '').replace(/\/$/, ''),
              apiKey: llmConfig.provider.apiKey || process.env.FAST_LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '',
              modelName: llmConfig.modelName || process.env.FAST_LLM_MODEL || (process.env.LLM_MODEL ?? ""),
            },
            {
              concurrency: Number(process.env.CONTEXTUAL_RETRIEVAL_CONCURRENCY || 5),
              batchSize: Number(process.env.CONTEXTUAL_RETRIEVAL_BATCH_SIZE || 3),
              documentTitle: document.title,
              cache: IngestionService.contextualPrefixCache,
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
    const parserMetadata: Record<string, unknown> = { ...conversionMetadata, contentHash, parserFingerprint };
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
      "ocr_image_count",
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
    if (extended?.language) parserMetadata["language"] = extended.language;
    if (extended?.simhash) parserMetadata["simhash"] = extended.simhash;
    // Parsed content is immutable per version/hash. The database pointer and
    // chunks change in one transaction; a stale job never replaces the file
    // used by a newer version.
    const relativeContentPath = `${documentId}/content.v${targetVersion}.${createHash("sha256").update(markdown).digest("hex")}.md`;
    const contentPath = join(this.uploadRoot, relativeContentPath);
    const pendingContentPath = join(
      this.uploadRoot,
      documentId,
      `content.md.v${targetVersion}.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(
      pendingContentPath,
      markdown,
      "utf8",
    );
    await rename(pendingContentPath, contentPath);
    if (immutableVersionsEnabled()) {
      const version = await new DocumentVersionStore(this.prisma).stage({
        documentId, kbId: document.kbId, number: targetVersion, sourceHash: contentHash,
        title: document.title, mdPath: relativeContentPath, parser: parserFingerprint,
        publicationData: { parserEngine: parsed.engine || null, parserClassification: parsed.classification || null,
          parserMetadata, qualityStatus, qualityScore, qualityIssues, contentHash, rawFileOid: document.rawFileOid },
        blocks: enrichedChunks.map(chunk => ({ ...chunk, rawContent: markdown.slice(chunk.charStart, chunk.charEnd), metadata: { ...(chunk.metadata || {}),
          canonical_block: buildCanonicalBlock({ document: { id: documentId, kbId: document.kbId, title: document.title,
            version: targetVersion, sourceType: document.sourceType }, chunk: { ...chunk,content:markdown.slice(chunk.charStart,chunk.charEnd) } }) } })),
        passed: qualityStatus === 'passed',
      });
      return { documentId, status: version.state, versionId: version.id, chunks: enrichedChunks.length, qualityStatus, qualityScore };
    }
    // The expectedVersion check at the top only fences queue-time. Re-check
    // inside the save transaction: a concurrent re-upload that bumped the
    // version between parse and save must not have its chunks clobbered.
    // Chunk rows carry no version column, so the delete scope cannot be
    // narrowed below documentId; the in-transaction version fence above is
    // what makes that document-wide delete safe.
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const claim = await tx.document.updateMany({
            where: { id: documentId, version: targetVersion },
            data: {
              mdPath: relativeContentPath,
              status: qualityStatus === "passed" ? "indexing" : "needs_review",
              ...(qualityStatus === "passed" ? { indexReadiness: "pending" } : {}),
              parserEngine: parsed.engine || null,
              parserClassification: parsed.classification || null,
              parserMetadata: parserMetadata as any,
              qualityStatus,
              qualityScore,
              qualityIssues: qualityIssues as any,
            },
          });
          if (claim.count !== 1) {
            throw new SupersededVersionError(
              documentId,
              targetVersion as number,
              -1,
            );
          }
          // A repeated parse can replace chunks even when it retains the same
          // document version (for example after a worker crash). Completed
          // stages for the old chunk set must not suppress re-indexing.
          await tx.enrichmentStage.deleteMany({ where: { documentId, version: targetVersion ?? document.version ?? 1 } });
          await tx.chunk.deleteMany({ where: { documentId } });
          const CHUNK_BATCH_SIZE = Number(process.env.INGESTION_CHUNK_BATCH || 2000);
          const chunkData = enrichedChunks.map((chunk) => {
            const canonicalBlock = buildCanonicalBlock({
              document: {
                id: documentId,
                kbId: document.kbId,
                title: document.title,
                version: targetVersion ?? document.version ?? 1,
                sourceType: document.sourceType,
              },
              chunk,
            });
            return {
              documentId,
              kbId: document.kbId,
              ord: chunk.ord,
              content: chunk.content,
              tokenCount: chunk.tokenCount,
              charStart: chunk.charStart,
              charEnd: chunk.charEnd,
              metadata: { ...(chunk.metadata || {}), canonical_block: canonicalBlock } as any,
            };
          });
          for (let i = 0; i < chunkData.length; i += CHUNK_BATCH_SIZE) {
            await tx.chunk.createMany({ data: chunkData.slice(i, i + CHUNK_BATCH_SIZE) });
          }
          if (qualityStatus === "passed") {
            // The document and its synchronization intent commit together. A
            // crash after this transaction cannot strand a published version.
            await tx.brainChangeEvent.create({
              data: {
                eventType: "doc_change",
                resourceType: "document",
                resourceId: documentId,
                status: "pending",
                payload: { kbId: document.kbId, version: targetVersion },
              },
            });
            await tx.brainChangeEvent.create({
              data: {
                eventType: "enrichment_request",
                resourceType: "document",
                resourceId: documentId,
                status: "pending",
                payload: { kbId: document.kbId, version: targetVersion },
              },
            });
          }
        },
        // Chunk replacement for large documents can exceed the default 5s
        // interactive-transaction timeout.
        {
          timeout: Math.max(5_000, Number(process.env.INGESTION_TX_TIMEOUT_MS || 120_000)),
          maxWait: 5_000,
        },
      );
    } catch (err) {
      await unlink(pendingContentPath).catch(() => undefined);
      if (err instanceof SupersededVersionError) {
        this.logger.warn(`Skipping save for ${documentId}: ${err.message}`);
        return {
          documentId,
          status: document.status,
          skipped: true,
          reason: "superseded-version",
        };
      }
      throw err;
    }

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

    // BrainOutboxService dispatches the doc_change event written above. Keep
    // source synchronization out of the request/parse path.
    // Post-publish enrichment owns lexical postings and the other derived
    // indexes. Running lexical indexing here as well paid twice per document.
    // Enrichment intent was committed beside the chunks. BrainOutboxService
    // delivers it to BullMQ and retries delivery independently of this worker.
    // Unit harnesses without the outbox keep the legacy local fallback.
    if (!this.enrichmentQueue && this.chunkEmbeddingService?.isEnabled()) {
      void this.chunkEmbeddingService.embedDocumentChunks(documentId).catch((err) => {
        this.logger.warn(
          `Chunk embedding failed for ${documentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    return {
      documentId,
      status: "indexing",
      chunks: chunks.length,
      parser: parsed.engine || "unknown",
      qualityStatus,
      qualityScore,
      qualityIssues,
    };
    } catch (err) {
      throw err;
    }
  }

  async markFailed(documentId: string, reason: string, expectedVersion?: number) {
    if (immutableVersionsEnabled()) {
      await this.prisma.$transaction(async tx => {
        const doc = await tx.document.findUnique({ where: { id: documentId } });
        if (!doc || (expectedVersion !== undefined && (doc.ingestVersion ?? doc.version) !== expectedVersion)) return;
        if (doc.buildingVersionId) await tx.documentVersion.updateMany({
          where: { id: doc.buildingVersionId, state: { in: ['parsed', 'indexing'] } }, data: { state: 'failed' },
        });
        // A failed replacement cannot unpublish the last coherent projection.
        await tx.document.update({ where: { id: documentId }, data: doc.activeVersionId
          ? { parserMetadata: { pendingError: reason } }
          : { status: 'failed', qualityStatus: 'rejected', qualityIssues: [reason], parserMetadata: { error: reason } } });
      });
      this.logger.error(`Document ${documentId} pending ingestion failed: ${reason}`);
      return;
    }
    await this.prisma.document
      .updateMany({
        where: {
          id: documentId,
          ...(expectedVersion === undefined ? {} : { version: expectedVersion }),
        },
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
