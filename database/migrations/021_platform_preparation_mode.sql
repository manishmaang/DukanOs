-- Qualitative preparation for new platform orders. No existing rows are rewritten.
-- NULL distinguishes migration-020 measured history from order-wide instructions.
ALTER TABLE orders ADD COLUMN preparation_mode text;
ALTER TABLE orders DROP CONSTRAINT order_financial_participation;
ALTER TABLE orders ADD CONSTRAINT order_financial_participation CHECK (
 (source='COUNTER' AND preparation_mode IS NULL AND bill_id IS NOT NULL AND external_reference IS NULL AND discount_classification IS NULL AND subtotal IS NOT NULL AND discount_total IS NOT NULL AND tax_total IS NOT NULL AND rounding_adjustment IS NOT NULL AND grand_total IS NOT NULL AND tax_rate IS NOT NULL AND tax_label IS NOT NULL AND tax_mode IS NOT NULL AND tax_rounding IS NOT NULL) OR
 (source IN ('ZOMATO','SWIGGY') AND bill_id IS NULL AND external_reference IS NOT NULL
 AND external_reference ~ '^[A-Z0-9][A-Z0-9_-]{0,79}$'
 AND ((preparation_mode IS NULL AND discount_classification IS NOT NULL AND discount_classification IN ('NONE','APPLIED','UNKNOWN')) OR (preparation_mode IS NOT NULL AND preparation_mode IN ('NORMAL','REDUCED') AND discount_classification IS NULL)) AND subtotal IS NULL AND discount_total IS NULL AND tax_total IS NULL AND rounding_adjustment IS NULL AND grand_total IS NULL AND tax_rate IS NULL AND tax_label IS NULL AND tax_mode IS NULL AND tax_rounding IS NULL)
);

CREATE FUNCTION require_platform_preparation_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source IN ('ZOMATO','SWIGGY') AND (NEW.preparation_mode IS NULL OR NEW.discount_classification IS NOT NULL) THEN
  RAISE EXCEPTION 'PLATFORM_PREPARATION_REQUIRED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER platform_preparation_required BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION require_platform_preparation_mode();
-- The existing to_jsonb order immutability guard also protects the new column.
-- New lines derive their preparation mode from the order, never a second stored mode.
CREATE OR REPLACE FUNCTION validate_order_line_participation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
 SELECT * INTO o FROM orders WHERE id=NEW.order_id;
 IF o.source='COUNTER' THEN
  IF NEW.unit_price_snapshot IS NULL OR NEW.line_subtotal IS NULL OR NEW.serving_mode IS NOT NULL THEN
   RAISE EXCEPTION 'INVALID_COUNTER_LINE' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NEW.unit_price_snapshot IS NOT NULL OR NEW.line_subtotal IS NOT NULL
   OR o.preparation_mode IS NULL OR NEW.serving_mode IS NOT NULL OR NEW.serving_amount IS NOT NULL OR NEW.serving_unit IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM variant_channel_settings s JOIN item_variants v ON v.id=s.variant_id
    JOIN menu_items i ON i.id=v.menu_item_id JOIN menu_categories c ON c.id=i.category_id
    JOIN sales_channels ch ON ch.code=s.channel_code
    WHERE s.variant_id=NEW.variant_id AND s.channel_code=o.source AND s.available AND v.active AND i.active AND c.active AND ch.active)
  THEN RAISE EXCEPTION 'INVALID_PLATFORM_LINE' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
