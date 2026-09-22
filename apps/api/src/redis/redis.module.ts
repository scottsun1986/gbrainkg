import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Global so any service can inject the shared Redis primitives without
 * threading an import through every feature module.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
