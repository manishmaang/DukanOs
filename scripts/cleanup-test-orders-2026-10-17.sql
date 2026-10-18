-- One-time destructive maintenance; NOT a normal cancellation/refund workflow.
-- Only the supplied seven test-order IDs. Owner executes separately after review.
-- No TEMP objects. No FK disabling. See docs/operations/TEST_ORDER_CLEANUP_2026-10-17.md.
\set ON_ERROR_STOP on
\if :{?apply}
\else
 \set apply false
\endif
\if :{?confirm}
\else
 \set confirm ''
\endif
\if :{?expected_fingerprint}
\else
 \set expected_fingerprint ''
\endif
\if :{?expected_report_id}
\else
 \set expected_report_id ''
\endif
\if :{?external_sends_checked}
\else
 \set external_sends_checked false
\endif
BEGIN;
SET LOCAL search_path=dukanos,pg_catalog;
SET LOCAL timezone='UTC';
SET LOCAL datestyle='ISO, YMD';
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
SET LOCAL idle_in_transaction_session_timeout='120s';
SELECT set_config('cleanup.expected_report_id', :'expected_report_id', true),
 set_config('cleanup.external_sends_checked', :'external_sends_checked', true),
 set_config('cleanup.apply', :'apply', true),
 set_config('cleanup.confirm', :'confirm', true),
 set_config('cleanup.expected_fingerprint', :'expected_fingerprint', true);
