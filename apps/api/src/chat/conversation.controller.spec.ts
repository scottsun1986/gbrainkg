const mockPrisma = {
  conversation: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() },
  message: { findMany: jest.fn(), count: jest.fn() },
  // The list annotates each row with its in-flight run stage, so the sidebar
  // keeps its running markers after a reload.
  chatRun: { findMany: jest.fn().mockResolvedValue([]) },
};
jest.mock('../prisma', () => ({ getPrismaClient: () => mockPrisma }));

import { ConversationController } from './conversation.controller';

const USER = 'user-1';
type Page = { items: Array<{ id: string; title: string; createdAt: Date }>; nextCursor: string | null; hasMore: boolean };
const auth = { userIdFromRequest: jest.fn(async () => USER) } as any;
const controller = () => new ConversationController(auth);

/** Rows newest-first, `count` rows total. `take` is honoured so the controller's
 *  `limit + 1` over-fetch for hasMore can be simulated. */
function seed(rows: Array<{ id: string; title: string; createdAt: string }>) {
  mockPrisma.conversation.findMany.mockImplementation(async ({ take }: any) => rows.slice(0, take));
}
const row = (n: number) => ({
  id: `c${String(n).padStart(2, '0')}`,
  title: `会话 ${n}`,
  createdAt: `2026-10-0${n}T00:00:00.000Z`,
});

beforeEach(() => jest.clearAllMocks());

describe('GET /conversations pagination', () => {
  it('keeps the legacy bare-array response for clients that do not ask for a page', async () => {
    seed([row(3), row(2), row(1)]);
    const result = await controller().list({}, undefined, undefined, undefined);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
  });

  it('defaults to 30 rows and over-fetches one to detect hasMore', async () => {
    seed(Array.from({ length: 31 }, (_, i) => row(31 - i)));
    const page = (await controller().list({}, undefined, undefined, '1')) as Page;
    expect(page.items).toHaveLength(30);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('c02');
    expect(mockPrisma.conversation.findMany.mock.calls[0][0].take).toBe(31);
  });

  it('reports no more pages and a null cursor on the last page', async () => {
    seed([row(2), row(1)]);
    const page = (await controller().list({}, '30', undefined, '1')) as Page;
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('exposes a full page as a cursor even when there is nothing after it', async () => {
    seed([row(5), row(4), row(3)]);
    const page = (await controller().list({}, '3', undefined, '1')) as Page;
    expect(page.hasMore).toBe(false);
    // A full page always yields a cursor: only the next call discovers the end.
    expect(page.nextCursor).toBe('c03');
  });

  it('pages strictly before the cursor anchor, not by offset', async () => {
    seed([row(9)]);
    mockPrisma.conversation.findFirst.mockResolvedValue({ id: 'c05', createdAt: new Date('2026-10-05T00:00:00.000Z') });
    await controller().list({}, '30', 'c05', '1');
    const args = mockPrisma.conversation.findMany.mock.calls[0][0];
    expect(args.where.OR).toEqual([
      { createdAt: { lt: new Date('2026-10-05T00:00:00.000Z') } },
      { createdAt: new Date('2026-10-05T00:00:00.000Z'), id: { lt: 'c05' } },
    ]);
  });

  it('breaks ties on id when the anchor shares a timestamp with other rows', async () => {
    // createdAt is not unique: without the id tie-break a row with the same
    // timestamp would be skipped or repeated on every page turn.
    const ts = '2026-10-05T00:00:00.000Z';
    seed([{ id: 'c04', title: 't', createdAt: ts }]);
    mockPrisma.conversation.findFirst.mockResolvedValue({ id: 'c05', createdAt: new Date(ts) });
    await controller().list({}, '30', 'c05', '1');
    expect(mockPrisma.conversation.findMany.mock.calls[0][0].orderBy).toEqual([
      { createdAt: 'desc' }, { id: 'desc' },
    ]);
  });

  it('scopes every page to the requesting user', async () => {
    seed([row(1)]);
    (await controller().list({}, '30', undefined, '1')) as Page;
    expect(mockPrisma.conversation.findMany.mock.calls[0][0].where.userId).toBe(USER);
  });

  it('never leaks kbScope or other JSON columns into the list payload', async () => {
    seed([row(1)]);
    const page = (await controller().list({}, '30', undefined, '1')) as Page;
    expect(Object.keys(page.items[0]).sort()).toEqual(['createdAt', 'id', 'title']);
  });

  it('returns an empty page when the cursor names a conversation the user does not own', async () => {
    seed([row(1)]);
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    expect(await controller().list({}, '30', 'someone-elses', undefined)).toEqual([]);
    expect(mockPrisma.conversation.findMany).not.toHaveBeenCalled();
    const page = (await controller().list({}, '30', 'someone-elses', '1')) as Page;
    expect(page).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it('clamps the page size into a sane range', async () => {
    seed([]);
    await controller().list({}, '10000', undefined, '1');
    expect(mockPrisma.conversation.findMany.mock.calls[0][0].take).toBe(201);
    jest.clearAllMocks();
    seed([]);
    await controller().list({}, '0', undefined, '1');
    expect(mockPrisma.conversation.findMany.mock.calls[0][0].take).toBe(31);
    jest.clearAllMocks();
    seed([]);
    await controller().list({}, 'not-a-number', undefined, '1');
    expect(mockPrisma.conversation.findMany.mock.calls[0][0].take).toBe(31);
  });
});

describe('GET /conversations/:id payload', () => {
  const conversation = { id: 'c01', userId: USER, title: 't', createdAt: new Date() };

  it('omits the processing trace, which is hundreds of KB per answer', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue(conversation);
    mockPrisma.message.count.mockResolvedValue(2);
    mockPrisma.message.findMany.mockResolvedValue([
      { id: 'm1', role: 'user', content: '问', createdAt: new Date(), citationsSummary: null, processingTrace: [{ id: 'x' }] },
      {
        id: 'm2', role: 'assistant', content: '答', createdAt: new Date(),
        citationsSummary: [{ index: 1 }], processingTrace: [{ id: 'y' }], dependencyManifest: [{ documentId: 'd' }],
      },
    ]);
    const result = await controller().get({}, 'c01');
    for (const message of result.messages) {
      expect(message).not.toHaveProperty('processingTrace');
      expect(message).not.toHaveProperty('dependencyManifest');
    }
    expect(result.messages[1].content).toBe('答');
    expect(result.messages[1].citationsSummary).toEqual([{ index: 1 }]);
  });

  it('reports pagination metadata for message windows', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue(conversation);
    mockPrisma.message.count.mockResolvedValue(500);
    mockPrisma.message.findMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, role: 'user', content: 'x', createdAt: new Date(), citationsSummary: null })),
    );
    const result = await controller().get({}, 'c01', '5');
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('m4');
    expect(mockPrisma.message.findMany.mock.calls[0][0].take).toBe(5);
  });
});