CREATE OR REPLACE FUNCTION app_auth_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  -- Revocation commit cannot overtake a strict output permit awaiting drain.
  PERFORM pg_advisory_xact_lock(hashtextextended(current_database() || ':core-auth-output',0));
  UPDATE "AuthorizationState" SET revision=revision+1,"updatedAt"=clock_timestamp() WHERE id=1;
  PERFORM set_config('app.cache.visible_kbs','',true);
  PERFORM set_config('app.cache.is_admin','',true);
  PERFORM set_config('app.cache.managed_kbs','',true);
  RETURN NULL;
END $$;
