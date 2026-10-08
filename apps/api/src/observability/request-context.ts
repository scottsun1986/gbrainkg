import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChatTiming } from './chat-timing';
import type { AuthorizationSnapshot } from '../permission/authorization-revision';
import type { QueryExecution } from '../retrieval/query-execution';
import type { EvidenceManifest } from '../permission/evidence-dependencies';

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
  evidenceDependencies?: EvidenceManifest | null;
  chatTiming?: ChatTiming;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Run work with NO request context. Background kicks triggered from HTTP
 * handlers (e.g. outbox dispatch) must drop the caller's identity before
 * promoting themselves to a service principal — runAsService rejects any
 * promotion while a non-service request context is active.
 */
export function runOutsideRequestContext<T>(fn: () => T): T {
  return storage.exit(fn);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Best-effort update (e.g. once auth guard attaches req.user). */
export function setRequestContextUser(userId: string | undefined): void {
  const ctx = storage.getStore();
  if (ctx && userId) ctx.userId = userId;
}
