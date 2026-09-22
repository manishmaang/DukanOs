-- Existing catalog, users and audit records are untouched.
CREATE TABLE order_daily_tokens (
 business_date date PRIMARY KEY,
 last_token integer NOT NULL CHECK (last_token > 0)
);
CREATE TABLE orders (
 id uuid PRIMARY KEY,
 source text NOT NULL REFERENCES sales_channels(code) CHECK (source = 'COUNTER'),
 status text NOT NULL CHECK (status IN ('DRAFT','QUEUED','PREPARING','READY','COMPLETED','CANCELLED')),
 business_date date NOT NULL,
 token_number integer NOT NULL CHECK (token_number > 0),
 confirmed_by uuid NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 queued_at timestamptz NOT NULL,
 subtotal numeric NOT NULL CHECK (subtotal >= 0 AND subtotal < 1000000000000000000 AND scale(subtotal) <= 2),
 discount_total numeric NOT NULL DEFAULT 0 CHECK (discount_total = 0),
 tax_total numeric NOT NULL CHECK (tax_total >= 0 AND tax_total < 1000000000000000000 AND scale(tax_total) <= 2),
 rounding_adjustment numeric NOT NULL DEFAULT 0 CHECK (rounding_adjustment = 0),
 grand_total numeric NOT NULL CHECK (grand_total = subtotal + tax_total AND grand_total < 1000000000000000000 AND scale(grand_total) <= 2),
 tax_rate numeric NOT NULL CHECK (tax_rate >= 0 AND tax_rate <= 100 AND scale(tax_rate) <= 2),
 tax_label text NOT NULL CHECK (length(btrim(tax_label)) BETWEEN 1 AND 80),
 timezone text NOT NULL,
 tax_mode text NOT NULL CHECK (tax_mode = 'EXCLUSIVE'),
 tax_rounding text NOT NULL CHECK (tax_rounding = 'HALF_UP_PAISE'),
 UNIQUE (business_date, token_number),
 UNIQUE (confirmed_by, request_id),
 CHECK (tax_total = round(subtotal * tax_rate / 100, 2))
);
CREATE INDEX orders_queue_idx ON orders(status, queued_at, id);
CREATE INDEX orders_actor_idx ON orders(confirmed_by, queued_at);
CREATE TABLE order_items (
 id uuid PRIMARY KEY,
 order_id uuid NOT NULL REFERENCES orders(id),
 position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
 menu_item_id uuid NOT NULL REFERENCES menu_items(id),
 variant_id uuid NOT NULL REFERENCES item_variants(id),
 item_name_snapshot text NOT NULL CHECK (length(btrim(item_name_snapshot)) BETWEEN 1 AND 120),
 kitchen_name_snapshot text NOT NULL CHECK (length(btrim(kitchen_name_snapshot)) BETWEEN 1 AND 120),
 variant_name_snapshot text NOT NULL CHECK (length(btrim(variant_name_snapshot)) BETWEEN 1 AND 80),
 quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
 unit_price_snapshot numeric NOT NULL CHECK (unit_price_snapshot >= 0 AND unit_price_snapshot < 1000000000000 AND scale(unit_price_snapshot) <= 2),
 line_subtotal numeric NOT NULL CHECK (line_subtotal = quantity * unit_price_snapshot AND scale(line_subtotal) <= 2),
 instruction text NOT NULL DEFAULT '' CHECK (length(instruction) <= 500),
 UNIQUE(order_id, position)
);
CREATE INDEX order_items_variant_idx ON order_items(variant_id);
CREATE INDEX order_items_menu_idx ON order_items(menu_item_id);
CREATE TABLE order_status_history (
 id uuid PRIMARY KEY,
 order_id uuid NOT NULL REFERENCES orders(id),
 from_status text NOT NULL,
 to_status text NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id),
 occurred_at timestamptz NOT NULL,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
 CHECK ((from_status='DRAFT' AND to_status IN ('QUEUED','CANCELLED')) OR
 (from_status='QUEUED' AND to_status IN ('PREPARING','CANCELLED')) OR
 (from_status='PREPARING' AND to_status='READY') OR
 (from_status='READY' AND to_status='COMPLETED'))
);
CREATE INDEX order_history_idx ON order_status_history(order_id, occurred_at, id);
CREATE FUNCTION protect_order_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ORDER_RECORD_IMMUTABLE' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_order_items BEFORE UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION protect_order_record();
CREATE TRIGGER immutable_order_history BEFORE UPDATE OR DELETE ON order_status_history FOR EACH ROW EXECUTE FUNCTION protect_order_record();
CREATE TRIGGER immutable_orders BEFORE UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION protect_order_record();
-- Future lifecycle migration will replace the order UPDATE guard with audited transitions.
CREATE FUNCTION validate_confirmed_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; o orders; item_count integer; line_sum numeric;
BEGIN
 IF TG_TABLE_NAME='orders' THEN target:=NEW.id; ELSE target:=NEW.order_id; END IF;
 SELECT * INTO o FROM orders WHERE id=target;
 SELECT count(*),sum(line_subtotal) INTO item_count,line_sum FROM order_items WHERE order_id=target;
 IF o.status<>'QUEUED' OR item_count NOT BETWEEN 1 AND 100 OR line_sum IS DISTINCT FROM o.subtotal OR NOT EXISTS (
 SELECT 1 FROM order_status_history WHERE order_id=target AND from_status='DRAFT' AND to_status='QUEUED' AND actor_id=o.confirmed_by AND occurred_at=o.queued_at
 ) THEN RAISE EXCEPTION 'ORDER_AGGREGATE_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER valid_order AFTER INSERT ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_confirmed_order();
CREATE CONSTRAINT TRIGGER valid_order_lines AFTER INSERT ON order_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_confirmed_order();
-- Kitchen can consume canonical queue data, but cannot create orders.
INSERT INTO role_permissions VALUES ('KITCHEN','orders.read');
CREATE FUNCTION protect_order_append() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Initial history seals the aggregate. Deferred constraints forbid committing before sealing.
 PERFORM id FROM orders WHERE id=NEW.order_id FOR UPDATE;
 IF EXISTS (SELECT 1 FROM order_status_history WHERE order_id=NEW.order_id) THEN
 RAISE EXCEPTION 'ORDER_ALREADY_CONFIRMED' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='order_items' THEN
 IF NOT EXISTS (SELECT 1 FROM item_variants WHERE id=NEW.variant_id AND menu_item_id=NEW.menu_item_id) THEN
 RAISE EXCEPTION 'ORDER_VARIANT_MISMATCH' USING ERRCODE='23514'; END IF; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_order_item_append BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION protect_order_append();
CREATE TRIGGER protect_order_history_append BEFORE INSERT ON order_status_history FOR EACH ROW EXECUTE FUNCTION protect_order_append();
CREATE FUNCTION protect_daily_token() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TOKEN_REUSE_FORBIDDEN' USING ERRCODE='23514'; END IF;
 IF NEW.business_date<>OLD.business_date OR NEW.last_token<=OLD.last_token THEN
 RAISE EXCEPTION 'TOKEN_REUSE_FORBIDDEN' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER monotonic_daily_tokens BEFORE UPDATE OR DELETE ON order_daily_tokens FOR EACH ROW EXECUTE FUNCTION protect_daily_token();
