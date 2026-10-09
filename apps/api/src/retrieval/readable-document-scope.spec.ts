import { boundedReadSql, readableDocumentSql, readableDocumentWhere } from './readable-document-scope';
import { runWithRequestContext } from '../observability/request-context';

describe('readable document scope', () => {
  const db = {
    document: { findMany: jest.fn().mockResolvedValue([]) },
    userRole: { findMany: jest.fn().mockResolvedValue([{ roleId: 'role' }]) },
    userOrg: { findMany: jest.fn().mockResolvedValue([{ orgNodeId: 'org' }]) },
  };
  it('applies ACL and time inside the database predicate before pagination', async () => {
    const predicate = await runWithRequestContext({ requestId: 'test', userId: 'reader', asOf: 1000 }, () => readableDocumentWhere(db));
    expect(predicate.AND[0].AND[0].OR[1].effectiveFrom.lte).toEqual(new Date(1000));
    const options = predicate.AND[1].OR;
    expect(options).toContainEqual({ aclMode: { not: 'restricted' }, aclEntries: { none: {} } });
    expect(options[3].aclEntries.some.OR).toContainEqual({ subjectType: 'role', subjectId: { in: ['role'] } });
    expect(options[3].aclEntries.some.OR).toContainEqual({ subjectType: 'org', subjectId: { in: ['org'] } });
    expect(options.slice(0, 2)).toEqual([{ kb: { ownerUserId: 'reader' } }, { kb: { admins: { some: { userId: 'reader' } } } }]);
  });
  it('rejects stale, revoked and cross-KB derived sources before pagination using the same client', async () => {
    const candidates = [
      {id:'good',kbId:'kb',parserMetadata:{qa:{sourceDocumentId:'live',sourceVersionId:'v1'}}},
      {id:'stale',kbId:'kb',parserMetadata:{qa:{sourceDocumentId:'live',sourceVersionId:'old'}}},
      {id:'revoked',kbId:'kb',parserMetadata:{qa:{sourceDocumentId:'hidden',sourceVersionId:'v1'}}},
      {id:'cross',kbId:'other',parserMetadata:{qa:{sourceDocumentId:'live',sourceVersionId:'v1'}}},
      {id:'manual',kbId:'kb',parserMetadata:{qa:{question:'Independent'}}},
    ];
    const findMany=jest.fn().mockResolvedValueOnce(candidates).mockResolvedValueOnce([{id:'live',kbId:'kb',activeVersionId:'v1'}]);
    const client={...db,document:{findMany}};
    const predicate=await readableDocumentWhere(client,'reader',['kb']);
    expect(predicate.AND[2]).toEqual({id:{notIn:['stale','revoked','cross']}});
    expect(findMany.mock.calls[0][0].where.AND[0]).toEqual({sourceType:'qa',kbId:{in:['kb']}});
    expect(findMany.mock.calls[1][0].where.AND[1]).toEqual(predicate.AND[0]);
    expect(findMany.mock.calls[1][0].where.AND[2]).toEqual(predicate.AND[1]);
  });
  it('compiles equivalent raw SQL without embedding user input into SQL text', () => {
    const sql = runWithRequestContext({ requestId: 'test', userId: "reader' OR true", asOf: 1000 }, readableDocumentSql);
    expect(sql.sql).toContain('"DocumentAcl"');
    expect(sql.sql).toContain('"UserRole"');
    expect(sql.sql).toContain('"effectiveTo"');
    expect(sql.sql).not.toContain("reader' OR true");
    expect(sql.values).toContain("reader' OR true");
  });
});


describe('server query deadline', () => {
  it('sets a transaction-local SQL timeout before executing the bounded statement', async () => {
    const query = readableDocumentSql();
    const raw = jest.fn().mockResolvedValueOnce([{ set_config: '75' }]).mockResolvedValueOnce([{ id: 'authorized' }]);
    const db = { $transaction: jest.fn(async (work: any) => work({ $queryRaw: raw })) };
    expect(await boundedReadSql(db, query, 75)).toEqual([{ id: 'authorized' }]);
    expect(raw.mock.calls[0][0].join('')).toContain("set_config('statement_timeout'");
    expect(raw.mock.calls[0][1]).toBe('75');
    expect(raw.mock.calls[1][0]).toBe(query);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 75, timeout: 1075 });
  });
});
