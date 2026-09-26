import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { GraphRagService } from './graph-rag.service';
import { GraphCommunityProcessor } from './graph-community.processor';

@Module({
  imports: [BullModule.registerQueue({ name: 'graph-community-queue' })],
  providers: [GraphRagService, GraphCommunityProcessor],
  exports: [GraphRagService],
})
export class GraphRagModule {}
