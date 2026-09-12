import type { PoolClient } from 'pg';
import type {
  MenuCatalog,
  MenuCategory,
  MenuItem,
  MenuVariant,
  SalesChannel,
  VariantChannel,
} from '@dukanos/shared-types';
type Dates = { createdAt: Date; updatedAt: Date };
function dates<T extends Dates>(row: T) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function readCatalog(client: PoolClient): Promise<MenuCatalog> {
  const categories = (
    await client.query<Omit<MenuCategory, keyof Dates> & Dates>(
      `SELECT id,name,description,sort_order AS "sortOrder",active,version,created_at AS "createdAt",updated_at AS "updatedAt" FROM menu_categories ORDER BY sort_order,lower(name),id`,
    )
  ).rows.map(dates);
  const items = (
    await client.query<Omit<MenuItem, keyof Dates | 'variants'> & Dates>(
      `SELECT id,category_id AS "categoryId",name,description,kitchen_name AS "kitchenName",sort_order AS "sortOrder",active,version,created_at AS "createdAt",updated_at AS "updatedAt" FROM menu_items ORDER BY sort_order,lower(name),id`,
    )
  ).rows;
  const variants = (
    await client.query<
      Omit<MenuVariant, keyof Dates | 'channels'> & Dates & { itemId: string }
    >(
      `SELECT id,menu_item_id AS "itemId",name,display_label AS "displayLabel",sort_order AS "sortOrder",active,created_at AS "createdAt",updated_at AS "updatedAt" FROM item_variants ORDER BY sort_order,lower(name),id`,
    )
  ).rows;
  const settings = (
    await client.query<VariantChannel & { variantId: string }>(
      `SELECT variant_id AS "variantId",channel_code AS "channelCode",price::text AS price,available FROM variant_channel_settings ORDER BY channel_code`,
    )
  ).rows;
  const channels = (
    await client.query<SalesChannel>(
      'SELECT code,name,active,sort_order AS "sortOrder" FROM sales_channels ORDER BY sort_order,code',
    )
  ).rows;
  return {
    categories,
    channels,
    items: items.map((item) => ({
      ...dates(item),
      variants: variants
        .filter((v) => v.itemId === item.id)
        .map((variant) => {
          const { itemId: _itemId, ...fields } = dates(variant);
          void _itemId;
          return {
            ...fields,
            channels: settings
              .filter((s) => s.variantId === variant.id)
              .map(({ channelCode, price, available }) => ({
                channelCode,
                price,
                available,
              })),
          };
        }),
    })),
  };
}
