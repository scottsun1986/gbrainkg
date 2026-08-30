import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

export type ModelKind = 'llm' | 'embedding' | 'rerank';

export interface ResolvedModelConfig {
  id: string;
  kind: ModelKind;
  modelName: string;
  contextLen: number;
  dimensions: number | null;
  provider: { id: string; name: string; baseUrl: string; apiKey: string; defaultParams: unknown };
}

/** Platform DB is the source of truth for model routes and credentials. */
@Injectable()
export class ModelConfigService implements OnModuleDestroy {
  private readonly logger = new Logger(ModelConfigService.name);
  private readonly prisma = new PrismaClient();

  async getDefault(kind: ModelKind): Promise<ResolvedModelConfig | null> {
    const config = await this.prisma.modelConfig.findFirst({
      where: { kind, isDefault: true, provider: { enabled: true } }, include: { provider: true }, orderBy: { createdAt: 'asc' },
    }) ?? await this.prisma.modelConfig.findFirst({
      where: { kind, provider: { enabled: true } }, include: { provider: true }, orderBy: { createdAt: 'asc' },
    });
    if (!config) return null;
    return {
      id: config.id, kind: config.kind as ModelKind, modelName: config.modelName,
      contextLen: config.contextLen, dimensions: config.dimensions,
      provider: {
        id: config.provider.id, name: config.provider.name, baseUrl: config.provider.baseUrl,
        apiKey: config.provider.apiKeyEncrypted ? Buffer.from(config.provider.apiKeyEncrypted).toString('utf8') : '',
        defaultParams: config.provider.defaultParams,
      },
    };
  }

  /** Project DB-selected routes into the API process and official GBrain child environment. */
  async applyRuntimeConfig(): Promise<void> {
    const [llm, embedding, rerank] = await Promise.all([this.getDefault('llm'), this.getDefault('embedding'), this.getDefault('rerank')]);
    if (llm) {
      process.env.LLM_BASE_URL = llm.provider.baseUrl;
      process.env.LLM_MODEL = llm.modelName;
      if (llm.provider.apiKey) process.env.DEEPSEEK_API_KEY = llm.provider.apiKey;
      process.env.GBRAIN_CHAT_MODEL = `deepseek:${llm.modelName}`;
      process.env.GBRAIN_EXPANSION_MODEL = `deepseek:${llm.modelName}`;
      process.env.GBRAIN_DEEPSEEK_BASE_URL = llm.provider.baseUrl;
    }
    if (embedding) {
      // SiliconFlow exposes the OpenAI-compatible /embeddings contract.
      process.env.GBRAIN_EMBEDDING_MODEL = `openai:${embedding.modelName}`;
      if (embedding.dimensions) process.env.GBRAIN_EMBEDDING_DIMENSIONS = String(embedding.dimensions);
      process.env.OPENAI_BASE_URL = embedding.provider.baseUrl;
      if (embedding.provider.apiKey) process.env.OPENAI_API_KEY = embedding.provider.apiKey;
    }
    if (rerank) {
      process.env.LLMWIKI_RERANK_BASE_URL = rerank.provider.baseUrl;
      process.env.LLMWIKI_RERANK_MODEL = rerank.modelName;
      if (rerank.provider.apiKey) process.env.LLMWIKI_RERANK_API_KEY = rerank.provider.apiKey;
      // SiliconFlow's /v1/rerank contract matches GBrain's configurable
      // OpenAI-style reranker recipe.
      process.env.GBRAIN_RERANK_MODEL = `llama-server-reranker:${rerank.modelName}`;
      process.env.LLAMA_SERVER_RERANKER_BASE_URL = rerank.provider.baseUrl;
      if (rerank.provider.apiKey) process.env.LLAMA_SERVER_RERANKER_API_KEY = rerank.provider.apiKey;
    }
    this.logger.debug(`Applied DB model routes (llm=${llm?.modelName ?? 'none'}, embedding=${embedding?.modelName ?? 'none'}, rerank=${rerank?.modelName ?? 'none'}).`);
  }

  async onModuleDestroy() { await this.prisma.$disconnect(); }
}
