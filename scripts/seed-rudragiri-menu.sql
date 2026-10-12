-- One-time restaurant data, NOT a migration. See docs/operations/MENU_IMPORT.md.
-- psql -X -v owner_username=YOUR_OWNER -f scripts/seed-rudragiri-menu.sql
-- Default is a full transaction rehearsal followed by ROLLBACK.
-- To persist reviewed data: -v apply=true -v confirm=RUDRAGIRI_118_156
\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply false
\endif
\if :{?confirm}
\else
  \set confirm ''
\endif
\if :{?expected_database}
\else
  \set expected_database dukanos_prod
\endif
\if :{?target_schema}
\else
  \set target_schema dukanos
\endif
\if :{?owner_username}
\else
  \echo 'Required: -v owner_username=YOUR_EXISTING_OWNER_USERNAME'
  \quit 3
\endif
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL timezone = 'UTC';
SELECT set_config('search_path', format('%I,pg_catalog,pg_temp', :'target_schema'), true);
CREATE TEMP TABLE import_context ON COMMIT DROP AS
SELECT :'expected_database'::text expected_database, :'target_schema'::text target_schema,
       lower(btrim(:'owner_username'))::text owner_username, :'apply'::boolean apply,
       :'confirm'::text confirmation;
DO $$
BEGIN
 IF current_database() <> (SELECT expected_database FROM import_context)
 OR (SELECT target_schema FROM import_context) !~ '^[a-z][a-z0-9_]{0,62}$'
 OR (SELECT target_schema FROM import_context) IN ('public','pg_catalog','information_schema')
 OR NOT EXISTS (SELECT 1 FROM pg_namespace n, import_context c WHERE n.nspname=c.target_schema AND n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) THEN
  RAISE EXCEPTION 'IMPORT_TARGET_INVALID: use the expected database/schema and its maintenance owner';
 END IF;
 IF (SELECT apply AND confirmation <> 'RUDRAGIRI_118_156' FROM import_context) THEN
  RAISE EXCEPTION 'IMPORT_CONFIRMATION_REQUIRED';
 END IF;
END $$;
-- Same lock used by Menu and order confirmation; table locks also serialize SQL writers.
SELECT pg_advisory_xact_lock(742019323);
LOCK TABLE menu_categories,menu_items,item_variants,variant_channel_settings,menu_audit,sales_channels IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE import_actor ON COMMIT DROP AS
SELECT u.id FROM users u JOIN import_context c ON u.username=c.owner_username WHERE u.active;
SELECT u.id FROM users u JOIN import_actor a ON a.id=u.id FOR SHARE OF u;
DO $$
BEGIN
 IF (SELECT count(*) FROM import_actor) <> 1 OR NOT EXISTS (
  SELECT 1 FROM import_actor a JOIN user_roles ur ON ur.user_id=a.id
  WHERE ur.role_code='OWNER' AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_code=ur.role_code AND rp.permission_code='menu.manage')
 ) THEN RAISE EXCEPTION 'IMPORT_OWNER_REQUIRED: existing active OWNER with menu.manage required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM sales_channels WHERE code='COUNTER' AND active) THEN
  RAISE EXCEPTION 'IMPORT_COUNTER_INACTIVE'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN ('menu_categories'::regclass,'menu_items'::regclass,'item_variants'::regclass,'variant_channel_settings'::regclass,'menu_audit'::regclass) AND tgenabled='D') THEN
  RAISE EXCEPTION 'IMPORT_DISABLED_TRIGGER'; END IF;
