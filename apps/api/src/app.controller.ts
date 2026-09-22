import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { AppService } from './app.service';
import { RedisService } from './redis/redis.service';
import { getPrismaClient } from './prisma';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly redisService: RedisService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Shallow liveness probe. Kept dependency-free so existing deploy probes
   * (deploy/healthcheck.sh, nginx, load balancers) keep working unchanged.
   */
  @Get('health')
  getHealth() {
    return { status: 'ok', service: 'api', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness probe: verifies PostgreSQL (`SELECT 1`) and Redis (PING).
   * Returns 200 only when both dependencies answer; otherwise 503 with the
   * per-dependency reason in JSON.
   */
  @Get('ready')
  async getReady() {
    const checks: Record<string, string> = {};

    try {
      const prisma = getPrismaClient();
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch (err) {
      checks.database = `error: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      const redisOk = await this.redisService.ping();
      checks.redis = redisOk ? 'ok' : 'error: ping failed';
    } catch (err) {
      checks.redis = `error: ${err instanceof Error ? err.message : String(err)}`;
    }

    const ready = Object.values(checks).every((value) => value === 'ok');
    const body = {
      status: ready ? 'ready' : 'error',
      checks,
      timestamp: new Date().toISOString(),
    };
    if (!ready) {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return body;
  }
}
