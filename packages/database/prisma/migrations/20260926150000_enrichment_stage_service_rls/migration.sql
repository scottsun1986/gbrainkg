-- Checkpoints contain internal worker state and must not be user-visible.
-- Explicitly enable RLS even on installations without the auto-RLS DDL trigger.
ALTER TABLE "EnrichmentStage" ENABLE ROW LEVEL SECURITY;

CREATE POLICY enrichment_stage_service_rw ON "EnrichmentStage" FOR ALL
USING (app_is_service())
WITH CHECK (app_is_service());
