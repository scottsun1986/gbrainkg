import { Module } from '@nestjs/common';
import { LexicalIndexService } from './lexical-index.service';

/**
 * Shares the PostgreSQL full-corpus BM25 channel between the request path
 * (ChatModule) and the ingestion/enrichment pipeline (IngestionModule) so both
 * sides use the same tokenizer, SQL and enablement switch.
 */
@Module({
  providers: [LexicalIndexService],
  exports: [LexicalIndexService],
})
export class LexicalIndexModule {}
