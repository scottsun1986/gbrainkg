import { createServer } from 'node:net';

/** Check before Nest initializes providers (which may mutate authorization). */
export async function assertStartupPortAvailable(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid API port: ${port}`);
  }
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === 'EADDRINUSE'
        ? `API port ${port} is already occupied; stop the duplicate process or use the existing service manager.`
        : `Cannot bind API port ${port}: ${error.message}`));
    });
    probe.listen(port, '0.0.0.0', () => probe.close((error) => error ? reject(error) : resolve()));
  });
}
