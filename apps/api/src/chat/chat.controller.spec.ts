import { concat, of, throwError, Observable } from 'rxjs';
import { ChatController } from './chat.controller';

const mockPrisma = {
  conversation: { create: jest.fn(), findFirst: jest.fn() },
  message: { create: jest.fn(), update: jest.fn() },
  citation: { createMany: jest.fn() },
};
jest.mock('../prisma', () => ({ getPrismaClient: () => mockPrisma }));

describe('Chat completion message identity', () => {
  it.each([true, false])('persists failure status without source data (stream=%s)', async stream => {
    jest.clearAllMocks();
    mockPrisma.conversation.create.mockResolvedValue({ id: 'conversation-1' });
    mockPrisma.message.create.mockResolvedValueOnce({ id: 'question-1' }).mockResolvedValueOnce({ id: 'answer-1' });
    mockPrisma.message.update.mockResolvedValue({});
    const service = {
      assertRequestedScopeAuthorized: jest.fn(),
      handleChatStream: jest.fn().mockResolvedValue(concat(of(
        { data: { type: 'delta', content: 'Partial source-backed answer' } },
        { data: { type: 'citation', timeline_entry: { document_id: 'd', snippet: 'private source' } } },
        { data: { type: 'trace', node: { id: 'gbrain_retrieval', summary: 'private source' } } },
      ), throwError(() => new Error('Query execution deadline exhausted')))),
    };
    const runs = { start: jest.fn().mockResolvedValue({ runId: 'run-1' }), complete: jest.fn(), fail: jest.fn() };
    const controller = new ChatController(service as any,
      { userIdFromRequest: async () => 'user-1' } as any,
      runs as any);
    let resolveEnd!: () => void;
    const ended = new Promise<void>(resolve => { resolveEnd = resolve; });
    const response = { setHeader: jest.fn(), flushHeaders: jest.fn(), writableEnded: false,
      status: jest.fn().mockReturnValue({ json: jest.fn() }), write: jest.fn(), end: () => resolveEnd() };
    await controller.streamCompletions({ message: 'Question', kb_scope: ['kb-1'], stream }, { on: jest.fn() }, response as any);
    await ended;
    const saved = mockPrisma.message.create.mock.calls[1][0].data;
    expect(saved.content).toBe('问答处理失败：Query execution deadline exhausted');
    expect(saved.citationsSummary).toEqual([]);
    expect(saved.dependencyManifest).toEqual({ kind: 'non_evidence', version: 1, outcome: 'failure' });
    expect(saved.processingTrace.every((node: any) => ['message_persistence', 'pipeline_timing'].includes(node.id))).toBe(true);
    expect(mockPrisma.citation.createMany).not.toHaveBeenCalled();
    if (!stream) expect(runs.fail).toHaveBeenCalledWith('run-1', '问答处理失败：Query execution deadline exhausted');
    expect(runs.complete).not.toHaveBeenCalled();
  });
  it('fails and cancels an oversized strict stream without escaping an async rejection', async () => {
    const previousStrict = process.env.KNOWLEDGE_STRICT_OUTPUT;
    const previousAuth = process.env.CORE_AUTH_ENFORCE;
    process.env.KNOWLEDGE_STRICT_OUTPUT = '1'; process.env.CORE_AUTH_ENFORCE = '1';
    try {
      jest.clearAllMocks();
      mockPrisma.conversation.create.mockResolvedValue({ id: 'conversation-1' });
      mockPrisma.message.create.mockResolvedValueOnce({ id: 'question-1' }).mockResolvedValueOnce({ id: 'answer-1' });
      mockPrisma.message.update.mockResolvedValue({});
      const cancelled = jest.fn();
      const source = new Observable(subscriber => {
        subscriber.next({ data: { type: 'delta', content: 'x'.repeat(8 * 1024 * 1024) } });
        return cancelled;
      });
      const service = { assertRequestedScopeAuthorized: jest.fn(), handleChatStream: jest.fn().mockResolvedValue(source) };
      const controller = new ChatController(service as any, { userIdFromRequest: async () => 'user-1' } as any, { start: jest.fn(), complete: jest.fn(), fail: jest.fn() } as any);
      let finish!: () => void;
      const ended = new Promise<void>(resolve => { finish = resolve; });
      const response = { writableEnded: false, setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: finish };
      await controller.streamCompletions({ message: 'Question', stream: true }, { on: jest.fn() }, response as any);
      await ended;
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(mockPrisma.message.create.mock.calls[1][0].data.content).toContain('安全输出容量');
      expect(mockPrisma.message.create.mock.calls[1][0].data.citationsSummary).toEqual([]);
    } finally {
      if (previousStrict === undefined) delete process.env.KNOWLEDGE_STRICT_OUTPUT; else process.env.KNOWLEDGE_STRICT_OUTPUT = previousStrict;
      if (previousAuth === undefined) delete process.env.CORE_AUTH_ENFORCE; else process.env.CORE_AUTH_ENFORCE = previousAuth;
    }
  });
  it('records an empty provider completion as failure rather than a successful run', async () => {
    jest.clearAllMocks();
    mockPrisma.conversation.create.mockResolvedValue({ id: 'conversation-1' });
    mockPrisma.message.create.mockResolvedValueOnce({ id: 'question-1' }).mockResolvedValueOnce({ id: 'answer-1' });
    mockPrisma.message.update.mockResolvedValue({});
    const runs = { start: jest.fn().mockResolvedValue({ runId: 'run-1' }), complete: jest.fn(), fail: jest.fn() };
    const service = { assertRequestedScopeAuthorized: jest.fn(), handleChatStream: jest.fn().mockResolvedValue(of({ data: { type: 'done' } })) };
    const controller = new ChatController(service as any, { userIdFromRequest: async () => 'user-1' } as any, runs as any);
    let finish!: () => void;
    const ended = new Promise<void>(resolve => { finish = resolve; });
    const response = { writableEnded: false, status: jest.fn().mockReturnValue({ json: jest.fn() }), write: jest.fn(), end: finish };
    await controller.streamCompletions({ message: 'Question', stream: false }, { on: jest.fn() }, response as any);
    await ended;
    expect(runs.complete).not.toHaveBeenCalled();
    expect(runs.fail).toHaveBeenCalledWith('run-1', expect.stringContaining('未生成可用回答'));
    expect(mockPrisma.message.create.mock.calls[1][0].data.dependencyManifest).toEqual({ kind: 'non_evidence', version: 1, outcome: 'failure' });
  });
  it('returns the persisted assistant ID only after persistence finishes', async () => {
    jest.clearAllMocks();
    mockPrisma.conversation.create.mockResolvedValue({ id: 'conversation-1' });
    mockPrisma.message.create.mockResolvedValueOnce({ id: 'question-1' })
      .mockResolvedValueOnce({ id: 'answer-1' });
    mockPrisma.message.update.mockResolvedValue({});
    const service = {
      assertRequestedScopeAuthorized: jest.fn(),
      handleChatStream: jest.fn().mockResolvedValue(of(
        { data: { type: 'delta', content: 'Answer' } },
        { data: { type: 'done', total_tokens: 3 } },
      )),
    };
    const controller = new ChatController(
      service as any,
      { userIdFromRequest: async () => 'user-1' } as any,
      { start: jest.fn(), complete: jest.fn(), fail: jest.fn() } as any,
    );
    const events: any[] = [];
    let resolveEnd!: () => void;
    const ended = new Promise<void>(resolve => { resolveEnd = resolve; });
    const response = {
      setHeader: jest.fn(), flushHeaders: jest.fn(), writableEnded: false,
      write: (raw: string) => { events.push(JSON.parse(raw.slice(6))); },
      end: () => { resolveEnd(); },
    };
    await controller.streamCompletions({ message: 'Question', kb_scope: ['kb-1'] }, { on: jest.fn() }, response as any);
    await ended;
    const done = events.filter(event => event.type === 'done');
    expect(done).toEqual([expect.objectContaining({ message_id: 'answer-1', total_tokens: 3 })]);
    expect(mockPrisma.message.create.mock.calls[1][0].data.content).toBe('Answer');
  });
});


