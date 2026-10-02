-- CLOSED ends a tab; only manual closure implies settled, completed service.
ALTER TABLE bills ADD COLUMN closure_reason text;
ALTER TABLE bills ADD COLUMN closure_timezone text;
ALTER TABLE bills DISABLE TRIGGER protect_bills;
UPDATE bills SET closure_reason='MANUAL' WHERE status='CLOSED';
ALTER TABLE bills ENABLE TRIGGER protect_bills;
DO $$ DECLARE name text; BEGIN
 FOR name IN SELECT conname FROM pg_constraint WHERE conrelid='bills'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%closed_at%'
 LOOP EXECUTE format('ALTER TABLE bills DROP CONSTRAINT %I',name); END LOOP;
END $$;
ALTER TABLE bills ADD CONSTRAINT bill_session_closure CHECK (
 (status='OPEN' AND closed_at IS NULL AND closed_by IS NULL AND closure_reason IS NULL AND closure_timezone IS NULL)
 OR (status='CLOSED' AND closure_reason IS NOT NULL AND closed_at IS NOT NULL AND closed_at>=opened_at AND (
  (closure_reason='MANUAL' AND closed_by IS NOT NULL AND closure_timezone IS NULL)
  OR (closure_reason='BUSINESS_DAY_ROLLOVER' AND closed_by IS NULL AND closure_timezone IS NOT NULL
      AND business_date < (closed_at AT TIME ZONE closure_timezone)::date)
 ))
);
CREATE OR REPLACE FUNCTION guard_bill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BILL_IMMUTABLE' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(742019323);
 IF (to_jsonb(NEW)-ARRAY['status','closed_by','closed_at','closure_reason','closure_timezone']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','closed_by','closed_at','closure_reason','closure_timezone'])
 OR OLD.status<>'OPEN' OR NEW.status<>'CLOSED' THEN RAISE EXCEPTION 'BILL_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.closure_reason IS DISTINCT FROM 'BUSINESS_DAY_ROLLOVER' THEN
  IF NEW.closure_reason IS DISTINCT FROM 'MANUAL' THEN RAISE EXCEPTION 'INVALID_CLOSURE_REASON' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM bill_balances WHERE id=OLD.id AND (amount_due<>0 OR refund_due<>0))
  OR EXISTS(SELECT 1 FROM orders WHERE bill_id=OLD.id AND status NOT IN ('COMPLETED','CANCELLED'))
  THEN RAISE EXCEPTION 'BILL_NOT_SETTLED' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b bills; due numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(742019323);
 SELECT * INTO b FROM bills WHERE id=NEW.bill_id FOR UPDATE;
 IF b.id IS NULL OR NOT (b.status='OPEN' OR (b.status='CLOSED' AND b.closure_reason='BUSINESS_DAY_ROLLOVER'))
 THEN RAISE EXCEPTION 'BILL_NOT_OPEN' USING ERRCODE='23514'; END IF;
 SELECT CASE WHEN NEW.type='REFUND' THEN refund_due ELSE amount_due END INTO due FROM bill_balances WHERE id=NEW.bill_id;
 IF NEW.amount>due THEN RAISE EXCEPTION 'PAYMENT_EXCEEDS_DUE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
-- updated_by remains the last manual editor. System pause cause is explicit.
ALTER TABLE bill_reminders ADD COLUMN pause_reason text CHECK(pause_reason IN ('BALANCE_SETTLED','MANUAL_CLOSE','BUSINESS_DAY_ROLLOVER'));
ALTER TABLE bill_reminders ADD CONSTRAINT active_reminder_has_no_pause_reason CHECK(next_due_at IS NULL OR pause_reason IS NULL);
CREATE OR REPLACE FUNCTION synchronize_bill_reminder() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; active boolean; reason text;
BEGIN
 IF TG_TABLE_NAME='bills' THEN target=NEW.id; ELSE target=NEW.bill_id; END IF;
 SELECT b.status='OPEN' AND f.amount_due>0,
 CASE WHEN b.status='CLOSED' THEN CASE WHEN b.closure_reason='BUSINESS_DAY_ROLLOVER' THEN 'BUSINESS_DAY_ROLLOVER' ELSE 'MANUAL_CLOSE' END ELSE 'BALANCE_SETTLED' END
 INTO active,reason FROM bills b JOIN bill_balances f ON f.id=b.id WHERE b.id=target;
 UPDATE bill_reminders SET next_due_at=CASE WHEN active THEN clock_timestamp()+make_interval(mins=>interval_minutes) ELSE NULL END,
 pause_reason=CASE WHEN active THEN NULL ELSE reason END
 WHERE bill_id=target AND ((active AND next_due_at IS NULL) OR (NOT active AND next_due_at IS NOT NULL));
 RETURN NEW;
END $$;
