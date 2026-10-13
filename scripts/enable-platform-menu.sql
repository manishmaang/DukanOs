-- One-time data maintenance; no TEMP objects, migrations or application changes.
-- Defaults to full rehearsal + ROLLBACK. See docs/operations/PLATFORM_MENU.md.
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
 \echo 'Required: -v owner_username=YOUR_EXISTING_OWNER'
 \quit 3
\endif
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL idle_in_transaction_session_timeout='60s';
SET LOCAL timezone='UTC';
SELECT set_config('search_path',format('%I,pg_catalog',:'target_schema'),true),
 set_config('platform_menu.database',:'expected_database',true),
 set_config('platform_menu.schema',:'target_schema',true),
 set_config('platform_menu.actor',lower(btrim(:'owner_username')),true),
 set_config('platform_menu.apply',:'apply',true),
 set_config('platform_menu.confirm',:'confirm',true);
DO $enable$
DECLARE
 actor uuid; item record; before_snapshot jsonb; after_snapshot jsonb;
 inserted integer; total_inserted integer:=0; updated_items integer:=0;
 snapshot_sql text := $snapshot$
 SELECT jsonb_build_object(
  'id',i.id,'categoryId',i.category_id,'name',i.name,'description',i.description,'kitchenName',i.kitchen_name,
  'active',i.active,'version',i.version,
  'image',CASE WHEN m.key IS NULL THEN NULL ELSE jsonb_build_object('key',m.key,'url','/api/menu/images/'||m.key,'width',m.width,'height',m.height) END,
  'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'variants',(SELECT jsonb_agg(jsonb_build_object(
   'id',v.id,'name',v.name,'displayLabel',v.display_label,'active',v.active,
   'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'updatedAt',to_char(v.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'channels',(SELECT coalesce(jsonb_agg(jsonb_build_object('channelCode',s.channel_code,'price',s.price::text,'available',s.available,
    'normalAmount',s.normal_amount::text,'reducedAmount',s.reduced_amount::text,'servingUnit',s.serving_unit) ORDER BY s.channel_code),'[]'::jsonb)
    FROM variant_channel_settings s WHERE s.variant_id=v.id)) ORDER BY v.created_at,v.id)
   FROM item_variants v WHERE v.menu_item_id=i.id),
  'counterVisibility',jsonb_build_object('visible',true,'reasons','[]'::jsonb,'variants',
   (SELECT jsonb_agg(jsonb_build_object('id',v.id,'visible',true,'reasons','[]'::jsonb) ORDER BY v.created_at,v.id) FROM item_variants v WHERE v.menu_item_id=i.id)))
 FROM menu_items i LEFT JOIN menu_images m ON m.key=i.image_key WHERE i.id=$1
 $snapshot$;
