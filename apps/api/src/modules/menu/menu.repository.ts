import { menuVisibility } from './menu-visibility';
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
export async function readCatalog(
  client: PoolClient,
  ordering: 'admin' | 'operational' = 'admin',
): Promise<MenuCatalog> {
  const direction = ordering === 'admin' ? 'DESC' : 'ASC';
  const categories = (
    await client.query<Omit<MenuCategory, keyof Dates> & Dates>(
      `SELECT id,name,description,active,version,created_at AS "createdAt",updated_at AS "updatedAt" FROM menu_categories ORDER BY created_at ${direction},id ${direction}`,
    )
  ).rows.map(dates);
  const items = (
    await client.query<
      Omit<MenuItem, keyof Dates | 'variants' | 'counterVisibility'> & Dates
    >(
      `SELECT i.id,category_id AS "categoryId",name,description,kitchen_name AS "kitchenName",active,version,i.created_at AS "createdAt",updated_at AS "updatedAt",CASE WHEN m.key IS NULL THEN NULL ELSE jsonb_build_object('key',m.key,'url','/api/menu/images/'||m.key,'width',m.width,'height',m.height) END AS image FROM menu_items i LEFT JOIN menu_images m ON m.key=i.image_key ORDER BY i.created_at ${direction},i.id ${direction}`,
    )
  ).rows;
  const variants = (
    await client.query<
      Omit<MenuVariant, keyof Dates | 'channels'> & Dates & { itemId: string }
    >(
      `SELECT id,menu_item_id AS "itemId",name,display_label AS "displayLabel",active,created_at AS "createdAt",updated_at AS "updatedAt" FROM item_variants ORDER BY created_at,id`,
    )
  ).rows;
  const settings = (
    await client.query<VariantChannel & { variantId: string }>(
      `SELECT variant_id AS "variantId",channel_code AS "channelCode",price::text AS price,available FROM variant_channel_settings ORDER BY channel_code`,
    )
  ).rows;
  const channels = (
    await client.query<SalesChannel>(
      'SELECT code,name,active FROM sales_channels ORDER BY created_at,code',
    )
  ).rows;
  return {
    categories,
    channels,
    items: items
      .map((item) => ({
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
      }))
      .map((item) => ({
        ...item,
        counterVisibility: menuVisibility(
          item,
          !!categories.find((c) => c.id === item.categoryId)?.active,
          channels.find((c) => c.code === 'COUNTER'),
        ),
      })),
  };
}
