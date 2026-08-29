import { Module } from '@nestjs/common';
import { IngestionController } from './ingestion.controller';
import { KnowledgeBaseController } from './knowledge-base.controller';
import { PermissionModule } from '../permission/permission.module';
import { AuthModule } from '../auth/auth.module';
import { BrainCompilerModule } from '../brain-compiler/brain-compiler.module';

@Module({
  imports: [PermissionModule, AuthModule, BrainCompilerModule],
  controllers: [IngestionController, KnowledgeBaseController],
})
export class IngestionModule {}
