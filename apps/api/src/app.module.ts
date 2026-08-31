import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AdminController } from './admin.controller';
import { BullModule } from '@nestjs/bullmq';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ChatModule } from './chat/chat.module';
import { BrainCompilerModule } from './brain-compiler/brain-compiler.module';
import { PermissionModule } from './permission/permission.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { AuthModule } from './auth/auth.module';
import { ModelConfigModule } from './model-config.module';
import { KnowledgeGraphController } from './knowledge-graph.controller';
import { AuditModule } from './audit/audit.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: Number(process.env.RATE_LIMIT_MAX || 600),
    }]),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
        ...(process.env.REDIS_PASS ? { password: process.env.REDIS_PASS } : {}),
      },
    }),
    ChatModule,
    BrainCompilerModule,
    PermissionModule,
    IngestionModule,
    AuthModule,
    ModelConfigModule,
    AuditModule,
  ],
  controllers: [AppController, AdminController, KnowledgeGraphController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
