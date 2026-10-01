import { createHash } from 'node:crypto';
import { getPrismaClient } from '../prisma';
import { withServiceContext } from '../db/tenant-context.service';
import { instanceIdentity } from '../observability/instance-identity';
import { getRequestContext } from '../observability/request-context';

export function modelArtifactKey(route: string, model: string, revision: string | undefined, input: unknown): string | null {
  if (!revision) return null;
  return createHash('sha256').update(JSON.stringify([instanceIdentity(),route,model,revision,input])).digest('hex');
}
export async function readModelArtifact(key: string | null): Promise<any | null> {
  if (!key || !getRequestContext()?.servicePrincipal) return null;
  try { return await withServiceContext(getPrismaClient(),async tx => {
    const rows = await tx.$queryRaw<Array<{ payload: any }>>`SELECT payload FROM "ModelArtifactCache" WHERE key=${key} AND "expiresAt">now()`;
    return rows[0]?.payload ?? null;
  }); } catch { return null; }
}
export async function saveModelArtifact(key: string | null, kind: string, payload: any): Promise<void> {
  if (!key || !getRequestContext()?.servicePrincipal || JSON.stringify(payload).length > 1024*1024) return;
  await withServiceContext(getPrismaClient(),async tx => {
    await tx.$executeRaw`INSERT INTO "ModelArtifactCache" (key,kind,payload,"expiresAt") VALUES (${key},${kind},${JSON.stringify(payload)}::jsonb,now()+interval '14 days') ON CONFLICT (key) DO NOTHING`;
  }).catch(() => undefined);
}
