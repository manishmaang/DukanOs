-- Additive fulfillment history. No historical orders, payments or menu rows rewritten.
CREATE TABLE order_serving_events (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), line_id uuid NOT NULL,
 FOREIGN KEY(order_id,line_id) REFERENCES order_items(order_id,id),
 revision integer NOT NULL CHECK(revision>=0), quantity integer NOT NULL CHECK(quantity BETWEEN -99 AND 99 AND quantity<>0),
 expected_served integer NOT NULL CHECK(expected_served BETWEEN 0 AND 99),
 reason text NOT NULL DEFAULT '' CHECK(length(reason)<=500 AND (quantity>0 OR length(btrim(reason))>0)),
 actor_id uuid NOT NULL REFERENCES users(id), occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request_id uuid NOT NULL, request_hash text NOT NULL CHECK(length(request_hash)=64), UNIQUE(actor_id,request_id)
);
CREATE INDEX serving_order_line ON order_serving_events(order_id,line_id);
CREATE TABLE kitchen_fulfillments (
 order_id uuid PRIMARY KEY REFERENCES orders(id), revision integer NOT NULL CHECK(revision>=0), actor_id uuid REFERENCES users(id),
 request_id uuid NOT NULL, request_hash text NOT NULL CHECK(length(request_hash)=64),
 occurred_at timestamptz NOT NULL, reason text NOT NULL,
 cleanup_timezone text, cleanup_time text,
 UNIQUE(actor_id,request_id),
 CHECK ((actor_id IS NOT NULL AND reason='KITCHEN_HANDOVER' AND cleanup_timezone IS NULL AND cleanup_time IS NULL)
 OR (actor_id IS NULL AND reason='PREVIOUS_BUSINESS_DAY_PART_SERVED_COMPLETE' AND cleanup_timezone IS NOT NULL AND cleanup_time IS NOT NULL AND cleanup_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
);
CREATE FUNCTION guard_serving_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders; rev integer; ordered integer; served integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SERVING_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(742019323);
 SELECT * INTO o FROM orders WHERE id=NEW.order_id FOR UPDATE;
 IF o.status NOT IN ('QUEUED','PREPARING','READY') OR NOT EXISTS(SELECT 1 FROM bills WHERE id=o.bill_id AND service_type='DINE_IN') THEN RAISE EXCEPTION 'ORDER_NOT_SERVABLE' USING ERRCODE='23514'; END IF;
 SELECT revision INTO rev FROM effective_orders WHERE id=o.id;
 SELECT quantity INTO ordered FROM effective_order_items WHERE order_id=o.id AND id=NEW.line_id;
 SELECT coalesce(sum(quantity),0) INTO served FROM order_serving_events WHERE order_id=o.id AND line_id=NEW.line_id;
 IF ordered IS NULL OR NEW.revision<>rev OR NEW.expected_served<>served OR served+NEW.quantity NOT BETWEEN 0 AND ordered THEN RAISE EXCEPTION 'SERVING_CONFLICT' USING ERRCODE='23514'; END IF;
 IF NEW.occurred_at<o.queued_at THEN RAISE EXCEPTION 'INVALID_SERVING_TIME' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_serving_events BEFORE INSERT OR UPDATE OR DELETE ON order_serving_events FOR EACH ROW EXECUTE FUNCTION guard_serving_event();
CREATE FUNCTION guard_served_amendment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(742019323);
 IF EXISTS(SELECT 1 FROM order_serving_events WHERE order_id=NEW.order_id) AND (NEW.performed_by IS NOT NULL OR EXISTS(SELECT 1 FROM order_serving_events WHERE order_id=NEW.order_id GROUP BY line_id HAVING sum(quantity)>0)) THEN RAISE EXCEPTION 'ORDER_HAS_SERVING_HISTORY' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER served_order_amendment BEFORE INSERT ON order_amendments FOR EACH ROW EXECUTE FUNCTION guard_served_amendment();
CREATE FUNCTION guard_kitchen_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'FULFILLMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(742019323);
 SELECT * INTO o FROM orders WHERE id=NEW.order_id FOR UPDATE;
 IF o.status NOT IN ('QUEUED','PREPARING','READY') THEN RAISE EXCEPTION 'ORDER_NOT_PENDING' USING ERRCODE='23514'; END IF;
 IF NEW.revision IS DISTINCT FROM (SELECT revision FROM effective_orders WHERE id=o.id) THEN RAISE EXCEPTION 'ORDER_REVISION_CHANGED' USING ERRCODE='23514'; END IF;
 IF NEW.actor_id IS NULL THEN
  IF o.business_date >= (NEW.occurred_at AT TIME ZONE NEW.cleanup_timezone)::date
  OR (NEW.occurred_at AT TIME ZONE NEW.cleanup_timezone)::time < NEW.cleanup_time::time
  OR NOT EXISTS(SELECT 1 FROM bills WHERE id=o.bill_id AND service_type='DINE_IN')
  OR NOT EXISTS(SELECT 1 FROM order_serving_events WHERE order_id=o.id GROUP BY line_id HAVING sum(quantity)>0)
  THEN RAISE EXCEPTION 'INVALID_SYSTEM_COMPLETION' USING ERRCODE='23514'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM bills WHERE id=o.bill_id AND service_type='DINE_IN') THEN RAISE EXCEPTION 'SERVE_DINE_IN_LINES' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_kitchen_fulfillments BEFORE INSERT OR UPDATE OR DELETE ON kitchen_fulfillments FOR EACH ROW EXECUTE FUNCTION guard_kitchen_fulfillment();
CREATE FUNCTION check_kitchen_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM order_status_history h JOIN orders o ON o.id=h.order_id WHERE o.id=NEW.order_id AND o.status='COMPLETED' AND h.to_status='COMPLETED' AND h.actor_id IS NOT DISTINCT FROM NEW.actor_id AND h.occurred_at=NEW.occurred_at AND h.reason=NEW.reason) THEN RAISE EXCEPTION 'FULFILLMENT_INCOMPLETE' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER complete_kitchen_fulfillment AFTER INSERT ON kitchen_fulfillments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_kitchen_fulfillment();
ALTER TABLE order_status_history DROP CONSTRAINT order_history_actor_transition;
ALTER TABLE order_status_history ADD CONSTRAINT order_history_actor_transition CHECK (
 (actor_id IS NOT NULL AND reason NOT IN ('PREVIOUS_BUSINESS_DAY_AUTO_CANCEL','PREVIOUS_BUSINESS_DAY_PART_SERVED_COMPLETE') AND (
 (from_status='DRAFT' AND to_status='QUEUED') OR
 (from_status='QUEUED' AND to_status IN ('PREPARING','CANCELLED','COMPLETED')) OR
 (from_status='PREPARING' AND to_status IN ('READY','CANCELLED','COMPLETED')) OR
 (from_status='READY' AND to_status IN ('COMPLETED','CANCELLED'))))
 OR (actor_id IS NULL AND from_status IN ('QUEUED','PREPARING','READY') AND (
 (reason='PREVIOUS_BUSINESS_DAY_AUTO_CANCEL' AND to_status='CANCELLED') OR
 (reason='PREVIOUS_BUSINESS_DAY_PART_SERVED_COMPLETE' AND to_status='COMPLETED'))));

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
   (NEW.from_status='QUEUED' AND NEW.to_status IN ('PREPARING','CANCELLED','COMPLETED')) OR
   (NEW.from_status='PREPARING' AND NEW.to_status IN ('READY','CANCELLED','COMPLETED')) OR
   (NEW.from_status='READY' AND NEW.to_status IN ('COMPLETED','CANCELLED'))) OR NEW.occurred_at<last_time THEN
   RAISE EXCEPTION 'INVALID_ORDER_TRANSITION' USING ERRCODE='23514'; END IF;
  IF NEW.to_status='CANCELLED' AND current_order.source='COUNTER' AND NOT EXISTS(SELECT 1 FROM order_amendments WHERE order_id=NEW.order_id AND kind='CANCEL' AND (NEW.actor_id IS NOT NULL OR reason=NEW.reason) AND performed_by IS NOT DISTINCT FROM NEW.actor_id AND xmin=pg_current_xact_id()::text::xid) THEN RAISE EXCEPTION 'CANCELLATION_REQUIRES_AMENDMENT' USING ERRCODE='23514'; END IF;
  IF NEW.to_status='CANCELLED' AND current_order.source<>'COUNTER' AND NOT EXISTS(SELECT 1 FROM platform_order_cancellations WHERE order_id=NEW.order_id AND actor_id IS NOT DISTINCT FROM NEW.actor_id AND reason=NEW.reason AND occurred_at=NEW.occurred_at AND xmin=pg_current_xact_id()::text::xid) THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_REQUIRED' USING ERRCODE='23514'; END IF;
  IF NEW.to_status='COMPLETED' THEN
   IF NEW.actor_id IS NULL AND NOT EXISTS(SELECT 1 FROM kitchen_fulfillments WHERE order_id=NEW.order_id AND actor_id IS NULL AND reason=NEW.reason AND occurred_at=NEW.occurred_at AND xmin=pg_current_xact_id()::text::xid) THEN RAISE EXCEPTION 'SYSTEM_COMPLETION_REQUIRED' USING ERRCODE='23514'; END IF;
   IF NEW.actor_id IS NOT NULL AND EXISTS(SELECT 1 FROM bills WHERE id=current_order.bill_id AND service_type='DINE_IN')
    AND (NEW.from_status<>'READY' OR EXISTS(SELECT 1 FROM order_serving_events WHERE order_id=NEW.order_id))
    AND EXISTS(SELECT 1 FROM effective_order_items i WHERE i.order_id=NEW.order_id AND i.quantity<>(SELECT coalesce(sum(e.quantity),0) FROM order_serving_events e WHERE e.order_id=i.order_id AND e.line_id=i.id)) THEN RAISE EXCEPTION 'UNSERVED_ITEMS_REMAIN' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.to_status='PREPARING' THEN
   SELECT id INTO oldest FROM orders WHERE status='QUEUED' ORDER BY queued_at,id LIMIT 1;
   IF oldest IS DISTINCT FROM NEW.order_id THEN RAISE EXCEPTION 'OLDER_ORDER_WAITING' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION protect_order_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ORDER_RECORD_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR NOT (
 (OLD.status='QUEUED' AND NEW.status IN ('PREPARING','CANCELLED','COMPLETED')) OR
 (OLD.status='PREPARING' AND NEW.status IN ('READY','CANCELLED','COMPLETED')) OR
 (OLD.status='READY' AND NEW.status IN ('COMPLETED','CANCELLED'))) OR NOT EXISTS (
 SELECT 1 FROM order_status_history WHERE order_id=OLD.id AND from_status=OLD.status AND to_status=NEW.status
 ) THEN RAISE EXCEPTION 'ORDER_RECORD_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

