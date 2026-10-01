ALTER TABLE "Document" ADD COLUMN "sourceConnectorId" uuid;
CREATE INDEX document_connector_source ON "Document" ("sourceConnectorId","sourceExternalId");
UPDATE "Document" d SET "sourceConnectorId"=c.id FROM "ConnectorSource" c WHERE c."kbId"=d."kbId" AND d."sourceExternalId" IS NOT NULL AND (SELECT count(*) FROM "ConnectorSource" c2 WHERE c2."kbId"=d."kbId")=1;
