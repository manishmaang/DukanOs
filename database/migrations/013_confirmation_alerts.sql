-- Optional confirmation collections share the order transaction and remain bill-level.
ALTER TABLE payments ADD COLUMN confirmation_order_id uuid REFERENCES orders(id);
CREATE UNIQUE INDEX payments_confirmation_method_idx ON payments(confirmation_order_id,method) WHERE confirmation_order_id IS NOT NULL;
CREATE FUNCTION check_confirmation_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.confirmation_order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM orders WHERE id=NEW.confirmation_order_id AND bill_id=NEW.bill_id AND confirmed_by=NEW.performed_by)
 THEN RAISE EXCEPTION 'INVALID_CONFIRMATION_PAYMENT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER confirmation_payment_reference BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION check_confirmation_payment();
CREATE TABLE bill_reminders (
 bill_id uuid PRIMARY KEY REFERENCES bills(id),
 interval_minutes integer NOT NULL CHECK(interval_minutes BETWEEN 1 AND 1440),
 next_due_at timestamptz,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 version integer NOT NULL DEFAULT 1 CHECK(version>0)
);
CREATE INDEX bill_reminders_due_idx ON bill_reminders(next_due_at) WHERE next_due_at IS NOT NULL;
CREATE FUNCTION guard_bill_reminder() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(742019323);
 IF NOT EXISTS(SELECT 1 FROM bills WHERE id=NEW.bill_id AND service_type='DINE_IN') THEN
  RAISE EXCEPTION 'REMINDER_REQUIRES_DINE_IN' USING ERRCODE='23514'; END IF;
 IF NEW.next_due_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bills b JOIN bill_balances f ON f.id=b.id WHERE b.id=NEW.bill_id AND b.status='OPEN' AND f.amount_due>0) THEN
  RAISE EXCEPTION 'REMINDER_REQUIRES_DUE' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.bill_id<>OLD.bill_id OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'REMINDER_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF;
  NEW.version=OLD.version+1; NEW.updated_at=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_bill_reminder BEFORE INSERT OR UPDATE ON bill_reminders FOR EACH ROW EXECUTE FUNCTION guard_bill_reminder();
CREATE FUNCTION synchronize_bill_reminder() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; active boolean;
BEGIN
 IF TG_TABLE_NAME='bills' THEN target=NEW.id; ELSE target=NEW.bill_id; END IF;
 SELECT b.status='OPEN' AND f.amount_due>0 INTO active FROM bills b JOIN bill_balances f ON f.id=b.id WHERE b.id=target;
 UPDATE bill_reminders SET next_due_at=CASE WHEN active THEN clock_timestamp()+make_interval(mins=>interval_minutes) ELSE NULL END
 WHERE bill_id=target AND ((active AND next_due_at IS NULL) OR (NOT active AND next_due_at IS NOT NULL));
 RETURN NEW;
END $$;
CREATE TRIGGER order_reminder_balance AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION synchronize_bill_reminder();
CREATE TRIGGER payment_reminder_balance AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION synchronize_bill_reminder();
CREATE TRIGGER closed_bill_reminder AFTER UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION synchronize_bill_reminder();
ALTER TABLE order_items ADD CONSTRAINT order_items_order_identity UNIQUE(order_id,id);
CREATE TABLE kitchen_timers (
 id uuid PRIMARY KEY, order_id uuid REFERENCES orders(id), order_item_id uuid,
 FOREIGN KEY(order_id,order_item_id) REFERENCES order_items(order_id,id),
 CHECK(order_item_id IS NULL OR order_id IS NOT NULL),
 label text NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 120),
 duration_seconds integer NOT NULL CHECK(duration_seconds BETWEEN 60 AND 86400),
 started_at timestamptz NOT NULL, due_at timestamptz NOT NULL,
 CHECK(due_at=started_at+duration_seconds*interval '1 second'),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ACKNOWLEDGED','CANCELLED')),
 created_by uuid NOT NULL REFERENCES users(id), request_id uuid NOT NULL, request_hash text NOT NULL CHECK(length(request_hash)=64),
 resolved_by uuid REFERENCES users(id), resolved_at timestamptz,
 CHECK((status='ACTIVE' AND resolved_by IS NULL AND resolved_at IS NULL) OR (status<>'ACTIVE' AND resolved_by IS NOT NULL AND resolved_at>=started_at)),
 UNIQUE(created_by,request_id)
);
CREATE INDEX kitchen_timers_active_idx ON kitchen_timers(due_at,id) WHERE status='ACTIVE';
CREATE FUNCTION protect_kitchen_timer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TIMER_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF OLD.status<>'ACTIVE' OR NEW.status='ACTIVE' OR (to_jsonb(NEW)-ARRAY['status','resolved_by','resolved_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','resolved_by','resolved_at']) THEN
  RAISE EXCEPTION 'INVALID_TIMER_TRANSITION' USING ERRCODE='23514'; END IF;
 IF NEW.status='ACKNOWLEDGED' AND NEW.resolved_at<NEW.due_at THEN RAISE EXCEPTION 'TIMER_NOT_DUE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_kitchen_timer BEFORE UPDATE OR DELETE ON kitchen_timers FOR EACH ROW EXECUTE FUNCTION protect_kitchen_timer();
INSERT INTO permissions(code) VALUES('bills.reminders.read'),('bills.reminders.manage'),('kitchen.timers.read'),('kitchen.timers.manage');
INSERT INTO role_permissions(role_code,permission_code)
 SELECT r,p FROM unnest(ARRAY['OWNER','MANAGER','CASHIER']) r CROSS JOIN unnest(ARRAY['bills.reminders.read','bills.reminders.manage']) p;
INSERT INTO role_permissions(role_code,permission_code)
 SELECT r,p FROM unnest(ARRAY['OWNER','MANAGER','KITCHEN']) r CROSS JOIN unnest(ARRAY['kitchen.timers.read','kitchen.timers.manage']) p;
