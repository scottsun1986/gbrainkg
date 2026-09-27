import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BrainCompilerService } from './brain-compiler.service';
import { BrainCompilerProcessor } from './brain-compiler.processor';
import { BrainScopeService } from './brain-scope.service';
import { BrainOutboxService } from './brain-outbox.service';
import { PermissionModule } from '../permission/permission.module';
import { ModelConfigModule } from '../model-config.module';
import { BrainBackupService } from './brain-backup.service';
import { brainAdapterProvider } from './brain-adapter.provider';

@Module({
  imports: [
    PermissionModule,
    ModelConfigModule,
    BullModule.registerQueue({
      name: 'dirty-compiler-queue',
    }, { name: 'enrichment-queue' }, { name: 'aux-enrichment-queue' }),
  ],
  providers: [
    brainAdapterProvider,
    BrainCompilerService,
    BrainCompilerProcessor,
    BrainScopeService,
    BrainOutboxService,
    BrainBackupService,
  ],
  exports: [
    brainAdapterProvider,
    BrainCompilerService,
    BrainScopeService,
    BrainOutboxService,
    BrainBackupService,
  ],
})
export class BrainCompilerModule {}
