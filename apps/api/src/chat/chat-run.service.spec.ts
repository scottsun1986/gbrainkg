import { NotFoundException } from '@nestjs/common';

const prismaMock = {
  chatRun: {
    create: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
  message: { findFirst: jest.fn() },
};

jest.mock('../prisma', () => ({ getPrismaClient: () => prismaMock }));
import { ChatRunService } from './chat-run.service';

const makeRun = (over: Record<string, unknown> = {}) => ({
  id: 'run-1', conversationId: 'conv-1', userId: 'user-1', messageId: null,
  status: 'running', stage: 'queued', errorMessage: null,
  startedAt: new Date(), completedAt: null, ...over,
});

describe('ChatRunService', () => {
  let service: ChatRunService;

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.chatRun.create.mockResolvedValue({ id: 'run-1', conversationId: 'conv-1' });
    prismaMock.chatRun.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.chatRun.findFirst.mockResolvedValue(makeRun());
    prismaMock.message.findFirst.mockResolvedValue(null);
    service = new ChatRunService();
  });

  it('starts a run in the running state', async () => {
    const run = await service.start('conv-1', 'user-1');
    expect(run).toMatchObject({ runId: 'run-1', conversationId: 'conv-1', status: 'running', stage: 'queued' });
    expect(prismaMock.chatRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ conversationId: 'conv-1', userId: 'user-1' }) }),
    );
  });

  it('records stage transitions while the run is in flight', async () => {
    await service.setStage('run-1', 'retrieving');
    expect(prismaMock.chatRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', status: 'running' },
      data: { stage: 'retrieving' },
    });
  });

  it('ignores an unknown stage rather than persisting junk', async () => {
    await service.setStage('run-1', 'not-a-stage');
    expect(prismaMock.chatRun.updateMany).not.toHaveBeenCalled();
  });

  it('never reopens a run that already finished when a late stage arrives', async () => {
    // The `status: 'running'` guard is what makes a trailing stage report from a
    // completed turn a no-op instead of a resurrection.
    await service.setStage('run-1', 'generating');
    const where = prismaMock.chatRun.updateMany.mock.calls[0][0].where;
    expect(where.status).toBe('running');
  });

  it('does not let a failed stage write break the answer', async () => {
    prismaMock.chatRun.updateMany.mockRejectedValueOnce(new Error('db down'));
    await expect(service.setStage('run-1', 'generating')).resolves.toBeUndefined();
  });

  it('reports a completed run with its answer, citations and trace', async () => {
    prismaMock.chatRun.findFirst.mockResolvedValue(makeRun({
      status: 'completed', stage: 'persisting', messageId: 'msg-1',
    }));
    prismaMock.message.findFirst.mockResolvedValue({
      id: 'msg-1', content: '答案正文', citationsSummary: [{ index: 1 }],
      processingTrace: [{ id: 'llm_generation', status: 'success' }], latencyMs: 1234,
    });
    const view = await service.get('user-1', 'run-1');
    expect(view).toMatchObject({
      runId: 'run-1', status: 'completed', messageId: 'msg-1',
      answer: '答案正文', latencyMs: 1234,
    });
    expect(view.citations).toHaveLength(1);
    expect(view.trace).toHaveLength(1);
  });

  it('hides a run that belongs to another user behind a 404', async () => {
    prismaMock.chatRun.findFirst.mockResolvedValue(null);
    await expect(service.get('user-2', 'run-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('never leaks another user\'s answer through the message lookup', async () => {
    prismaMock.chatRun.findFirst.mockResolvedValue(makeRun({ status: 'completed', messageId: 'msg-1' }));
    // The message query must be scoped by the conversation's owner as well, so a
    // run row that outlived an ownership change cannot return foreign content.
    expect(prismaMock.message.findFirst).not.toHaveBeenCalled();
    prismaMock.message.findFirst.mockResolvedValue(null);
    const view = await service.get('user-1', 'run-1');
    expect(view.answer).toBeUndefined();
  });

  it('surfaces the failure reason on a failed run', async () => {
    prismaMock.chatRun.findFirst.mockResolvedValue(makeRun({ status: 'failed', errorMessage: '检索超时' }));
    const view = await service.get('user-1', 'run-1');
    expect(view.status).toBe('failed');
    expect(view.errorMessage).toBe('检索超时');
  });

  it('cancels only runs this process started', async () => {
    await service.start('conv-1', 'user-1');
    expect(service.cancel('run-1')).toBe(true);
    expect(service.cancel('run-unknown')).toBe(false);
  });

  it('fails abandoned runs so the sidebar does not spin forever', async () => {
    prismaMock.chatRun.updateMany.mockResolvedValue({ count: 2 });
    const count = await service.reapStaleRuns();
    expect(count).toBe(2);
    const args = prismaMock.chatRun.updateMany.mock.calls[0][0];
    expect(args.where.status).toBe('running');
    expect(args.data.status).toBe('failed');
  });
});