DO $cleanup$
DECLARE
 targets constant uuid[] := '{f6cca944-a322-4f3a-a021-a21b2bc7c7fc,87776115-adf3-4ec9-a62e-829374a47ede,1dd1fb53-a551-47a7-8109-85fe889d4441,4d2bb443-edc1-46de-9da1-b2d21e730456,3d499b63-c885-425f-ac2a-21cb2c06df46,f29f9147-4929-48f7-ae4a-009891fc7ea9,f70effcb-5a1e-4cfe-9bb1-ae5b1a52715d}';
 expected_ledger constant jsonb := '[{"name":"001_foundation.sql","checksum":"0a9f44ff6a722807b4355eed1ffc69d2b85ef7b74f68c480a552c71a8fd24734"},{"name":"002_auth_rbac.sql","checksum":"7331a25146d5bc966dd094dc7173b48e3992e0c22cc89ff22409fd7b059f3fa3"},{"name":"003_password_management.sql","checksum":"eb84d18ddbf7cf3edbe31494a7a1a2c901fc501de3bd7c822f0d4690219ce3f6"},{"name":"004_menu_foundation.sql","checksum":"caaa3c6e51764539a42c8d369753f24292e951412cc36e3b96f1b04a5d4f5273"},{"name":"005_menu_automatic_ordering.sql","checksum":"810c822003b932308ab2e76ff4721868e5b4808d926dcfd67db5349666d0aab7"},{"name":"006_menu_images.sql","checksum":"546a792978dc3a569b0d7f1d4bcbf4d6f0952897d96052667cf21989129b75d6"},{"name":"007_counter_availability.sql","checksum":"4242774067144bfd9d070c9eec3a5ea57fdcb8d542ed75b6f758b32be395c9e6"},{"name":"008_orders_core.sql","checksum":"bae4a0f22450486fafdebb5c75c1f39b8c6e1d2f3542f74e1f63747f05ec0f1a"},{"name":"009_kitchen_lifecycle.sql","checksum":"6df123e74b7335aa9ba07d4b9075aa145ea5524e314dcb1e8dd3243ca1fc5c3f"},{"name":"010_kitchen_counter_availability.sql","checksum":"7635e971867f7cc08fe5df471b506570cb8e01c14008d0412aa97741fe686d54"},{"name":"011_dispatch_handoff.sql","checksum":"5a3e5f6f1dee166912ecebf3feed3bf222e68c3c9af791e5eac84f0b49682cbf"},{"name":"012_bills_payments.sql","checksum":"3106d9ded908eb573bfc35db1edf455c1466730a27eaa0eeea0f2af1ece306f4"},{"name":"013_confirmation_alerts.sql","checksum":"e911d3c768c1e622b0941ca8ad3bafa70e7bb1237f74db364ed230d690660eb8"},{"name":"014_order_amendments.sql","checksum":"f404f472a660e8f2d042f1ac5ccb589e590cde86847dfb2fd2e54cdbdd075ba1"},{"name":"015_bill_history_indexes.sql","checksum":"a12efa85157d254fd27e68b99b3535f89bd20cec41f1a8e5db953a3aac0ddfa4"},{"name":"016_bill_session_rollover.sql","checksum":"89449e7f537179bb1b0ff5d3b4a8e6999b47b0ceca4221d5c73a2a9aed9260d4"},{"name":"017_restaurant_expenses.sql","checksum":"f96b2f6fa501921495769fc1bddd637eab48eee582336618cb5f971872cd5244"},{"name":"018_daily_owner_reports.sql","checksum":"58e0d8fa808e5cbd72b659be241b3e06dfbe2ac31230ab7a303da8c006375e90"},{"name":"019_previous_day_order_cleanup.sql","checksum":"ae7603ff3cf7fd71534347a922d6465746483e9e4934d686eb357d2852bf529b"},{"name":"020_manual_platform_orders.sql","checksum":"eed2395398a7804fff1c1c767359b7df06a550057e80b260c734ee012764d389"},{"name":"021_platform_preparation_mode.sql","checksum":"318467ba1e97684a8abee43783b242874a8a78b33e177067b7173f232b66ba29"}]'::jsonb;
 schema_query constant text := $schema$SELECT encode(sha256(convert_to(jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.relname COLLATE "C") FROM pg_class c WHERE c.relnamespace='dukanos'::regnamespace AND c.relkind IN ('r','p','v','m','S','f')),
 'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname COLLATE "C",a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE c.relnamespace='dukanos'::regnamespace AND c.relkind IN ('r','p','v','m','S','f') AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid),k.convalidated,k.condeferrable,k.condeferred) ORDER BY c.relname COLLATE "C",k.conname COLLATE "C") FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='dukanos'::regnamespace),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname,t.tgenabled,t.tgisinternal,pg_get_triggerdef(t.oid)) ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C") FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='dukanos'::regnamespace AND NOT t.tgisinternal),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_functiondef(p.oid)) ORDER BY p.proname COLLATE "C",pg_get_function_identity_arguments(p.oid) COLLATE "C") FROM pg_proc p WHERE p.pronamespace='dukanos'::regnamespace),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(c.relname,pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY c.relname COLLATE "C") FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace='dukanos'::regnamespace),
 'rules',(SELECT jsonb_agg(jsonb_build_array(c.relname,r.rulename,pg_get_ruledef(r.oid)) ORDER BY c.relname COLLATE "C",r.rulename COLLATE "C") FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class WHERE c.relnamespace='dukanos'::regnamespace)
)::text,'UTF8')),'hex')$schema$;
 expected_schema constant text := '6b9ec2c9e9afb656f13677f85606a61ef6a7d0b691edd2d21c2b0c44eca16f72';
 schema_before text; schema_after text; fingerprint text;
 report_id uuid; amendment_ids uuid[]; bill_ids uuid[]; r record; rowset jsonb; before_rows jsonb := '{}'; after_rows jsonb := '{}';
 affected constant text[] := ARRAY['kitchen_timers','payments','order_status_history','order_items','orders','bills','order_amendments','platform_order_cancellations'];
 n integer; deleted jsonb := '{}';
