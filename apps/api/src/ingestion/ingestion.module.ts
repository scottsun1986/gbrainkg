import { Module } from '@nestjs/common';
import { IngestionController } from './ingestion.controller';
import { KnowledgeBaseController } from './knowledge-base.controller';
import { PermissionModule } from '../permission/permission.module';
import { AuthModule } from '../auth/auth.module';
import { BrainCompilerModule } from '../brain-compiler/brain-compiler.module';
import { BullModule } from '@nestjs/bullmq';
import { IngestionService } from './ingestion.service';
import { IngestionProcessor } from './ingestion.processor';

@Module({
  imports: [PermissionModule, AuthModule, BrainCompilerModule, BullModule.registerQueue({ name: 'ingestion-queue' })],
  controllers: [IngestionController, KnowledgeBaseController],
  providers: [IngestionService, IngestionProcessor],
})
export class IngestionModule {}