INSERT INTO permissions(code) VALUES ('kitchen.fulfill');
INSERT INTO role_permissions(role_code,permission_code) SELECT r,'kitchen.fulfill' FROM unnest(ARRAY['OWNER','MANAGER','KITCHEN','DISPATCH']) r;
INSERT INTO role_permissions(role_code,permission_code) VALUES ('DISPATCH','kitchen.read') ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION protect_kitchen_timer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TIMER_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF OLD.status<>'ACTIVE' OR NEW.status='ACTIVE' OR (to_jsonb(NEW)-ARRAY['status','resolved_by','resolved_at','resolution_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','resolved_by','resolved_at','resolution_reason']) THEN
  RAISE EXCEPTION 'INVALID_TIMER_TRANSITION' USING ERRCODE='23514'; END IF;
 IF NEW.resolved_by IS NULL AND NOT EXISTS(SELECT 1 FROM kitchen_fulfillments f JOIN orders o ON o.id=f.order_id WHERE f.order_id=NEW.order_id AND o.status='COMPLETED' AND f.actor_id IS NULL AND f.reason=NEW.resolution_reason AND f.xmin=pg_current_xact_id()::text::xid) AND NOT EXISTS(SELECT 1 FROM platform_order_cancellations a JOIN orders o ON o.id=a.order_id WHERE a.order_id=NEW.order_id AND o.status='CANCELLED' AND a.actor_id IS NULL AND a.reason=NEW.resolution_reason AND a.xmin=pg_current_xact_id()::text::xid) AND NOT EXISTS(SELECT 1 FROM order_amendments a JOIN orders o ON o.id=a.order_id WHERE a.order_id=NEW.order_id AND o.status='CANCELLED' AND a.performed_by IS NULL AND a.reason=NEW.resolution_reason AND a.xmin=pg_current_xact_id()::text::xid) THEN
  RAISE EXCEPTION 'INVALID_SYSTEM_TIMER_RESOLUTION' USING ERRCODE='23514'; END IF;
 IF NEW.status='ACKNOWLEDGED' AND NEW.resolved_at<NEW.due_at THEN RAISE EXCEPTION 'TIMER_NOT_DUE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
ALTER TABLE kitchen_timers DROP CONSTRAINT timer_resolution_identity;
ALTER TABLE kitchen_timers ADD CONSTRAINT timer_resolution_identity CHECK (
 (status='ACTIVE' AND resolved_by IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL)
 OR (status<>'ACTIVE' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolved_at>=started_at AND resolution_reason IS NULL)
 OR (status='CANCELLED' AND resolved_by IS NULL AND resolved_at IS NOT NULL AND resolved_at>=started_at AND resolution_reason IN ('PREVIOUS_BUSINESS_DAY_AUTO_CANCEL','PREVIOUS_BUSINESS_DAY_PART_SERVED_COMPLETE'))
);
