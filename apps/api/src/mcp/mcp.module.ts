import { McpAuthenticationService, McpOriginGuard, McpUploadGuard } from './mcp-authentication';
import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { PermissionModule } from '../permission/permission.module';
import { OpenApiModule } from '../open-api/open-api.module';

import { IngestionModule } from '../ingestion/ingestion.module';

@Module({
  imports: [
    AuthModule,
    ChatModule,
    PermissionModule,
    OpenApiModule,
    IngestionModule,
  ],
  controllers: [McpController],
  providers: [McpService, McpAuthenticationService, McpOriginGuard, McpUploadGuard],
  exports: [McpService],
})
export class McpModule {}
