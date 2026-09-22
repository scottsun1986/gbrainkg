import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttl?: number, flag?: string): Promise<any>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numberOfKeys: number, ...args: any[]): Promise<any>;
  quit(): Promise<any>;
  on(event: string, handler: (...args: any[]) => void): any;
  status?: string;
};

/**
 * Shared Redis access for cross-instance state.
 *
 * The audit lists several multi-instance defects that all have the same root
 * cause: caches, debounce timers and single-flight guards lived in one process.
 * This service exposes the three primitives needed to fix them:
 *
 *   getJson/setJson  - L2 cache shared by every instance of an instance group
 *   withLock         - distributed mutex (RAPTOR debounce, background rebuilds)
 *   singleflight     - one computation per key even when N requests race
 *
 * Every method degrades to a no-op when Redis is unreachable, so a Redis
 * outage costs cache hits and extra work, never correctness or availability.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: RedisLike | null = null;
  private connecting = false;
  private available = false;
  private readonly prefix = process.env.REDIS_KEY_PREFIX || 'llmwiki';

  private async connect(): Promise<RedisLike | null> {
    if (this.client) return this.client;
    if (this.connecting) return null;
    this.connecting = true;
    try {
      const { default: Redis } = await import('ioredis');
      const client = new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT || 6379),
        db: Number(process.env.REDIS_DB || 0),
        ...(process.env.REDIS_PASS ? { password: process.env.REDIS_PASS } : {}),
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        enableOfflineQueue: true,
        retryStrategy: (times: number) => Math.min(times * 500, 5000),
      }) as unknown as RedisLike;
      client.on?.('error', (err: Error) => {
        this.available = false;
        this.logger.debug(`Redis error (degrading to local-only behaviour): ${err.message}`);
      });
      client.on?.('ready', () => {
        this.available = true;
      });
      this.client = client;
      const anyClient = client as any;
      if (typeof anyClient.connect === 'function') {
        try {
          await anyClient.connect();
        } catch (connErr) {
          this.logger.debug(`Redis connect: ${connErr instanceof Error ? connErr.message : String(connErr)}`);
        }
      }
      this.available = true;
      return client;
    } catch (err) {
      this.logger.warn(
        `Redis unavailable (${err instanceof Error ? err.message : String(err)}); shared cache and distributed locks are disabled.`,
      );
      this.client = null;
      return null;
    } finally {
      this.connecting = false;
    }
  }

  /** True when a Redis round trip is currently possible. */
  async ping(): Promise<boolean> {
    const client = await this.connect();
    if (!client) return false;
    try {
      // Prefer the native PING; fall back to SET for stubs that only implement get/set.
      const anyClient = client as any;
      if (typeof anyClient.ping === 'function') {
        await anyClient.ping();
      } else {
        await client.set(`${this.prefix}:health`, '1', 'EX', 30);
      }
      this.available = true;
      return true;
    } catch (err) {
      this.available = false;
      this.logger.debug(`Redis ping failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available && this.client !== null;
  }

  private key(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const client = await this.connect();
    if (!client) return null;
    try {
      const raw = await client.get(this.key(key));
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.debug(`Redis GET failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const client = await this.connect();
    if (!client) return;
    try {
      await client.set(this.key(key), JSON.stringify(value), 'EX', Math.max(1, Math.floor(ttlSeconds)));
    } catch (err) {
      this.logger.debug(`Redis SET failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async del(key: string): Promise<void> {
    const client = await this.connect();
    if (!client) return;
    try {
      await client.del(this.key(key));
    } catch {
      // ignore
    }
  }

  /**
   * Run `fn` while holding a distributed lock. Returns null when another
   * instance holds it (the caller should treat that as "someone else is doing
   * this work"). The lock is released only by its owner.
   */
  async withLock<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<{ acquired: boolean; value?: T }> {
    const client = await this.connect();
    if (!client) {
      // No Redis: behave exactly like the single-process implementation.
      return { acquired: true, value: await fn() };
    }
    const token = randomUUID();
    const lockKey = this.key(`lock:${key}`);
    let acquired = false;
    try {
      const result = await client.set(lockKey, token, 'PX', Math.max(1000, Math.floor(ttlMs)), 'NX');
      acquired = result === 'OK' || result === true;
    } catch {
      return { acquired: true, value: await fn() };
    }
    if (!acquired) return { acquired: false };
    try {
      const value = await fn();
      return { acquired: true, value };
    } finally {
      await client
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          lockKey,
          token,
        )
        .catch(() => undefined);
    }
  }

  /**
   * Single-flight: identical concurrent work shares one result. The fresh
   * result is also stored in the shared cache so the other instances stop
   * recomputing it.
   */
  async cachedSingleFlight<T>(
    key: string,
    ttlSeconds: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.getJson<T>(key);
    if (cached !== null && cached !== undefined) return cached;
    const { acquired, value } = await this.withLock(`sf:${key}`, 60_000, async () => {
      const second = await this.getJson<T>(key);
      if (second !== null && second !== undefined) return second;
      const computed = await fn();
      if (computed !== null && computed !== undefined) {
        await this.setJson(key, computed, ttlSeconds);
      }
      return computed;
    });
    if (acquired && value !== undefined) return value as T;
    // Another instance is computing: briefly wait for its result.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const retried = await this.getJson<T>(key);
      if (retried !== null && retried !== undefined) return retried;
    }
    return fn();
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client?.quit();
    } catch {
      // ignore
    }
    this.client = null;
  }
}
