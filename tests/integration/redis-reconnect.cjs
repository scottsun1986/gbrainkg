// Three real OS processes and a disposable Redis server; never uses application Redis.
const assert = require('node:assert/strict');
const { fork, spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv[2] === 'peer') {
  const { RedisService } = require('../../apps/api/dist/redis/redis.service');
  const service = new RedisService();
  let cache = true, messages = 0, resets = 0;
  (async () => {
    await service.subscribe('permission-cache-invalidation', () => { cache = false; messages++; }, () => { cache = false; resets++; });
    process.send({ ready: true });
  })().catch(error => { process.send({ error: error.message }); process.exitCode = 1; });
  process.on('message', async request => {
    try {
      if (request.action === 'seed') cache = true;
      if (request.action === 'publish') await service.publish('permission-cache-invalidation', { userId: 'reader', instanceId: service.getInstanceId() });
      if (request.action === 'disconnect') service.subscriberClient.disconnect();
      if (request.action === 'connect') await service.subscriberClient.connect();
      if (request.action === 'quit') { await service.onModuleDestroy(); process.disconnect(); }
      else process.send({ id: request.id, cache, messages, resets });
    } catch (error) { process.send({ id: request.id, error: error.message }); }
  });
} else {
  async function main() {
    const directory = await mkdtemp(join(tmpdir(), 'gbrain-redis-fault-'));
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    let server; const peers = []; let sequence = 0;
    const native = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0;
    const containerName = `gbrain-redis-fault-${process.pid}`;
    if (!native && spawnSync('docker', ['image', 'inspect', 'redis:7-alpine'], { stdio: 'ignore' }).status !== 0) throw new Error('Need local redis-server or already installed redis:7-alpine image; no downloads attempted');
    const start = async () => {
      server = native
        ? spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--dir', directory, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
        : spawn('docker', ['run', '--rm', '--pull', 'never', '--name', containerName, '--memory', '64m', '-p', `127.0.0.1:${port}:6379`, 'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
      for (let i = 0; i < 100; i++) {
        const ready = await new Promise(resolve => { const socket = net.connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
        if (ready) return;
        await sleep(20);
      }
      throw new Error('Disposable Redis did not start');
    };
    const stop = async () => {
      const old = server; server = null;
      await new Promise(resolve => {
        old.once('exit', resolve);
        if (native) old.kill('SIGTERM');
        else { const stopper=spawn('docker',['stop','-t','1',containerName],{stdio:'ignore'}); stopper.on('error',resolve); }
      });
    };
    const create = db => new Promise((resolve, reject) => {
      const peer = fork(__filename, ['peer'], { env: { ...process.env, REDIS_HOST: '127.0.0.1', REDIS_PORT: String(port), REDIS_DB: String(db), REDIS_PASS: '', REDIS_KEY_PREFIX: 'fault-test' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      peers.push(peer);
      const timer = setTimeout(() => reject(new Error('Peer startup timeout')), 10000);
      peer.once('message', message => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(peer); });
    });
    const call = (peer, action) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { peer.off('message', handler); reject(new Error(`${action} timeout`)); }, 10000);
      const handler = result => { if (result.id !== id) return; clearTimeout(timer); peer.off('message', handler); result.error ? reject(new Error(result.error)) : resolve(result); };
      peer.on('message', handler); peer.send({ id, action });
    });
    const until = async (peer, predicate) => { for (let i=0;i<100;i++) { const state=await call(peer,'state'); if(predicate(state)) return state; await sleep(30); } throw new Error('Recovery condition timeout'); };
    try {
      await start();
      const [publisher, same, isolated] = await Promise.all([create(0), create(0), create(1)]);
      await Promise.all(peers.map(peer => call(peer, 'seed')));
      await call(publisher, 'publish');
      await until(same, state => !state.cache && state.messages === 1);
      assert.equal((await call(isolated, 'state')).cache, true, 'logical DB1 must not receive DB0 messages');
      const before = (await call(same, 'state')).resets;
      await call(same, 'disconnect');
      await until(same, state => state.resets > before);
      await call(same, 'seed');
      await call(publisher, 'publish'); // Deliberately missed while disconnected.
      assert.equal((await call(same, 'state')).cache, true);
      await call(same, 'connect');
      await until(same, state => !state.cache && state.resets > before);
      await stop(); await sleep(200); await start();
      await until(same, state => state.resets > before + 2);
      await call(same, 'seed');
      await call(publisher, 'publish');
      await until(same, state => !state.cache && state.messages >= 2);
      console.log(JSON.stringify({ same_db_broadcast: true, cross_db_isolation: true, missed_message_cache_reset: true, server_restart_resubscribe: true, processes: 3 }));
    } finally {
      for (const peer of peers) { if (peer.connected) peer.send({ action: 'quit' }); }
      await sleep(100);
      for (const peer of peers) if (!peer.killed) peer.kill('SIGKILL');
      if (server) await stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
