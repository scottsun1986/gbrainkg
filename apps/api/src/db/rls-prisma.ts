import type { PrismaClient } from '@prisma/client';
import { getRequestContext } from '../observability/request-context';

type Client = PrismaClient & Record<string, any>;

/**
 * Prisma's pool does not pin a connection to an HTTP request. Every standalone
 * operation therefore runs in a short transaction with transaction-local RLS
 * settings. Callback transactions are scoped once and use their tx client.
 * Background work (no request context) is the only implicit service scope.
 */
export function withRlsContext(base: PrismaClient): PrismaClient {
  const client = base as Client;
  const delegates = new Map<string, any>();
  let validation: Promise<void> | undefined;

  const validateRole = (): Promise<void> => {
    validation ??= (async () => {
      const rows = await client.$queryRawUnsafe<Array<{
        role: string; superuser: boolean; bypass: boolean; service: string | null; userId: string | null;
      }>>(`
        SELECT current_user AS role, r.rolsuper AS superuser,
               r.rolbypassrls AS bypass, current_setting('app.service', true) AS service,
               current_setting('app.user_id', true) AS "userId"
        FROM pg_roles r WHERE r.rolname = current_user
      `);
      const role = rows[0];
      if (!role || role.superuser || role.bypass || role.service === 'on' || role.userId) {
        throw new Error(`RLS runtime role is unsafe: ${role?.role || 'unknown'} (superuser=${role?.superuser}, bypass=${role?.bypass}, service=${role?.service}, userDefault=${Boolean(role?.userId)})`);
      }
    })();
    return validation;
  };

  const scoped = async <T>(fn: (tx: any) => Promise<T>, options?: Record<string, any>): Promise<T> => {
    await validateRole();
    const context = getRequestContext();
    const userId = context?.userId || '';
    const service = context ? 'off' : 'on';
    return client.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true), set_config('app.service', ${service}, true)`;
      return fn(tx);
    }, options ?? {
      maxWait: Number(process.env.RLS_TX_MAX_WAIT_MS || 20_000),
      timeout: Number(process.env.RLS_TX_TIMEOUT_MS || 30_000),
    });
  };

  return new Proxy(client, {
    get(target, prop) {
      if (prop === '$transaction') {
        return (fn: unknown, options?: Record<string, any>) => {
          if (typeof fn !== 'function') {
            throw new Error('RLS requires callback transactions; array transactions cannot carry per-transaction context');
          }
          return scoped(fn as (tx: any) => Promise<any>, options);
        };
      }
      if (typeof prop === 'string' && ['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe'].includes(prop)) {
        return (...args: any[]) => scoped((tx) => tx[prop](...args));
      }
      const value = Reflect.get(target, prop, target);
      if (typeof prop === 'string' && value && typeof value === 'object' && typeof value.findMany === 'function') {
        if (!delegates.has(prop)) {
          delegates.set(prop, new Proxy(value, {
            get(delegate, operation) {
              const method = Reflect.get(delegate, operation);
              return typeof method === 'function' && typeof operation === 'string'
                ? (...args: any[]) => scoped((tx) => tx[prop][operation](...args))
                : method;
            },
          }));
        }
        return delegates.get(prop);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaClient;
}
