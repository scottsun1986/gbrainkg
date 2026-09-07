import { Module } from '@nestjs/common';
import { GraphRagService } from './graph-rag.service';

@Module({
  providers: [GraphRagService],
  exports: [GraphRagService],
})
export class GraphRagModule {}
