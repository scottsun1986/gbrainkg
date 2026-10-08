import { withStrictOutputPermit, withStrictResourceOutput } from './strict-output-permit';
import { validateEvidenceDependenciesInClient } from './evidence-dependencies';

const tx = { $executeRaw: jest.fn(), $queryRaw: jest.fn() };
jest.mock('../prisma', () => ({ getPrismaClient: () => ({ $transaction: async (work: any) => work(tx) }) }));
jest.mock('./evidence-dependencies', () => ({ validateEvidenceDependenciesInClient: jest.fn() }));
const snapshot = { revision: '10', policyVersion: 'test', expiresAt: Infinity };
const manifest = [{ documentId: 'doc', versionId: 'version', number: 1, sourceHash: 'hash' }];

describe('strict output exact source barrier', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  it('checks source versions inside the lock even when the authority revision is unchanged', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ revision: 10n, policyVersion: 'test', active: true }]);
    (validateEvidenceDependenciesInClient as jest.Mock).mockResolvedValueOnce(false);
    const emit = jest.fn();
    await expect(withStrictOutputPermit('user', snapshot, emit, manifest)).rejects.toThrow('Source evidence changed');
    expect(emit).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalled();
  });
  it('emits only after both authority and exact source barriers pass', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ revision: 10n, policyVersion: 'test', active: true }]);
    (validateEvidenceDependenciesInClient as jest.Mock).mockResolvedValueOnce(true);
    const emit = jest.fn();
    await withStrictOutputPermit('user', snapshot, emit, manifest);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(validateEvidenceDependenciesInClient).toHaveBeenCalledWith('user', manifest, tx);
  });
  it('rejects a changed authority before consulting source evidence', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ revision: 11n, policyVersion: 'test', active: true }]);
    const emit = jest.fn();
    await expect(withStrictOutputPermit('user', snapshot, emit, manifest)).rejects.toThrow('Authorization changed');
    expect(validateEvidenceDependenciesInClient).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
  it('reads resource permissions and payload inside the fresh authorization lock before drain', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ revision: 10n, policyVersion: 'test', active: true }]);
    const read = jest.fn(async (client: any) => { expect(client).toBe(tx); expect(tx.$executeRaw).toHaveBeenCalled(); return { items: [] }; });
    const drain = jest.fn();
    await withStrictResourceOutput('user', snapshot, read, drain);
    expect(drain).toHaveBeenCalledWith({ items: [] });
    expect(validateEvidenceDependenciesInClient).not.toHaveBeenCalled();
  });
  it('never reads resource content after authority revocation', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ revision: 11n, policyVersion: 'test', active: true }]);
    const read = jest.fn(); const drain = jest.fn();
    await expect(withStrictResourceOutput('user', snapshot, read, drain)).rejects.toThrow('Authorization changed');
    expect(read).not.toHaveBeenCalled(); expect(drain).not.toHaveBeenCalled();
  });

});
