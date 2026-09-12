INSERT INTO permissions(code) VALUES ('menu.read');
INSERT INTO role_permissions(role_code,permission_code) VALUES
 ('OWNER','menu.read'),('MANAGER','menu.read'),('CASHIER','menu.read'),('KITCHEN','menu.read');
CREATE TABLE menu_categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK (name=btrim(name) AND length(name) BETWEEN 1 AND 100),
 description text CHECK (length(description)<=1000),
 sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order>=0),
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX menu_category_name_unique ON menu_categories(lower(name));
CREATE TABLE menu_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 category_id uuid NOT NULL REFERENCES menu_categories(id),
 name text NOT NULL CHECK(name=btrim(name) AND length(name) BETWEEN 1 AND 120),
 description text CHECK(length(description)<=1000),
 kitchen_name text CHECK(length(kitchen_name) BETWEEN 1 AND 120),
 sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order>=0),
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX menu_item_name_unique ON menu_items(category_id,lower(name));
CREATE INDEX menu_item_category_order_idx ON menu_items(category_id,sort_order,id);
CREATE TABLE item_variants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), menu_item_id uuid NOT NULL REFERENCES menu_items(id),
 name text NOT NULL CHECK(name=btrim(name) AND length(name) BETWEEN 1 AND 80),
 display_label text CHECK(length(display_label) BETWEEN 1 AND 40),
 sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order>=0), active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX menu_variant_name_unique ON item_variants(menu_item_id,lower(name));
CREATE INDEX menu_variant_item_order_idx ON item_variants(menu_item_id,sort_order,id);
CREATE TABLE sales_channels (
 code text PRIMARY KEY CHECK(code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100),
 active boolean NOT NULL DEFAULT true, sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order>=0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sales_channels(code,name,sort_order) VALUES ('COUNTER','Counter',0),('ZOMATO','Zomato',1),('SWIGGY','Swiggy',2);
CREATE TABLE variant_channel_settings (
 variant_id uuid NOT NULL REFERENCES item_variants(id), channel_code text NOT NULL REFERENCES sales_channels(code),
 -- Unconstrained numeric plus a scale check rejects excessive precision instead of silently rounding it.
 price numeric NOT NULL CHECK(price>=0 AND price<1000000000000 AND scale(price)<=2),
 available boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(variant_id,channel_code)
);
CREATE INDEX menu_channel_available_idx ON variant_channel_settings(channel_code,variant_id) WHERE available;
CREATE FUNCTION menu_touch_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.version:=OLD.version+1; NEW.updated_at:=clock_timestamp(); RETURN NEW; END $$;
CREATE TRIGGER category_version BEFORE UPDATE ON menu_categories FOR EACH ROW EXECUTE FUNCTION menu_touch_version();
CREATE TRIGGER item_version BEFORE UPDATE ON menu_items FOR EACH ROW EXECUTE FUNCTION menu_touch_version();
CREATE FUNCTION menu_child_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_id uuid;
BEGIN
 IF TG_TABLE_NAME='item_variants' THEN
  IF TG_OP='UPDATE' AND NEW.menu_item_id<>OLD.menu_item_id THEN RAISE EXCEPTION 'VARIANT_PARENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN item_id:=OLD.menu_item_id; ELSE item_id:=NEW.menu_item_id; END IF;
 ELSE
  IF TG_OP='UPDATE' AND (NEW.variant_id<>OLD.variant_id OR NEW.channel_code<>OLD.channel_code) THEN RAISE EXCEPTION 'CHANNEL_SETTING_KEY_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN SELECT menu_item_id INTO item_id FROM item_variants WHERE id=OLD.variant_id;
  ELSE SELECT menu_item_id INTO item_id FROM item_variants WHERE id=NEW.variant_id; END IF;
 END IF;
 UPDATE menu_items SET updated_at=clock_timestamp() WHERE id=item_id;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE' THEN NEW.updated_at:=clock_timestamp(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER variant_changed BEFORE INSERT OR UPDATE OR DELETE ON item_variants FOR EACH ROW EXECUTE FUNCTION menu_child_changed();
CREATE TRIGGER channel_setting_changed BEFORE INSERT OR UPDATE OR DELETE ON variant_channel_settings FOR EACH ROW EXECUTE FUNCTION menu_child_changed();
CREATE FUNCTION menu_requires_variant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_id uuid;
BEGIN
 IF TG_TABLE_NAME='menu_items' THEN item_id:=NEW.id; ELSE item_id:=OLD.menu_item_id; END IF;
 IF EXISTS(SELECT 1 FROM menu_items WHERE id=item_id) AND NOT EXISTS(SELECT 1 FROM item_variants WHERE menu_item_id=item_id) THEN
  RAISE EXCEPTION 'ITEM_REQUIRES_VARIANT' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER item_requires_variant AFTER INSERT ON menu_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION menu_requires_variant();
CREATE CONSTRAINT TRIGGER item_retains_variant AFTER DELETE ON item_variants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION menu_requires_variant();
CREATE TABLE menu_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES users(id),
 category_id uuid REFERENCES menu_categories(id), item_id uuid REFERENCES menu_items(id),
 action text NOT NULL CHECK(action IN ('CREATED','UPDATED')),
 before_value jsonb, after_value jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((category_id IS NULL) <> (item_id IS NULL))
);
CREATE INDEX menu_audit_item_idx ON menu_audit(item_id,created_at);
CREATE INDEX menu_audit_category_idx ON menu_audit(category_id,created_at);
CREATE FUNCTION menu_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AUDIT_IMMUTABLE' USING ERRCODE='23514'; END $$;
CREATE TRIGGER protect_menu_audit BEFORE UPDATE OR DELETE ON menu_audit FOR EACH ROW EXECUTE FUNCTION menu_audit_immutable();