END $$;
CREATE TEMP TABLE import_expected_migrations(name text PRIMARY KEY, checksum text NOT NULL) ON COMMIT DROP;
-- Exact current 001-021 compatibility; neither writes nor replays migrations.
INSERT INTO import_expected_migrations VALUES
('001_foundation.sql','0a9f44ff6a722807b4355eed1ffc69d2b85ef7b74f68c480a552c71a8fd24734'),
('002_auth_rbac.sql','7331a25146d5bc966dd094dc7173b48e3992e0c22cc89ff22409fd7b059f3fa3'),
('003_password_management.sql','eb84d18ddbf7cf3edbe31494a7a1a2c901fc501de3bd7c822f0d4690219ce3f6'),
('004_menu_foundation.sql','caaa3c6e51764539a42c8d369753f24292e951412cc36e3b96f1b04a5d4f5273'),
('005_menu_automatic_ordering.sql','810c822003b932308ab2e76ff4721868e5b4808d926dcfd67db5349666d0aab7'),
('006_menu_images.sql','546a792978dc3a569b0d7f1d4bcbf4d6f0952897d96052667cf21989129b75d6'),
('007_counter_availability.sql','4242774067144bfd9d070c9eec3a5ea57fdcb8d542ed75b6f758b32be395c9e6'),
('008_orders_core.sql','bae4a0f22450486fafdebb5c75c1f39b8c6e1d2f3542f74e1f63747f05ec0f1a'),
('009_kitchen_lifecycle.sql','6df123e74b7335aa9ba07d4b9075aa145ea5524e314dcb1e8dd3243ca1fc5c3f'),
('010_kitchen_counter_availability.sql','7635e971867f7cc08fe5df471b506570cb8e01c14008d0412aa97741fe686d54'),
('011_dispatch_handoff.sql','5a3e5f6f1dee166912ecebf3feed3bf222e68c3c9af791e5eac84f0b49682cbf'),
('012_bills_payments.sql','3106d9ded908eb573bfc35db1edf455c1466730a27eaa0eeea0f2af1ece306f4'),
('013_confirmation_alerts.sql','e911d3c768c1e622b0941ca8ad3bafa70e7bb1237f74db364ed230d690660eb8'),
('014_order_amendments.sql','f404f472a660e8f2d042f1ac5ccb589e590cde86847dfb2fd2e54cdbdd075ba1'),
('015_bill_history_indexes.sql','a12efa85157d254fd27e68b99b3535f89bd20cec41f1a8e5db953a3aac0ddfa4'),
('016_bill_session_rollover.sql','89449e7f537179bb1b0ff5d3b4a8e6999b47b0ceca4221d5c73a2a9aed9260d4'),
('017_restaurant_expenses.sql','f96b2f6fa501921495769fc1bddd637eab48eee582336618cb5f971872cd5244'),
('018_daily_owner_reports.sql','58e0d8fa808e5cbd72b659be241b3e06dfbe2ac31230ab7a303da8c006375e90'),
('019_previous_day_order_cleanup.sql','ae7603ff3cf7fd71534347a922d6465746483e9e4934d686eb357d2852bf529b'),
('020_manual_platform_orders.sql','eed2395398a7804fff1c1c767359b7df06a550057e80b260c734ee012764d389'),
('021_platform_preparation_mode.sql','318467ba1e97684a8abee43783b242874a8a78b33e177067b7173f232b66ba29');
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM import_expected_migrations e FULL JOIN schema_migrations m USING(name) WHERE e.checksum IS DISTINCT FROM m.checksum) THEN
  RAISE EXCEPTION 'IMPORT_SCHEMA_MISMATCH: expected unchanged migrations 001-021';
 END IF;
