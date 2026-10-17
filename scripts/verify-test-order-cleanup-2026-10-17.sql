-- Read-only pre/post evidence; counts and digests, never passwords or row payloads.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
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
SELECT business_date,version FROM daily_reports ORDER BY business_date,version;
SELECT c.relname,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 WHERE c.relnamespace='dukanos'::regnamespace AND t.tgname IN ('immutable_orders','immutable_order_items','immutable_order_history','immutable_kitchen_timer','protect_payments','protect_bills','protect_amendments','protect_revision_items','protect_platform_cancellation') ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C";
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
