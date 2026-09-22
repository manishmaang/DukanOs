-- Extend history-driven Orders lifecycle without modifying existing records.
-- READY/completion timestamps remain the unique history timestamps.
CREATE OR REPLACE FUNCTION protect_order_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ORDER_RECORD_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR NOT (
 (OLD.status='QUEUED' AND NEW.status='PREPARING') OR
 (OLD.status='PREPARING' AND NEW.status='READY') OR
 (OLD.status='READY' AND NEW.status='COMPLETED')) OR NOT EXISTS (
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
   (NEW.from_status='QUEUED' AND NEW.to_status='PREPARING') OR
   (NEW.from_status='PREPARING' AND NEW.to_status='READY') OR
   (NEW.from_status='READY' AND NEW.to_status='COMPLETED')) OR NEW.occurred_at<last_time THEN
   RAISE EXCEPTION 'INVALID_ORDER_TRANSITION' USING ERRCODE='23514'; END IF;
  IF NEW.to_status='PREPARING' THEN
   SELECT id INTO oldest FROM orders WHERE status='QUEUED' ORDER BY queued_at,id LIMIT 1;
   IF oldest IS DISTINCT FROM NEW.order_id THEN RAISE EXCEPTION 'OLDER_ORDER_WAITING' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE INDEX order_history_ready_queue_idx ON order_status_history(occurred_at,order_id) WHERE to_status='READY';
