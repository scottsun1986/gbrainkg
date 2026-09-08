import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { PermissionModule } from '../permission/permission.module';
import { BrainCompilerModule } from '../brain-compiler/brain-compiler.module';
import { AuthModule } from '../auth/auth.module';
import { ConversationController } from './conversation.controller';

import { GraphRagModule } from '../graph-rag/graph-rag.module';
import { weknoraClientProvider } from '../retrieval/weknora.provider';
import { SemanticCacheService } from './semantic-cache.service';
import { AgenticRagService } from './agentic-rag.service';

@Module({
  imports: [PermissionModule, BrainCompilerModule, AuthModule, GraphRagModule],
  controllers: [ChatController, ConversationController],
  providers: [ChatService, weknoraClientProvider, SemanticCacheService, AgenticRagService],
  exports: [ChatService, SemanticCacheService, AgenticRagService],
})
export class ChatModule {}
