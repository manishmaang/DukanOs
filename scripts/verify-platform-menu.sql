-- Read only; expected_database override is for disposable tests only.
\set ON_ERROR_STOP on
\if :{?expected_database}
\else
 \set expected_database dukanos_prod
\endif
BEGIN READ ONLY;
SET LOCAL search_path=dukanos,pg_catalog;
SET LOCAL statement_timeout='15s';
SELECT set_config('platform_menu.database',:'expected_database',true);
DO $$ BEGIN
 IF current_database()<>current_setting('platform_menu.database') THEN RAISE EXCEPTION 'PLATFORM_MENU_TARGET_INVALID'; END IF;
END $$;
SELECT current_database(),current_schema(),current_user,has_database_privilege(current_user,current_database(),'TEMP') AS has_temporary_privilege;
SELECT channel_code,count(*) AS configured,count(*) FILTER(WHERE available) AS available,count(*) FILTER(WHERE price IS NOT NULL) AS priced
FROM variant_channel_settings WHERE channel_code IN ('COUNTER','SWIGGY','ZOMATO') GROUP BY channel_code ORDER BY channel_code;
-- Must be zero: catches missing rows, null/conflicting prices, disabled availability and measurements.
SELECT count(*) AS missing_or_conflicting_platform_records
FROM item_variants v CROSS JOIN (VALUES ('SWIGGY'),('ZOMATO')) p(code)
LEFT JOIN variant_channel_settings c ON c.variant_id=v.id AND c.channel_code='COUNTER'
LEFT JOIN variant_channel_settings s ON s.variant_id=v.id AND s.channel_code=p.code
WHERE c.price IS NULL OR s.variant_id IS NULL OR s.price IS DISTINCT FROM c.price OR s.available IS DISTINCT FROM true
 OR s.normal_amount IS NOT NULL OR s.reduced_amount IS NOT NULL OR s.serving_unit IS NOT NULL;
SELECT c.name AS category,i.name AS dish,i.kitchen_name,v.id AS variant_id,v.name AS portion,v.display_label,
 counter.price AS counter_price,swiggy.price AS swiggy_price,zomato.price AS zomato_price,
 swiggy.available AS swiggy_available,zomato.available AS zomato_available
FROM item_variants v JOIN menu_items i ON i.id=v.menu_item_id JOIN menu_categories c ON c.id=i.category_id
LEFT JOIN variant_channel_settings counter ON counter.variant_id=v.id AND counter.channel_code='COUNTER'
LEFT JOIN variant_channel_settings swiggy ON swiggy.variant_id=v.id AND swiggy.channel_code='SWIGGY'
LEFT JOIN variant_channel_settings zomato ON zomato.variant_id=v.id AND zomato.channel_code='ZOMATO'
ORDER BY c.created_at,c.id,i.created_at,i.id,v.created_at,v.id;
SELECT action,count(*) FROM menu_audit GROUP BY action ORDER BY action;
SELECT a.item_id,u.username,a.created_at,a.before_value->>'version' AS before_version,a.after_value->>'version' AS after_version
FROM menu_audit a JOIN users u ON u.id=a.actor_id WHERE a.action='UPDATED' ORDER BY a.created_at DESC,a.id;
COMMIT;
