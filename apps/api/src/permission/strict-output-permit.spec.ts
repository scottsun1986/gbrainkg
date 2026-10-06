import { withStrictOutputPermit } from './strict-output-permit';

const tx = { $executeRaw: jest.fn(), $queryRaw: jest.fn() };
jest.mock('../prisma', () => ({ getPrismaClient: () => ({ $transaction: async (work: any) => work(tx) }) }));
const snapshot = { revision: '10', policyVersion: 'test', expiresAt: Infinity };
const manifest = [{ documentId: 'doc', versionId: 'version', number: 1, sourceHash: 'hash' }];

describe('strict output exact source barrier', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  it('checks source versions inside the lock even when the authority revision is unchanged', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ revision: 10n, policyVersion: 'test', active: true }]).mockResolvedValueOnce([{ readable: false }]);
    const emit = jest.fn();
    await expect(withStrictOutputPermit('user', snapshot, emit, manifest)).rejects.toThrow('Source evidence changed');
    expect(emit).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalled();
  });
  it('emits only after both authority and exact source barriers pass', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ revision: 10n, policyVersion: 'test', active: true }]).mockResolvedValueOnce([{ readable: true }]);
    const emit = jest.fn();
    await withStrictOutputPermit('user', snapshot, emit, manifest);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
