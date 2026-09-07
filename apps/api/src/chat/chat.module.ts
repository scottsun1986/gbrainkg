import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { PermissionModule } from '../permission/permission.module';
import { BrainCompilerModule } from '../brain-compiler/brain-compiler.module';
import { AuthModule } from '../auth/auth.module';
import { ConversationController } from './conversation.controller';

import { GraphRagModule } from '../graph-rag/graph-rag.module';
import { weknoraClientProvider } from '../retrieval/weknora.provider';

@Module({
  imports: [PermissionModule, BrainCompilerModule, AuthModule, GraphRagModule],
  controllers: [ChatController, ConversationController],
  providers: [ChatService, weknoraClientProvider],
})
export class ChatModule {}
