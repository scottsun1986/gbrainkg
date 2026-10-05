import { LexicalIndexService } from './lexical-index.service';
const unindex = jest.fn();
jest.mock('./lexical-index-store', () => ({ unindexDocument: (...args: any[]) => unindex(...args) }));
jest.mock('../prisma', () => ({ getPrismaClient: () => ({}) }));
describe('Lexical cleanup maintenance', () => {
  afterEach(() => { delete process.env.LEXICAL_INDEX_ENABLED; jest.clearAllMocks(); });
  it('strict deletion cleans existing postings even if serving channel is disabled', async () => {
    process.env.LEXICAL_INDEX_ENABLED = 'false'; unindex.mockResolvedValue({ removed: 1, terms: 2 });
    expect(await new LexicalIndexService().removeDocument('kb', 'doc', { strict: true })).toEqual({ removed: 1, terms: 2 });
    expect(unindex).toHaveBeenCalled();
  });
  it('strict failures propagate while ordinary deletion retains existing tolerance', async () => {
    unindex.mockRejectedValue(new Error('unindex unavailable'));
    const service = new LexicalIndexService();
    await expect(service.removeDocument('kb', 'doc', { strict: true })).rejects.toThrow('unindex unavailable');
    await expect(service.removeDocument('kb', 'doc')).resolves.toEqual({ removed: 0, terms: 0 });
  });
});
