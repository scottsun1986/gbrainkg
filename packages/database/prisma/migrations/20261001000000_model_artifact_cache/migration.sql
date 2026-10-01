CREATE TABLE "ModelArtifactCache" (key text PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL, "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX model_artifact_expiry ON "ModelArtifactCache" ("expiresAt");
ALTER TABLE "ModelArtifactCache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ModelArtifactCache" FORCE ROW LEVEL SECURITY;
CREATE POLICY model_artifact_service ON "ModelArtifactCache" FOR ALL USING(app_is_service()) WITH CHECK(app_is_service());
