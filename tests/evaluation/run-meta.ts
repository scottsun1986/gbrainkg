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

export interface RunMetadata {
  runId: string;
  gitCommit: string;
  timestamp: string;
  corpusVersion: string;
}

export function runMetadata(datasetPath: string): RunMetadata {
  return {
    runId: randomUUID(),
    gitCommit: gitCommitHash(),
    timestamp: new Date().toISOString(),
    corpusVersion: corpusFingerprint(datasetPath),
  };
}
