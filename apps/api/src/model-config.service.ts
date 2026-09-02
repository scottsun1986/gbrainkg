import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import {
  decryptModelCredential,
  encryptModelCredential,
  isEncryptedModelCredential,
} from "./model-credential";

export type ModelKind = "llm" | "embedding" | "rerank";

export interface ResolvedOcrConfig {
  providerId: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  secretKey: string;
}

export interface ResolvedModelConfig {
  id: string;
  kind: ModelKind;
  modelName: string;
  contextLen: number;
  dimensions: number | null;
  provider: {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    defaultParams: unknown;
  };
}

export interface RuntimeModelStatus {
  routes: Record<ModelKind, {
    configured: boolean;
    injected: boolean;
    modelName: string | null;
    baseUrl: string | null;
  }>;
  gbrain: {
    bin: string;
    home: string;
    poolSize: number;
    scopeSynthesizeEnabled: boolean;
    graphExtractEnabled: boolean;
  };
}

/** Platform DB is the source of truth for model routes and credentials. */
@Injectable()
export class ModelConfigService implements OnModuleDestroy {
  private readonly logger = new Logger(ModelConfigService.name);
  private readonly prisma = new PrismaClient();

  async getDefault(kind: ModelKind): Promise<ResolvedModelConfig | null> {
    const config =
      (await this.prisma.modelConfig.findFirst({
        where: { kind, isDefault: true, provider: { enabled: true } },
        include: { provider: true },
        orderBy: { createdAt: "asc" },
      })) ??
      (await this.prisma.modelConfig.findFirst({
        where: { kind, provider: { enabled: true } },
        include: { provider: true },
        orderBy: { createdAt: "asc" },
      }));
    if (!config) return null;
    const apiKey = decryptModelCredential(config.provider.apiKeyEncrypted);
    if (
      apiKey &&
      !isEncryptedModelCredential(config.provider.apiKeyEncrypted)
    ) {
      await this.prisma.modelProvider.update({
        where: { id: config.provider.id },
        data: { apiKeyEncrypted: encryptModelCredential(apiKey) },
      });
      this.logger.log(
        `Migrated provider credential ${config.provider.id} to AES-GCM storage.`,
      );
    }
    return {
      id: config.id,
      kind: config.kind as ModelKind,
      modelName: config.modelName,
      contextLen: config.contextLen,
      dimensions: config.dimensions,
      provider: {
        id: config.provider.id,
        name: config.provider.name,
        baseUrl: config.provider.baseUrl,
        apiKey,
        defaultParams: config.provider.defaultParams,
      },
    };
  }

  async getOcrConfig(): Promise<ResolvedOcrConfig | null> {
    const provider = await this.prisma.modelProvider.findFirst({
      where: { kind: "ocr", enabled: true },
      orderBy: { name: "asc" },
    });
    if (!provider) return null;
    const apiKey = decryptModelCredential(provider.apiKeyEncrypted);
    const secretKey = decryptModelCredential(provider.secretKeyEncrypted);
    const defaultParams =
      provider.defaultParams && typeof provider.defaultParams === "object"
        ? (provider.defaultParams as Record<string, unknown>)
        : {};
    return {
      providerId: provider.id,
      provider: String(defaultParams.provider || "baidu").toLowerCase(),
      baseUrl: provider.baseUrl,
      apiKey,
      secretKey,
    };
  }

