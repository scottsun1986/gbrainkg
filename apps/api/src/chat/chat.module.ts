import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { ChatRunService } from './chat-run.service';
import { PermissionModule } from '../permission/permission.module';
import { BrainCompilerModule } from '../brain-compiler/brain-compiler.module';
import { AuthModule } from '../auth/auth.module';
import { ConversationController } from './conversation.controller';

import { GraphRagModule } from '../graph-rag/graph-rag.module';
import { RaptorModule } from '../raptor/raptor.module';
import { weknoraClientProvider } from '../retrieval/weknora.provider';
import { SemanticCacheService } from './semantic-cache.service';
import { AgenticRagService } from './agentic-rag.service';
import { LexicalIndexModule } from '../retrieval/lexical-index.module';

@Module({
  imports: [PermissionModule, BrainCompilerModule, AuthModule, GraphRagModule, RaptorModule, LexicalIndexModule],
  controllers: [ChatController, ConversationController],
  providers: [ChatService, ChatRunService, weknoraClientProvider, SemanticCacheService, AgenticRagService],
  exports: [ChatService, ChatRunService, SemanticCacheService, AgenticRagService],
})
export class ChatModule {}