BEGIN
 IF current_database()<>current_setting('platform_menu.database')
 OR current_setting('platform_menu.schema') !~ '^[a-z][a-z0-9_]{0,62}$'
 OR current_setting('platform_menu.schema') IN ('public','pg_catalog','information_schema')
 OR NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=current_setting('platform_menu.schema') AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) THEN
  RAISE EXCEPTION 'PLATFORM_MENU_TARGET_INVALID'; END IF;
 IF current_setting('platform_menu.apply')::boolean AND current_setting('platform_menu.confirm')<>'ENABLE_PLATFORMS_156_312' THEN
  RAISE EXCEPTION 'PLATFORM_MENU_CONFIRMATION_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock(742019323);
 LOCK TABLE menu_categories,menu_items,item_variants,variant_channel_settings,menu_audit,sales_channels,menu_images IN SHARE ROW EXCLUSIVE MODE;
 SELECT id INTO actor FROM users WHERE username=current_setting('platform_menu.actor') AND active FOR SHARE;
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_code=ur.role_code WHERE ur.user_id=actor AND ur.role_code='OWNER' AND rp.permission_code='menu.manage') THEN
  RAISE EXCEPTION 'PLATFORM_MENU_OWNER_REQUIRED'; END IF;
 IF current_setting('session_replication_role')<>'origin' OR EXISTS(
  SELECT 1 FROM pg_trigger WHERE tgrelid IN ('menu_categories'::regclass,'menu_items'::regclass,'item_variants'::regclass,'variant_channel_settings'::regclass,'menu_audit'::regclass) AND tgenabled NOT IN ('O','A')
 ) THEN RAISE EXCEPTION 'PLATFORM_MENU_TRIGGER_DISABLED'; END IF;
 IF EXISTS(SELECT 1 FROM (VALUES
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
('021_platform_preparation_mode.sql','318467ba1e97684a8abee43783b242874a8a78b33e177067b7173f232b66ba29')) e(name,checksum) FULL JOIN schema_migrations m USING(name) WHERE e.checksum IS DISTINCT FROM m.checksum) THEN
  RAISE EXCEPTION 'PLATFORM_MENU_SCHEMA_MISMATCH'; END IF;
 -- Conservative one-time baseline: every existing portion is Counter-sellable.
 IF (SELECT count(*) FROM menu_categories)<>15 OR (SELECT count(*) FROM menu_items)<>118
 OR (SELECT count(*) FROM item_variants)<>156
 OR (SELECT count(*) FROM sales_channels WHERE code IN ('COUNTER','SWIGGY','ZOMATO') AND active)<>3
 OR (SELECT count(*) FROM variant_channel_settings WHERE channel_code='COUNTER' AND price IS NOT NULL AND available)<>156
 OR EXISTS(SELECT 1 FROM menu_categories WHERE NOT active)
 OR EXISTS(SELECT 1 FROM menu_items i WHERE NOT active OR NOT EXISTS(SELECT 1 FROM item_variants v WHERE v.menu_item_id=i.id))
 OR EXISTS(SELECT 1 FROM item_variants WHERE NOT active) THEN
  RAISE EXCEPTION 'PLATFORM_MENU_BASELINE_INVALID: require 15 active categories, 118 active dishes and 156 active priced available Counter portions'; END IF;
 -- Validate every pre-existing platform record before the first write.
 IF EXISTS(SELECT 1 FROM variant_channel_settings p JOIN variant_channel_settings c ON c.variant_id=p.variant_id AND c.channel_code='COUNTER'
  WHERE p.channel_code IN ('SWIGGY','ZOMATO') AND (p.price IS DISTINCT FROM c.price OR NOT p.available OR p.normal_amount IS NOT NULL OR p.reduced_amount IS NOT NULL OR p.serving_unit IS NOT NULL)) THEN
  RAISE EXCEPTION 'PLATFORM_MENU_CONFLICT: existing price/availability/measurements differ; no overwrite'; END IF;
 FOR item IN
  SELECT i.id FROM menu_items i WHERE EXISTS (
   SELECT 1 FROM item_variants v CROSS JOIN (VALUES ('SWIGGY'),('ZOMATO')) p(code)
   WHERE v.menu_item_id=i.id AND NOT EXISTS(SELECT 1 FROM variant_channel_settings s WHERE s.variant_id=v.id AND s.channel_code=p.code)
  ) ORDER BY i.id
 LOOP
  EXECUTE snapshot_sql INTO before_snapshot USING item.id;
  INSERT INTO variant_channel_settings(variant_id,channel_code,price,available,normal_amount,reduced_amount,serving_unit)
  SELECT v.id,p.code,c.price,true,NULL,NULL,NULL FROM item_variants v
  JOIN variant_channel_settings c ON c.variant_id=v.id AND c.channel_code='COUNTER'
  CROSS JOIN (VALUES ('SWIGGY'),('ZOMATO')) p(code)
  WHERE v.menu_item_id=item.id AND NOT EXISTS(SELECT 1 FROM variant_channel_settings s WHERE s.variant_id=v.id AND s.channel_code=p.code);
  GET DIAGNOSTICS inserted=ROW_COUNT;
  total_inserted:=total_inserted+inserted;
  -- Existing channel_setting_changed/item_version triggers provide version increments.
  EXECUTE snapshot_sql INTO after_snapshot USING item.id;
  INSERT INTO menu_audit(actor_id,item_id,action,before_value,after_value)
   VALUES(actor,item.id,'UPDATED',before_snapshot,after_snapshot);
  updated_items:=updated_items+1;
 END LOOP;
 IF (SELECT count(*) FROM variant_channel_settings p JOIN variant_channel_settings c ON c.variant_id=p.variant_id AND c.channel_code='COUNTER'
  WHERE p.channel_code IN ('SWIGGY','ZOMATO') AND p.price=c.price AND p.available AND p.normal_amount IS NULL AND p.reduced_amount IS NULL AND p.serving_unit IS NULL)<>312 THEN
  RAISE EXCEPTION 'PLATFORM_MENU_RECONCILIATION_FAILED'; END IF;
 RAISE NOTICE 'Platform rows inserted: %, matching rows skipped: %, UPDATED item audits: %',total_inserted,312-total_inserted,updated_items;
END $enable$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT channel_code,count(*) AS configured,count(*) FILTER(WHERE available) AS available,
 count(*) FILTER(WHERE price IS NOT NULL) AS priced FROM variant_channel_settings
WHERE channel_code IN ('COUNTER','SWIGGY','ZOMATO') GROUP BY channel_code ORDER BY channel_code;
\if :apply
 COMMIT;
 \echo 'PLATFORM MENU COMMITTED. Run verify-platform-menu.sql.'
\else
 ROLLBACK;
 \echo 'DRY RUN: all platform inserts, item versions and audits rolled back.'
\endif
