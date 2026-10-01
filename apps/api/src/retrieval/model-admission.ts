import { createHash } from 'node:crypto';
import { getPrismaClient } from '../prisma';
import { getRequestContext } from '../observability/request-context';
import { assertRequestAuthorization } from '../permission/authorization-revision';

export function modelQuotaRoute(route: string): string {
  const url = new URL(route);
  url.hash = ''; url.search = '';
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|embeddings|rerank|late-chunking|query)\/?$/, '').replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

/** Each isolated instance owns <= hostBudget/instances; all its API/worker processes share one DB counter. */
export async function admitModelCall(route: string, model: string, inputTokens: number): Promise<void> {
  await assertRequestAuthorization();
  const execution = getRequestContext()?.execution;
  if (execution && !execution.reserveModelCall(inputTokens)) throw new Error('Query model budget exhausted');
  if (!process.env.MODEL_HOST_RPM && !process.env.MODEL_HOST_INPUT_TPM) return;
  const instances = Number(process.env.HOST_INSTANCE_COUNT || 1);
  const requests = Math.floor(Number(process.env.MODEL_HOST_RPM || 600)/instances);
  const tokens = Math.floor(Number(process.env.MODEL_HOST_INPUT_TPM || 1000000)/instances);
  if (!Number.isInteger(instances) || instances<1 || !Number.isFinite(requests) || requests<1 || !Number.isFinite(tokens) || tokens<1) throw new Error('Invalid shared model quota allocation');
  // A shared gateway serves many model names; changing model must not multiply
  // the host allocation. An explicit resource ID can join gateway aliases.
  const resource = process.env.MODEL_QUOTA_RESOURCE_ID || new URL(modelQuotaRoute(route)).origin;
  const key = createHash('sha256').update(resource).digest('hex');
  const [row] = await getPrismaClient().$queryRaw<Array<{ admitted:boolean }>>`SELECT app_admit_model_call(${key},${requests}::int,${tokens}::bigint,${Math.ceil(inputTokens)}::int) AS admitted`;
  if (!row?.admitted) throw new Error('Instance model quota exhausted; retry next window');
}
