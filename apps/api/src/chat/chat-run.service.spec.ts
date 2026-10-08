import { NotFoundException } from '@nestjs/common';

const prismaMock = {
  chatRun: {
    create: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  message: { findFirst: jest.fn() },
  $executeRaw: jest.fn().mockResolvedValue(1),
};

jest.mock('../prisma', () => ({ getPrismaClient: () => prismaMock }));
jest.mock('../permission/authorization-revision', () => ({ authorizationEnforced: () => true }));
jest.mock('../permission/evidence-dependencies', () => ({ validateEvidenceDependencies: jest.fn() }));
import { validateEvidenceDependencies } from '../permission/evidence-dependencies';
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
    (validateEvidenceDependencies as jest.Mock).mockResolvedValue(true);
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

  it('redacts a completed answer, citations and trace after evidence access is revoked', async () => {
    const manifest = [{ documentId: 'doc-1', number: 1 }];
    prismaMock.chatRun.findFirst.mockResolvedValue(makeRun({ status: 'completed', messageId: 'msg-1' }));
    prismaMock.message.findFirst.mockResolvedValue({
      id: 'msg-1', content: 'Restricted answer', citationsSummary: [{ docId: 'doc-1' }],
      processingTrace: [{ summary: 'Restricted source excerpt' }], dependencyManifest: manifest,
    });
    (validateEvidenceDependencies as jest.Mock).mockResolvedValue(false);
    const view = await service.get('user-1', 'run-1');
    expect(validateEvidenceDependencies).toHaveBeenCalledWith('user-1', manifest);
    expect(view.answer).toBe('该回答的来源已失效或您已无权访问。');
    expect(view.citations).toEqual([]);
    expect(view.trace).toEqual([]);
    expect(view).not.toHaveProperty('dependencyManifest');
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

  it('does not overwrite a cancelled run when the pipeline finishes late', async () => {
    // P0-2: cancel() writes status='failed'; if complete() then wrote
    // unconditionally the user would be told "stopped" while a full answer sat
    // in the database. The guard is what makes the first write win.
    await service.start('conv-1', 'user-1');
    await service.fail('run-1', '用户已停止生成。');
    await service.complete('run-1', 'msg-1');
    const completeCall = prismaMock.chatRun.updateMany.mock.calls.at(-1)![0];
    expect(completeCall.where).toEqual({ id: 'run-1', status: 'running' });
  });

  it('prunes finished runs past the retention window but never a running one', async () => {
    prismaMock.chatRun.deleteMany = jest.fn().mockResolvedValue({ count: 7 });
    const count = await service.pruneOldRuns(1000);
    expect(count).toBe(7);
    const where = prismaMock.chatRun.deleteMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['completed', 'failed'] });
    expect(where.completedAt).toBeDefined();
    // A running row is still being polled; deleting it would strand the sidebar.
    expect(where.status).not.toContain('running');
  });

  it('skips pruning when retention is disabled', async () => {
    prismaMock.chatRun.deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    expect(await service.pruneOldRuns(0)).toBe(0);
    expect(prismaMock.chatRun.deleteMany).not.toHaveBeenCalled();
  });

  it('reaps abandoned runs on a schedule, not only at first boot', () => {
    // P0-1: the reaper existed but nothing called it, so a crashed run left the
    // sidebar spinning until the next restart. Wiring it to the module lifecycle
    // is the fix; assert the hook is actually installed.
    const previous = process.env.CHAT_RUN_REAP_INTERVAL_MS;
    process.env.CHAT_RUN_REAP_INTERVAL_MS = '60000';
    try {
      service.onModuleInit();
      service.onModuleDestroy();
    } finally {
      if (previous === undefined) delete process.env.CHAT_RUN_REAP_INTERVAL_MS;
      else process.env.CHAT_RUN_REAP_INTERVAL_MS = previous;
    }
    expect(prismaMock.chatRun.updateMany).toHaveBeenCalled();
  });

  it('fails abandoned runs so the sidebar does not spin forever', async () => {
    prismaMock.chatRun.updateMany.mockResolvedValue({ count: 2 });
    const count = await service.reapStaleRuns();
    expect(count).toBe(2);
    const args = prismaMock.chatRun.updateMany.mock.calls[0][0];
    expect(args.where.status).toBe('running');
    expect(args.data.status).toBe('failed');
  });
  it('does not reap a locally active run and requires an expired database lease', async () => {
    await service.start('conv-1', 'user-1');
    prismaMock.chatRun.updateMany.mockClear();
    await service.reapStaleRuns(1);
    const where = prismaMock.chatRun.updateMany.mock.calls[0][0].where;
    expect(where.id.notIn).toContain('run-1');
    expect(where.OR).toEqual([{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: expect.any(Date) } }]);
    service.onModuleDestroy();
  });

});


describe('owner-scoped browser timing ACK', () => {
  const messageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  beforeEach(() => jest.clearAllMocks());
  it('rejects another owner before writing any trace', async () => {
    prismaMock.message.findFirst.mockResolvedValue(null);
    await expect(new ChatRunService().recordClientTiming('user', messageId, { firstVisibleMs: 50, finalVisibleMs: 100 })).rejects.toThrow('Message not found');
    expect(prismaMock.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: messageId, role: 'assistant', conversation: { userId: 'user' } } }));
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });
  it('records client-clock measurements only after current source authorization', async () => {
    prismaMock.message.findFirst.mockResolvedValue({ id: messageId, dependencyManifest: ['source'] });
    (validateEvidenceDependencies as jest.Mock).mockResolvedValue(true);
    await expect(new ChatRunService().recordClientTiming('user', messageId, { firstVisibleMs: 50, finalVisibleMs: 100 })).resolves.toEqual({ recorded: true });
    const args = prismaMock.$executeRaw.mock.calls[0];
    expect(args[0].join(' ')).toContain('c."userId"=');
    expect(args.some((arg: any) => typeof arg === 'string' && arg.includes('client-performance'))).toBe(true);
  });
  it('denies revoked sources and invalid/negative client clocks', async () => {
    const service = new ChatRunService();
    await expect(service.recordClientTiming('user', messageId, { firstVisibleMs: -1, finalVisibleMs: 10 })).rejects.toThrow('Invalid client render timing');
    prismaMock.message.findFirst.mockResolvedValue({ id: messageId, dependencyManifest: ['source'] });
    (validateEvidenceDependencies as jest.Mock).mockResolvedValue(false);
    await expect(service.recordClientTiming('user', messageId, { firstVisibleMs: 1, finalVisibleMs: 10 })).rejects.toThrow('Message not found');
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });
});