END $$;
CREATE TEMP TABLE import_rows (
 category_order integer NOT NULL, item_order integer NOT NULL, variant_order integer NOT NULL,
 category text NOT NULL CHECK(category=btrim(category) AND length(category) BETWEEN 1 AND 100),
 dish text NOT NULL CHECK(dish=btrim(dish) AND length(dish) BETWEEN 1 AND 120),
 variant text NOT NULL CHECK(variant IN ('REGULAR','HALF','FULL','REFILL')),
 price_text text NOT NULL CHECK(price_text ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$'),
 PRIMARY KEY(category_order,item_order,variant_order)
) ON COMMIT DROP;
CREATE UNIQUE INDEX ON import_rows(lower(category),lower(dish),lower(variant));
-- BEGIN REVIEWED MENU DATA
INSERT INTO import_rows VALUES
(1,1,1,'SANDWICH/BURGER','VEG SANDWICH','FULL','70.00'),
(1,2,1,'SANDWICH/BURGER','VEG CHEESE SANDWICH','FULL','80.00'),
(1,3,1,'SANDWICH/BURGER','PANEER SANDWICH','FULL','90.00'),
(1,4,1,'SANDWICH/BURGER','PANEER CHEESE SANDWICH','FULL','100.00'),
(1,5,1,'SANDWICH/BURGER','DOUBLE CHEESE SANDWICH','FULL','100.00'),
(1,6,1,'SANDWICH/BURGER','CORN SANDWICH','FULL','90.00'),
(1,7,1,'SANDWICH/BURGER','CORN CHEESE SANDWICH','FULL','100.00'),
(1,8,1,'SANDWICH/BURGER','CORN PANEER SANDWICH','FULL','110.00'),
(1,9,1,'SANDWICH/BURGER','CORN PANEER CHEESE SANDWICH','FULL','120.00'),
(1,10,1,'SANDWICH/BURGER','VEG BURGER','FULL','80.00'),
(1,11,1,'SANDWICH/BURGER','VEG CHEESE BURGER','FULL','90.00'),
(1,12,1,'SANDWICH/BURGER','PANEER BURGER','FULL','90.00'),
(1,13,1,'SANDWICH/BURGER','PANEER CHEESE BURGER','FULL','100.00'),
(2,1,1,'CHINESE','VEG NOODLES','HALF','60.00'),
(2,1,2,'CHINESE','VEG NOODLES','FULL','80.00'),
(2,2,1,'CHINESE','GARLIC NOODLES','HALF','90.00'),
(2,2,2,'CHINESE','GARLIC NOODLES','FULL','110.00'),
(2,3,1,'CHINESE','CHILLI GARLIC NOODLES','HALF','90.00'),
(2,3,2,'CHINESE','CHILLI GARLIC NOODLES','FULL','110.00'),
(2,4,1,'CHINESE','CORN NOODLES','HALF','90.00'),
(2,4,2,'CHINESE','CORN NOODLES','FULL','110.00'),
(2,5,1,'CHINESE','MANCHURIAN NOODLES','HALF','80.00'),
(2,5,2,'CHINESE','MANCHURIAN NOODLES','FULL','100.00'),
(2,6,1,'CHINESE','VEG HAKKA NOODLES','HALF','80.00'),
(2,6,2,'CHINESE','VEG HAKKA NOODLES','FULL','100.00'),
(2,7,1,'CHINESE','CRISPY NOODLES','HALF','90.00'),
(2,7,2,'CHINESE','CRISPY NOODLES','FULL','110.00'),
(2,8,1,'CHINESE','SCHEZWAN NOODLES','HALF','90.00'),
(2,8,2,'CHINESE','SCHEZWAN NOODLES','FULL','110.00'),
(2,9,1,'CHINESE','PANEER NOODLES','HALF','130.00'),
(2,9,2,'CHINESE','PANEER NOODLES','FULL','160.00'),
(2,10,1,'CHINESE','SINGAPURI NOODLES','HALF','70.00'),
(2,10,2,'CHINESE','SINGAPURI NOODLES','FULL','90.00'),
(2,11,1,'CHINESE','MANCHURIAN DRY','HALF','70.00'),
(2,11,2,'CHINESE','MANCHURIAN DRY','FULL','90.00'),
(2,12,1,'CHINESE','MANCHURIAN GRAVY','HALF','70.00'),
(2,12,2,'CHINESE','MANCHURIAN GRAVY','FULL','90.00'),
(2,13,1,'CHINESE','CRISPY MANCHURIAN','HALF','90.00'),
(2,13,2,'CHINESE','CRISPY MANCHURIAN','FULL','110.00'),
(2,14,1,'CHINESE','PANEER MANCHURIAN','HALF','130.00'),
(2,14,2,'CHINESE','PANEER MANCHURIAN','FULL','160.00'),
(2,15,1,'CHINESE','VEG ALL MIX COMBO','HALF','80.00'),
(2,15,2,'CHINESE','VEG ALL MIX COMBO','FULL','100.00'),
(2,16,1,'CHINESE','CHINESE BHEL','FULL','110.00'),
(2,17,1,'CHINESE','CHINESE THALI','FULL','210.00'),
(2,18,1,'CHINESE','MACRONI','HALF','90.00'),
(2,18,2,'CHINESE','MACRONI','FULL','110.00'),
(3,1,1,'PASTA','CHINESE PASTA','HALF','90.00'),
(3,1,2,'PASTA','CHINESE PASTA','FULL','110.00'),
(3,2,1,'PASTA','MIX SAUCE CHEESE PASTA','FULL','180.00'),
(3,3,1,'PASTA','RED SAUCE PASTA','FULL','120.00'),
(3,4,1,'PASTA','RED SAUCE CHEESE PASTA','FULL','140.00'),
(3,5,1,'PASTA','WHITE SAUCE CHEESE PASTA','FULL','140.00'),
(3,6,1,'PASTA','HOT GARLIC CHEESE PASTA','FULL','160.00'),
(3,7,1,'PASTA','PANEER CHEESE PASTA','FULL','160.00'),
(3,8,1,'PASTA','SPECIAL PASTA WHITE CHEESE','FULL','210.00'),
(4,1,1,'PIZZA','CHEESE PIZZA','FULL','140.00'),
(4,2,1,'PIZZA','VEG CHEESE PIZZA','FULL','140.00'),
(4,3,1,'PIZZA','PANEER CHEESE PIZZA','FULL','160.00'),
(4,4,1,'PIZZA','CORN CHEESE PIZZA','FULL','150.00'),
(4,5,1,'PIZZA','CORN PANEER CHEESE PIZZA','FULL','180.00'),
(4,6,1,'PIZZA','CHILLI PANEER PIZZA','FULL','180.00'),
(5,1,1,'INDIAN','CHOLE KULCHA','FULL','130.00'),
(5,2,1,'INDIAN','PANEER KULCHA','FULL','160.00'),
(5,3,1,'INDIAN','CHOLE PANEER KULCHA COMBO','FULL','190.00'),
(5,4,1,'INDIAN','CHOLE AATA KULCHA','FULL','150.00'),
(5,5,1,'INDIAN','PANEER AATA KULCHA','FULL','170.00'),
(5,6,1,'INDIAN','CHOLE PANEER AATA KULCHA COMBO','FULL','190.00'),
(5,7,1,'INDIAN','KADAI PANEER KULCHA','FULL','210.00'),
(5,8,1,'INDIAN','CHOLE CHUR CHUR NAN','FULL','150.00'),
(5,9,1,'INDIAN','PANEER CHUR CHUR NAN','FULL','190.00'),
(5,10,1,'INDIAN','CHOLE PANEER CHUR CHUR NAN COMBO','FULL','210.00'),
(5,11,1,'INDIAN','CHOLE','REGULAR','90.00'),
(5,11,2,'INDIAN','CHOLE','HALF','110.00'),
(5,11,3,'INDIAN','CHOLE','FULL','160.00'),
(5,12,1,'INDIAN','BUTTER PANEER MASALA','REGULAR','120.00'),
(5,12,2,'INDIAN','BUTTER PANEER MASALA','HALF','170.00'),
(5,12,3,'INDIAN','BUTTER PANEER MASALA','FULL','210.00'),
(5,13,1,'INDIAN','KADAI PANEER','HALF','190.00'),
(5,13,2,'INDIAN','KADAI PANEER','FULL','240.00'),
(5,14,1,'INDIAN','MATAR PANEER','HALF','190.00'),
(5,14,2,'INDIAN','MATAR PANEER','FULL','240.00'),
(5,15,1,'INDIAN','SEV TAMATAR','FULL','130.00'),
(6,1,1,'ROTI / NAAN','TANDOORI ROTI PLAIN','FULL','12.00'),
(6,2,1,'ROTI / NAAN','TANDOORI ROTI BUTTER','FULL','15.00'),
(6,3,1,'ROTI / NAAN','ALLU KULCHA','FULL','30.00'),
(6,4,1,'ROTI / NAAN','PANEER KULCHA','FULL','40.00'),
(6,5,1,'ROTI / NAAN','BUTTER NAAN','FULL','40.00'),
(6,6,1,'ROTI / NAAN','GARLIC NAAN','FULL','50.00'),
(6,7,1,'ROTI / NAAN','GARLIC CHEESE NAN','FULL','80.00'),
(6,8,1,'ROTI / NAAN','PANEER PARATHA','FULL','60.00'),
(6,9,1,'ROTI / NAAN','ALLU PARATHA','FULL','40.00'),
(6,10,1,'ROTI / NAAN','LACHA PARATHA','FULL','40.00'),
(7,1,1,'BIRYANI','VEG BIRYANI','HALF','80.00'),
(7,1,2,'BIRYANI','VEG BIRYANI','FULL','100.00'),
(7,2,1,'BIRYANI','SCHEZWAN BIRYANI','HALF','100.00'),
(7,2,2,'BIRYANI','SCHEZWAN BIRYANI','FULL','120.00'),
(7,3,1,'BIRYANI','MANCHURIAN BIRYANI','HALF','100.00'),
(7,3,2,'BIRYANI','MANCHURIAN BIRYANI','FULL','120.00'),
(7,4,1,'BIRYANI','GARLIC BIRYANI','HALF','100.00'),
(7,4,2,'BIRYANI','GARLIC BIRYANI','FULL','120.00'),
(7,5,1,'BIRYANI','NOODLES BIRYANI','FULL','120.00'),
(7,6,1,'BIRYANI','PANEER BIRYANI','HALF','130.00'),
(7,6,2,'BIRYANI','PANEER BIRYANI','FULL','160.00'),
(7,7,1,'BIRYANI','CORN BIRYANI','FULL','130.00'),
(7,8,1,'BIRYANI','PAV BHAJI','FULL','90.00'),
(7,9,1,'BIRYANI','RUDRAGIRI SPECIAL','FULL','140.00'),
(7,10,1,'BIRYANI','BADI FRY','FULL','120.00'),
(8,1,1,'RICE','VEG FRIED RICE','HALF','70.00'),
(8,1,2,'RICE','VEG FRIED RICE','FULL','90.00'),
(8,2,1,'RICE','JIRA RICE','HALF','70.00'),
(8,2,2,'RICE','JIRA RICE','FULL','90.00'),
(8,3,1,'RICE','CRISPY RICE','HALF','90.00'),
(8,3,2,'RICE','CRISPY RICE','FULL','110.00'),
(8,4,1,'RICE','CORN RICE','HALF','80.00'),
(8,4,2,'RICE','CORN RICE','FULL','100.00'),
(8,5,1,'RICE','GARLIC RICE','HALF','90.00'),
(8,5,2,'RICE','GARLIC RICE','FULL','110.00'),
(8,6,1,'RICE','MANCHURIAN RICE','HALF','80.00'),
(8,6,2,'RICE','MANCHURIAN RICE','FULL','100.00'),
(8,7,1,'RICE','SCHEZWAN RICE','HALF','90.00'),
(8,7,2,'RICE','SCHEZWAN RICE','FULL','110.00'),
(8,8,1,'RICE','PANEER RICE','HALF','130.00'),
(8,8,2,'RICE','PANEER RICE','FULL','160.00'),
(9,1,1,'SOYA CHAP','SOYA CHAP','FULL','190.00'),
(9,2,1,'SOYA CHAP','SOYA MALAI CHAP','FULL','190.00'),
(9,3,1,'SOYA CHAP','SOYA CHAP GRAVY','FULL','260.00'),
(10,1,1,'SOUP','VEG SOUP','FULL','50.00'),
(10,2,1,'SOUP','MANCHOW SOUP','FULL','50.00'),
(10,3,1,'SOUP','TOMATO SOUP','FULL','50.00'),
(11,1,1,'SPECIAL''S','FRENCH FRIED','FULL','100.00'),
(11,2,1,'SPECIAL''S','MASALA CORN','FULL','100.00'),
(11,3,1,'SPECIAL''S','PANEER TIKKA','FULL','190.00'),
(11,4,1,'SPECIAL''S','PANEER TIKKA MASALA','FULL','280.00'),
(11,5,1,'SPECIAL''S','CRISPY CORN','FULL','140.00'),
(11,6,1,'SPECIAL''S','KOTHE','FULL','110.00'),
(11,7,1,'SPECIAL''S','CHILLI PANEER','FULL','160.00'),
(11,8,1,'SPECIAL''S','CHILLI POTATO','FULL','120.00'),
(12,1,1,'MOMOS','VEG MOMOS STEAM','HALF','60.00'),
(12,1,2,'MOMOS','VEG MOMOS STEAM','FULL','80.00'),
(12,2,1,'MOMOS','VEG MOMOS FRY','HALF','70.00'),
(12,2,2,'MOMOS','VEG MOMOS FRY','FULL','90.00'),
(12,3,1,'MOMOS','TANDOORI MOMOS','FULL','140.00'),
(13,1,1,'MAGGI','SIMPLE MAGGI','FULL','70.00'),
(13,2,1,'MAGGI','MASALA MAGGI','FULL','90.00'),
(13,3,1,'MAGGI','CHEESE BUTTER MAGGI','FULL','110.00'),
(13,4,1,'MAGGI','PANJABI TADKA MAGGI','FULL','100.00'),
(14,1,1,'COLD / SHAKE','COLD COFFEE','FULL','80.00'),
(14,2,1,'COLD / SHAKE','COLD COFFEE WITH ICE CREAM','FULL','100.00'),
(14,3,1,'COLD / SHAKE','CHOCOLATE SHAKE','FULL','110.00'),
(14,4,1,'COLD / SHAKE','OREO SHAKE','FULL','110.00'),
(15,1,1,'EXTRA','EXTRA CHOLE','REFILL','40.00'),
(15,2,1,'EXTRA','EXTRA PANEER','REFILL','60.00'),
(15,3,1,'EXTRA','EXTRA CHEESE','REFILL','20.00'),
(15,4,1,'EXTRA','EXTRA PAV','REFILL','20.00'),
(15,5,1,'EXTRA','EXTRA CRISPY','REFILL','10.00');
-- END REVIEWED MENU DATA
DO $$
BEGIN
 IF (SELECT count(*) FROM import_rows)<>156
 OR (SELECT count(DISTINCT lower(category)) FROM import_rows)<>15
 OR (SELECT count(DISTINCT (lower(category),lower(dish))) FROM import_rows)<>118 THEN
  RAISE EXCEPTION 'IMPORT_DATASET_COUNT_MISMATCH'; END IF;
 IF EXISTS (SELECT 1 FROM import_rows GROUP BY category_order HAVING count(DISTINCT category)<>1)
 OR EXISTS (SELECT 1 FROM import_rows GROUP BY lower(category) HAVING count(DISTINCT category_order)<>1)
 OR EXISTS (SELECT 1 FROM import_rows GROUP BY category_order,item_order HAVING count(DISTINCT dish)<>1)
 OR EXISTS (SELECT 1 FROM import_rows GROUP BY lower(category),lower(dish) HAVING count(DISTINCT item_order)<>1) THEN
  RAISE EXCEPTION 'IMPORT_DUPLICATE_DISH_OR_CATEGORY'; END IF;
 IF EXISTS (
  SELECT 1 FROM import_rows GROUP BY category,dish HAVING
  array_agg(variant ORDER BY variant_order) <> CASE
   WHEN category='EXTRA' THEN ARRAY['REFILL']
   WHEN category='INDIAN' AND dish IN ('CHOLE','BUTTER PANEER MASALA') THEN ARRAY['REGULAR','HALF','FULL']
   WHEN count(*)=1 THEN ARRAY['FULL'] ELSE ARRAY['HALF','FULL'] END
 ) THEN RAISE EXCEPTION 'IMPORT_VARIANT_PATTERN_INVALID'; END IF;
 IF EXISTS (SELECT 1 FROM import_rows a JOIN import_rows b ON a.category=b.category AND a.dish=b.dish AND a.variant_order<b.variant_order WHERE a.price_text::numeric>b.price_text::numeric) THEN
  RAISE EXCEPTION 'IMPORT_PRICE_ORDER_INVALID'; END IF;
END $$;
-- Preflight ALL conflicts before creating persistent rows. No partial repairs/upserts.
DO $$
DECLARE r record; existing_id uuid;
BEGIN
 FOR r IN SELECT DISTINCT category,dish FROM import_rows LOOP
  IF EXISTS(SELECT 1 FROM menu_categories WHERE lower(name)=lower(r.category) AND NOT active) THEN
   RAISE EXCEPTION 'IMPORT_CONFLICT: category % is inactive', r.category;
  END IF;
  SELECT i.id INTO existing_id FROM menu_items i JOIN menu_categories c ON c.id=i.category_id
   WHERE lower(c.name)=lower(r.category) AND lower(i.name)=lower(r.dish);
  IF existing_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM menu_items WHERE id=existing_id AND active)
   OR EXISTS (
    SELECT 1 FROM (SELECT variant,price_text FROM import_rows WHERE category=r.category AND dish=r.dish) e
    FULL JOIN (SELECT v.name,v.active,s.price,s.available FROM item_variants v LEFT JOIN variant_channel_settings s ON s.variant_id=v.id AND s.channel_code='COUNTER' WHERE v.menu_item_id=existing_id) v
    ON lower(v.name)=lower(e.variant)
    WHERE v.name IS NULL OR e.variant IS NULL OR NOT v.active OR v.available IS DISTINCT FROM true OR v.price IS DISTINCT FROM e.price_text::numeric
   ) THEN RAISE EXCEPTION 'IMPORT_CONFLICT: % / % differs; existing item will not be changed',r.category,r.dish; END IF;
  END IF;
 END LOOP;
