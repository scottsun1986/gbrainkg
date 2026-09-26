CREATE TABLE "EnrichmentStage" (
  "documentId" uuid NOT NULL REFERENCES "Document"(id) ON DELETE CASCADE,
  "version" integer NOT NULL,
  "stage" text NOT NULL,
  "completedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("documentId", "version", "stage")
);
