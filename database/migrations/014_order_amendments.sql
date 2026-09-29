-- Original sale rows remain untouched. Each revision is a complete immutable snapshot.
CREATE TABLE order_amendments (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), bill_id uuid NOT NULL REFERENCES bills(id),
 revision integer NOT NULL CHECK(revision>0), kind text NOT NULL CHECK(kind IN ('CHANGE','CANCEL')),
 performed_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reason text NOT NULL CHECK(reason IN ('CUSTOMER_CHANGE','WRONG_ITEM_SELECTED','WRONG_PORTION','ITEM_UNAVAILABLE','CASHIER_CORRECTION','OTHER')),
 note text NOT NULL DEFAULT '' CHECK(length(note)<=500), request_id uuid NOT NULL, request_hash text NOT NULL CHECK(length(request_hash)=64),
 before_total numeric NOT NULL CHECK(before_total>=0 AND scale(before_total)<=2),
 subtotal numeric NOT NULL CHECK(subtotal>=0 AND scale(subtotal)<=2), tax_total numeric NOT NULL CHECK(tax_total>=0 AND scale(tax_total)<=2),
 grand_total numeric NOT NULL CHECK(grand_total=subtotal+tax_total),
 UNIQUE(order_id,revision), UNIQUE(performed_by,request_id), UNIQUE(id,order_id)
);
CREATE TABLE order_item_revisions (
 amendment_id uuid NOT NULL, order_id uuid NOT NULL, id uuid NOT NULL,
 FOREIGN KEY(amendment_id,order_id) REFERENCES order_amendments(id,order_id),
 FOREIGN KEY(order_id,id) REFERENCES order_items(order_id,id),
 position integer NOT NULL CHECK(position BETWEEN 1 AND 100),
 menu_item_id uuid NOT NULL REFERENCES menu_items(id), variant_id uuid NOT NULL REFERENCES item_variants(id),
 item_name_snapshot text NOT NULL CHECK(length(btrim(item_name_snapshot)) BETWEEN 1 AND 120),
 kitchen_name_snapshot text NOT NULL CHECK(length(btrim(kitchen_name_snapshot)) BETWEEN 1 AND 120),
 variant_name_snapshot text NOT NULL CHECK(length(btrim(variant_name_snapshot)) BETWEEN 1 AND 80),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 99),
 unit_price_snapshot numeric NOT NULL CHECK(unit_price_snapshot>=0 AND unit_price_snapshot<1000000000000 AND scale(unit_price_snapshot)<=2),
 line_subtotal numeric NOT NULL CHECK(line_subtotal=quantity*unit_price_snapshot AND scale(line_subtotal)<=2),
 instruction text NOT NULL CHECK(length(instruction)<=500), PRIMARY KEY(amendment_id,id), UNIQUE(amendment_id,position)
);
CREATE VIEW effective_orders AS
 SELECT o.id,o.bill_id,coalesce(a.revision,0) AS revision,
 coalesce(a.subtotal,o.subtotal) AS subtotal,coalesce(a.tax_total,o.tax_total) AS tax_total,coalesce(a.grand_total,o.grand_total) AS grand_total
 FROM orders o LEFT JOIN LATERAL (SELECT * FROM order_amendments WHERE order_id=o.id ORDER BY revision DESC LIMIT 1) a ON true;
CREATE VIEW effective_order_items AS
 SELECT i.* FROM order_items i WHERE NOT EXISTS(SELECT 1 FROM order_amendments a WHERE a.order_id=i.order_id)
 UNION ALL
 SELECT i.id,i.order_id,i.position,i.menu_item_id,i.variant_id,i.item_name_snapshot,i.kitchen_name_snapshot,i.variant_name_snapshot,i.quantity,i.unit_price_snapshot,i.line_subtotal,i.instruction
 FROM order_item_revisions i JOIN order_amendments a ON a.id=i.amendment_id
 WHERE NOT EXISTS(SELECT 1 FROM order_amendments newer WHERE newer.order_id=a.order_id AND newer.revision>a.revision);
