import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BrainCompilerService } from './brain-compiler.service';
import { BrainCompilerProcessor } from './brain-compiler.processor';
import { BrainScopeService } from './brain-scope.service';
import { BrainOutboxService } from './brain-outbox.service';
import { PermissionModule } from '../permission/permission.module';
import { ModelConfigModule } from '../model-config.module';
import { brainAdapterProvider } from './brain-adapter.provider';

@Module({
  imports: [
    PermissionModule,
    ModelConfigModule,
    BullModule.registerQueue({
      name: 'dirty-compiler-queue',
    }),
  ],
  providers: [
    brainAdapterProvider,
    BrainCompilerService,
    BrainCompilerProcessor,
    BrainScopeService,
    BrainOutboxService,
  ],
  exports: [
    brainAdapterProvider,
    BrainCompilerService,
    BrainScopeService,
    BrainOutboxService,
  ],
})
export class BrainCompilerModule {}
