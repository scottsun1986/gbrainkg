import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { PermissionModule } from '../permission/permission.module';
import { BrainCompilerModule } from '../brain-compiler/brain-compiler.module';
import { AuthModule } from '../auth/auth.module';
import { ConversationController } from './conversation.controller';

@Module({
  imports: [PermissionModule, BrainCompilerModule, AuthModule],
  controllers: [ChatController, ConversationController],
  providers: [ChatService],
})
export class ChatModule {}
