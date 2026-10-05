BEGIN;

-- Preserve the restrictive source conjunction; evaluate shared document ACLs
-- once per statement rather than once per dependency of every returned row.
-- No authorization result survives the statement snapshot.
CREATE FUNCTION app_readable_artifacts()
RETURNS TABLE ("artifactId" text, "kbId" uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
  -- Service policies already allow access. Do not build an unused reader set.
  IF app_is_service() OR app_current_user_id() IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH readable_documents AS MATERIALIZED (
    SELECT d.id, d."kbId", d."activeVersionId",
           COALESCE(d."contentHash",'') || ':' || d.version::text AS "sourceHash"
    FROM "Document" d
    WHERE d."kbId" IN (SELECT app_visible_kb_ids())
      AND d.status='published'
      AND app_document_readable(d.id,d."kbId")
      AND (d."effectiveFrom" IS NULL OR d."effectiveFrom"<=COALESCE(NULLIF(current_setting('app.as_of',true),'')::timestamptz,statement_timestamp()))
      AND (d."effectiveTo" IS NULL OR d."effectiveTo">COALESCE(NULLIF(current_setting('app.as_of',true),'')::timestamptz,statement_timestamp()))
      AND NOT (d."lifecycleStatus"='repealed' AND d."effectiveTo" IS NULL)
  )
  SELECT a."artifactId", min(d."kbId"::text)::uuid
  FROM "ArtifactDependency" a
  JOIN "ArtifactManifest" m ON m."artifactId"=a."artifactId"
  LEFT JOIN readable_documents d ON d.id=a."sourceDocumentId"
    AND d."activeVersionId" IS NOT DISTINCT FROM a."sourceVersionId"
    AND d."sourceHash"=a."sourceHash"
  GROUP BY a."artifactId",m."expectedCount"
  HAVING count(*)=m."expectedCount" AND count(d.id)=count(*)
    AND min(d."kbId"::text)=max(d."kbId"::text);
END $$;

-- Each derived table checks only its own candidate IDs. A GraphEntity scan
-- must not build the reader set for unrelated RAPTOR summaries. Resolve IDs
-- from the table itself; historical artifactKind labels are not authoritative.
CREATE FUNCTION app_readable_artifacts(p_table text)
RETURNS TABLE ("artifactId" text, "kbId" uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
  IF app_is_service() OR app_current_user_id() IS NULL THEN RETURN; END IF;
  IF p_table IS NULL OR p_table NOT IN ('GraphEntity','GraphRelation','GraphCommunity','RaptorNode') THEN
    RAISE EXCEPTION 'Unsupported derived artifact table';
  END IF;
  RETURN QUERY EXECUTE format($query$
    WITH candidates AS MATERIALIZED (
      SELECT id::text AS "artifactId", "kbId" FROM %I
      WHERE "kbId" IN (SELECT app_visible_kb_ids())
    ), readable_documents AS MATERIALIZED (
      SELECT d.id, d."kbId", d."activeVersionId",
             COALESCE(d."contentHash",'') || ':' || d.version::text AS "sourceHash"
      FROM "Document" d
      WHERE d."kbId" IN (SELECT c."kbId" FROM candidates c)
        AND d.status='published'
        AND app_document_readable(d.id,d."kbId")
        AND (d."effectiveFrom" IS NULL OR d."effectiveFrom"<=COALESCE(NULLIF(current_setting('app.as_of',true),'')::timestamptz,statement_timestamp()))
        AND (d."effectiveTo" IS NULL OR d."effectiveTo">COALESCE(NULLIF(current_setting('app.as_of',true),'')::timestamptz,statement_timestamp()))
        AND NOT (d."lifecycleStatus"='repealed' AND d."effectiveTo" IS NULL)
    )
    SELECT a."artifactId", c."kbId"
    FROM candidates c
    JOIN "ArtifactDependency" a ON a."artifactId"=c."artifactId"
    JOIN "ArtifactManifest" m ON m."artifactId"=a."artifactId"
    LEFT JOIN readable_documents d ON d.id=a."sourceDocumentId"
      AND d."kbId"=c."kbId"
      AND d."activeVersionId" IS NOT DISTINCT FROM a."sourceVersionId"
      AND d."sourceHash"=a."sourceHash"
    GROUP BY a."artifactId",c."kbId",m."expectedCount"
    HAVING count(*)=m."expectedCount" AND count(d.id)=count(*)
  $query$, p_table);
END $$;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['GraphEntity','GraphRelation','GraphCommunity','RaptorNode'] LOOP
    EXECUTE format('DROP POLICY artifact_inputs_guard ON %I',table_name);
    EXECUTE format('CREATE POLICY artifact_inputs_guard ON %I AS RESTRICTIVE FOR SELECT USING (app_is_service() OR (id::text,"kbId") IN (SELECT "artifactId","kbId" FROM app_readable_artifacts(%L)))',table_name,table_name);
  END LOOP;
END $$;
DROP POLICY artifact_manifest_reader ON "ArtifactManifest";
CREATE POLICY artifact_manifest_reader ON "ArtifactManifest" FOR SELECT USING (
  app_is_service() OR "artifactId" IN (SELECT "artifactId" FROM app_readable_artifacts())
);

COMMIT;