CREATE FUNCTION guard_amendment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders; current_revision integer; old_total numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AMENDMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(742019323);
 SELECT * INTO o FROM orders WHERE id=NEW.order_id FOR UPDATE;
 IF o.status IS DISTINCT FROM 'QUEUED' OR o.bill_id<>NEW.bill_id OR NOT EXISTS(SELECT 1 FROM bills WHERE id=NEW.bill_id AND status='OPEN') THEN
 RAISE EXCEPTION 'ORDER_NOT_AMENDABLE' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM kitchen_timers WHERE order_id=o.id AND status='ACTIVE') THEN RAISE EXCEPTION 'ORDER_HAS_ACTIVE_TIMER' USING ERRCODE='23514'; END IF;
 SELECT revision,grand_total INTO current_revision,old_total FROM effective_orders WHERE id=o.id;
 IF NEW.revision<>current_revision+1 OR NEW.before_total<>old_total OR NEW.tax_total<>round(NEW.subtotal*o.tax_rate/100,2) THEN
 RAISE EXCEPTION 'INVALID_AMENDMENT_REVISION' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_amendments BEFORE INSERT OR UPDATE OR DELETE ON order_amendments FOR EACH ROW EXECUTE FUNCTION guard_amendment();
CREATE FUNCTION guard_revision_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a order_amendments; previous_quantity integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AMENDMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM order_amendments WHERE id=NEW.amendment_id AND xmin=pg_current_xact_id()::text::xid;
 IF a.id IS NULL OR a.kind<>'CHANGE' OR NOT EXISTS(SELECT 1 FROM orders WHERE id=a.order_id AND status='QUEUED') THEN
 RAISE EXCEPTION 'AMENDMENT_ALREADY_SEALED' USING ERRCODE='23514'; END IF;
 IF a.revision=1 THEN SELECT quantity INTO previous_quantity FROM order_items WHERE order_id=a.order_id AND id=NEW.id;
 ELSE SELECT i.quantity INTO previous_quantity FROM order_item_revisions i JOIN order_amendments p ON p.id=i.amendment_id WHERE p.order_id=a.order_id AND p.revision=a.revision-1 AND i.id=NEW.id; END IF;
 IF previous_quantity IS NULL OR NEW.quantity>previous_quantity THEN RAISE EXCEPTION 'USE_NEW_ROUND' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM item_variants WHERE id=NEW.variant_id AND menu_item_id=NEW.menu_item_id) THEN RAISE EXCEPTION 'ORDER_VARIANT_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_revision_items BEFORE INSERT OR UPDATE OR DELETE ON order_item_revisions FOR EACH ROW EXECUTE FUNCTION guard_revision_item();
CREATE FUNCTION validate_amendment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a order_amendments; n integer; total numeric;
BEGIN
 IF TG_TABLE_NAME='order_amendments' THEN a=NEW; ELSE SELECT * INTO a FROM order_amendments WHERE id=NEW.amendment_id; END IF;
 SELECT count(*),coalesce(sum(line_subtotal),0) INTO n,total FROM order_item_revisions WHERE amendment_id=a.id;
 IF total<>a.subtotal OR (a.kind='CHANGE' AND n NOT BETWEEN 1 AND 100) OR (a.kind='CANCEL' AND (n<>0 OR a.grand_total<>0 OR NOT EXISTS(SELECT 1 FROM order_status_history WHERE order_id=a.order_id AND to_status='CANCELLED' AND actor_id=a.performed_by))) THEN
 RAISE EXCEPTION 'AMENDMENT_AGGREGATE_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER valid_amendment AFTER INSERT ON order_amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_amendment();
CREATE CONSTRAINT TRIGGER valid_amendment_lines AFTER INSERT ON order_item_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_amendment();
CREATE OR REPLACE VIEW bill_balances AS
 SELECT b.id,
 coalesce(o.total,0)::numeric AS bill_total,
 coalesce(p.collected,0)::numeric AS total_collected,
 coalesce(p.refunded,0)::numeric AS total_refunded,
 (coalesce(p.collected,0)-coalesce(p.refunded,0))::numeric AS net_paid,
 greatest(coalesce(o.total,0)-coalesce(p.collected,0)+coalesce(p.refunded,0),0)::numeric AS amount_due,
 greatest(coalesce(p.collected,0)-coalesce(p.refunded,0)-coalesce(o.total,0),0)::numeric AS refund_due
 FROM bills b
 LEFT JOIN LATERAL (SELECT sum(grand_total) AS total FROM effective_orders WHERE bill_id=b.id) o ON true
 LEFT JOIN LATERAL (SELECT sum(amount) FILTER(WHERE type='COLLECTION') AS collected,sum(amount) FILTER(WHERE type='REFUND') AS refunded FROM payments WHERE bill_id=b.id) p ON true;
