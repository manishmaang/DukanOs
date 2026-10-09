-- Operational platform orders share lifecycle, never Counter financial participation.
ALTER TABLE variant_channel_settings ALTER COLUMN price DROP NOT NULL;
ALTER TABLE variant_channel_settings ADD CONSTRAINT counter_requires_price CHECK(channel_code<>'COUNTER' OR price IS NOT NULL);
ALTER TABLE variant_channel_settings ADD COLUMN normal_amount numeric;
ALTER TABLE variant_channel_settings ADD COLUMN reduced_amount numeric;
ALTER TABLE variant_channel_settings ADD COLUMN serving_unit text;
ALTER TABLE variant_channel_settings ADD CONSTRAINT serving_configuration CHECK (
 (normal_amount IS NULL AND reduced_amount IS NULL AND serving_unit IS NULL) OR
 (channel_code IN ('ZOMATO','SWIGGY') AND normal_amount IS NOT NULL AND normal_amount>0 AND normal_amount<=100000 AND scale(normal_amount)<=2
 AND serving_unit IS NOT NULL AND serving_unit IN ('g','ml')
 AND (reduced_amount IS NULL OR (reduced_amount>0 AND reduced_amount<normal_amount AND scale(reduced_amount)<=2)))
);
ALTER TABLE orders DROP CONSTRAINT orders_source_check;
ALTER TABLE orders ADD CONSTRAINT order_source CHECK(source IN ('COUNTER','ZOMATO','SWIGGY'));
ALTER TABLE orders ALTER COLUMN bill_id DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN subtotal DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN discount_total DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN tax_total DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN rounding_adjustment DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN grand_total DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN tax_rate DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN tax_label DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN tax_mode DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN tax_rounding DROP NOT NULL;
ALTER TABLE orders ADD COLUMN external_reference text;
ALTER TABLE orders ADD COLUMN discount_classification text;
ALTER TABLE orders ADD CONSTRAINT order_financial_participation CHECK (
 (source='COUNTER' AND bill_id IS NOT NULL AND external_reference IS NULL AND discount_classification IS NULL AND subtotal IS NOT NULL AND discount_total IS NOT NULL AND tax_total IS NOT NULL AND rounding_adjustment IS NOT NULL AND grand_total IS NOT NULL AND tax_rate IS NOT NULL AND tax_label IS NOT NULL AND tax_mode IS NOT NULL AND tax_rounding IS NOT NULL) OR
 (source IN ('ZOMATO','SWIGGY') AND bill_id IS NULL AND external_reference IS NOT NULL
 AND external_reference ~ '^[A-Z0-9][A-Z0-9_-]{0,79}$'
 AND discount_classification IS NOT NULL AND discount_classification IN ('NONE','APPLIED','UNKNOWN') AND subtotal IS NULL AND discount_total IS NULL AND tax_total IS NULL AND rounding_adjustment IS NULL AND grand_total IS NULL AND tax_rate IS NULL AND tax_label IS NULL AND tax_mode IS NULL AND tax_rounding IS NULL)
);
CREATE UNIQUE INDEX platform_reference_unique ON orders(source,external_reference) WHERE external_reference IS NOT NULL;
CREATE INDEX platform_recent_orders ON orders(queued_at DESC,id DESC) WHERE source<>'COUNTER';
ALTER TABLE order_items ALTER COLUMN unit_price_snapshot DROP NOT NULL;
ALTER TABLE order_items ALTER COLUMN line_subtotal DROP NOT NULL;
ALTER TABLE order_items ADD COLUMN serving_mode text;
ALTER TABLE order_items ADD COLUMN serving_amount numeric;
ALTER TABLE order_items ADD COLUMN serving_unit text;
ALTER TABLE order_items ADD CONSTRAINT serving_snapshot CHECK (
 (serving_mode IS NULL AND serving_amount IS NULL AND serving_unit IS NULL) OR
 (serving_mode IS NOT NULL AND serving_mode IN ('NORMAL','REDUCED') AND serving_amount IS NOT NULL AND serving_amount>0 AND serving_amount<=100000 AND scale(serving_amount)<=2 AND serving_unit IS NOT NULL AND serving_unit IN ('g','ml')));
CREATE OR REPLACE VIEW effective_order_items AS
 SELECT i.* FROM order_items i WHERE NOT EXISTS(SELECT 1 FROM order_amendments a WHERE a.order_id=i.order_id)
 UNION ALL
 SELECT i.id,i.order_id,i.position,i.menu_item_id,i.variant_id,i.item_name_snapshot,i.kitchen_name_snapshot,i.variant_name_snapshot,i.quantity,i.unit_price_snapshot,i.line_subtotal,i.instruction,
 NULL::text,NULL::numeric,NULL::text
 FROM order_item_revisions i JOIN order_amendments a ON a.id=i.amendment_id
 WHERE NOT EXISTS(SELECT 1 FROM order_amendments newer WHERE newer.order_id=a.order_id AND newer.revision>a.revision);
