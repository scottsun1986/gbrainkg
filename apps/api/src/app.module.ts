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
import { GraphRagModule } from './graph-rag/graph-rag.module';
import { RaptorModule } from './raptor/raptor.module';
import { EmbeddingModule } from './embedding/embedding.module';
import { OpenApiModule } from './open-api/open-api.module';
import { McpModule } from './mcp/mcp.module';
import { SystemReprocessService } from './system-reprocess.service';
import { RedisModule } from './redis/redis.module';
import { DbModule } from './db/db.module';
import { TenantContextService } from './db/tenant-context.service';
import { ObservabilityModule } from './observability/observability.module';
import { DocumentAclController } from './permission/document-acl.controller';
import { ConnectorModule } from './connector/connector.module';
import { ExperimentsModule } from './experiments/experiments.module';
import { VersionChainModule } from './ingestion/version-chain.module';

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
        db: Number(process.env.REDIS_DB || 0),
        ...(process.env.REDIS_PASS ? { password: process.env.REDIS_PASS } : {}),
      },
    }),
    BullModule.registerQueue({ name: 'enrichment-queue' }),
    RedisModule,
    ChatModule,
    BrainCompilerModule,
    PermissionModule,
    IngestionModule,
    AuthModule,
    ModelConfigModule,
    AuditModule,
    GraphRagModule,
    RaptorModule,
    EmbeddingModule,
    OpenApiModule,
    McpModule,
    ObservabilityModule,
    DbModule,
    ConnectorModule, ExperimentsModule,
    VersionChainModule,
  ],
  controllers: [AppController, AdminController, KnowledgeGraphController, DocumentAclController],
  providers: [
    AppService,
    SystemReprocessService,
    TenantContextService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
