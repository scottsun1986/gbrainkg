import AdmZip = require('adm-zip');
import { BadRequestException } from '@nestjs/common';
import { IngestionController } from './ingestion.controller';

const mockPrisma = {
  knowledgeBase: {
    findUnique: jest.fn(),
  },
  document: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

jest.mock('../prisma', () => ({
  getPrismaClient: jest.fn(() => mockPrisma),
}));

describe('IngestionController', () => {
  let controller: IngestionController;
  let mockPermissionService: any;
  let mockAuthService: any;
  let mockCompilerService: any;
  let mockIngestionService: any;
  let mockObjectStorage: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockObjectStorage = {
      put: jest.fn().mockResolvedValue({ provider: 'local', objectKey: 'raw/test', size: 1, sha256: 'x' }),
    };

    mockPermissionService = {
      getVisibleKnowledgeBases: jest.fn().mockResolvedValue(['kb-1']),
      canManageKnowledgeBase: jest.fn().mockResolvedValue(true),
    };

    mockAuthService = {
      userIdFromRequest: jest.fn().mockResolvedValue('user-1'),
    };

    mockCompilerService = {
      onKnowledgeDeleted: jest.fn().mockResolvedValue(undefined),
    };

    mockIngestionService = {
      enqueue: jest.fn().mockResolvedValue(undefined),
    };

    mockPrisma.knowledgeBase.findUnique.mockResolvedValue({
      id: 'kb-1',
      type: 'department',
      ownerUserId: 'user-1',
      orgNodeId: null,
      status: 'active',
    });

    mockPrisma.document.create.mockImplementation(({ data }: any) => {
      return Promise.resolve({
        ...data,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    controller = new IngestionController(
      mockPermissionService,
      mockAuthService,
      mockCompilerService,
      mockIngestionService,
      mockObjectStorage,
    );
  });

  describe('uploadDocument with normal file', () => {
    it('successfully uploads and enqueues a single markdown file', async () => {
      const file = {
        originalname: 'readme.md',
        buffer: Buffer.from('# Hello Knowledge Base'),
        size: 22,
      };

      const res = await controller.uploadDocument('kb-1', file, {} as any);

      expect(res.status).toBe('accepted');
      expect(res.documents.length).toBe(1);
      expect(res.documents[0].title).toBe('readme.md');
      expect(mockPrisma.document.create).toHaveBeenCalledTimes(1);
      expect(mockIngestionService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('rejects unsupported file extension', async () => {
      const file = {
        originalname: 'virus.exe',
        buffer: Buffer.from('binary-content'),
        size: 14,
      };

      await expect(
        controller.uploadDocument('kb-1', file, {} as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('uploadDocument with archive file', () => {
    it('unzips, extracts valid documents, enqueues each, and does not persist the zip itself', async () => {
      const zip = new AdmZip();
      zip.addFile('guide.md', Buffer.from('# User Guide\nHow to use.'));
      zip.addFile('data.csv', Buffer.from('col1,col2\nval1,val2'));
      zip.addFile('__MACOSX/._guide.md', Buffer.from('junk-meta'));
      zip.addFile('.DS_Store', Buffer.from('ds-store'));
      zip.addFile('run.sh', Buffer.from('echo hello'));

      const zipBuffer = zip.toBuffer();
      const file = {
        originalname: 'bulk-docs.zip',
        buffer: zipBuffer,
        size: zipBuffer.length,
      };

      const res = await controller.uploadDocument('kb-1', file, {} as any);

      expect(res.status).toBe('accepted');
      expect(res.isArchive).toBe(true);
      expect(res.total).toBe(2);
      expect(res.documents.length).toBe(2);

      const titles = res.documents.map((d: any) => d.title);
      expect(titles).toContain('guide.md');
      expect(titles).toContain('data.csv');
      // The zip file itself must not be created as a document
      expect(titles).not.toContain('bulk-docs.zip');

      // Prisma document.create called twice (once for each extracted file)
      expect(mockPrisma.document.create).toHaveBeenCalledTimes(2);

      // IngestionService.enqueue called twice (parsed one by one)
      expect(mockIngestionService.enqueue).toHaveBeenCalledTimes(2);
    });

    it('rejects an archive that contains no supported files', async () => {
      const zip = new AdmZip();
      zip.addFile('main.py', Buffer.from('print("hi")'));
      zip.addFile('package.json', Buffer.from('{}'));

      const zipBuffer = zip.toBuffer();
      const file = {
        originalname: 'code-only.zip',
        buffer: zipBuffer,
        size: zipBuffer.length,
      };

      await expect(
        controller.uploadDocument('kb-1', file, {} as any),
      ).rejects.toThrow(/未包含有效且受支持的文档/);
    });
  });
});