describe('Native knowledge search depth', () => {
  const makeController = () => {
    const service = { searchKnowledgeForAgent: jest.fn().mockResolvedValue({ results: [] }) };
    return { service, controller: new ChatController(service as any,
      { userIdFromRequest: async () => 'user-1' } as any, {} as any) };
  };

  it.each([100, 101, 10000])('allows bounded deep search for limit %s with the original identity and scope', async requested => {
    const { service, controller } = makeController();
    await controller.searchKnowledge({} as any, { query: 'question', kb_scope: ['authorized-kb'], limit: requested });
    expect(service.searchKnowledgeForAgent).toHaveBeenCalledWith('user-1', 'question', ['authorized-kb'], 100);
  });

  it('keeps the default depth', async () => {
    const { service, controller } = makeController();
    await controller.searchKnowledge({} as any, { query: 'question' });
    expect(service.searchKnowledgeForAgent).toHaveBeenCalledWith('user-1', 'question', undefined, 10);
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])('rejects invalid limit %s before retrieval', async limit => {
    const { service, controller } = makeController();
    await expect(controller.searchKnowledge({} as any, { query: 'question', limit })).rejects.toThrow('positive integer');
    expect(service.searchKnowledgeForAgent).not.toHaveBeenCalled();
  });

  it('preserves scope-denial errors at deeper limits', async () => {
    const { service, controller } = makeController();
    service.searchKnowledgeForAgent.mockRejectedValue(new Error('forbidden scope'));
    await expect(controller.searchKnowledge({} as any,
      { query: 'question', kb_scope: ['denied-kb'], limit: 100 })).rejects.toThrow('forbidden scope');
  });
});
