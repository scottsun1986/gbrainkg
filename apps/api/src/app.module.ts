import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { BullModule } from '@nestjs/bullmq';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ChatModule } from './chat/chat.module';
import { BrainCompilerModule } from './brain-compiler/brain-compiler.module';
import { PermissionModule } from './permission/permission.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { AuthModule } from './auth/auth.module';
import { ModelConfigModule } from './model-config.module';
import { KnowledgeGraphController } from './knowledge-graph.controller';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
      },
    }),
    ChatModule,
    BrainCompilerModule,
    PermissionModule,
    IngestionModule,
    AuthModule,
    ModelConfigModule,
  ],
  controllers: [AppController, AdminController, KnowledgeGraphController],
  providers: [AppService],
})
export class AppModule {}
