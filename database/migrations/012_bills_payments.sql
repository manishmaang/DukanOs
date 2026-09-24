-- Bills are commercial tabs; orders remain immutable kitchen rounds.
CREATE TABLE bill_daily_numbers (
 business_date date PRIMARY KEY, last_number integer NOT NULL CHECK(last_number>0)
);
CREATE TABLE bills (
 id uuid PRIMARY KEY, business_date date NOT NULL, bill_number integer NOT NULL CHECK(bill_number>0),
 service_type text CHECK(service_type IN ('DINE_IN','TAKEAWAY')),
 legacy boolean NOT NULL DEFAULT false,
 reference text NOT NULL DEFAULT '' CHECK(length(reference)<=80),
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
 opened_by uuid NOT NULL REFERENCES users(id), opened_at timestamptz NOT NULL,
 closed_by uuid REFERENCES users(id), closed_at timestamptz,
 CHECK((legacy AND service_type IS NULL) OR (NOT legacy AND service_type IS NOT NULL)),
 CHECK((status='OPEN' AND closed_at IS NULL AND closed_by IS NULL) OR (status='CLOSED' AND closed_at>=opened_at AND closed_by IS NOT NULL)),
 UNIQUE(business_date,bill_number)
);
ALTER TABLE orders ADD COLUMN bill_id uuid REFERENCES bills(id);
-- Reuse UUID only for deterministic legacy mapping, never Kitchen token as bill number.
INSERT INTO bills(id,business_date,bill_number,legacy,opened_by,opened_at)
 SELECT id,business_date,row_number() OVER(PARTITION BY business_date ORDER BY queued_at,id),true,confirmed_by,queued_at FROM orders;
ALTER TABLE orders DISABLE TRIGGER immutable_orders;
UPDATE orders SET bill_id=id;
ALTER TABLE orders ENABLE TRIGGER immutable_orders;
ALTER TABLE orders ALTER COLUMN bill_id SET NOT NULL;
INSERT INTO bill_daily_numbers SELECT business_date,max(bill_number) FROM bills GROUP BY business_date;
CREATE INDEX orders_bill_idx ON orders(bill_id,queued_at,id);
CREATE INDEX bills_open_idx ON bills(opened_at,id) WHERE status='OPEN';
CREATE TABLE payments (
 id uuid PRIMARY KEY, bill_id uuid NOT NULL REFERENCES bills(id),
 type text NOT NULL CHECK(type IN ('COLLECTION','REFUND')),
 method text NOT NULL CHECK(method IN ('CASH','UPI')),
 amount numeric NOT NULL CHECK(amount>0 AND amount<=999999999999.99 AND scale(amount)<=2),
 CHECK(type<>'REFUND' OR method='CASH'),
 performed_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request_id uuid NOT NULL, request_hash text NOT NULL CHECK(length(request_hash)=64),
 UNIQUE(performed_by,request_id)
);
CREATE INDEX payments_bill_idx ON payments(bill_id,created_at,id);
CREATE VIEW bill_balances AS
 SELECT b.id,
 coalesce(o.total,0)::numeric AS bill_total,
 coalesce(p.collected,0)::numeric AS total_collected,
 coalesce(p.refunded,0)::numeric AS total_refunded,
 (coalesce(p.collected,0)-coalesce(p.refunded,0))::numeric AS net_paid,
 greatest(coalesce(o.total,0)-coalesce(p.collected,0)+coalesce(p.refunded,0),0)::numeric AS amount_due,
 greatest(coalesce(p.collected,0)-coalesce(p.refunded,0)-coalesce(o.total,0),0)::numeric AS refund_due
 FROM bills b
 LEFT JOIN LATERAL (SELECT sum(grand_total) AS total FROM orders WHERE bill_id=b.id) o ON true
 LEFT JOIN LATERAL (SELECT sum(amount) FILTER(WHERE type='COLLECTION') AS collected,sum(amount) FILTER(WHERE type='REFUND') AS refunded FROM payments WHERE bill_id=b.id) p ON true;
