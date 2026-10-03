import { createServer, Server } from 'node:net';
import { assertStartupPortAvailable } from './startup-port';

describe('API startup port guard', () => {
  let occupied: Server;
  afterEach(async () => {
    if (occupied?.listening) await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });
  it('rejects a duplicate listener before provider initialization', async () => {
    occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Missing port');
    await expect(assertStartupPortAvailable(address.port)).rejects.toThrow('already occupied');
    const port = address.port;
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await expect(assertStartupPortAvailable(port)).resolves.toBeUndefined();
  });
  it.each([0, -1, 65536, NaN, 1.5])('rejects invalid port %s', async (port) => {
    await expect(assertStartupPortAvailable(port)).rejects.toThrow('Invalid API port');
  });
});
