import { Test, TestingModule } from '@nestjs/testing';
import { BrainCompilerProcessor } from './brain-compiler.processor';
import { Job } from 'bullmq';

const mockPrisma = {
  brainRepo: {
    findUnique: jest.fn(),
  },
  brainTopic: {
    update: jest.fn(),
  }
};

const mockGbrainAdapter = {
  ingest: jest.fn(),
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma)
}));

jest.mock('@llmwiki/gbrain-adapter', () => ({
  BrainRepoAdapter: jest.fn().mockImplementation(() => mockGbrainAdapter)
}));

describe('BrainCompilerProcessor', () => {
  let processor: BrainCompilerProcessor;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BrainCompilerProcessor],
    }).compile();

    processor = module.get<BrainCompilerProcessor>(BrainCompilerProcessor);
    jest.clearAllMocks();
  });

  it('should process a dirty job through READ, GATHER, WRITE, SYNC', async () => {
    const mockJob = {
      data: {
        userId: 'user-1',
        topicSlug: '安全合规',
        source: 'knowledge_publish'
      }
    } as Job;

    // READ Mock
    mockPrisma.brainRepo.findUnique.mockResolvedValue({ id: 'repo-1', gitRepoUrl: '/tmp/repo' });
    
    // WRITE Mock
    mockGbrainAdapter.ingest.mockResolvedValue(undefined);
    
    // SYNC Mock
    mockPrisma.brainTopic.update.mockResolvedValue({});

    const result = await processor.process(mockJob);

    // 断言四个阶段都被正确调用
    expect(mockPrisma.brainRepo.findUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' }});
    expect(mockGbrainAdapter.ingest).toHaveBeenCalled();
    expect(mockPrisma.brainTopic.update).toHaveBeenCalledWith({
      where: { brainRepoId_topicSlug: { brainRepoId: 'repo-1', topicSlug: '安全合规' } },
      data: expect.objectContaining({ compileStatus: 'clean' })
    });
    expect(result).toEqual({ status: 'success', topicSlug: '安全合规' });
  });
});
