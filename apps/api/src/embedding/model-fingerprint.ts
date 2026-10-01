import { createHash } from 'node:crypto';
import type { EmbeddingProviderConfig } from './embedding.service';
import { instanceIdentity } from '../observability/instance-identity';
export function reusableEmbeddingIdentity(config: EmbeddingProviderConfig, env = process.env): boolean {
  return Boolean(config.deploymentRevision || env.EMBEDDING_DEPLOYMENT_REVISION);
}

/** No credentials are persisted. Deployment revision must change when weights change. */
export function embeddingFingerprint(config: EmbeddingProviderConfig, env = process.env): string {
  return createHash('sha256').update(JSON.stringify({
    route: config.baseUrl, model: config.modelName, dimensions: config.dimensions,
    revision: config.deploymentRevision || env.EMBEDDING_DEPLOYMENT_REVISION || 'unversioned',
    tokenizer: env.EMBEDDING_TOKENIZER_REVISION || 'provider',
    projection: 'indexable-chunk-v1', maxChars: env.EMBEDDING_MAX_CHARS || '6000',
    normalization: 'provider', instance: instanceIdentity(env),
  })).digest('hex');
}

export function hybridFingerprint(config: EmbeddingProviderConfig, env=process.env): string {
  return createHash('sha256').update(JSON.stringify([embeddingFingerprint({ ...config, baseUrl:env.BGE_M3_HYBRID_ENDPOINT || config.baseUrl, deploymentRevision:env.BGE_M3_HYBRID_DEPLOYMENT_REVISION || config.deploymentRevision },env),
    'verified-bge-hybrid-v1',env.BGE_M3_MAXSIM_ENABLED==='true',env.BGE_M3_MULTI_VECTOR_MAX_TOKENS || '128',env.BGE_M3_CAPABILITIES_ENDPOINT || config.baseUrl+'/capabilities'])).digest('hex');
}