  /** Project DB-selected routes into the API process and official GBrain child environment. */
  async applyRuntimeConfig(): Promise<void> {
    const [llm, embedding, rerank] = await Promise.all([
      this.getDefault("llm"),
      this.getDefault("embedding"),
      this.getDefault("rerank"),
    ]);
    if (llm) {
      process.env.LLM_BASE_URL = llm.provider.baseUrl;
      process.env.LLM_MODEL = llm.modelName;
      if (llm.provider.apiKey)
        process.env.DEEPSEEK_API_KEY = llm.provider.apiKey;
      process.env.GBRAIN_CHAT_MODEL = `deepseek:${llm.modelName}`;
      process.env.GBRAIN_EXPANSION_MODEL = `deepseek:${llm.modelName}`;
      process.env.GBRAIN_DEEPSEEK_BASE_URL = llm.provider.baseUrl;
    }
    if (embedding) {
      // SiliconFlow exposes the OpenAI-compatible /embeddings contract.
      process.env.GBRAIN_EMBEDDING_MODEL = `openai:${embedding.modelName}`;
      if (embedding.dimensions)
        process.env.GBRAIN_EMBEDDING_DIMENSIONS = String(embedding.dimensions);
      process.env.OPENAI_BASE_URL = embedding.provider.baseUrl;
      if (embedding.provider.apiKey)
        process.env.OPENAI_API_KEY = embedding.provider.apiKey;
    }
    if (rerank) {
      process.env.LLMWIKI_RERANK_BASE_URL = rerank.provider.baseUrl;
      process.env.LLMWIKI_RERANK_MODEL = rerank.modelName;
      if (rerank.provider.apiKey)
        process.env.LLMWIKI_RERANK_API_KEY = rerank.provider.apiKey;
      // SiliconFlow's /v1/rerank contract matches GBrain's configurable
      // OpenAI-style reranker recipe.
      process.env.GBRAIN_RERANK_MODEL = `llama-server-reranker:${rerank.modelName}`;
      process.env.LLAMA_SERVER_RERANKER_BASE_URL = rerank.provider.baseUrl;
      if (rerank.provider.apiKey)
        process.env.LLAMA_SERVER_RERANKER_API_KEY = rerank.provider.apiKey;
    }
    this.logger.debug(
      `Applied DB model routes (llm=${llm?.modelName ?? "none"}, embedding=${embedding?.modelName ?? "none"}, rerank=${rerank?.modelName ?? "none"}).`,
    );
  }

  /**
   * Safe, secret-free proof that the DB-selected routes are the routes the API
   * will pass to every GBrain child process. This is intentionally diagnostic
   * only: credentials are never returned and the CLI itself remains private.
   */
  async getRuntimeStatus(): Promise<RuntimeModelStatus> {
    const [llm, embedding, rerank] = await Promise.all([
      this.getDefault("llm"),
      this.getDefault("embedding"),
      this.getDefault("rerank"),
    ]);
    const routes = {
      llm: {
        configured: Boolean(llm),
        injected: Boolean(llm && process.env.LLM_MODEL === llm.modelName && process.env.GBRAIN_CHAT_MODEL === `deepseek:${llm.modelName}`),
        modelName: llm?.modelName || null,
        baseUrl: llm?.provider.baseUrl || null,
      },
      embedding: {
        configured: Boolean(embedding),
        injected: Boolean(embedding && process.env.GBRAIN_EMBEDDING_MODEL === `openai:${embedding.modelName}` && process.env.OPENAI_BASE_URL === embedding.provider.baseUrl),
        modelName: embedding?.modelName || null,
        baseUrl: embedding?.provider.baseUrl || null,
      },
      rerank: {
        configured: Boolean(rerank),
        injected: Boolean(rerank && process.env.LLMWIKI_RERANK_MODEL === rerank.modelName && process.env.LLMWIKI_RERANK_BASE_URL === rerank.provider.baseUrl),
        modelName: rerank?.modelName || null,
        baseUrl: rerank?.provider.baseUrl || null,
      },
    } satisfies Record<ModelKind, RuntimeModelStatus["routes"][ModelKind]>;
    return {
      routes,
      gbrain: {
        bin: process.env.GBRAIN_BIN || "/home/scottsun/.bun/bin/gbrain",
        home: process.env.GBRAIN_HOME || "/home/scottsun/.config/gbrain",
        poolSize: Math.max(1, Number(process.env.GBRAIN_POOL_SIZE || 2)),
        scopeSynthesizeEnabled: process.env.GBRAIN_SCOPE_SYNTHESIZE_ENABLED !== "0",
        graphExtractEnabled: process.env.GBRAIN_GRAPH_EXTRACT_ENABLED !== "0",
      },
    };
  }

  async onModuleDestroy() {
    await this.prisma.$disconnect();
  }
}
