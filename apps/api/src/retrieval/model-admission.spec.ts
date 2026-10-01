import { admitModelCall, modelQuotaRoute } from './model-admission';
const query = jest.fn();
jest.mock('../prisma', () => ({ getPrismaClient: () => ({ $queryRaw:(...args:unknown[]) => query(...args) }) }));
jest.mock('../permission/authorization-revision', () => ({ assertRequestAuthorization: jest.fn().mockResolvedValue(undefined) }));

describe('shared model host allocation', () => {
  const previous = { ...process.env };
  afterEach(() => { process.env= { ...previous }; query.mockReset(); });
  it('normalizes operation paths consistently', () => {
    expect(modelQuotaRoute('https://gateway.invalid/v1/chat/completions')).toBe(modelQuotaRoute('https://gateway.invalid/v1'));
    expect(modelQuotaRoute('https://gateway.invalid/v1/embeddings')).toBe(modelQuotaRoute('https://gateway.invalid/v1'));
  });
  it('shares one counter across model names and divides allocation by instance count', async () => {
    process.env.MODEL_HOST_RPM='100';process.env.MODEL_HOST_INPUT_TPM='10000';process.env.HOST_INSTANCE_COUNT='10';
    query.mockResolvedValue([{ admitted:true }]);
    await admitModelCall('https://gateway.invalid/v1/chat/completions','chat',100);
    await admitModelCall('https://gateway.invalid/v1/embeddings','embedding',100);
    expect(query.mock.calls[0][1]).toBe(query.mock.calls[1][1]);
    expect(query.mock.calls[0].slice(2)).toEqual([10,1000,100]);
  });
  it('rejects malformed quota configuration and exhausted allocation', async () => {
    process.env.MODEL_HOST_RPM='1';process.env.HOST_INSTANCE_COUNT='10';
    await expect(admitModelCall('https://gateway.invalid/v1','m',1)).rejects.toThrow('Invalid');
    process.env.MODEL_HOST_RPM='100';query.mockResolvedValue([{ admitted:false }]);
    await expect(admitModelCall('https://gateway.invalid/v1','m',1)).rejects.toThrow('quota exhausted');
  });
});
