import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { PermissionModule } from '../permission/permission.module';
import { OpenApiModule } from '../open-api/open-api.module';
import { OpenApiRateLimitService } from '../open-api/open-api-rate-limit.service';

@Module({
  imports: [
    AuthModule,
    ChatModule,
    PermissionModule,
    OpenApiModule,
  ],
  controllers: [McpController],
  providers: [McpService, OpenApiRateLimitService],
  exports: [McpService],
})
export class McpModule {}
