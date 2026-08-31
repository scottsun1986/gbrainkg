import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BrainCompilerService } from './brain-compiler.service';
import { BrainCompilerProcessor } from './brain-compiler.processor';
import { BrainScopeService } from './brain-scope.service';
import { BrainOutboxService } from './brain-outbox.service';
import { PermissionModule } from '../permission/permission.module';

@Module({
  imports: [
    PermissionModule,
    BullModule.registerQueue({
      name: 'dirty-compiler-queue',
    }),
  ],
  providers: [
    BrainCompilerService,
    BrainCompilerProcessor,
    BrainScopeService,
    BrainOutboxService,
  ],
  exports: [
    BrainCompilerService,
    BrainScopeService,
    BrainOutboxService,
  ],
})
export class BrainCompilerModule {}
