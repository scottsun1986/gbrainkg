import { of } from 'rxjs';
import { ChatController } from './chat.controller';

const mockPrisma = {
  conversation: { create: jest.fn(), findFirst: jest.fn() },
  message: { create: jest.fn(), update: jest.fn() },
  citation: { createMany: jest.fn() },
};
jest.mock('../prisma', () => ({ getPrismaClient: () => mockPrisma }));

describe('Chat completion message identity', () => {
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
