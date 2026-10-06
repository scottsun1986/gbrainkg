import { isAbsolute, join, resolve } from 'node:path';

/** All new local artifacts share one root. Historical absolute DB pointers remain valid. */
export function uploadRoot(): string {
  return resolve(process.env.UPLOAD_ROOT || '/tmp/llmwiki/uploads');
}

export function resolveUploadPath(path: string): string {
  return isAbsolute(path) ? path : join(uploadRoot(), path);
}
