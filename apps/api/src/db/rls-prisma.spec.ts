import { runWithRequestContext, setRequestContextUser } from '../observability/request-context';
import { withRlsContext } from './rls-prisma';

function fixture(role: { superuser?: boolean; bypass?: boolean; service?: string | null } = {}) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    document: { findMany: jest.fn().mockResolvedValue([{ id: 'doc' }]) },
  };
  const base = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{
      role: 'llmwiki_app', superuser: false, bypass: false, service: null, ...role,
    }]),
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<any>) => fn(tx)),
    document: { findMany: jest.fn() },
  };
  return { prisma: withRlsContext(base as any), base, tx };
}

describe('RLS Prisma context', () => {
  it('scopes user queries to a transaction-local user and disables service mode', async () => {
    const { prisma, tx, base } = fixture();
    await runWithRequestContext({ requestId: 'req-1' }, async () => {
      setRequestContextUser('user-1');
      await prisma.document.findMany();
    });
    expect(base.document.findMany).not.toHaveBeenCalled();
    expect(tx.document.findMany).toHaveBeenCalled();
    expect(tx.$executeRaw.mock.calls[0].slice(1,3)).toEqual(['user-1', 'off']);
  });

  it('fails closed for a request without an authenticated user', async () => {
    const { prisma, tx } = fixture();
    await runWithRequestContext({ requestId: 'req-2' }, () => prisma.document.findMany());
    expect(tx.$executeRaw.mock.calls[0].slice(1,3)).toEqual(['', 'off']);
  });

  it('propagates the same historical instant into the RLS transaction', async () => {
    const { prisma, tx } = fixture();
    const asOf = Date.parse('2025-03-01T02:00:00+08:00');
    await runWithRequestContext({ requestId: 'historical', userId: 'user-1', asOf }, () => prisma.document.findMany());
    // GUC 与超时合并为单条 set_config 语句（每查询省一次 DB 往返）：
    // 参数依次为 user_id / service / as_of / statement_timeout / lock_timeout。
    const params = tx.$executeRaw.mock.calls[0].slice(1);
    expect(params.slice(0, 3)).toEqual(['user-1', 'off', '2025-02-28T18:00:00.000Z']);
    expect(Number(params[3])).toBeGreaterThan(0);
    expect(Number(params[4])).toBeGreaterThan(0);
  });

  it('missing context never grants a service identity', async () => {
    const { prisma, tx } = fixture();
    await prisma.document.findMany();
    expect(tx.$executeRaw.mock.calls[0].slice(1,3)).toEqual(['', 'off']);
  });
  it('grants only an explicit worker principal', async () => {
    const { prisma, tx } = fixture();
    await runWithRequestContext({ requestId: 'worker', servicePrincipal: 'enrichment' }, () => prisma.document.findMany());
    expect(tx.$executeRaw.mock.calls[0].slice(1,3)).toEqual(['', 'on']);
  });

  it('rejects a BYPASSRLS role before any tenant query', async () => {
    const { prisma, tx } = fixture({ bypass: true });
    await expect(prisma.document.findMany()).rejects.toThrow(/unsafe/);
    expect(tx.document.findMany).not.toHaveBeenCalled();
  });

  it('rejects the legacy service-on role default', async () => {
    const { prisma } = fixture({ service: 'on' });
    await expect(prisma.document.findMany()).rejects.toThrow(/unsafe/);
  });

  it('keeps callback transactions on one scoped client', async () => {
    const { prisma, tx, base } = fixture();
    await runWithRequestContext({ requestId: 'tx', userId: 'user-2' }, () =>
      prisma.$transaction(async (client) => client.document.findMany()),
    );
    expect(base.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.calls[0].slice(1,3)).toEqual(['user-2', 'off']);
    expect(tx.document.findMany).toHaveBeenCalledTimes(1);
  });

  it('rejects array transactions that cannot preserve a single RLS context', () => {
    const { prisma } = fixture();
    expect(() => (prisma as any).$transaction([])).toThrow(/callback transactions/);
  });
});
