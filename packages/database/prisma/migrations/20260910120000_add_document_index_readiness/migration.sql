-- Enrichment index-readiness state machine for documents.
-- legacy   : historical documents enriched before this field existed
-- pending  : published, waiting for the enrichment queue
-- enriching: enrichment job in flight
-- ready    : chunk embeddings (and enabled RAPTOR/graph projections) built
-- degraded : enrichment failed permanently after retries
ALTER TABLE "Document" ADD COLUMN "indexReadiness" TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX "Document_indexReadiness_idx" ON "Document"("indexReadiness");
