import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

export interface OpenApiRateLimitResult {
  allowed: boolean;
  /** 超限时建议客户端等待的秒数（向上取整，至少 1 秒）；允许通过时为 0 */
  retryAfterSec: number;
}

/**
 * open-api 凭证级限流（进程内滑动窗口，无需 Redis）。
 *
 * 按 appId 维护窗口内的请求时间戳队列：每次 check 先剔除滑出窗口的旧时间戳，
 * 再判断窗口内请求数是否达到上限。窗口固定 60 秒，上限由环境变量
 * OPENAPI_RATE_LIMIT_PER_MIN 控制（默认 120）。
 *
 * 通过 onModuleInit 启动定期清理定时器，回收长时间不活跃 appId 的空队列，
 * 防止 Map 无限增长导致内存泄漏（定时器模式参考 chat/semantic-cache.service.ts）。
 */
@Injectable()
export class OpenApiRateLimitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OpenApiRateLimitService.name);
  private readonly windowMs = 60_000;
  private readonly maxPerWindow = Math.max(
    1,
    Number(process.env.OPENAPI_RATE_LIMIT_PER_MIN || 120) || 120,
  );
  /** appId -> 窗口内请求时间戳（毫秒，升序）队列 */
  private readonly hits = new Map<string, number[]>();
  private cleanupTimer?: NodeJS.Timeout;

  /** 每分钟允许的请求上限，供 429 错误消息展示 */
  get limitPerMinute(): number {
    return this.maxPerWindow;
  }

  onModuleInit(): void {
    // 定期清扫：删除队列为空的 appId，避免长期运行后 Map 无限膨胀
    const intervalMs = Number(
      process.env.OPENAPI_RATE_LIMIT_CLEANUP_INTERVAL_MS || 300_000,
    );
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, intervalMs);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /**
   * 记录一次请求并判断是否放行。
   * @param key 凭证标识（appId）
   */
  check(key: string): OpenApiRateLimitResult {
    const now = Date.now();

    let timestamps = this.hits.get(key);
    if (!timestamps) {
      timestamps = [];
      this.hits.set(key, timestamps);
    }

    // 剔除滑出窗口的旧时间戳
    while (timestamps.length > 0 && now - timestamps[0] >= this.windowMs) {
      timestamps.shift();
    }

    if (timestamps.length >= this.maxPerWindow) {
      // 距离窗口内最早一次请求满 60 秒还需等待的时间
      const retryAfterMs = this.windowMs - (now - timestamps[0]);
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    timestamps.push(now);
    return { allowed: true, retryAfterSec: 0 };
  }

  /** 清理窗口外时间戳，并回收空队列（防内存泄漏） */
  cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.hits) {
      while (timestamps.length > 0 && now - timestamps[0] >= this.windowMs) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.hits.delete(key);
      }
    }
  }
}
