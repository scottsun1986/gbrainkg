import { Module } from '@nestjs/common';
import { IngestionController } from './ingestion.controller';
import { KnowledgeBaseController } from './knowledge-base.controller';
import { PermissionModule } from '../permission/permission.module';
import { AuthModule } from '../auth/auth.module';
import { BrainCompilerModule } from '../brain-compiler/brain-compiler.module';
import { GraphRagModule } from '../graph-rag/graph-rag.module';
import { RaptorModule } from '../raptor/raptor.module';
import { BullModule } from '@nestjs/bullmq';
import { IngestionService } from './ingestion.service';
import { IngestionProcessor } from './ingestion.processor';
import { EnrichmentProcessor } from './enrichment.processor';

@Module({
  imports: [PermissionModule, AuthModule, BrainCompilerModule, GraphRagModule, RaptorModule,
    BullModule.registerQueue({ name: 'ingestion-queue' }, { name: 'enrichment-queue' })],
  controllers: [IngestionController, KnowledgeBaseController],
  providers: [IngestionService, IngestionProcessor, EnrichmentProcessor],
  exports: [IngestionService],
})
export class IngestionModule {}
