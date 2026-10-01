import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthorizationSnapshot } from '../permission/authorization-revision';
import type { QueryExecution } from '../retrieval/query-execution';
import type { EvidenceDependency } from '../permission/evidence-dependencies';

/**
 * Per-request correlation context. Populated by the request-id middleware and
 * consumed by the JSON logger so every record can carry requestId/userId/route
 * without threading those values through every call site.
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
  method?: string;
  route?: string;
  startedAt?: number;
  authorization?: AuthorizationSnapshot;
  asOf?: number;
  asOfExplicit?: boolean;
  instanceId?: string;
  execution?: QueryExecution;
  cancellation?: AbortSignal;
  servicePrincipal?: string;
  artifactInputs?: string;
  evidenceDependencies?: EvidenceDependency[] | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Best-effort update (e.g. once auth guard attaches req.user). */
export function setRequestContextUser(userId: string | undefined): void {
  const ctx = storage.getStore();
  if (ctx && userId) ctx.userId = userId;
}
