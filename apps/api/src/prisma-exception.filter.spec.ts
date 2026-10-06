import { databaseVisibilityFailure, PrismaExceptionFilter } from './prisma-exception.filter';

describe('database visibility error observation', () => {
  it('recognizes Prisma wrapped SQLSTATE without labeling every grant error RLS', () => {
    const error = Object.assign(new Error('Raw query failed'), { code: 'P2010', meta: { code: '42501', message: 'permission denied for table User' } });
    expect(databaseVisibilityFailure(error)).toEqual({ event: 'database_permission_denied', sqlState: '42501', prismaCode: 'P2010' });
    error.meta.message = 'new row violates row-level security policy for table User';
    expect(databaseVisibilityFailure(error)?.event).toBe('rls_policy_denied');
  });

  it('observes missing required relations without claiming they prove RLS', () => {
    expect(databaseVisibilityFailure(new Error('Inconsistent query result: Field user is required to return data, got `null` instead.')))
      .toEqual({ event: 'database_required_relation_missing' });
    expect(databaseVisibilityFailure(new Error('ordinary failure'))).toBeNull();
  });

  it('emits a bounded event, while retaining the generic 500 response', () => {
    const filter = new PrismaExceptionFilter();
    const log = jest.spyOn((filter as any).logger, 'error').mockImplementation(() => undefined);
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host = { switchToHttp: () => ({ getResponse: () => response }) };
    filter.catch(new Error('row-level security policy: sensitive query argument'), host as any);
    expect(log).toHaveBeenCalledWith({ event: 'rls_policy_denied', sqlState: '42501' });
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({ statusCode: 500, message: 'Internal server error' });
  });
});
