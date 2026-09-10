import { Global, Module } from '@nestjs/common';
import { ModelConfigModule } from '../model-config.module';
import { EmbeddingService } from './embedding.service';
import { ChunkEmbeddingService } from './chunk-embedding.service';

@Global()
@Module({
  imports: [ModelConfigModule],
  providers: [EmbeddingService, ChunkEmbeddingService],
  exports: [EmbeddingService, ChunkEmbeddingService],
})
export class EmbeddingModule {}
