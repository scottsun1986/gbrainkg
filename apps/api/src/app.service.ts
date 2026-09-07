import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { disconnectPrismaClient } from './prisma';

@Injectable()
export class AppService implements OnModuleDestroy {
  getHello(): string {
    return 'Hello World!';
  }

  async onModuleDestroy() {
    await disconnectPrismaClient();
  }
}
