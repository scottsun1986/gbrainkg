ALTER TABLE "BlockArtifact" ADD COLUMN "rawContent" text;
-- Historical enriched chunks are not asserted to be the original source span.
-- Re-ingestion supplies rawContent from immutable parsed Markdown before strict citation switching.
