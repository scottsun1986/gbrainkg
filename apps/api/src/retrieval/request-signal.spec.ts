import { requestFetch } from './request-signal';
import { runWithRequestContext } from '../observability/request-context';
import { admitModelCall } from './model-admission';
jest.mock('./model-admission', () => ({ admitModelCall: jest.fn() }));

describe('model request cancellation boundary', () => {
  const previousFetch = global.fetch;
  beforeEach(() => { jest.clearAllMocks(); (admitModelCall as jest.Mock).mockResolvedValue(undefined); });
  afterEach(() => { global.fetch = previousFetch; });
  it('does not start a request already cancelled by its caller', async () => {
    global.fetch = jest.fn();
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(requestFetch('https://gateway.invalid/chat/completions',{ signal:controller.signal,body:'{"model":"m"}' },100)).rejects.toThrow('cancelled');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('preserves caller cancellation while reading a response body', async () => {
    const controller = new AbortController(); let upstreamSignal: AbortSignal;
    global.fetch = jest.fn(async (_url,init) => {
      upstreamSignal = init!.signal!;
      return { ok:true,json:()=>new Promise((_resolve,reject) => upstreamSignal.addEventListener('abort',()=>reject(upstreamSignal.reason),{ once:true })) } as any;
    });
    await runWithRequestContext({ requestId:'body-cancel' }, async () => {
      const response = await requestFetch('https://gateway.invalid/chat/completions',{ signal:controller.signal,body:'{"model":"m"}' },1000);
      const body = response.json(); controller.abort(new Error('stop body'));
      await expect(body).rejects.toThrow('stop body');
      expect(upstreamSignal!.aborted).toBe(true);
    });
  });
  it('checks admission before exposing evidence to a provider', async () => {
    global.fetch = jest.fn(); (admitModelCall as jest.Mock).mockRejectedValue(new Error('quota exhausted'));
    await expect(requestFetch('https://gateway.invalid/chat/completions',{ body:'{"model":"m"}' },100)).rejects.toThrow('quota exhausted');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
