/**
 * Run provenance helpers shared by the evaluation collectors. Every result
 * file must be traceable to a run id, a git commit and a corpus fingerprint
 * so stale or unidentified results cannot pass the quality gate.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';

const REPO_ROOT = path.join(__dirname, '..', '..');

export function gitCommitHash(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return 'unknown';
  }
}

/** First 8 hex chars of the golden dataset content hash. */
export function corpusFingerprint(datasetPath: string): string {
  try {
    return createHash('sha256').update(fs.readFileSync(datasetPath, 'utf-8')).digest('hex').slice(0, 8);
  } catch {
    return 'unknown';
  }
}

/**
 * Retrieval configuration fingerprint (review 2026-10-05 §3.4/§3.5): identifies
 * the exact retrieval behaviour a run executed under, so two reports can be
 * attributed to config differences instead of guessing.
 */
export function retrievalFingerprint(): string {
  const keys = [
    'RETRIEVAL_RELEVANCE_FLOOR_RATIO', 'RETRIEVAL_SOFT_FLOOR_ENABLED', 'RETRIEVAL_MIN_FLOOR_GROUPS',
    'RETRIEVAL_MAX_GROUPS', 'RETRIEVAL_MMR_LAMBDA', 'RETRIEVAL_CONTEXT_TOKEN_BUDGET',
    'RERANK_MAX_DOCS', 'RERANK_TIMEOUT_MS', 'RERANK_CASCADE_ENABLED',
    'FORCE_PLATFORM_RERANK', 'RETRIEVAL_ARM_POLICY', 'RETRIEVAL_QUALITY_PROFILE',
    'AGENTIC_RAG_ENABLED', 'HYDE_ENABLED', 'GRAPHRAG_DRIFT_ENABLED', 'RAPTOR_ENABLED',
    'ADAPTIVE_RETRIEVAL_ENABLED', 'SEMANTIC_CACHE_KEY_VERSION',
  ];
  return createHash('sha256')
    .update(keys.map((key) => `${key}=${process.env[key] ?? ''}`).join(';'))
    .digest('hex')
    .slice(0, 16);
}

export interface RunMetadata {
  runId: string;
  gitCommit: string;
  timestamp: string;
  corpusVersion: string;
  /** Retrieval behaviour fingerprint + rerank input format version. */
  retrievalConfig: string;
  rerankTextFormat: string;
}

export function runMetadata(datasetPath: string): RunMetadata {
  return {
    runId: randomUUID(),
    gitCommit: gitCommitHash(),
    timestamp: new Date().toISOString(),
    corpusVersion: corpusFingerprint(datasetPath),
    retrievalConfig: retrievalFingerprint(),
    // Keep in sync with apps/api/src/chat/fusion-rerank.ts RERANK_TEXT_FORMAT_VERSION.
    rerankTextFormat: process.env.RERANK_TEXT_FORMAT_VERSION_OVERRIDE || 'v2',
  };
}
