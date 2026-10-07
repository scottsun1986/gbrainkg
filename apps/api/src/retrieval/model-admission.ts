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
  const context = getRequestContext();
  if (process.env.CORE_AUTH_ENFORCE === '1' && !context?.servicePrincipal && (!context?.userId || !context.authorization)) throw new Error('Authorized model caller required');
  const execution = context?.execution;
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
  if (!Number.isFinite(inputTokens) || inputTokens < 0 || Math.ceil(inputTokens) > tokens) throw new Error('Invalid model input token allocation');
  // Authorization is application owned. The historical SQL helper still
  // checks obsolete RLS identity GUCs and cannot authorize current requests.
  const [row] = await getPrismaClient().$queryRaw<Array<{ admitted:boolean }>>`
    INSERT INTO "ModelQuotaBucket" (key,period,requests,tokens)
    VALUES (${key},floor(extract(epoch FROM clock_timestamp())/60)::bigint,1,${Math.ceil(inputTokens)}::bigint)
    ON CONFLICT (key,period) DO UPDATE
      SET requests="ModelQuotaBucket".requests+1,tokens="ModelQuotaBucket".tokens+EXCLUDED.tokens
      WHERE "ModelQuotaBucket".requests<${requests}::int AND "ModelQuotaBucket".tokens+EXCLUDED.tokens<=${tokens}::bigint
    RETURNING true AS admitted`;
  if (!row?.admitted) throw new Error('Instance model quota exhausted; retry next window');
}
