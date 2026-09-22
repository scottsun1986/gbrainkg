import { Global, Module } from '@nestjs/common';
import { ModelConfigModule } from '../model-config.module';
import { EmbeddingService } from './embedding.service';
import { ChunkEmbeddingService } from './chunk-embedding.service';
import { HybridRetrievalService } from '../retrieval/hybrid-retrieval.service';

@Global()
@Module({
  imports: [ModelConfigModule],
  providers: [EmbeddingService, ChunkEmbeddingService, HybridRetrievalService],
  exports: [EmbeddingService, ChunkEmbeddingService, HybridRetrievalService],
})
export class EmbeddingModule {}