END $$;
CREATE TEMP TABLE import_created_categories(id uuid PRIMARY KEY) ON COMMIT DROP;
CREATE TEMP TABLE import_created_items(id uuid PRIMARY KEY) ON COMMIT DROP;
DO $$
DECLARE c record; d record; v record; cid uuid; iid uuid; vid uuid;
BEGIN
 FOR c IN SELECT DISTINCT category_order,category FROM import_rows ORDER BY category_order LOOP
  SELECT id INTO cid FROM menu_categories WHERE lower(name)=lower(c.category);
  IF cid IS NULL THEN
   INSERT INTO menu_categories(name,active,created_at) VALUES(c.category,true,clock_timestamp()) RETURNING id INTO cid;
   INSERT INTO import_created_categories VALUES(cid);
  END IF;
  FOR d IN SELECT DISTINCT item_order,dish FROM import_rows WHERE category=c.category ORDER BY item_order LOOP
   IF EXISTS(SELECT 1 FROM menu_items WHERE category_id=cid AND lower(name)=lower(d.dish)) THEN CONTINUE; END IF;
   INSERT INTO menu_items(category_id,name,kitchen_name,active,created_at) VALUES(cid,d.dish,d.dish,true,clock_timestamp()) RETURNING id INTO iid;
   INSERT INTO import_created_items VALUES(iid);
   FOR v IN SELECT variant,price_text FROM import_rows WHERE category=c.category AND dish=d.dish ORDER BY variant_order LOOP
    INSERT INTO item_variants(menu_item_id,name,active) VALUES(iid,v.variant,true) RETURNING id INTO vid;
    INSERT INTO variant_channel_settings(variant_id,channel_code,price,available) VALUES(vid,'COUNTER',v.price_text::numeric,true);
   END LOOP;
  END LOOP;
 END LOOP;
