import { Module } from '@nestjs/common';
import { OpenApiController } from './open-api.controller';
import { OpenApiGuard } from './open-api.guard';
import { OpenApiRateLimitService } from './open-api-rate-limit.service';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { PermissionModule } from '../permission/permission.module';
import { BrainCompilerModule } from '../brain-compiler/brain-compiler.module';
import { IngestionModule } from '../ingestion/ingestion.module';

@Module({
  imports: [
    AuthModule,
    ChatModule,
    PermissionModule,
    BrainCompilerModule,
    IngestionModule,
  ],
  controllers: [OpenApiController],
  providers: [OpenApiRateLimitService, OpenApiGuard],
  exports: [OpenApiGuard],
})
export class OpenApiModule {}
