const mockPrisma = { document: { findMany: jest.fn() } };
jest.mock('../prisma', () => ({ getPrismaClient: () => mockPrisma }));
jest.mock('./authorization-revision', () => ({ assertRequestAuthorization: jest.fn().mockResolvedValue(undefined) }));
import { assertRequestAuthorization } from './authorization-revision';
import { nonEvidenceManifest, validateEvidenceDependencies } from './evidence-dependencies';

describe('Evidence dependency manifests', () => {
  beforeEach(() => jest.clearAllMocks());
  it.each(['failure', 'refusal'] as const)('accepts explicit %s status after authorization', async outcome => {
    await expect(validateEvidenceDependencies('u', nonEvidenceManifest(outcome))).resolves.toBe(true);
    expect(assertRequestAuthorization).toHaveBeenCalled();
    expect(mockPrisma.document.findMany).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { kind: 'non_evidence', version: 2, outcome: 'failure' },
    { kind: 'non_evidence', version: 1, outcome: 'answer' }])('rejects missing or unknown provenance %p', async manifest => {
    await expect(validateEvidenceDependencies('u', manifest)).resolves.toBe(false);
  });
  it('does not permit status output after authorization fails', async () => {
    (assertRequestAuthorization as jest.Mock).mockRejectedValueOnce(new Error('Authorization expired'));
    await expect(validateEvidenceDependencies('u', nonEvidenceManifest('failure'))).rejects.toThrow('Authorization expired');
  });
});