BEGIN
 IF current_database()<>'dukanos_prod' OR current_schema()<>'dukanos' OR current_user<>'postgres'
 OR session_user<>'postgres' OR current_setting('session_replication_role')<>'origin'
 OR current_setting('server_version_num')::int NOT BETWEEN 160000 AND 169999 THEN
  RAISE EXCEPTION 'CLEANUP_TARGET_OR_ROLE_MISMATCH';
 END IF;
 IF current_setting('cleanup.apply') NOT IN ('true','false') THEN RAISE EXCEPTION 'CLEANUP_INVALID_APPLY_FLAG'; END IF;
 IF current_setting('cleanup.apply')='true' AND
 (current_setting('cleanup.confirm')<>'DELETE_20261017_TEST_ORDERS_AND_REPORT_V1'
 OR current_setting('cleanup.external_sends_checked')<>'true'
 OR current_setting('cleanup.expected_report_id') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
 OR current_setting('cleanup.expected_fingerprint') !~ '^[a-f0-9]{64}$') THEN
  RAISE EXCEPTION 'CLEANUP_EXPLICIT_CONFIRMATION_REQUIRED';
 END IF;
 -- Maintenance requires all app/report workers and other clients stopped.
 IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend') THEN
  RAISE EXCEPTION 'CLEANUP_OTHER_DATABASE_CLIENTS';
 END IF;
 PERFORM pg_advisory_xact_lock(742019321); -- migrations
 PERFORM pg_advisory_xact_lock(742019323); -- restaurant writes
 PERFORM pg_advisory_xact_lock(742019324); -- report generation
 -- ACCESS EXCLUSIVE prevents non-cooperating writes and trigger-lock upgrades.
 FOR r IN SELECT c.relname FROM pg_class c WHERE c.relnamespace='dukanos'::regnamespace AND c.relkind IN ('r','p') ORDER BY c.relname COLLATE "C" LOOP
  EXECUTE format('LOCK TABLE dukanos.%I IN ACCESS EXCLUSIVE MODE',r.relname);
 END LOOP;
 IF (SELECT jsonb_agg(jsonb_build_object('name',name,'checksum',checksum) ORDER BY name) FROM schema_migrations) IS DISTINCT FROM expected_ledger THEN
  RAISE EXCEPTION 'CLEANUP_MIGRATION_LEDGER_CHANGED';
 END IF;
 EXECUTE schema_query INTO schema_before;
 IF schema_before<>expected_schema THEN RAISE EXCEPTION 'CLEANUP_SCHEMA_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 OR EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid=k.confrelid JOIN pg_class src ON src.oid=k.conrelid WHERE k.contype='f' AND c.relnamespace='dukanos'::regnamespace AND src.relnamespace<>c.relnamespace)
 OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='dukanos'::regnamespace AND t.tgenabled<>'O') THEN
  RAISE EXCEPTION 'CLEANUP_UNEXPECTED_TRIGGER_OR_EXTERNAL_DEPENDENCY';
 END IF;
  -- Entire order population must be the seven inventoried records, all on Oct 17.
  IF (SELECT count(*) FROM orders) <> 7
     OR (SELECT count(*) FROM orders WHERE id = ANY(targets) AND business_date = DATE '2026-10-17') <> 7
     OR (SELECT count(*) FROM orders WHERE source='COUNTER') <> 5
     OR (SELECT count(*) FROM orders WHERE source='ZOMATO') <> 2
     OR (SELECT count(*) FROM orders WHERE status='COMPLETED') <> 2
     OR (SELECT count(*) FROM orders WHERE status='CANCELLED') <> 5 THEN
    RAISE EXCEPTION 'CLEANUP_ORDER_BASELINE_CHANGED';
  END IF;
  IF (SELECT count(*) FROM bills) <> 5
     OR (SELECT count(*) FROM bills WHERE business_date=DATE '2026-10-17' AND service_type='DINE_IN') <> 5
     OR (SELECT count(DISTINCT bill_id) FROM orders WHERE source='COUNTER') <> 5
     OR EXISTS (SELECT 1 FROM orders WHERE (source='COUNTER') IS DISTINCT FROM (bill_id IS NOT NULL))
     OR (SELECT count(*) FROM order_items) <> 9
     OR (SELECT count(*) FROM order_status_history) <> 18 THEN
    RAISE EXCEPTION 'CLEANUP_BILL_OR_ORDER_CHILD_BASELINE_CHANGED';
  END IF;
  IF (SELECT count(*) FROM payments) <> 4
     OR (SELECT coalesce(sum(amount),0) FROM payments) <> 1100.00
     OR (SELECT count(*) FROM payments WHERE type='COLLECTION' AND method='CASH' AND amount=280.00) <> 1
     OR (SELECT count(*) FROM payments WHERE type='COLLECTION' AND method='UPI') <> 3
     OR (SELECT coalesce(sum(amount),0) FROM payments WHERE type='COLLECTION' AND method='UPI') <> 820.00
     OR EXISTS (SELECT 1 FROM payments p WHERE NOT EXISTS (
          SELECT 1 FROM bills b WHERE b.id=p.bill_id AND b.business_date=DATE '2026-10-17')) THEN
    RAISE EXCEPTION 'CLEANUP_PAYMENT_BASELINE_CHANGED';
  END IF;
  IF (SELECT count(*) FROM kitchen_timers) <> 1
     OR NOT EXISTS (
        SELECT 1 FROM kitchen_timers WHERE id='273e996f-81c6-45bd-8bd8-95f836bc3722'::uuid
          AND order_id='87776115-adf3-4ec9-a62e-829374a47ede'::uuid
          AND order_item_id IS NULL AND status='ACKNOWLEDGED')
     OR (SELECT count(*) FROM bill_reminders) <> 0
     OR (SELECT count(*) FROM order_amendments) <> 3
     OR (SELECT count(*) FROM order_item_revisions) <> 0
     OR (SELECT count(*) FROM platform_order_cancellations) <> 2 THEN
    RAISE EXCEPTION 'CLEANUP_DEPENDENT_BASELINE_CHANGED';
  END IF;
  -- Do not alter stored historical reports/expenses/email/other business data.
  IF (SELECT count(*) FROM expenses) <> 0
     OR (SELECT count(*) FROM daily_reports) <> 8
     OR (SELECT count(*) FROM daily_reports WHERE business_date BETWEEN DATE '2026-10-10' AND DATE '2026-10-16') <> 7
     OR (SELECT count(*) FROM report_deliveries) <> 0
     OR (SELECT count(*) FROM report_delivery_attempts) <> 0
     OR (SELECT count(*) FROM report_delivery_actions) <> 0
     OR (SELECT count(*) FROM order_daily_tokens) <> 1
     OR (SELECT count(*) FROM order_daily_tokens WHERE business_date=DATE '2026-10-17' AND last_token=7) <> 1
     OR (SELECT count(*) FROM bill_daily_numbers) <> 1
     OR (SELECT count(*) FROM bill_daily_numbers WHERE business_date=DATE '2026-10-17' AND last_number=5) <> 1 THEN
    RAISE EXCEPTION 'CLEANUP_UNRELATED_OR_NUMBERING_BASELINE_CHANGED';
  END IF;
  IF (SELECT count(*) FROM menu_categories) <> 15
     OR (SELECT count(*) FROM menu_items) <> 118
     OR (SELECT count(*) FROM item_variants) <> 156
     OR (SELECT count(*) FROM variant_channel_settings) <> 468
     OR (SELECT count(*) FROM menu_audit) <> 293 THEN
    RAISE EXCEPTION 'CLEANUP_MENU_BASELINE_CHANGED';
  END IF;

  -- Exact system cancellation shape; UUIDs discovered here are bound by the
  -- all-row reviewed fingerprint, never invented or accepted by date alone.
  IF (SELECT count(*) FROM orders WHERE source='COUNTER' AND status='CANCELLED')<>3
   OR (SELECT count(*) FROM orders WHERE source='ZOMATO' AND status='CANCELLED')<>2
   OR EXISTS(SELECT 1 FROM order_amendments a JOIN orders o ON o.id=a.order_id JOIN bills b ON b.id=a.bill_id
     WHERE NOT(o.id=ANY(targets)) OR o.source<>'COUNTER' OR o.status<>'CANCELLED'
      OR a.bill_id<>o.bill_id OR a.kind<>'CANCEL' OR a.revision<>1 OR a.performed_by IS NOT NULL
      OR a.reason<>'PREVIOUS_BUSINESS_DAY_AUTO_CANCEL' OR a.note<>''
      OR a.before_total<>o.grand_total OR a.subtotal<>0 OR a.tax_total<>0 OR a.grand_total<>0
      OR a.cleanup_timezone IS DISTINCT FROM 'Asia/Kolkata' OR a.cleanup_time IS DISTINCT FROM '05:00'
      OR (a.created_at AT TIME ZONE 'Asia/Kolkata')::date<>DATE '2026-10-18'
      OR (a.created_at AT TIME ZONE 'Asia/Kolkata')::time<TIME '05:00'
      OR b.status<>'CLOSED' OR b.closure_reason IS DISTINCT FROM 'BUSINESS_DAY_ROLLOVER'
      OR NOT EXISTS(SELECT 1 FROM order_status_history h WHERE h.order_id=o.id AND h.to_status='CANCELLED' AND h.occurred_at=a.created_at))
   OR EXISTS(SELECT 1 FROM platform_order_cancellations c JOIN orders o ON o.id=c.order_id
     WHERE NOT(o.id=ANY(targets)) OR o.source<>'ZOMATO' OR o.status<>'CANCELLED' OR c.actor_id IS NOT NULL
      OR c.reason<>'PREVIOUS_BUSINESS_DAY_AUTO_CANCEL'
      OR c.cleanup_timezone IS DISTINCT FROM 'Asia/Kolkata' OR c.cleanup_time IS DISTINCT FROM '05:00'
      OR (c.occurred_at AT TIME ZONE 'Asia/Kolkata')::date<>DATE '2026-10-18'
      OR (c.occurred_at AT TIME ZONE 'Asia/Kolkata')::time<TIME '05:00'
      OR NOT EXISTS(SELECT 1 FROM order_status_history h WHERE h.order_id=o.id AND h.to_status='CANCELLED' AND h.occurred_at=c.occurred_at))
   OR (SELECT count(*) FROM order_status_history WHERE to_status='CANCELLED' AND from_status='QUEUED' AND actor_id IS NULL AND reason='PREVIOUS_BUSINESS_DAY_AUTO_CANCEL')<>5
   OR EXISTS(SELECT 1 FROM orders o WHERE (SELECT count(*) FROM order_status_history h WHERE h.order_id=o.id)<>CASE WHEN o.status='COMPLETED' THEN 4 ELSE 2 END) THEN
   RAISE EXCEPTION 'CLEANUP_CANCELLATION_BASELINE_CHANGED';
  END IF;
  SELECT array_agg(id) INTO amendment_ids FROM order_amendments WHERE order_id=ANY(targets);
  -- No cursor writes: initialized cursor must already have passed the test day.
  -- Otherwise catchUp() could recreate v1 even with automatic EMAIL disabled.
  IF (SELECT count(*) FROM daily_report_settings WHERE id AND start_date IS NOT NULL AND start_date<=DATE '2026-10-17' AND next_date=DATE '2026-10-18')<>1 THEN
   RAISE EXCEPTION 'CLEANUP_REPORT_CURSOR_UNSAFE';
  END IF;
  SELECT id INTO report_id FROM daily_reports WHERE business_date=DATE '2026-10-17' AND version=1;
  IF current_setting('cleanup.expected_report_id')<>'' AND current_setting('cleanup.expected_report_id') IS DISTINCT FROM report_id::text THEN
   RAISE EXCEPTION 'CLEANUP_REPORT_ID_CHANGED';
  END IF;
  RAISE NOTICE 'CLEANUP_TARGET_REPORT_ID=%',report_id;
  IF report_id IS NULL OR NOT EXISTS(SELECT 1 FROM daily_reports WHERE id=report_id
   AND source='AUTOMATIC' AND generated_by IS NULL AND request_id IS NULL AND request_hash IS NULL
   AND reason='' AND (generated_at AT TIME ZONE 'Asia/Kolkata')::date=DATE '2026-10-18'
   AND snapshot->>'businessDate'='2026-10-17' AND snapshot->>'timezone'='Asia/Kolkata')
   OR EXISTS(SELECT 1 FROM daily_reports WHERE version<>1) THEN
   RAISE EXCEPTION 'CLEANUP_REPORT_BASELINE_CHANGED';
  END IF;
  -- Reports must cover each historical date once; no hidden reference to deleted IDs.
  IF (SELECT count(DISTINCT business_date) FROM daily_reports)<>8
   OR EXISTS(SELECT 1 FROM daily_reports d CROSS JOIN unnest(targets) t(id) WHERE strpos(d.snapshot::text,t.id::text)>0)
   OR NOT EXISTS(SELECT 1 FROM orders WHERE id='87776115-adf3-4ec9-a62e-829374a47ede' AND token_number=2)
   OR (SELECT array_agg(token_number ORDER BY token_number) FROM orders)<>ARRAY[1,2,3,4,5,6,7]
   OR (SELECT array_agg(bill_number ORDER BY bill_number) FROM bills)<>ARRAY[1,2,3,4,5] THEN
    RAISE EXCEPTION 'CLEANUP_REPORT_OR_NUMBER_IDENTITY_CHANGED';
  END IF;
  IF EXISTS(SELECT 1 FROM orders WHERE timezone<>'Asia/Kolkata' OR (queued_at AT TIME ZONE 'Asia/Kolkata')::date<>DATE '2026-10-17')
   OR EXISTS(SELECT 1 FROM bills WHERE (opened_at AT TIME ZONE 'Asia/Kolkata')::date<>DATE '2026-10-17')
   OR EXISTS(SELECT 1 FROM payments WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date<>DATE '2026-10-17')
   OR EXISTS(SELECT 1 FROM order_status_history WHERE (occurred_at AT TIME ZONE 'Asia/Kolkata')::date<>CASE WHEN to_status='CANCELLED' THEN DATE '2026-10-18' ELSE DATE '2026-10-17' END)
   OR EXISTS(SELECT 1 FROM kitchen_timers WHERE (started_at AT TIME ZONE 'Asia/Kolkata')::date<>DATE '2026-10-17' OR (resolved_at AT TIME ZONE 'Asia/Kolkata')::date<>DATE '2026-10-17') THEN
   RAISE EXCEPTION 'CLEANUP_EVENT_DATE_CHANGED';
  END IF;
  SELECT array_agg(DISTINCT bill_id) FILTER(WHERE bill_id IS NOT NULL) INTO bill_ids FROM orders WHERE id=ANY(targets);
  IF EXISTS(SELECT 1 FROM payments WHERE NOT(bill_id=ANY(bill_ids)) OR (confirmation_order_id IS NOT NULL AND NOT(confirmation_order_id=ANY(targets)))) THEN
   RAISE EXCEPTION 'CLEANUP_PAYMENT_SCOPE_CHANGED';
  END IF;
  IF EXISTS(SELECT 1 FROM daily_reports d CROSS JOIN unnest(bill_ids) b(id) WHERE strpos(d.snapshot::text,b.id::text)>0) THEN
   RAISE EXCEPTION 'CLEANUP_REPORT_REFERENCE_CHANGED';
  END IF;
  -- Exact in-memory comparison of EVERY table, including staff hashes/settings/audits.
  -- Sensitive values never leave this DO block. Only SHA256 digest is printed.
  FOR r IN SELECT c.relname FROM pg_class c WHERE c.relnamespace='dukanos'::regnamespace AND c.relkind='r' ORDER BY c.relname COLLATE "C" LOOP
   EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),''[]''::jsonb) FROM dukanos.%I t',r.relname) INTO rowset;
   before_rows:=before_rows||jsonb_build_object(r.relname,rowset);
  END LOOP;
  fingerprint:=encode(sha256(convert_to(before_rows::text,'UTF8')),'hex');
  RAISE NOTICE 'CLEANUP_REVIEW_FINGERPRINT=%',fingerprint;
  IF current_setting('cleanup.expected_fingerprint')<>'' AND current_setting('cleanup.expected_fingerprint')<>fingerprint THEN
   RAISE EXCEPTION 'CLEANUP_REVIEW_FINGERPRINT_CHANGED';
  END IF;
  -- Only these nine application deletion guards; revision/FK guards stay active.
  ALTER TABLE order_amendments DISABLE TRIGGER protect_amendments;
  ALTER TABLE platform_order_cancellations DISABLE TRIGGER protect_platform_cancellation;
  ALTER TABLE daily_reports DISABLE TRIGGER daily_reports_immutable;
  ALTER TABLE kitchen_timers DISABLE TRIGGER immutable_kitchen_timer;
  ALTER TABLE payments DISABLE TRIGGER protect_payments;
  ALTER TABLE order_status_history DISABLE TRIGGER immutable_order_history;
  ALTER TABLE order_items DISABLE TRIGGER immutable_order_items;
  ALTER TABLE orders DISABLE TRIGGER immutable_orders;
  ALTER TABLE bills DISABLE TRIGGER protect_bills;

  DELETE FROM kitchen_timers WHERE id='273e996f-81c6-45bd-8bd8-95f836bc3722' AND order_id=ANY(targets);
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'CLEANUP_TIMER_DELETE_COUNT'; END IF;
  deleted:=deleted||jsonb_build_object('kitchen_timers',n);
  DELETE FROM payments WHERE bill_id=ANY(bill_ids);
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>4 THEN RAISE EXCEPTION 'CLEANUP_PAYMENT_DELETE_COUNT'; END IF;
  deleted:=deleted||jsonb_build_object('payments',n);
  DELETE FROM order_amendments WHERE id=ANY(amendment_ids) AND order_id=ANY(targets);
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>3 THEN RAISE EXCEPTION 'CLEANUP_AMENDMENT_DELETE_COUNT'; END IF;
  deleted:=deleted||jsonb_build_object('order_amendments',n);
  DELETE FROM platform_order_cancellations WHERE order_id=ANY(targets);
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>2 THEN RAISE EXCEPTION 'CLEANUP_PLATFORM_DELETE_COUNT'; END IF;
  deleted:=deleted||jsonb_build_object('platform_order_cancellations',n);
  DELETE FROM daily_reports WHERE id=report_id AND business_date=DATE '2026-10-17' AND version=1;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'CLEANUP_REPORT_DELETE_COUNT'; END IF;
  deleted:=deleted||jsonb_build_object('daily_reports',n);
  DELETE FROM order_status_history WHERE order_id=ANY(targets);
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>18 THEN RAISE EXCEPTION 'CLEANUP_HISTORY_DELETE_COUNT'; END IF;
  deleted:=deleted||jsonb_build_object('order_status_history',n);
  DELETE FROM order_items WHERE order_id=ANY(targets);
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>9 THEN RAISE EXCEPTION 'CLEANUP_ITEM_DELETE_COUNT'; END IF;
  deleted:=deleted||jsonb_build_object('order_items',n);
  DELETE FROM orders WHERE id=ANY(targets);
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>7 THEN RAISE EXCEPTION 'CLEANUP_ORDER_DELETE_COUNT'; END IF;
  deleted:=deleted||jsonb_build_object('orders',n);
  DELETE FROM bills WHERE id=ANY(bill_ids);
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>5 THEN RAISE EXCEPTION 'CLEANUP_BILL_DELETE_COUNT'; END IF;
  deleted:=deleted||jsonb_build_object('bills',n);

  ALTER TABLE order_amendments ENABLE TRIGGER protect_amendments;
  ALTER TABLE platform_order_cancellations ENABLE TRIGGER protect_platform_cancellation;
  ALTER TABLE daily_reports ENABLE TRIGGER daily_reports_immutable;
  ALTER TABLE kitchen_timers ENABLE TRIGGER immutable_kitchen_timer;
  ALTER TABLE payments ENABLE TRIGGER protect_payments;
  ALTER TABLE order_status_history ENABLE TRIGGER immutable_order_history;
  ALTER TABLE order_items ENABLE TRIGGER immutable_order_items;
  ALTER TABLE orders ENABLE TRIGGER immutable_orders;
  ALTER TABLE bills ENABLE TRIGGER protect_bills;
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE schema_query INTO schema_after;
  IF schema_after<>schema_before OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='dukanos'::regnamespace AND t.tgenabled<>'O') THEN
   RAISE EXCEPTION 'CLEANUP_SCHEMA_OR_TRIGGER_RESTORE_FAILED';
  END IF;
  FOR r IN SELECT c.relname FROM pg_class c WHERE c.relnamespace='dukanos'::regnamespace AND c.relkind='r' ORDER BY c.relname COLLATE "C" LOOP
   EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),''[]''::jsonb) FROM dukanos.%I t',r.relname) INTO rowset;
   after_rows:=after_rows||jsonb_build_object(r.relname,rowset);
   IF r.relname=ANY(affected) THEN
    IF rowset<>'[]'::jsonb THEN RAISE EXCEPTION 'CLEANUP_UNEXPECTED_REMAINING_ROWS'; END IF;
   ELSIF r.relname='daily_reports' THEN
    IF rowset IS DISTINCT FROM (SELECT coalesce(jsonb_agg(v ORDER BY v::text COLLATE "C"),'[]'::jsonb) FROM jsonb_array_elements(before_rows->'daily_reports') v WHERE v->>'id'<>report_id::text) THEN
     RAISE EXCEPTION 'CLEANUP_PRESERVED_REPORTS_CHANGED';
    END IF;
   ELSIF rowset IS DISTINCT FROM before_rows->r.relname THEN
    RAISE EXCEPTION 'CLEANUP_PRESERVED_DATA_CHANGED: %',r.relname;
   END IF;
  END LOOP;
  RAISE NOTICE 'CLEANUP_DELETED=%',deleted;
  RAISE NOTICE 'CLEANUP_PRESERVATION_AND_TRIGGER_CHECKS_PASSED';
END
$cleanup$;
\if :apply
 COMMIT;
 \echo CLEANUP_COMMITTED
\else
 ROLLBACK;
 \echo CLEANUP_DRY_RUN_ROLLED_BACK
\endif
