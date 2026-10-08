-- System-only historical cancellation extends existing immutable financial revisions.
-- Existing rows and payment records are preserved. No cleanup runs in this migration.
ALTER TABLE order_amendments ALTER COLUMN performed_by DROP NOT NULL;
ALTER TABLE order_amendments ADD COLUMN cleanup_timezone text;
ALTER TABLE order_amendments ADD COLUMN cleanup_time text;
ALTER TABLE order_amendments DROP CONSTRAINT order_amendments_reason_check;
ALTER TABLE order_amendments ADD CONSTRAINT amendment_actor_reason CHECK (
 (performed_by IS NOT NULL AND reason IN ('CUSTOMER_CHANGE','WRONG_ITEM_SELECTED','WRONG_PORTION','ITEM_UNAVAILABLE','CASHIER_CORRECTION','OTHER') AND cleanup_timezone IS NULL AND cleanup_time IS NULL)
 OR (performed_by IS NULL AND reason='PREVIOUS_BUSINESS_DAY_AUTO_CANCEL' AND kind='CANCEL' AND cleanup_timezone IS NOT NULL AND cleanup_time IS NOT NULL AND cleanup_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND subtotal=0 AND tax_total=0 AND grand_total=0)
);
CREATE UNIQUE INDEX order_one_system_cancellation_idx ON order_amendments(order_id) WHERE performed_by IS NULL;
ALTER TABLE order_status_history ALTER COLUMN actor_id DROP NOT NULL;
DO $$ DECLARE n text; BEGIN
 FOR n IN SELECT conname FROM pg_constraint WHERE conrelid='order_status_history'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%from_status%'
 LOOP EXECUTE format('ALTER TABLE order_status_history DROP CONSTRAINT %I',n); END LOOP;
END $$;
ALTER TABLE order_status_history ADD CONSTRAINT order_history_actor_transition CHECK (
 (actor_id IS NOT NULL AND reason<>'PREVIOUS_BUSINESS_DAY_AUTO_CANCEL' AND (
 (from_status='DRAFT' AND to_status IN ('QUEUED','CANCELLED')) OR
 (from_status='QUEUED' AND to_status IN ('PREPARING','CANCELLED')) OR
 (from_status='PREPARING' AND to_status='READY') OR
 (from_status='READY' AND to_status='COMPLETED')))
 OR (actor_id IS NULL AND reason='PREVIOUS_BUSINESS_DAY_AUTO_CANCEL' AND from_status IN ('QUEUED','PREPARING','READY') AND to_status='CANCELLED')
);
CREATE OR REPLACE FUNCTION guard_amendment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders; current_revision integer; old_total numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AMENDMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(742019323);
 SELECT * INTO o FROM orders WHERE id=NEW.order_id FOR UPDATE;
 IF NEW.performed_by IS NULL THEN
  IF NEW.reason IS DISTINCT FROM 'PREVIOUS_BUSINESS_DAY_AUTO_CANCEL' OR NEW.kind<>'CANCEL'
   OR o.id IS NULL OR o.status NOT IN ('QUEUED','PREPARING','READY') OR o.bill_id<>NEW.bill_id
   OR NEW.cleanup_timezone IS NULL OR NEW.cleanup_time IS NULL
   OR o.business_date >= (NEW.created_at AT TIME ZONE NEW.cleanup_timezone)::date
   OR (NEW.created_at AT TIME ZONE NEW.cleanup_timezone)::time < NEW.cleanup_time::time
   OR NOT EXISTS(SELECT 1 FROM bills WHERE id=o.bill_id AND status='CLOSED' AND closure_reason='BUSINESS_DAY_ROLLOVER') THEN
   RAISE EXCEPTION 'INVALID_SYSTEM_CANCELLATION' USING ERRCODE='23514'; END IF;
 ELSE
  IF o.status IS DISTINCT FROM 'QUEUED' OR o.bill_id<>NEW.bill_id OR NOT EXISTS(SELECT 1 FROM bills WHERE id=NEW.bill_id AND status='OPEN') THEN
   RAISE EXCEPTION 'ORDER_NOT_AMENDABLE' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM kitchen_timers WHERE order_id=o.id AND status='ACTIVE') THEN RAISE EXCEPTION 'ORDER_HAS_ACTIVE_TIMER' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT revision,grand_total INTO current_revision,old_total FROM effective_orders WHERE id=o.id;
 IF NEW.revision<>current_revision+1 OR NEW.before_total<>old_total OR NEW.tax_total<>round(NEW.subtotal*o.tax_rate/100,2) THEN
 RAISE EXCEPTION 'INVALID_AMENDMENT_REVISION' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION validate_amendment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a order_amendments; n integer; total numeric;