CREATE OR REPLACE FUNCTION guard_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bill_status text; due numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(742019323);
 SELECT status INTO bill_status FROM bills WHERE id=NEW.bill_id FOR UPDATE;
 IF bill_status IS DISTINCT FROM 'OPEN' THEN RAISE EXCEPTION 'BILL_NOT_OPEN' USING ERRCODE='23514'; END IF;

 SELECT CASE WHEN NEW.type='REFUND' THEN refund_due ELSE amount_due END INTO due FROM bill_balances WHERE id=NEW.bill_id;
 IF NEW.amount>due THEN RAISE EXCEPTION 'PAYMENT_EXCEEDS_DUE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_bill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BILL_IMMUTABLE' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(742019323);
 IF (to_jsonb(NEW)-ARRAY['status','closed_by','closed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','closed_by','closed_at'])
 OR OLD.status<>'OPEN' OR NEW.status<>'CLOSED' THEN RAISE EXCEPTION 'BILL_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM bill_balances WHERE id=OLD.id AND (amount_due<>0 OR refund_due<>0))
 OR EXISTS(SELECT 1 FROM orders WHERE bill_id=OLD.id AND status NOT IN ('COMPLETED','CANCELLED'))
 THEN RAISE EXCEPTION 'BILL_NOT_SETTLED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_takeaway_handover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.to_status='COMPLETED' THEN
  PERFORM pg_advisory_xact_lock(742019323);
  PERFORM b.id FROM bills b JOIN orders o ON o.bill_id=b.id WHERE o.id=NEW.order_id FOR UPDATE OF b;
  IF EXISTS(SELECT 1 FROM orders o JOIN bills b ON b.id=o.bill_id JOIN bill_balances f ON f.id=b.id
   WHERE o.id=NEW.order_id AND b.service_type='TAKEAWAY' AND (f.amount_due>0 OR f.refund_due>0))
  THEN RAISE EXCEPTION 'PAYMENT_REQUIRED' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
-- Extend history-driven Orders lifecycle without modifying existing records.
-- READY/completion timestamps remain the unique history timestamps.
CREATE OR REPLACE FUNCTION protect_order_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ORDER_RECORD_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR NOT (
 (OLD.status='QUEUED' AND NEW.status IN ('PREPARING','CANCELLED')) OR
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
   (NEW.from_status='QUEUED' AND NEW.to_status IN ('PREPARING','CANCELLED')) OR
   (NEW.from_status='PREPARING' AND NEW.to_status='READY') OR
   (NEW.from_status='READY' AND NEW.to_status='COMPLETED')) OR NEW.occurred_at<last_time THEN
   RAISE EXCEPTION 'INVALID_ORDER_TRANSITION' USING ERRCODE='23514'; END IF;
  IF NEW.to_status='CANCELLED' AND NOT EXISTS(SELECT 1 FROM order_amendments WHERE order_id=NEW.order_id AND kind='CANCEL' AND performed_by=NEW.actor_id AND xmin=pg_current_xact_id()::text::xid) THEN RAISE EXCEPTION 'CANCELLATION_REQUIRES_AMENDMENT' USING ERRCODE='23514'; END IF;
  IF NEW.to_status='PREPARING' THEN
   SELECT id INTO oldest FROM orders WHERE status='QUEUED' ORDER BY queued_at,id LIMIT 1;
   IF oldest IS DISTINCT FROM NEW.order_id THEN RAISE EXCEPTION 'OLDER_ORDER_WAITING' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER amendment_reminder_balance AFTER INSERT ON order_amendments FOR EACH ROW EXECUTE FUNCTION synchronize_bill_reminder();
INSERT INTO permissions(code) VALUES('orders.amend');
INSERT INTO role_permissions(role_code,permission_code)
 SELECT r,p FROM unnest(ARRAY['OWNER','MANAGER','CASHIER']) r CROSS JOIN unnest(ARRAY['orders.amend','orders.cancel','payments.refund']) p ON CONFLICT DO NOTHING;

ALTER TABLE payments ADD CONSTRAINT refund_has_no_confirmation CHECK(type<>'REFUND' OR confirmation_order_id IS NULL);
