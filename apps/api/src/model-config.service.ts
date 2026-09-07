import { Injectable, Logger } from "@nestjs/common";
import { getPrismaClient } from "./prisma";
import { createHash } from "node:crypto";
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

const RECIPES: Record<ModelKind, readonly string[]> = {
  llm: ['deepseek', 'openai', 'openrouter', 'litellm', 'ollama'],
  embedding: ['openai', 'voyage', 'ollama', 'llama-server'],
  rerank: ['llama-server-reranker'],
};

function modelRecipe(config: ResolvedModelConfig, fallback: string): string {
  const params = config.provider.defaultParams && typeof config.provider.defaultParams === 'object'
    ? config.provider.defaultParams as Record<string, unknown>
    : {};
  const requested = String(params.gbrainRecipe || fallback).trim().toLowerCase();
  return RECIPES[config.kind].includes(requested) ? requested : fallback;
}

function injectRecipeKey(recipe: string, apiKey: string): void {
  if (!apiKey) return;
  const keyName: Record<string, string> = {
    deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY', litellm: 'LITELLM_API_KEY',
    voyage: 'VOYAGE_API_KEY',
  };
  if (keyName[recipe]) process.env[keyName[recipe]] = apiKey;
}

/** Platform DB is the source of truth for model routes and credentials. */
@Injectable()
export class ModelConfigService {
  private readonly logger = new Logger(ModelConfigService.name);
  private readonly prisma = getPrismaClient();
  private readonly cache = new Map<ModelKind, {
    expiresAt: number;
    value: Promise<ResolvedModelConfig | null>;
  }>();
  private appliedSignature = "";

  async getDefault(kind: ModelKind, force = false): Promise<ResolvedModelConfig | null> {
    const now = Date.now();
    const cached = this.cache.get(kind);
    if (!force && cached && cached.expiresAt > now) return cached.value;
    const value = this.loadDefault(kind);
    this.cache.set(kind, {
      expiresAt: now + Math.max(1_000, Number(process.env.MODEL_CONFIG_CACHE_MS || 5_000)),
      value,
    });
    return value;
  }

  private async loadDefault(kind: ModelKind): Promise<ResolvedModelConfig | null> {
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
  async applyRuntimeConfig(force = false): Promise<void> {
    if (force) this.cache.clear();
    const [llm, embedding, rerank] = await Promise.all([
      this.getDefault("llm", force),
      this.getDefault("embedding", force),
      this.getDefault("rerank", force),
    ]);
    const signature = createHash("sha256").update(JSON.stringify([
      llm && [llm.id, llm.modelName, llm.provider.baseUrl, llm.provider.apiKey],
      embedding && [embedding.id, embedding.modelName, embedding.dimensions, embedding.provider.baseUrl, embedding.provider.apiKey],
      rerank && [rerank.id, rerank.modelName, rerank.provider.baseUrl, rerank.provider.apiKey],
    ])).digest("hex");
    if (!force && signature === this.appliedSignature) return;
    for (const key of [
      "LLM_BASE_URL", "LLM_MODEL", "DEEPSEEK_API_KEY",
      "GBRAIN_CHAT_MODEL", "GBRAIN_EXPANSION_MODEL", "GBRAIN_DEEPSEEK_BASE_URL",
      "GBRAIN_EMBEDDING_MODEL", "GBRAIN_EMBEDDING_DIMENSIONS", "OPENAI_BASE_URL", "OPENAI_API_KEY",
      "LLMWIKI_RERANK_BASE_URL", "LLMWIKI_RERANK_MODEL", "LLMWIKI_RERANK_API_KEY",
      "GBRAIN_RERANK_MODEL", "LLAMA_SERVER_RERANKER_BASE_URL", "LLAMA_SERVER_RERANKER_API_KEY",
      "GBRAIN_CHAT_BASE_URL", "GBRAIN_EMBEDDING_BASE_URL", "GBRAIN_RERANK_BASE_URL",
      "OPENROUTER_API_KEY", "LITELLM_API_KEY", "VOYAGE_API_KEY",
    ]) delete process.env[key];
    if (llm) {
      const recipe = modelRecipe(llm, 'deepseek');
      process.env.LLM_BASE_URL = llm.provider.baseUrl;
      process.env.LLM_MODEL = llm.modelName;
      injectRecipeKey(recipe, llm.provider.apiKey);
      process.env.GBRAIN_CHAT_MODEL = `${recipe}:${llm.modelName}`;
      process.env.GBRAIN_EXPANSION_MODEL = `${recipe}:${llm.modelName}`;
      process.env.GBRAIN_CHAT_BASE_URL = llm.provider.baseUrl;
    }
    if (embedding) {
      const recipe = modelRecipe(embedding, 'openai');
      process.env.GBRAIN_EMBEDDING_MODEL = `${recipe}:${embedding.modelName}`;
      if (embedding.dimensions)
        process.env.GBRAIN_EMBEDDING_DIMENSIONS = String(embedding.dimensions);
      process.env.GBRAIN_EMBEDDING_BASE_URL = embedding.provider.baseUrl;
      injectRecipeKey(recipe, embedding.provider.apiKey);
    }
    if (rerank) {
      const recipe = modelRecipe(rerank, 'llama-server-reranker');
      process.env.LLMWIKI_RERANK_BASE_URL = rerank.provider.baseUrl;
      process.env.LLMWIKI_RERANK_MODEL = rerank.modelName;
      if (rerank.provider.apiKey)
        process.env.LLMWIKI_RERANK_API_KEY = rerank.provider.apiKey;
      process.env.GBRAIN_RERANK_MODEL = `${recipe}:${rerank.modelName}`;
      process.env.GBRAIN_RERANK_BASE_URL = rerank.provider.baseUrl;
      if (recipe === 'llama-server-reranker' && rerank.provider.apiKey)
        process.env.LLAMA_SERVER_RERANKER_API_KEY = rerank.provider.apiKey;
    }
    this.logger.debug(
      `Applied DB model routes (llm=${llm?.modelName ?? "none"}, embedding=${embedding?.modelName ?? "none"}, rerank=${rerank?.modelName ?? "none"}).`,
    );
    this.appliedSignature = signature;
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
        injected: Boolean(llm && process.env.LLM_MODEL === llm.modelName && process.env.GBRAIN_CHAT_MODEL === `${modelRecipe(llm, 'deepseek')}:${llm.modelName}`),
        modelName: llm?.modelName || null,
        baseUrl: llm?.provider.baseUrl || null,
      },
      embedding: {
        configured: Boolean(embedding),
        injected: Boolean(embedding && process.env.GBRAIN_EMBEDDING_MODEL === `${modelRecipe(embedding, 'openai')}:${embedding.modelName}` && process.env.GBRAIN_EMBEDDING_BASE_URL === embedding.provider.baseUrl),
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

}