END $$;
-- Equivalent public aggregate snapshots to MenuService audit; no HTTP session is fabricated.
INSERT INTO menu_audit(actor_id,category_id,action,before_value,after_value)
SELECT a.id,c.id,'CREATED',NULL,jsonb_build_object(
 'id',c.id,'name',c.name,'description',c.description,'active',c.active,'version',c.version,
 'createdAt',to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'updatedAt',to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
FROM menu_categories c JOIN import_created_categories n ON n.id=c.id CROSS JOIN import_actor a;
INSERT INTO menu_audit(actor_id,item_id,action,before_value,after_value)
SELECT a.id,i.id,'CREATED',NULL,jsonb_build_object(
 'id',i.id,'categoryId',i.category_id,'name',i.name,'description',i.description,'kitchenName',i.kitchen_name,
 'active',i.active,'version',i.version,'image',NULL,
 'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'variants',(SELECT jsonb_agg(jsonb_build_object(
  'id',v.id,'name',v.name,'displayLabel',v.display_label,'active',v.active,
  'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char(v.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'channels',jsonb_build_array(jsonb_build_object('channelCode','COUNTER','price',s.price::text,'available',true,'normalAmount',NULL,'reducedAmount',NULL,'servingUnit',NULL))) ORDER BY v.created_at,v.id)
  FROM item_variants v JOIN variant_channel_settings s ON s.variant_id=v.id AND s.channel_code='COUNTER' WHERE v.menu_item_id=i.id),
 'counterVisibility',jsonb_build_object('visible',true,'reasons','[]'::jsonb,'variants',
  (SELECT jsonb_agg(jsonb_build_object('id',v.id,'visible',true,'reasons','[]'::jsonb) ORDER BY v.created_at,v.id) FROM item_variants v WHERE v.menu_item_id=i.id)))
