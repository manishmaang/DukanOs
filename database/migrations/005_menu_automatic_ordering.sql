-- Retain every menu record, price, availability flag and historical audit snapshot.
-- Only obsolete, manually assigned ordering metadata is removed.
ALTER TABLE menu_categories DROP COLUMN sort_order;
ALTER TABLE menu_items DROP COLUMN sort_order;
ALTER TABLE item_variants DROP COLUMN sort_order;
ALTER TABLE sales_channels DROP COLUMN sort_order;
CREATE INDEX menu_category_created_idx ON menu_categories(created_at DESC,id DESC);
CREATE INDEX menu_item_created_idx ON menu_items(created_at DESC,id DESC);
CREATE INDEX menu_item_category_created_idx ON menu_items(category_id,created_at,id);
CREATE INDEX menu_variant_item_created_idx ON item_variants(menu_item_id,created_at,id);
-- New variants created together follow their insertion sequence, without an order field.
ALTER TABLE item_variants ALTER COLUMN created_at SET DEFAULT clock_timestamp();
