import { MenuMediaService, type PhotoUpload } from './menu-media.service';
import { menuVisibility } from './menu-visibility';
import { randomUUID } from 'node:crypto';
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
import { prepareDish } from './menu-draft';
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
  SaveItemDto,
  CounterAvailabilityDto,
} from './menu.dto';
type Actor = Pick<AuthRequest, 'user' | 'sessionHash'>;
@Injectable()
export class MenuService {
  constructor(
    private readonly db: DatabaseService,
    private readonly media: MenuMediaService,
  ) {}
  /** Orders holds this lock through commit: menu changes cannot invalidate sale snapshots. */
  async lockForConfirmation(client: PoolClient) {
    await client.query('SELECT pg_advisory_xact_lock(742019323)');
  }
  async counterForConfirmation(client: PoolClient) {
    return this.operationalCatalog(await readCatalog(client), 'COUNTER', true);
  }
  async catalog(
    ordering: 'admin' | 'operational' = 'admin',
  ): Promise<MenuCatalog> {
    return this.db.transaction(async (client) => {
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      return readCatalog(client, ordering);
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
    capability: 'menu.manage' | 'menu.availability.manage' = 'menu.manage',
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
          'SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_code=ur.role_code WHERE ur.user_id=$1 AND rp.permission_code=$2',
          [actor.user.id, capability],
        );
        if (!permission.rowCount)
          throw new ForbiddenException({
            code: 'PERMISSION_DENIED',
            message: 'Permission for this menu action is required.',
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
          'INSERT INTO menu_categories(name,description,active) VALUES ($1,$2,$3) RETURNING id',
          [
            textName(input.name, 100),
            optionalText(input.description, 1000),
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
        'UPDATE menu_categories SET name=$2,description=$3,active=$4 WHERE id=$1',
        [
          id,
          textName(input.name ?? old.name, 100),
          input.description === undefined
            ? old.description
            : optionalText(input.description, 1000),
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
    const result = await client.query<{ id: string }>(
      'INSERT INTO item_variants(menu_item_id,name,display_label,active) VALUES ($1,$2,$3,$4) RETURNING id',
      [
        itemId,
        textName(input.name, 80),
        optionalText(input.displayLabel, 40),
        input.active ?? true,
      ],
    );
    return result.rows[0]!.id;
  }
  async uploadImage(file: PhotoUpload | undefined, actor: Actor) {
    // Serialize staged writes with menu edits and bound unassigned files per manager.
    let stagedKey: string | undefined;
    try {
      return await this.write(actor, async (client) => {
        const staged = await client.query<{ count: string }>(
          'SELECT count(*) FROM menu_images m WHERE uploaded_by=$1 AND NOT EXISTS(SELECT 1 FROM menu_items i WHERE i.image_key=m.key)',
          [actor.user.id],
        );
        if (Number(staged.rows[0]!.count) >= 20)
          menuError(
            'MENU_IMAGE_LIMIT',
            'Too many unsaved photos. Save an existing upload or ask the administrator to run media cleanup after 24 hours.',
          );
        const image = await this.media.prepare(file);
        stagedKey = image.key;
        // Persist the file first. A crash can leave an orphan, never a committed missing photo.
        await client.query(
          'INSERT INTO menu_images(key,uploaded_by,width,height,byte_size) VALUES ($1,$2,$3,$4,$5)',
          [image.key, actor.user.id, image.width, image.height, image.byteSize],
        );
        return {
          key: image.key,
          url: image.url,
          width: image.width,
          height: image.height,
        };
      });
    } catch (error) {
      // Failed staging has no client-visible key; discard only after transaction rollback.
      if (stagedKey) await this.media.discardUnused(stagedKey);
      throw error;
    }
  }

  async readImage(key: string, actor: AuthRequest) {
    return this.media.read(key, actor);
  }
  async createItem(input: CreateItemDto, actor: Actor) {
    return this.write(actor, async (client, catalog) =>
      this.writeDish(client, catalog, input, actor),
    );
  }
  async replaceItem(id: string, input: SaveItemDto, actor: Actor) {
    let obsolete: string | undefined;
    const result = await this.write(actor, async (client, catalog) => {
      const old = this.findItem(catalog, id);
      checkVersion(old.version, input.version);
      const saved = await this.writeDish(client, catalog, input, actor, old);
      if (old.image?.key && old.image.key !== saved.image?.key)
        obsolete = old.image.key;
      return saved;
    });
    if (obsolete) await this.media.discardUnused(obsolete);
    return result;
  }
  private async writeDish(
    client: PoolClient,
    catalog: MenuCatalog,
    input: CreateItemDto,
    actor: Actor,
    old?: MenuItem,
  ) {
    // Validate the complete final configuration before the first write.
    const dish = prepareDish(catalog, input, old);
    const imageKey =
      input.imageKey === undefined ? (old?.image?.key ?? null) : input.imageKey;
    if (imageKey && imageKey !== old?.image?.key) {
      const image = await client.query(
        'SELECT 1 FROM menu_images m WHERE key=$1 AND uploaded_by=$2 AND NOT EXISTS(SELECT 1 FROM menu_items i WHERE i.image_key=m.key)',
        [imageKey, actor.user.id],
      );
      if (!image.rowCount || !(await this.media.exists(imageKey)))
        menuError(
          'MENU_IMAGE_INVALID',
          'This photo is no longer available. Upload it again.',
        );
    }
    let id = old?.id;
    if (id) {
      await client.query(
        'UPDATE menu_items SET category_id=$2,name=$3,description=$4,kitchen_name=$5,active=$6 WHERE id=$1',
        [
          id,
          dish.categoryId,
          dish.name,
          dish.description,
          dish.kitchenName,
          dish.active,
        ],
      );
    } else {
      id = (
        await client.query<{ id: string }>(
          'INSERT INTO menu_items(category_id,name,description,kitchen_name,active) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [
            dish.categoryId,
            dish.name,
            dish.description,
            dish.kitchenName,
            dish.active,
          ],
        )
      ).rows[0]!.id;
    }
    if (input.imageKey !== undefined)
      await client.query('UPDATE menu_items SET image_key=$2 WHERE id=$1', [
        id,
        imageKey,
      ]);
    // Free names being changed so a valid full-dish save can swap portion names.
    // Temporary names are transaction-local and never enter the public audit snapshot.
    for (const variant of dish.variants) {
      if (
        variant.id &&
        old?.variants.find((v) => v.id === variant.id)?.name !== variant.name
      ) {
        await client.query('UPDATE item_variants SET name=$2 WHERE id=$1', [
          variant.id,
          '__rename_' + randomUUID(),
        ]);
      }
    }
    for (const variant of dish.variants) {
      let variantId = variant.id;
      if (variantId) {
        await client.query(
          'UPDATE item_variants SET name=$2,display_label=$3,active=$4 WHERE id=$1',
          [variantId, variant.name, variant.displayLabel, variant.active],
        );
      } else {
        variantId = await this.insertVariant(client, id, variant);
      }
      for (const setting of variant.channels) {
        await client.query(
          'INSERT INTO variant_channel_settings(variant_id,channel_code,price,available) VALUES ($1,$2,$3,$4) ON CONFLICT(variant_id,channel_code) DO UPDATE SET price=EXCLUDED.price,available=EXCLUDED.available',
          [variantId, setting.channelCode, setting.price, setting.available],
        );
      }
    }
    return this.saveItem(client, actor, id, old ?? null);
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
        'UPDATE menu_items SET category_id=$2,name=$3,description=$4,kitchen_name=$5,active=$6 WHERE id=$1',
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
        'UPDATE item_variants SET name=$2,display_label=$3,active=$4 WHERE id=$1',
        [
          id,
          textName(input.name ?? variant.name, 80),
          input.displayLabel === undefined
            ? variant.displayLabel
            : optionalText(input.displayLabel, 40),
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
  async setCounterAvailability(
    id: string,
    input: CounterAvailabilityDto,
    actor: Actor,
  ) {
    return this.write(
      actor,
      async (client, catalog) => {
        const item = this.findItem(catalog, id);
        checkVersion(item.version, input.version);
        this.active(
          item.active &&
            this.category(catalog, item.categoryId).active &&
            !!catalog.channels.find((c) => c.code === 'COUNTER')?.active,
        );
        const targets = input.variantId
          ? item.variants.filter((v) => v.id === input.variantId)
          : item.variants.filter(
              (v) =>
                v.active && v.channels.some((c) => c.channelCode === 'COUNTER'),
            );
        if (!targets.length)
          menuError(
            'MENU_VARIANT_INVALID',
            'Choose an active Counter portion of this dish.',
          );
        for (const variant of targets) {
          this.active(variant.active);
          if (!variant.channels.some((c) => c.channelCode === 'COUNTER'))
            menuError(
              'MENU_PRICE_REQUIRED',
              'Set a Counter price in Menu before changing availability.',
            );
        }
        await client.query(
          "UPDATE variant_channel_settings SET available=$2 WHERE channel_code='COUNTER' AND variant_id=ANY($1::uuid[]) AND available IS DISTINCT FROM $2",
          [targets.map((v) => v.id), input.available],
        );
        await this.saveItem(client, actor, item.id, item);
        return this.operationalCatalog(
          await readCatalog(client, 'operational'),
          'COUNTER',
          true,
        );
      },
      'menu.availability.manage',
    );
  }
  async counter(): Promise<OperationalMenu> {
    return this.operationalCatalog(
      await this.catalog('operational'),
      'COUNTER',
      true,
    );
  }
  async operational(code: string): Promise<OperationalMenu> {
    return this.operationalCatalog(await this.catalog('operational'), code);
  }
  private operationalCatalog(
    catalog: MenuCatalog,
    code: string,
    includeUnavailable = false,
  ): OperationalMenu {
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
              version: item.version,
              name: item.name,
              kitchenName: item.kitchenName,
              image: item.image,
              variants: item.variants
                .filter((v) =>
                  includeUnavailable
                    ? v.active
                    : menuVisibility(
                        item,
                        category.active,
                        channel,
                      ).variants.some((p) => p.id === v.id && p.visible),
                )
                .flatMap((v) => {
                  const price = v.channels.find(
                    (c) =>
                      c.channelCode === code &&
                      (includeUnavailable || c.available),
                  );
                  return price
                    ? [
                        {
                          id: v.id,
                          name: v.name,
                          displayLabel: v.displayLabel,
                          price: price.price,
                          available: price.available,
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
