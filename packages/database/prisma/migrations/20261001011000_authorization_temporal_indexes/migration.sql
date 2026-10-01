CREATE INDEX core_document_effective_from ON "Document"("effectiveFrom") WHERE status='published' AND "effectiveFrom" IS NOT NULL;
CREATE INDEX core_document_effective_to ON "Document"("effectiveTo") WHERE status='published' AND "effectiveTo" IS NOT NULL;
CREATE INDEX core_grant_expiration ON "IndustryGrant"("expiresAt") WHERE "expiresAt" IS NOT NULL;
