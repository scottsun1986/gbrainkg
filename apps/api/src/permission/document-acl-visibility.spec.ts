import { NotFoundException } from '@nestjs/common';
import { DocumentAclController } from './document-acl.controller';
import { getPrismaClient } from '../prisma';

jest.mock('../db/tenant-context.service', () => ({
  runAsAuth: async (work: any) => work(require('../prisma').getPrismaClient()),
}));

const prisma = getPrismaClient();
const documentId = '33333333-3333-4333-8333-333333333333';
const kbId = '44444444-4444-4444-8444-444444444444';

describe('document ACL visibility boundary', () => {
  const documentAcl = {
    isDocumentReadable: jest.fn(async () => true),
    canManageAcl: jest.fn(async () => true),
    list: jest.fn(async () => []),
    replace: jest.fn(async () => []),
    add: jest.fn(async () => ({}) as any),
    remove: jest.fn(async () => ({}) as any),
  };
  const permission = { getVisibleKnowledgeBases: jest.fn(async () => [kbId]) };
  let controller: DocumentAclController;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(prisma.document, 'findUnique').mockImplementation((async () => ({
      id: documentId, kbId, aclMode: 'inherit',
    })) as any);
    permission.getVisibleKnowledgeBases.mockResolvedValue([kbId]);
    controller = new DocumentAclController(documentAcl as any, permission as any);
  });

  it('serves the ACL to a user who can see the knowledge base', async () => {
    await expect(controller.list(documentId, { user: { id: 'user-1' } } as any)).resolves.toMatchObject({ aclMode: 'inherit' });
  });

  it('hides the document behind 404 when its knowledge base is not visible', async () => {
    // A 403 here would confirm the id exists and belongs to someone else.
    permission.getVisibleKnowledgeBases.mockResolvedValue([]);
    await expect(controller.list(documentId, { user: { id: 'user-2' } } as any)).rejects.toThrow(NotFoundException);
  });

  it('applies the same boundary to ACL management entry points', async () => {
    permission.getVisibleKnowledgeBases.mockResolvedValue([]);
    await expect(controller.subjects(documentId, { user: { id: 'user-2' } } as any, 'user', 'x')).rejects.toThrow(NotFoundException);
    await expect(controller.replace(documentId, { user: { id: 'user-2' } } as any, { aclMode: 'inherit', entries: [] } as any)).rejects.toThrow(NotFoundException);
  });

  it('still answers 404 for an unknown document id', async () => {
    jest.spyOn(prisma.document, 'findUnique').mockImplementation((async () => null) as any);
    await expect(controller.list(documentId, { user: { id: 'user-1' } } as any)).rejects.toThrow(NotFoundException);
  });
});