FROM menu_items i JOIN import_created_items n ON n.id=i.id CROSS JOIN import_actor a;
-- Force deferred invariants during dry run as well as apply.
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 15 AS expected_categories,118 AS expected_dishes,156 AS expected_variants,
 (SELECT count(*) FROM import_created_categories) AS created_categories,
 (SELECT count(*) FROM import_created_items) AS created_dishes,
 (SELECT count(*) FROM item_variants v JOIN import_created_items i ON i.id=v.menu_item_id) AS created_variants,
 118-(SELECT count(*) FROM import_created_items) AS skipped_dishes;
SELECT r.category,r.dish,r.variant,r.price_text AS expected_price,s.price AS actual_price,s.available
FROM import_rows r JOIN menu_categories c ON lower(c.name)=lower(r.category)
JOIN menu_items i ON i.category_id=c.id AND lower(i.name)=lower(r.dish)
JOIN item_variants v ON v.menu_item_id=i.id AND lower(v.name)=lower(r.variant)
JOIN variant_channel_settings s ON s.variant_id=v.id AND s.channel_code='COUNTER'
ORDER BY r.category_order,r.item_order,r.variant_order;
\if :apply
 COMMIT;
 \echo 'IMPORT COMMITTED. Verify menu and readiness using the runbook.'
\else
 ROLLBACK;
 \echo 'DRY RUN: rolled back all menu and audit writes. Nothing persisted.'
\endif
