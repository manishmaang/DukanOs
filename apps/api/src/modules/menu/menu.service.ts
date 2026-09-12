import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  MenuCatalog,
  MenuItem,
  MenuCategory,
  OperationalMenu,
} from '@dukanos/shared-types';
import type { AuthRequest } from '../auth/access';
import { DatabaseService } from '../../database/database.service';
import { readCatalog } from './menu.repository';
import {
  checkVersion,
  menuError,
  money,
  optionalText,
  textName,
} from './menu-policy';
import type {
  CreateCategoryDto,
  UpdateCategoryDto,
  CreateItemDto,
  UpdateItemDto,
  InitialVariantDto,
  CreateVariantDto,
  UpdateVariantDto,
  PriceDto,
  ChannelAvailabilityDto,
} from './menu.dto';
type Actor = Pick<AuthRequest, 'user' | 'sessionHash'>;
@Injectable()
export class MenuService {
  constructor(private readonly db: DatabaseService) {}
  async catalog(): Promise<MenuCatalog> {
    return this.db.transaction(async (client) => {
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      return readCatalog(client);
    });
  }
  async item(id: string): Promise<MenuItem> {
    return this.findItem(await this.catalog(), id);
  }
  private findItem(catalog: MenuCatalog, id: string) {
    const item = catalog.items.find((item) => item.id === id);
    if (!item)
      throw new NotFoundException({
        code: 'MENU_ITEM_NOT_FOUND',
        message: 'Menu item was not found.',
      });
    return item;
  }
  private category(catalog: MenuCatalog, id: string) {
    const category = catalog.categories.find((c) => c.id === id);
    if (!category)
      throw new NotFoundException({
        code: 'MENU_CATEGORY_NOT_FOUND',
        message: 'Category was not found.',
      });
    return category;
  }
  private active(value: boolean) {
    if (!value)
      menuError(
        'MENU_REFERENCE_INACTIVE',
        'Activate the category, item, variant and channel before configuring a price or enabling availability.',
      );
  }
  private async write<T>(
    actor: Actor,
    work: (client: PoolClient, before: MenuCatalog) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(742019323)');
        await client.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [
          actor.user.id,
        ]);
        const session = await client.query(
          'SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND u.id=$2 AND u.active AND s.expires_at>clock_timestamp()',
          [actor.sessionHash, actor.user.id],
        );
        if (!session.rowCount)
          throw new UnauthorizedException({
            code: 'AUTHENTICATION_REQUIRED',
            message: 'Please sign in again.',
          });
        const permission = await client.query(
          "SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_code=ur.role_code WHERE ur.user_id=$1 AND rp.permission_code='menu.manage'",
          [actor.user.id],
        );
        if (!permission.rowCount)
          throw new ForbiddenException({
            code: 'PERMISSION_DENIED',
            message: 'Menu management permission is required.',
          });
        return work(client, await readCatalog(client));
      });
    } catch (error) {
      const pg = error as { code?: string };
      if (pg.code === '23505')
        throw new ConflictException({
          code: 'MENU_DUPLICATE',
          message:
            'This name is already used in its category/item, or this channel setting already exists.',
        });
      if (pg.code === '23503')
        menuError(
          'MENU_REFERENCE_INVALID',
          'A referenced menu entry does not exist.',
        );
      throw error;
    }
  }
  private async audit(
    client: PoolClient,
    actor: Actor,
    kind: 'category' | 'item',
    id: string,
    before: MenuCategory | MenuItem | null,
    after: MenuCategory | MenuItem,
  ) {
    await client.query(
      'INSERT INTO menu_audit(actor_id,category_id,item_id,action,before_value,after_value) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        actor.user.id,
        kind === 'category' ? id : null,
        kind === 'item' ? id : null,
        before ? 'UPDATED' : 'CREATED',
        before ? JSON.stringify(before) : null,
        JSON.stringify(after),
      ],
    );
  }
  private async saveItem(
    client: PoolClient,
    actor: Actor,
    id: string,
    before: MenuItem | null,
  ) {
    const after = this.findItem(await readCatalog(client), id);
    await this.audit(client, actor, 'item', id, before, after);
    return after;
  }
  async createCategory(input: CreateCategoryDto, actor: Actor) {
    return this.write(actor, async (client) => {
      const id = (
        await client.query<{ id: string }>(
          'INSERT INTO menu_categories(name,description,sort_order,active) VALUES ($1,$2,$3,$4) RETURNING id',
          [
            textName(input.name, 100),
            optionalText(input.description, 1000),
            input.sortOrder ?? 0,
            input.active ?? true,
          ],
        )
      ).rows[0]!.id;
      const after = this.category(await readCatalog(client), id);
      await this.audit(client, actor, 'category', id, null, after);
      return after;
    });
  }
  async updateCategory(id: string, input: UpdateCategoryDto, actor: Actor) {
    return this.write(actor, async (client, catalog) => {
      const old = this.category(catalog, id);
      checkVersion(old.version, input.version);
      await client.query(
        'UPDATE menu_categories SET name=$2,description=$3,sort_order=$4,active=$5 WHERE id=$1',
        [
          id,
          textName(input.name ?? old.name, 100),
          input.description === undefined
            ? old.description
            : optionalText(input.description, 1000),
          input.sortOrder ?? old.sortOrder,
          input.active ?? old.active,
        ],
      );
      const after = this.category(await readCatalog(client), id);
      await this.audit(client, actor, 'category', id, old, after);
      return after;
    });
  }
  private async insertVariant(
    client: PoolClient,
    itemId: string,
    input: InitialVariantDto,
  ) {
    await client.query(
      'INSERT INTO item_variants(menu_item_id,name,display_label,sort_order,active) VALUES ($1,$2,$3,$4,$5)',
      [
        itemId,
        textName(input.name, 80),
        optionalText(input.displayLabel, 40),
        input.sortOrder ?? 0,
        input.active ?? true,
      ],
    );
  }
  async createItem(input: CreateItemDto, actor: Actor) {
    return this.write(actor, async (client, catalog) => {
      this.active(this.category(catalog, input.categoryId).active);
      if (!input.variants?.length)
        menuError('ITEM_REQUIRES_VARIANT', 'Create at least one variant.');
      const id = (
        await client.query<{ id: string }>(
          'INSERT INTO menu_items(category_id,name,description,kitchen_name,sort_order,active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [
            input.categoryId,
            textName(input.name, 120),
            optionalText(input.description, 1000),
            optionalText(input.kitchenName, 120),
            input.sortOrder ?? 0,
            input.active ?? true,
          ],
        )
      ).rows[0]!.id;
      for (const variant of input.variants)
        await this.insertVariant(client, id, variant);
      return this.saveItem(client, actor, id, null);
    });
  }
  async updateItem(id: string, input: UpdateItemDto, actor: Actor) {
    return this.write(actor, async (client, catalog) => {
      const old = this.findItem(catalog, id);
      checkVersion(old.version, input.version);
      const category = this.category(
        catalog,
        input.categoryId ?? old.categoryId,
      );
      if (
        (input.categoryId && input.categoryId !== old.categoryId) ||
        input.active === true
      )
        this.active(category.active);
      await client.query(
        'UPDATE menu_items SET category_id=$2,name=$3,description=$4,kitchen_name=$5,sort_order=$6,active=$7 WHERE id=$1',
        [
          id,
          category.id,
          textName(input.name ?? old.name, 120),
          input.description === undefined
            ? old.description
            : optionalText(input.description, 1000),
          input.kitchenName === undefined
            ? old.kitchenName
            : optionalText(input.kitchenName, 120),
          input.sortOrder ?? old.sortOrder,
          input.active ?? old.active,
        ],
      );
      return this.saveItem(client, actor, id, old);
    });
  }
  async createVariant(itemId: string, input: CreateVariantDto, actor: Actor) {
    return this.write(actor, async (client, catalog) => {
      const old = this.findItem(catalog, itemId);
      checkVersion(old.version, input.itemVersion);
      this.active(old.active && this.category(catalog, old.categoryId).active);
      await this.insertVariant(client, itemId, input);
      return this.saveItem(client, actor, itemId, old);
    });
  }
  private variant(catalog: MenuCatalog, id: string) {
    const item = catalog.items.find((i) => i.variants.some((v) => v.id === id));
    if (!item)
      throw new NotFoundException({
        code: 'MENU_VARIANT_NOT_FOUND',
        message: 'Variant was not found.',
      });
    return { item, variant: item.variants.find((v) => v.id === id)! };
  }
  async updateVariant(id: string, input: UpdateVariantDto, actor: Actor) {
    return this.write(actor, async (client, catalog) => {
      const { item, variant } = this.variant(catalog, id);
      checkVersion(item.version, input.itemVersion);
      if (input.active === true)
        this.active(
          item.active && this.category(catalog, item.categoryId).active,
        );
      await client.query(
        'UPDATE item_variants SET name=$2,display_label=$3,sort_order=$4,active=$5 WHERE id=$1',
        [
          id,
          textName(input.name ?? variant.name, 80),
          input.displayLabel === undefined
            ? variant.displayLabel
            : optionalText(input.displayLabel, 40),
          input.sortOrder ?? variant.sortOrder,
          input.active ?? variant.active,
        ],
      );
      return this.saveItem(client, actor, item.id, item);
    });
  }
  async setPrice(id: string, code: string, input: PriceDto, actor: Actor) {
    const price = money(input.price);
    return this.write(actor, async (client, catalog) => {
      const { item, variant } = this.variant(catalog, id);
      checkVersion(item.version, input.itemVersion);
      const channel = catalog.channels.find((c) => c.code === code);
      if (!channel)
        menuError('MENU_CHANNEL_INVALID', 'Sales channel was not found.');
      this.active(
        this.category(catalog, item.categoryId).active &&
          item.active &&
          variant.active &&
          channel!.active,
      );
      await client.query(
        'INSERT INTO variant_channel_settings(variant_id,channel_code,price) VALUES ($1,$2,$3) ON CONFLICT(variant_id,channel_code) DO UPDATE SET price=EXCLUDED.price',
        [id, code, price],
      );
      return this.saveItem(client, actor, item.id, item);
    });
  }
  async setAvailability(
    id: string,
    code: string,
    input: ChannelAvailabilityDto,
    actor: Actor,
  ) {
    return this.write(actor, async (client, catalog) => {
      const { item, variant } = this.variant(catalog, id);
      checkVersion(item.version, input.itemVersion);
      const channel = catalog.channels.find((c) => c.code === code);
      if (!channel)
        menuError('MENU_CHANNEL_INVALID', 'Sales channel was not found.');
      if (!variant.channels.some((c) => c.channelCode === code))
        menuError(
          'MENU_PRICE_REQUIRED',
          'Set a channel price before changing its availability.',
        );
      if (input.available)
        this.active(
          this.category(catalog, item.categoryId).active &&
            item.active &&
            variant.active &&
            channel!.active,
        );
      await client.query(
        'UPDATE variant_channel_settings SET available=$3 WHERE variant_id=$1 AND channel_code=$2',
        [id, code, input.available],
      );
      return this.saveItem(client, actor, item.id, item);
    });
  }
  async operational(code: string): Promise<OperationalMenu> {
    const catalog = await this.catalog();
    const channel = catalog.channels.find((c) => c.code === code);
    if (!channel)
      menuError('MENU_CHANNEL_INVALID', 'Choose a configured sales channel.');
    if (!channel!.active)
      menuError(
        'MENU_CHANNEL_INACTIVE',
        'The selected sales channel is inactive.',
      );
    return {
      channel: channel!,
      categories: catalog.categories
        .filter((c) => c.active)
        .map((category) => ({
          id: category.id,
          name: category.name,
          items: catalog.items
            .filter((i) => i.categoryId === category.id && i.active)
            .map((item) => ({
              id: item.id,
              name: item.name,
              kitchenName: item.kitchenName,
              variants: item.variants
                .filter((v) => v.active)
                .flatMap((v) => {
                  const price = v.channels.find(
                    (c) => c.channelCode === code && c.available,
                  );
                  return price
                    ? [
                        {
                          id: v.id,
                          name: v.name,
                          displayLabel: v.displayLabel,
                          price: price.price,
                        },
                      ]
                    : [];
                }),
            }))
            .filter((i) => i.variants.length > 0),
        }))
        .filter((c) => c.items.length > 0),
    };
  }
}