BEGIN
 IF TG_TABLE_NAME='order_amendments' THEN a=NEW; ELSE SELECT * INTO a FROM order_amendments WHERE id=NEW.amendment_id; END IF;
 SELECT count(*),coalesce(sum(line_subtotal),0) INTO n,total FROM order_item_revisions WHERE amendment_id=a.id;
 IF total<>a.subtotal OR (a.kind='CHANGE' AND n NOT BETWEEN 1 AND 100) OR (a.kind='CANCEL' AND (n<>0 OR a.grand_total<>0 OR NOT EXISTS(SELECT 1 FROM order_status_history WHERE order_id=a.order_id AND to_status='CANCELLED' AND actor_id IS NOT DISTINCT FROM a.performed_by))) THEN
 RAISE EXCEPTION 'AMENDMENT_AGGREGATE_INVALID' USING ERRCODE='23514'; END IF;
 IF a.performed_by IS NULL AND EXISTS(SELECT 1 FROM kitchen_timers WHERE order_id=a.order_id AND status='ACTIVE') THEN RAISE EXCEPTION 'SYSTEM_CANCELLATION_HAS_ACTIVE_TIMER' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION protect_order_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ORDER_RECORD_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR NOT (
 (OLD.status='QUEUED' AND NEW.status IN ('PREPARING','CANCELLED')) OR
 (OLD.status='PREPARING' AND NEW.status IN ('READY','CANCELLED')) OR
 (OLD.status='READY' AND NEW.status IN ('COMPLETED','CANCELLED'))) OR NOT EXISTS (
 SELECT 1 FROM order_status_history WHERE order_id=OLD.id AND from_status=OLD.status AND to_status=NEW.status
 ) THEN RAISE EXCEPTION 'ORDER_RECORD_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION validate_order_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_order orders; oldest uuid; last_time timestamptz;
BEGIN
 -- Same serialization boundary as Counter confirmation, so newly queued work
 -- cannot commit out of FIFO order while another device starts an order.
 PERFORM pg_advisory_xact_lock(742019323);
 SELECT * INTO current_order FROM orders WHERE id=NEW.order_id FOR UPDATE;
 SELECT max(occurred_at) INTO last_time FROM order_status_history WHERE order_id=NEW.order_id;
 IF last_time IS NULL THEN
  IF NEW.from_status<>'DRAFT' OR NEW.to_status<>'QUEUED' OR current_order.status<>'QUEUED'
   OR NEW.actor_id<>current_order.confirmed_by OR NEW.occurred_at<>current_order.queued_at THEN
   RAISE EXCEPTION 'INVALID_ORDER_TRANSITION' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.from_status<>current_order.status OR NOT (
   (NEW.from_status='QUEUED' AND NEW.to_status IN ('PREPARING','CANCELLED')) OR
   (NEW.from_status='PREPARING' AND NEW.to_status IN ('READY','CANCELLED')) OR
   (NEW.from_status='READY' AND NEW.to_status IN ('COMPLETED','CANCELLED'))) OR NEW.occurred_at<last_time THEN
   RAISE EXCEPTION 'INVALID_ORDER_TRANSITION' USING ERRCODE='23514'; END IF;
  IF NEW.to_status='CANCELLED' AND NOT EXISTS(SELECT 1 FROM order_amendments WHERE order_id=NEW.order_id AND kind='CANCEL' AND (NEW.actor_id IS NOT NULL OR reason=NEW.reason) AND performed_by IS NOT DISTINCT FROM NEW.actor_id AND xmin=pg_current_xact_id()::text::xid) THEN RAISE EXCEPTION 'CANCELLATION_REQUIRES_AMENDMENT' USING ERRCODE='23514'; END IF;
  IF NEW.to_status='PREPARING' THEN
   SELECT id INTO oldest FROM orders WHERE status='QUEUED' ORDER BY queued_at,id LIMIT 1;
   IF oldest IS DISTINCT FROM NEW.order_id THEN RAISE EXCEPTION 'OLDER_ORDER_WAITING' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER TABLE kitchen_timers ADD COLUMN resolution_reason text;
DO $$ DECLARE n text; BEGIN
 FOR n IN SELECT conname FROM pg_constraint WHERE conrelid='kitchen_timers'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%resolved_by%'
 LOOP EXECUTE format('ALTER TABLE kitchen_timers DROP CONSTRAINT %I',n); END LOOP;
END $$;
ALTER TABLE kitchen_timers ADD CONSTRAINT timer_resolution_identity CHECK (
 (status='ACTIVE' AND resolved_by IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL)
 OR (status<>'ACTIVE' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolved_at>=started_at AND resolution_reason IS NULL)
 OR (status='CANCELLED' AND resolved_by IS NULL AND resolved_at IS NOT NULL AND resolved_at>=started_at AND resolution_reason IS NOT NULL AND resolution_reason='PREVIOUS_BUSINESS_DAY_AUTO_CANCEL')
);
CREATE OR REPLACE FUNCTION protect_kitchen_timer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TIMER_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF OLD.status<>'ACTIVE' OR NEW.status='ACTIVE' OR (to_jsonb(NEW)-ARRAY['status','resolved_by','resolved_at','resolution_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','resolved_by','resolved_at','resolution_reason']) THEN
  RAISE EXCEPTION 'INVALID_TIMER_TRANSITION' USING ERRCODE='23514'; END IF;
 IF NEW.resolved_by IS NULL AND NOT EXISTS(SELECT 1 FROM order_amendments a JOIN orders o ON o.id=a.order_id WHERE a.order_id=NEW.order_id AND o.status='CANCELLED' AND a.performed_by IS NULL AND a.reason=NEW.resolution_reason AND a.xmin=pg_current_xact_id()::text::xid) THEN
  RAISE EXCEPTION 'INVALID_SYSTEM_TIMER_RESOLUTION' USING ERRCODE='23514'; END IF;
 IF NEW.status='ACKNOWLEDGED' AND NEW.resolved_at<NEW.due_at THEN RAISE EXCEPTION 'TIMER_NOT_DUE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
