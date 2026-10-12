-- Read-only reconciliation; run with the same protected maintenance connection.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL search_path = dukanos,pg_catalog;
SET LOCAL statement_timeout = '15s';
SELECT current_database(),current_schema(),current_user;
SELECT count(*) AS applied_migrations,max(name) AS latest_migration FROM schema_migrations;
SELECT c.name AS category,i.name AS dish,i.kitchen_name,v.name AS variant,s.price,s.available,
 c.active AS category_active,i.active AS item_active,v.active AS variant_active
FROM menu_categories c JOIN menu_items i ON i.category_id=c.id
JOIN item_variants v ON v.menu_item_id=i.id
LEFT JOIN variant_channel_settings s ON s.variant_id=v.id AND s.channel_code='COUNTER'
ORDER BY c.created_at,c.id,i.created_at,i.id,v.created_at,v.id;
SELECT c.name,count(DISTINCT i.id) AS dishes,count(v.id) AS variants
FROM menu_categories c LEFT JOIN menu_items i ON i.category_id=c.id
LEFT JOIN item_variants v ON v.menu_item_id=i.id GROUP BY c.id ORDER BY c.created_at,c.id;
SELECT u.username,a.action,count(*) AS audit_rows,min(a.created_at),max(a.created_at)
FROM menu_audit a JOIN users u ON u.id=a.actor_id GROUP BY u.username,a.action ORDER BY u.username,a.action;
SELECT u.id,u.username,u.active,array_agg(ur.role_code ORDER BY ur.role_code) AS roles
FROM users u JOIN user_roles ur ON ur.user_id=u.id GROUP BY u.id ORDER BY u.username;
SELECT 'orders' AS record_type,count(*) FROM orders
UNION ALL SELECT 'bills',count(*) FROM bills
UNION ALL SELECT 'payments',count(*) FROM payments;
COMMIT;
