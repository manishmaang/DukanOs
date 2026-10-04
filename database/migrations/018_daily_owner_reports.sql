INSERT INTO permissions(code) VALUES ('daily_reports.read'),('daily_reports.manage'),('daily_reports.send');
INSERT INTO role_permissions(role_code,permission_code) SELECT r.code,p.code FROM roles r CROSS JOIN permissions p WHERE r.code IN ('OWNER','MANAGER') AND p.code LIKE 'daily_reports.%';
CREATE TABLE daily_report_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), enabled boolean NOT NULL DEFAULT false,
 recipients text[] NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1 CHECK(version>0),
 start_date date, next_date date, CHECK(cardinality(recipients)<=10)
);
INSERT INTO daily_report_settings(id) VALUES(true);
CREATE TABLE daily_report_settings_audit (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), before_value jsonb NOT NULL, after_value jsonb NOT NULL
);
CREATE TABLE daily_reports (
 id uuid PRIMARY KEY, business_date date NOT NULL, version integer NOT NULL CHECK(version>0),
 generated_at timestamptz NOT NULL DEFAULT clock_timestamp(), generated_by uuid REFERENCES users(id),
 source text NOT NULL CHECK(source IN ('AUTOMATIC','MANUAL')), reason text NOT NULL DEFAULT '' CHECK(length(reason)<=500),
 request_id uuid, request_hash text,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND snapshot->>'schemaVersion'='1' AND snapshot ?& ARRAY['foodSold','cashReturned','recordedExpenses','expenseCategories','expenseEntries','bestSeller','timezone']),
 UNIQUE(business_date,version), UNIQUE(generated_by,request_id),
 CHECK((source='AUTOMATIC' AND generated_by IS NULL AND version=1 AND request_id IS NULL AND request_hash IS NULL) OR (source='MANUAL' AND generated_by IS NOT NULL AND request_id IS NOT NULL AND length(request_hash)=64)),
 CHECK(version=1 OR length(btrim(reason))>0)
);
CREATE INDEX daily_reports_history_idx ON daily_reports(business_date DESC,version DESC);
CREATE TABLE report_deliveries (
 id uuid PRIMARY KEY, report_id uuid REFERENCES daily_reports(id), channel text NOT NULL DEFAULT 'EMAIL' CHECK(channel='EMAIL'),
 kind text NOT NULL CHECK(kind IN ('AUTOMATIC','MANUAL','TEST')), recipient text NOT NULL CHECK(length(recipient) BETWEEN 3 AND 254 AND recipient !~ '[\r\n]'),
 requested_by uuid REFERENCES users(id), request_id uuid, request_hash text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENDING','RETRY_PENDING','SENT','FAILED')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0), next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_until timestamptz, claim_id uuid,
 sent_at timestamptz, last_error_code text, provider_message_id text,
 CHECK((kind='TEST')=(report_id IS NULL)), CHECK((kind='AUTOMATIC' AND requested_by IS NULL) OR (kind<>'AUTOMATIC' AND requested_by IS NOT NULL AND request_id IS NOT NULL AND length(request_hash)=64)),
 CHECK((status='SENT')=(sent_at IS NOT NULL)), UNIQUE(requested_by,request_id,recipient)
);
CREATE UNIQUE INDEX report_automatic_recipient_unique ON report_deliveries(report_id,recipient) WHERE kind='AUTOMATIC';
CREATE INDEX report_delivery_due_idx ON report_deliveries(next_attempt_at,created_at) WHERE status IN ('PENDING','RETRY_PENDING','SENDING');
CREATE INDEX report_delivery_report_idx ON report_deliveries(report_id,created_at);
CREATE TABLE report_delivery_attempts (
 id uuid PRIMARY KEY, delivery_id uuid NOT NULL REFERENCES report_deliveries(id), attempt integer NOT NULL CHECK(attempt>0),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), outcome text NOT NULL CHECK(outcome IN ('SENT','RETRY_PENDING','FAILED','LEASE_EXPIRED')), error_code text, provider_message_id text,
 UNIQUE(delivery_id,attempt)
);
CREATE TABLE report_delivery_actions (
 id uuid PRIMARY KEY, delivery_id uuid NOT NULL REFERENCES report_deliveries(id), actor_id uuid NOT NULL REFERENCES users(id), occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), request_id uuid NOT NULL, UNIQUE(actor_id,request_id)
);
CREATE FUNCTION daily_report_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'DAILY_REPORT_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END $$;
CREATE TRIGGER daily_reports_immutable BEFORE UPDATE OR DELETE ON daily_reports FOR EACH ROW EXECUTE FUNCTION daily_report_immutable();
CREATE TRIGGER daily_settings_audit_immutable BEFORE UPDATE OR DELETE ON daily_report_settings_audit FOR EACH ROW EXECUTE FUNCTION daily_report_immutable();
CREATE TRIGGER daily_attempts_immutable BEFORE UPDATE OR DELETE ON report_delivery_attempts FOR EACH ROW EXECUTE FUNCTION daily_report_immutable();
CREATE TRIGGER daily_actions_immutable BEFORE UPDATE OR DELETE ON report_delivery_actions FOR EACH ROW EXECUTE FUNCTION daily_report_immutable();
CREATE FUNCTION guard_report_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['status','attempt_count','next_attempt_at','lease_until','claim_id','sent_at','last_error_code','provider_message_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','attempt_count','next_attempt_at','lease_until','claim_id','sent_at','last_error_code','provider_message_id']) OR OLD.status='SENT' THEN RAISE EXCEPTION 'REPORT_DELIVERY_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER report_delivery_identity BEFORE UPDATE OR DELETE ON report_deliveries FOR EACH ROW EXECUTE FUNCTION guard_report_delivery();
