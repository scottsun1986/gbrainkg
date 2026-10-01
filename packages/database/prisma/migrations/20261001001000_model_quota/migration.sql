CREATE TABLE "ModelQuotaBucket" (key text NOT NULL, period bigint NOT NULL, requests int NOT NULL, tokens bigint NOT NULL, PRIMARY KEY(key,period));
ALTER TABLE "ModelQuotaBucket" ENABLE ROW LEVEL SECURITY;
-- The SECURITY DEFINER admission function owns this table. Runtime roles have
-- no direct access; owner bypass is needed for atomic admission by users.
CREATE POLICY model_quota_service ON "ModelQuotaBucket" FOR ALL USING(app_is_service()) WITH CHECK(app_is_service());
CREATE FUNCTION app_admit_model_call(resource_key text, request_limit int, token_limit bigint, input_tokens int) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE bucket bigint := floor(extract(epoch FROM clock_timestamp())/60); admitted boolean;
BEGIN
 IF NOT app_is_service() AND NOT EXISTS(SELECT 1 FROM "User" WHERE id=app_current_user_id() AND status='active') THEN RETURN false; END IF;
 IF request_limit<1 OR token_limit<1 OR input_tokens<0 OR input_tokens>token_limit THEN RETURN false; END IF;
 INSERT INTO "ModelQuotaBucket" (key,period,requests,tokens) VALUES(resource_key,bucket,1,input_tokens)
 ON CONFLICT(key,period) DO UPDATE SET requests="ModelQuotaBucket".requests+1,tokens="ModelQuotaBucket".tokens+input_tokens
 WHERE "ModelQuotaBucket".requests<request_limit AND "ModelQuotaBucket".tokens+input_tokens<=token_limit RETURNING true INTO admitted;
 RETURN COALESCE(admitted,false);
END $$;
