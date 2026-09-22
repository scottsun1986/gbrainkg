-- 20260919120000_lexical_bm25_index
--
-- Engine-side full-corpus lexical channel.
--
-- Before this migration the lexical arm pulled a bounded candidate set with
-- `content ILIKE '%term%'` ordered by (documentId, ord) and only then computed
-- BM25 inside Node over that truncated pool. With a high-frequency term the
-- pool filled up before any relevance decision was made, so genuinely relevant
-- chunks could be dropped before scoring.
--
-- The tables below store a per-chunk term vector produced by the application
-- tokenizer (CJK bigram/unigram + word + identifier terms, see
-- apps/api/src/retrieval/lexical-tokenizer.ts). A GIN index over that tsvector
-- lets PostgreSQL itself resolve the matching set for the whole corpus, and the
-- BM25 score is then computed in SQL with exact corpus df/N/avgdl, so ranking
-- happens before any LIMIT. ACL scope (kbId) and the published-document gate
-- are applied in the same statement, which keeps the channel permission-safe.
--
-- After a large backfill operators should refresh the GIN index:
--   REINDEX INDEX CONCURRENTLY chunk_lexical_tsv_gin_idx;

CREATE TABLE IF NOT EXISTS "ChunkLexicalDoc" (
  "chunkId"    uuid NOT NULL,
  "kbId"       uuid NOT NULL,
  "documentId" uuid NOT NULL,
  "len"        integer NOT NULL,
  "tsv"        tsvector NOT NULL,
  "updatedAt"  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChunkLexicalDoc_pkey" PRIMARY KEY ("chunkId")
);

CREATE INDEX IF NOT EXISTS chunk_lexical_doc_kbid_idx ON "ChunkLexicalDoc" ("kbId");
CREATE INDEX IF NOT EXISTS chunk_lexical_doc_document_idx ON "ChunkLexicalDoc" ("documentId");
CREATE INDEX IF NOT EXISTS chunk_lexical_tsv_gin_idx ON "ChunkLexicalDoc" USING gin ("tsv");
-- Length normalisation aggregates scan this index only.
CREATE INDEX IF NOT EXISTS chunk_lexical_doc_kbid_len_idx ON "ChunkLexicalDoc" ("kbId", "len");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ChunkLexicalDoc_chunkId_fkey'
  ) THEN
    ALTER TABLE "ChunkLexicalDoc"
      ADD CONSTRAINT "ChunkLexicalDoc_chunkId_fkey"
      FOREIGN KEY ("chunkId") REFERENCES "Chunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ChunkLexicalDoc_documentId_fkey'
  ) THEN
    ALTER TABLE "ChunkLexicalDoc"
      ADD CONSTRAINT "ChunkLexicalDoc_documentId_fkey"
      FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Per-KB corpus statistics (N and average document length) so the BM25 query
-- does not have to aggregate the whole KB on every request.
CREATE TABLE IF NOT EXISTS "KbLexicalStat" (
  "kbId"       uuid NOT NULL,
  "docCount"   integer NOT NULL DEFAULT 0,
  "totalLen"   bigint NOT NULL DEFAULT 0,
  "statsVersion" integer NOT NULL DEFAULT 0,
  "updatedAt"  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KbLexicalStat_pkey" PRIMARY KEY ("kbId")
);

-- Corpus document frequency per term. Without it, df could only be measured
-- inside whatever candidate window a query happened to scan, which inflates the
-- IDF of very common terms and lets boilerplate outrank the answer. The index
-- write path maintains it incrementally (new postings minus replaced postings).
CREATE TABLE IF NOT EXISTS "LexicalTermStat" (
  "kbId"     uuid NOT NULL,
  "term"     text NOT NULL,
  "df"       integer NOT NULL DEFAULT 0,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LexicalTermStat_pkey" PRIMARY KEY ("kbId", "term")
);
CREATE INDEX IF NOT EXISTS lexical_term_stat_term_idx ON "LexicalTermStat" ("term");

-- Build a tsquery from a term array without letting user text inject tsquery
-- syntax. Each term is quoted as a literal lexeme and OR-joined.
CREATE OR REPLACE FUNCTION lexical_tsquery(terms text[]) RETURNS tsquery AS $$
DECLARE
  joined text;
BEGIN
  SELECT string_agg(quote_literal(t), ' | ') INTO joined FROM unnest(terms) AS t;
  IF joined IS NULL OR joined = '' THEN
    RETURN NULL;
  END IF;
  RETURN to_tsquery('simple', joined);
END;
$$ LANGUAGE plpgsql IMMUTABLE;