CREATE FUNCTION guard_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bill_status text; due numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(742019323);
 SELECT status INTO bill_status FROM bills WHERE id=NEW.bill_id FOR UPDATE;
 IF bill_status IS DISTINCT FROM 'OPEN' THEN RAISE EXCEPTION 'BILL_NOT_OPEN' USING ERRCODE='23514'; END IF;
 IF NEW.type<>'COLLECTION' THEN RAISE EXCEPTION 'REFUNDS_NOT_IMPLEMENTED' USING ERRCODE='23514'; END IF;
 SELECT amount_due INTO due FROM bill_balances WHERE id=NEW.bill_id;
 IF NEW.amount>due THEN RAISE EXCEPTION 'PAYMENT_EXCEEDS_DUE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_payments BEFORE INSERT OR UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION guard_payment();
CREATE FUNCTION guard_bill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BILL_IMMUTABLE' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(742019323);
 IF (to_jsonb(NEW)-ARRAY['status','closed_by','closed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','closed_by','closed_at'])
 OR OLD.status<>'OPEN' OR NEW.status<>'CLOSED' THEN RAISE EXCEPTION 'BILL_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM bill_balances WHERE id=OLD.id AND (amount_due<>0 OR refund_due<>0))
 OR EXISTS(SELECT 1 FROM orders WHERE bill_id=OLD.id AND status<>'COMPLETED')
 THEN RAISE EXCEPTION 'BILL_NOT_SETTLED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_bills BEFORE UPDATE OR DELETE ON bills FOR EACH ROW EXECUTE FUNCTION guard_bill();
CREATE FUNCTION guard_order_bill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bill_status text;
BEGIN
 PERFORM pg_advisory_xact_lock(742019323);
 SELECT status INTO bill_status FROM bills WHERE id=NEW.bill_id FOR UPDATE;
 IF bill_status IS DISTINCT FROM 'OPEN' THEN RAISE EXCEPTION 'BILL_NOT_OPEN' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER require_open_bill BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION guard_order_bill();
CREATE FUNCTION guard_takeaway_handover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.to_status='COMPLETED' THEN
  PERFORM pg_advisory_xact_lock(742019323);
  PERFORM b.id FROM bills b JOIN orders o ON o.bill_id=b.id WHERE o.id=NEW.order_id FOR UPDATE OF b;
  IF EXISTS(SELECT 1 FROM orders o JOIN bills b ON b.id=o.bill_id JOIN bill_balances f ON f.id=b.id
   WHERE o.id=NEW.order_id AND b.service_type='TAKEAWAY' AND f.amount_due>0)
  THEN RAISE EXCEPTION 'PAYMENT_REQUIRED' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER require_takeaway_payment BEFORE INSERT ON order_status_history FOR EACH ROW EXECUTE FUNCTION guard_takeaway_handover();
INSERT INTO permissions(code) VALUES ('bills.read'),('bills.manage'),('payments.read');
INSERT INTO role_permissions(role_code,permission_code)
 SELECT r,p FROM unnest(ARRAY['OWNER','MANAGER','CASHIER']) r CROSS JOIN unnest(ARRAY['bills.read','bills.manage','payments.read','payments.collect']) p ON CONFLICT DO NOTHING;
-- Kitchen projections contain no financial fields; generic financial order reads are restricted.
DELETE FROM role_permissions WHERE role_code='KITCHEN' AND permission_code='orders.read';
CREATE FUNCTION protect_bill_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BILL_NUMBER_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.business_date<>OLD.business_date OR NEW.last_number<=OLD.last_number THEN
  RAISE EXCEPTION 'BILL_NUMBER_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER monotonic_bill_numbers BEFORE UPDATE OR DELETE ON bill_daily_numbers FOR EACH ROW EXECUTE FUNCTION protect_bill_number();
