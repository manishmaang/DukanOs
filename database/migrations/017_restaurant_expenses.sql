INSERT INTO permissions(code) VALUES ('expenses.read'),('expenses.create'),('expenses.manage'),('expense_categories.manage');
INSERT INTO role_permissions(role_code,permission_code)
 SELECT r.code,p.code FROM roles r CROSS JOIN permissions p
 WHERE (r.code IN ('OWNER','MANAGER') AND p.code IN ('expenses.read','expenses.create','expenses.manage','expense_categories.manage'))
 OR (r.code='CASHIER' AND p.code IN ('expenses.read','expenses.create'));
CREATE TABLE expense_categories (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX expense_category_name_unique ON expense_categories(lower(btrim(name)));
INSERT INTO expense_categories(id,name) SELECT gen_random_uuid(),name FROM unnest(ARRAY[
 'Vegetables / Raw Material','Bread / Bakery','Staff Food / Tea','Packaging','Gas / Fuel','Cleaning','Maintenance','Transport','Utilities','Miscellaneous']) AS name;
CREATE TABLE expense_category_audit (
 id uuid PRIMARY KEY, category_id uuid NOT NULL REFERENCES expense_categories(id),
 performed_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 before_state jsonb, after_state jsonb NOT NULL
);
CREATE TABLE expense_receipts (
 key uuid PRIMARY KEY, uploaded_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), width integer NOT NULL CHECK(width>0),
 height integer NOT NULL CHECK(height>0), byte_size integer NOT NULL CHECK(byte_size>0)
);
CREATE TABLE expenses (
 id uuid PRIMARY KEY, business_date date NOT NULL, restaurant_timezone text NOT NULL,
 amount numeric NOT NULL CHECK(amount>0 AND amount<1000000000000 AND scale(amount)<=2),
 category_id uuid NOT NULL REFERENCES expense_categories(id), category_name_snapshot text NOT NULL CHECK(length(btrim(category_name_snapshot)) BETWEEN 1 AND 100),
 payment_method text NOT NULL CHECK(payment_method IN ('CASH','UPI')),
 vendor text NOT NULL DEFAULT '' CHECK(length(vendor)<=120), note text NOT NULL DEFAULT '' CHECK(length(note)<=500),
 receipt_key uuid UNIQUE REFERENCES expense_receipts(key),
 recorded_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request_id uuid NOT NULL, request_hash text NOT NULL CHECK(length(request_hash)=64), UNIQUE(recorded_by,request_id),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','VOIDED')),
 voided_by uuid REFERENCES users(id), voided_at timestamptz, void_reason text, void_note text,
 void_request_id uuid, void_request_hash text, UNIQUE(voided_by,void_request_id),
 CHECK((status='ACTIVE' AND voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL AND void_note IS NULL AND void_request_id IS NULL AND void_request_hash IS NULL)
 OR (status='VOIDED' AND voided_by IS NOT NULL AND voided_at IS NOT NULL AND voided_at>=created_at
 AND void_reason IS NOT NULL AND void_reason IN ('DUPLICATE_ENTRY','WRONG_AMOUNT','WRONG_CATEGORY','NOT_A_BUSINESS_EXPENSE','OTHER')
 AND void_note IS NOT NULL AND length(void_note)<=500 AND (void_reason<>'OTHER' OR length(btrim(void_note))>0)
 AND void_request_id IS NOT NULL AND void_request_hash IS NOT NULL AND length(void_request_hash)=64))
);
CREATE INDEX expenses_date_idx ON expenses(business_date DESC,created_at DESC,id DESC);
CREATE INDEX expenses_category_date_idx ON expenses(category_id,business_date);
CREATE FUNCTION guard_expense() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category expense_categories; BEGIN
 PERFORM pg_advisory_xact_lock(742019323);
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EXPENSE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO category FROM expense_categories WHERE id=NEW.category_id FOR SHARE;
  IF category.id IS NULL OR NOT category.active OR NEW.category_name_snapshot<>category.name OR NEW.status<>'ACTIVE'
  THEN RAISE EXCEPTION 'INVALID_EXPENSE_CATEGORY' USING ERRCODE='23514'; END IF;
  IF NEW.business_date NOT BETWEEN (NEW.created_at AT TIME ZONE NEW.restaurant_timezone)::date-30 AND (NEW.created_at AT TIME ZONE NEW.restaurant_timezone)::date
  THEN RAISE EXCEPTION 'INVALID_EXPENSE_DATE' USING ERRCODE='23514'; END IF;
  IF NEW.receipt_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM expense_receipts WHERE key=NEW.receipt_key AND uploaded_by=NEW.recorded_by)
  THEN RAISE EXCEPTION 'INVALID_EXPENSE_RECEIPT' USING ERRCODE='23514'; END IF;
 ELSE
  IF OLD.status<>'ACTIVE' OR NEW.status<>'VOIDED' OR
  (to_jsonb(NEW)-ARRAY['status','voided_by','voided_at','void_reason','void_note','void_request_id','void_request_hash']) IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['status','voided_by','voided_at','void_reason','void_note','void_request_id','void_request_hash'])
  THEN RAISE EXCEPTION 'EXPENSE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_expenses BEFORE INSERT OR UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION guard_expense();
CREATE FUNCTION guard_expense_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'EXPENSE_AUDIT_IMMUTABLE' USING ERRCODE='23514'; END $$;
CREATE TRIGGER protect_expense_category_audit BEFORE UPDATE OR DELETE ON expense_category_audit FOR EACH ROW EXECUTE FUNCTION guard_expense_audit();
CREATE FUNCTION guard_expense_category() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(742019323);
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EXPENSE_CATEGORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'STALE_EXPENSE_CATEGORY' USING ERRCODE='23514'; END IF;
 NEW.updated_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER protect_expense_categories BEFORE UPDATE OR DELETE ON expense_categories FOR EACH ROW EXECUTE FUNCTION guard_expense_category();
CREATE FUNCTION guard_expense_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(742019323);
 IF EXISTS(SELECT 1 FROM expenses WHERE receipt_key=OLD.key) THEN RAISE EXCEPTION 'EXPENSE_RECEIPT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER protect_expense_receipts BEFORE UPDATE OR DELETE ON expense_receipts FOR EACH ROW EXECUTE FUNCTION guard_expense_receipt();