CREATE TABLE platform_order_cancellations (
 order_id uuid PRIMARY KEY REFERENCES orders(id), actor_id uuid REFERENCES users(id),
 occurred_at timestamptz NOT NULL, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 cleanup_timezone text, cleanup_time text,
 CHECK ((actor_id IS NOT NULL AND reason<>'PREVIOUS_BUSINESS_DAY_AUTO_CANCEL' AND cleanup_timezone IS NULL AND cleanup_time IS NULL)
 OR (actor_id IS NULL AND reason='PREVIOUS_BUSINESS_DAY_AUTO_CANCEL' AND cleanup_timezone IS NOT NULL AND cleanup_time IS NOT NULL AND cleanup_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
);
CREATE FUNCTION guard_platform_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CANCELLATION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(742019323);
 SELECT * INTO o FROM orders WHERE id=NEW.order_id FOR UPDATE;
 IF o.id IS NULL OR o.source='COUNTER' OR o.status NOT IN ('QUEUED','PREPARING','READY') THEN RAISE EXCEPTION 'INVALID_PLATFORM_CANCELLATION' USING ERRCODE='23514'; END IF;
 IF NEW.actor_id IS NULL AND (o.business_date >= (NEW.occurred_at AT TIME ZONE NEW.cleanup_timezone)::date OR (NEW.occurred_at AT TIME ZONE NEW.cleanup_timezone)::time < NEW.cleanup_time::time) THEN RAISE EXCEPTION 'INVALID_SYSTEM_CANCELLATION' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_platform_cancellation BEFORE INSERT OR UPDATE OR DELETE ON platform_order_cancellations FOR EACH ROW EXECUTE FUNCTION guard_platform_cancellation();
CREATE FUNCTION validate_platform_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM orders o JOIN order_status_history h ON h.order_id=o.id WHERE o.id=NEW.order_id AND o.status='CANCELLED' AND h.to_status='CANCELLED' AND h.actor_id IS NOT DISTINCT FROM NEW.actor_id AND h.reason=NEW.reason AND h.occurred_at=NEW.occurred_at)
 OR EXISTS(SELECT 1 FROM kitchen_timers WHERE order_id=NEW.order_id AND status='ACTIVE') THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_INCOMPLETE' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER valid_platform_cancellation AFTER INSERT ON platform_order_cancellations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_platform_cancellation();
CREATE OR REPLACE FUNCTION guard_order_bill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bill_status text;
BEGIN
 PERFORM pg_advisory_xact_lock(742019323);
 IF NEW.source='COUNTER' THEN
 SELECT status INTO bill_status FROM bills WHERE id=NEW.bill_id FOR UPDATE;
 IF bill_status IS DISTINCT FROM 'OPEN' THEN RAISE EXCEPTION 'BILL_NOT_OPEN' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION validate_order_line_participation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders; s variant_channel_settings;
BEGIN
 SELECT * INTO o FROM orders WHERE id=NEW.order_id;
 IF o.source='COUNTER' THEN
 IF NEW.unit_price_snapshot IS NULL OR NEW.line_subtotal IS NULL OR NEW.serving_mode IS NOT NULL THEN RAISE EXCEPTION 'INVALID_COUNTER_LINE' USING ERRCODE='23514'; END IF;
 ELSE
 SELECT * INTO s FROM variant_channel_settings WHERE variant_id=NEW.variant_id AND channel_code=o.source;
 IF NEW.unit_price_snapshot IS NOT NULL OR NEW.line_subtotal IS NOT NULL OR NEW.serving_mode IS NULL
 OR s.normal_amount IS NULL OR NOT s.available
 OR NEW.serving_unit IS DISTINCT FROM s.serving_unit
 OR NEW.serving_amount IS DISTINCT FROM (CASE WHEN NEW.serving_mode='NORMAL' THEN s.normal_amount ELSE s.reduced_amount END)
 OR NOT EXISTS(SELECT 1 FROM item_variants v JOIN menu_items i ON i.id=v.menu_item_id JOIN menu_categories c ON c.id=i.category_id JOIN sales_channels ch ON ch.code=o.source WHERE v.id=NEW.variant_id AND v.active AND i.active AND c.active AND ch.active)
 THEN RAISE EXCEPTION 'INVALID_PLATFORM_LINE' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_line_participation BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION validate_order_line_participation();
ALTER TABLE order_status_history DROP CONSTRAINT order_history_actor_transition;
ALTER TABLE order_status_history ADD CONSTRAINT order_history_actor_transition CHECK (
 (actor_id IS NOT NULL AND reason<>'PREVIOUS_BUSINESS_DAY_AUTO_CANCEL' AND (
 (from_status='DRAFT' AND to_status='QUEUED') OR
 (from_status='QUEUED' AND to_status IN ('PREPARING','CANCELLED')) OR
 (from_status='PREPARING' AND to_status IN ('READY','CANCELLED')) OR
 (from_status='READY' AND to_status IN ('COMPLETED','CANCELLED'))))
 OR (actor_id IS NULL AND reason='PREVIOUS_BUSINESS_DAY_AUTO_CANCEL' AND from_status IN ('QUEUED','PREPARING','READY') AND to_status='CANCELLED'));
CREATE OR REPLACE FUNCTION guard_amendment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders; current_revision integer; old_total numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AMENDMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(742019323);
 SELECT * INTO o FROM orders WHERE id=NEW.order_id FOR UPDATE;
 IF o.source IS DISTINCT FROM 'COUNTER' THEN RAISE EXCEPTION 'COUNTER_ORDER_REQUIRED' USING ERRCODE='23514'; END IF;
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
  IF NEW.to_status='CANCELLED' AND current_order.source='COUNTER' AND NOT EXISTS(SELECT 1 FROM order_amendments WHERE order_id=NEW.order_id AND kind='CANCEL' AND (NEW.actor_id IS NOT NULL OR reason=NEW.reason) AND performed_by IS NOT DISTINCT FROM NEW.actor_id AND xmin=pg_current_xact_id()::text::xid) THEN RAISE EXCEPTION 'CANCELLATION_REQUIRES_AMENDMENT' USING ERRCODE='23514'; END IF;
  IF NEW.to_status='CANCELLED' AND current_order.source<>'COUNTER' AND NOT EXISTS(SELECT 1 FROM platform_order_cancellations WHERE order_id=NEW.order_id AND actor_id IS NOT DISTINCT FROM NEW.actor_id AND reason=NEW.reason AND occurred_at=NEW.occurred_at AND xmin=pg_current_xact_id()::text::xid) THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_REQUIRED' USING ERRCODE='23514'; END IF;
  IF NEW.to_status='PREPARING' THEN
   SELECT id INTO oldest FROM orders WHERE status='QUEUED' ORDER BY queued_at,id LIMIT 1;
   IF oldest IS DISTINCT FROM NEW.order_id THEN RAISE EXCEPTION 'OLDER_ORDER_WAITING' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION protect_kitchen_timer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TIMER_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF OLD.status<>'ACTIVE' OR NEW.status='ACTIVE' OR (to_jsonb(NEW)-ARRAY['status','resolved_by','resolved_at','resolution_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','resolved_by','resolved_at','resolution_reason']) THEN
  RAISE EXCEPTION 'INVALID_TIMER_TRANSITION' USING ERRCODE='23514'; END IF;
 IF NEW.resolved_by IS NULL AND NOT EXISTS(SELECT 1 FROM platform_order_cancellations a JOIN orders o ON o.id=a.order_id WHERE a.order_id=NEW.order_id AND o.status='CANCELLED' AND a.actor_id IS NULL AND a.reason=NEW.resolution_reason AND a.xmin=pg_current_xact_id()::text::xid) AND NOT EXISTS(SELECT 1 FROM order_amendments a JOIN orders o ON o.id=a.order_id WHERE a.order_id=NEW.order_id AND o.status='CANCELLED' AND a.performed_by IS NULL AND a.reason=NEW.resolution_reason AND a.xmin=pg_current_xact_id()::text::xid) THEN
  RAISE EXCEPTION 'INVALID_SYSTEM_TIMER_RESOLUTION' USING ERRCODE='23514'; END IF;
 IF NEW.status='ACKNOWLEDGED' AND NEW.resolved_at<NEW.due_at THEN RAISE EXCEPTION 'TIMER_NOT_DUE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
INSERT INTO permissions(code) VALUES ('platform_orders.create'),('platform_orders.read'),('platform_orders.cancel');
INSERT INTO role_permissions(role_code,permission_code) SELECT r,p FROM unnest(ARRAY['OWNER','MANAGER','CASHIER']) r CROSS JOIN unnest(ARRAY['platform_orders.create','platform_orders.read','platform_orders.cancel']) p;
