import { Test, TestingModule } from '@nestjs/testing';
import { ChatService } from './chat.service';
import { PermissionService } from '../permission/permission.service';
import { BrainCompilerService } from '../brain-compiler/brain-compiler.service';
import { lastValueFrom, toArray } from 'rxjs';

// Mocks
const mockPermissionService = {
  getVisibleKnowledgeBases: jest.fn(),
};

const mockCompilerService = {
  triggerLazyCompileAndWait: jest.fn(),
  ensureUserBrainRepo: jest.fn(),
};

const mockPrisma = {
  brainRepo: {
    findUnique: jest.fn(),
  },
  brainTopic: {
    findUnique: jest.fn(),
  },
  document: {
    findMany: jest.fn(),
  },
  message: {
    findMany: jest.fn(),
  },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma)
}));

jest.mock('@llmwiki/gbrain-adapter', () => ({
  BrainRepoAdapter: jest.fn().mockImplementation(() => ({
    query: jest.fn().mockResolvedValue({
      topics: ['数据合规'],
      answer: 'Compiled truth',
      citations: [{ topic: '数据合规', docId: 'doc-1', docTitle: '规则.md', snippet: 'Compiled truth' }],
    })
  }))
}));

describe('ChatService', () => {
  let service: ChatService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PermissionService, useValue: mockPermissionService },
        { provide: BrainCompilerService, useValue: mockCompilerService },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
    jest.clearAllMocks();
  });

  it('should stream chat and trigger lazy compile if topic is dirty', async () => {
    // 权限校验 mock
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(['kb-1']);
    
    // Brain repo mock
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ id: 'repo-1', gitRepoUrl: '/tmp/repo' });
    mockPrisma.document.findMany.mockResolvedValue([{ id: 'doc-1', kbId: 'kb-1', title: '规则.md' }]);
    
    // 模拟主题是 dirty 的，触发懒编译
    mockPrisma.brainTopic.findUnique.mockResolvedValue({ compileStatus: 'dirty' });
    mockCompilerService.triggerLazyCompileAndWait.mockResolvedValue(undefined);

    const stream$ = await service.handleChatStream('user-1', '测试问题');
    const events = await lastValueFrom(stream$.pipe(toArray()));

    // 验证懒编译被调用
    expect(mockCompilerService.triggerLazyCompileAndWait).toHaveBeenCalledWith('user-1', '数据合规');

    // 验证流式事件输出
    expect(events.some(e => (e.data as any).type === 'meta')).toBeTruthy();
    expect(events.some(e => (e.data as any).type === 'delta')).toBeTruthy();
    expect(events.some(e => (e.data as any).type === 'citation')).toBeTruthy();
    expect(events.some(e => (e.data as any).type === 'done')).toBeTruthy();
  });

  it('should preserve conversation context without sending stale assistant turns as live messages', async () => {
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(['kb-1']);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ id: 'repo-1', gitRepoUrl: '/tmp/repo' });
    mockPrisma.document.findMany.mockResolvedValue([{ id: 'doc-1', kbId: 'kb-1', title: '规则.md' }]);
    mockPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: '上一轮问题' },
      { role: 'assistant', content: '上一轮回答' },
      { role: 'user', content: '当前问题' },
    ]);
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const originalFetch = global.fetch;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"query":"当前问题"}' } }] }),
      })
      .mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      });
    (global as any).fetch = fetchMock;

    try {
      const stream$ = await service.handleChatStream('user-1', '当前问题', ['kb-1'], 'conversation-1');
      await lastValueFrom(stream$.pipe(toArray()));
      const requestBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(requestBody.messages.slice(1)).toEqual([{ role: 'user', content: '当前问题' }]);
      expect(requestBody.messages[0].content).toContain('上一轮问题');
      expect(requestBody.messages[0].content).toContain('上一轮回答');
      expect(requestBody.messages[0].content).toContain('Current compiled truth (authoritative)');
    } finally {
      (global as any).fetch = originalFetch;
      delete process.env.DEEPSEEK_API_KEY;
    }
  });
});
