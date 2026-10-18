-- Read-only pre/post evidence; counts and digests, never passwords or row payloads.
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path=dukanos,pg_catalog;
SET LOCAL timezone='UTC';
SET LOCAL datestyle='ISO, YMD';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF current_database()<>'dukanos_prod' OR current_schema()<>'dukanos' THEN
 RAISE EXCEPTION 'CLEANUP_VERIFICATION_WRONG_DATABASE'; END IF;
END $$;
SELECT id,business_date,token_number,source,status,bill_id FROM orders ORDER BY business_date,token_number;
SELECT count(*) AS collections,sum(amount) AS total,sum(amount) FILTER(WHERE method='CASH') AS cash,sum(amount) FILTER(WHERE method='UPI') AS upi FROM payments WHERE type='COLLECTION';
SELECT * FROM order_daily_tokens ORDER BY business_date;
SELECT * FROM bill_daily_numbers ORDER BY business_date;
-- Exact identities and metadata for independent owner review; no recipients/secrets.
SELECT id,business_date,version,source,generated_at,generated_by,reason,
 snapshot->>'businessDate' AS snapshot_date,snapshot->>'timezone' AS snapshot_timezone,
 encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') AS snapshot_hash
 FROM daily_reports ORDER BY business_date,version;
SELECT enabled,cardinality(recipients) AS recipient_count,version,start_date,next_date,
 (start_date IS NOT NULL AND start_date<=DATE '2026-10-17' AND next_date=DATE '2026-10-18') AS cleanup_cursor_safe
 FROM daily_report_settings;
SELECT id,order_id,bill_id,revision,kind,performed_by,created_at,reason,before_total,subtotal,tax_total,grand_total,cleanup_timezone,cleanup_time
 FROM order_amendments ORDER BY order_id,revision;
SELECT * FROM platform_order_cancellations ORDER BY order_id;
SELECT id,order_id,from_status,to_status,actor_id,occurred_at,reason FROM order_status_history ORDER BY order_id,occurred_at,id;
SELECT id,order_id,order_item_id,status,started_at,resolved_at FROM kitchen_timers ORDER BY id;
SELECT id,business_date,bill_number,status,closure_reason,opened_at,closed_at FROM bills ORDER BY business_date,bill_number;
SELECT id,bill_id,confirmation_order_id,type,method,amount,created_at FROM payments ORDER BY created_at,id;
SELECT id,order_id,menu_item_id,variant_id,quantity,line_subtotal FROM order_items ORDER BY order_id,position;
SELECT id,report_id,kind,status,created_at,sent_at,attempt_count FROM report_deliveries ORDER BY created_at,id;
SELECT id,delivery_id,attempt,outcome,occurred_at FROM report_delivery_attempts ORDER BY occurred_at,id;
SELECT id,delivery_id,actor_id,occurred_at FROM report_delivery_actions ORDER BY occurred_at,id;
SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') AS preserved_oct10_oct16_reports_sha256,
 count(*) AS preserved_reports FROM daily_reports r WHERE business_date BETWEEN DATE '2026-10-10' AND DATE '2026-10-16';
SELECT pid,backend_type,state FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid();
SELECT c.relname AS referencing_table,k.conname,pg_get_constraintdef(k.oid) AS definition
 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
 WHERE k.contype='f' AND k.confrelid IN ('orders'::regclass,'bills'::regclass,'order_items'::regclass,'order_amendments'::regclass,'daily_reports'::regclass,'report_deliveries'::regclass)
 ORDER BY c.relname,k.conname;
SELECT c.relname,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 WHERE c.relnamespace='dukanos'::regnamespace AND t.tgname IN ('immutable_orders','immutable_order_items','immutable_order_history','immutable_kitchen_timer','protect_payments','protect_bills','protect_amendments','protect_revision_items','protect_platform_cancellation','daily_reports_immutable') ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C";
SELECT count(*) AS disabled_triggers FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='dukanos'::regnamespace AND t.tgenabled<>'O';
SELECT count(*) AS unvalidated_foreign_keys FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='dukanos'::regnamespace AND k.contype='f' AND NOT k.convalidated;
SELECT encode(sha256(convert_to(jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.relname COLLATE "C") FROM pg_class c WHERE c.relnamespace='dukanos'::regnamespace AND c.relkind IN ('r','p','v','m','S','f')),
 'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname COLLATE "C",a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE c.relnamespace='dukanos'::regnamespace AND c.relkind IN ('r','p','v','m','S','f') AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid),k.convalidated,k.condeferrable,k.condeferred) ORDER BY c.relname COLLATE "C",k.conname COLLATE "C") FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='dukanos'::regnamespace),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname,t.tgenabled,t.tgisinternal,pg_get_triggerdef(t.oid)) ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C") FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='dukanos'::regnamespace AND NOT t.tgisinternal),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_functiondef(p.oid)) ORDER BY p.proname COLLATE "C",pg_get_function_identity_arguments(p.oid) COLLATE "C") FROM pg_proc p WHERE p.pronamespace='dukanos'::regnamespace),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(c.relname,pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY c.relname COLLATE "C") FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace='dukanos'::regnamespace),
 'rules',(SELECT jsonb_agg(jsonb_build_array(c.relname,r.rulename,pg_get_ruledef(r.oid)) ORDER BY c.relname COLLATE "C",r.rulename COLLATE "C") FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class WHERE c.relnamespace='dukanos'::regnamespace)
)::text,'UTF8')),'hex');
DO $$ DECLARE r record; digest text; n bigint; BEGIN
 FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='dukanos' ORDER BY tablename LOOP
 EXECUTE format('SELECT count(*),encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),''[]''::jsonb)::text,''UTF8'')),''hex'') FROM dukanos.%I t',r.tablename) INTO n,digest;
 RAISE NOTICE 'PRESERVATION_HASH % rows=% sha256=%',r.tablename,n,digest;
 END LOOP;
END $$;
SELECT 'PRESERVATION_HASH verification complete';
COMMIT;
