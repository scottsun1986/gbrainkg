import { EventEmitter } from 'node:events';
import { RedisService } from './redis.service';

describe('Redis pub/sub replica isolation', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });

  function client() {
    const bus = new EventEmitter() as any;
    bus.connect = jest.fn().mockResolvedValue(undefined);
    bus.publish = jest.fn().mockResolvedValue(1);
    bus.subscribe = jest.fn(async (channel: string) => {
      // Simulate a publisher racing with the subscription acknowledgement.
      bus.emit('message', channel, 'invalidation');
      return 1;
    });
    return bus;
  }

  it('namespaces channels by logical Redis DB, which Redis itself does not do', async () => {
    process.env.REDIS_KEY_PREFIX = 'shared';
    const bus = client();
    process.env.REDIS_DB = '0';
    const first = new RedisService();
    process.env.REDIS_DB = '1';
    const second = new RedisService();
    jest.spyOn(first as any, 'newClient').mockResolvedValue(bus);
    jest.spyOn(second as any, 'newClient').mockResolvedValue(bus);
    await first.publish('acl', { userId: 'u' });
    await second.publish('acl', { userId: 'u' });
    expect(bus.publish.mock.calls.map((args: any[]) => args[0])).toEqual(['shared:db:0:acl', 'shared:db:1:acl']);
  });

  it('receives messages sent immediately after the subscription ack', async () => {
    const bus = client();
    const service = new RedisService();
    jest.spyOn(service as any, 'newClient').mockResolvedValue(bus);
    const handler = jest.fn();
    await service.subscribe('acl', handler);
    expect(handler).toHaveBeenCalledWith('invalidation');
  });

  it('shares one subscriber connection when subscriptions start concurrently', async () => {
    const service = new RedisService();
    const create = jest.spyOn(service as any, 'newClient').mockResolvedValue(client());
    await Promise.all([service.subscribe('a', jest.fn()), service.subscribe('b', jest.fn())]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('retires consumer caches on disconnect and reconnect after missed broadcasts', async () => {
    const bus = client();
    const service = new RedisService();
    jest.spyOn(service as any, 'newClient').mockResolvedValue(bus);
    const reset = jest.fn();
    await service.subscribe('acl', jest.fn(), reset);
    bus.emit('close'); bus.emit('ready');
    expect(reset).toHaveBeenCalledTimes(2);
  });
});
