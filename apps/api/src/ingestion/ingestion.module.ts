import { KnowledgeOperationsService } from './knowledge-operations.service';
import { DocumentLifecycleService } from './document-lifecycle.service';
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
import { AuxiliaryEnrichmentProcessor } from './auxiliary-enrichment.processor';
import { LexicalIndexModule } from '../retrieval/lexical-index.module';
import { StorageModule } from '../storage/storage.module';
import { VersionChainModule } from './version-chain.module';

@Module({
  imports: [PermissionModule, AuthModule, BrainCompilerModule, GraphRagModule, RaptorModule, LexicalIndexModule, StorageModule, VersionChainModule,
    BullModule.registerQueue({ name: 'ingestion-queue' }, { name: 'enrichment-queue' }, { name: 'aux-enrichment-queue' })],
  controllers: [IngestionController, KnowledgeBaseController],
  providers: [KnowledgeOperationsService, DocumentLifecycleService, IngestionService, IngestionProcessor, EnrichmentProcessor, AuxiliaryEnrichmentProcessor],
  exports: [IngestionService, DocumentLifecycleService, KnowledgeOperationsService],
})
export class IngestionModule {}
