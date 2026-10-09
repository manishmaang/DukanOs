import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  PlatformMenu,
  PlatformOrder,
  PlatformOrderList,
  PlatformSource,
  ServingSnapshot,
} from '@dukanos/shared-types';
import { DatabaseService } from '../../database/database.service';
import { RestaurantClock } from '../../database/restaurant-clock';
import { authorizeMutation } from '../auth/mutation-access';
import type { AuthRequest } from '../auth/access';
import { readCatalog } from '../menu/menu.repository';
import type { PlatformListDto, PlatformOrderDto } from './platform-orders.dto';
import { amount, paise } from './order-policy';
@Injectable()
export class PlatformOrdersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly clock: RestaurantClock,
  ) {}
  async menu(source: PlatformSource): Promise<PlatformMenu> {
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      return this.menuOn(c, source);
    });
  }
  private async menuOn(
    c: PoolClient,
    source: PlatformSource,
  ): Promise<PlatformMenu> {
    const catalog = await readCatalog(c, 'operational');
    if (!catalog.channels.find((ch) => ch.code === source)?.active)
      throw new BadRequestException({
        code: 'MENU_CHANNEL_INACTIVE',
        message: 'This platform channel is inactive.',
      });
    return {
      source,
      categories: catalog.categories
        .filter((c) => c.active)
        .map((category) => ({
          id: category.id,
          name: category.name,
          items: catalog.items
            .filter((i) => i.categoryId === category.id && i.active)
            .map((i) => ({
              id: i.id,
              name: i.name,
              image: i.image,
              variants: i.variants
                .filter((v) => v.active)
                .flatMap((v) => {
                  const s = v.channels.find((s) => s.channelCode === source);
                  if (!s) return [];
                  const profile = (
                    mode: 'NORMAL' | 'REDUCED',
                    value: string | null | undefined,
                  ): ServingSnapshot | null =>
                    value && s.servingUnit
                      ? {
                          mode,
                          amount: amount(paise(value)),
                          unit: s.servingUnit,
                        }
                      : null;
                  return [
                    {
                      id: v.id,
                      name: v.name,
                      available: s.available,
                      normal: profile('NORMAL', s.normalAmount),
                      reduced: profile('REDUCED', s.reducedAmount),
                    },
                  ];
                }),
            }))
            .filter((i) => i.variants.length),
        }))
        .filter((c) => c.items.length),
    };
  }
  async create(
    input: PlatformOrderDto,
    actor: AuthRequest,
  ): Promise<PlatformOrder> {
    const normalized = {
      source: input.source,
      externalReference: input.externalReference.trim().toUpperCase(),
      discountClassification: input.discountClassification,
      lines: input.lines.map((l) => ({
        variantId: l.variantId.toLowerCase(),
        quantity: l.quantity,
        instruction: (l.instruction ?? '').trim(),
        serving: { ...l.serving, amount: amount(paise(l.serving.amount)) },
      })),
    };
    const hash = createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');
    return this.db.transaction(async (c) => {
      await authorizeMutation(c, actor, 'platform_orders.create');
      const existing = (
        await c.query(
          'SELECT id,request_hash FROM orders WHERE confirmed_by=$1 AND request_id=$2',
          [actor.user.id, input.requestId],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== hash)
          throw new ConflictException({
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'This request was already used for a different order.',
          });
        return this.read(c, existing.id);
      }
      const duplicate = (
        await c.query(
          'SELECT id,token_number FROM orders WHERE source=$1 AND external_reference=$2',
          [input.source, normalized.externalReference],
        )
      ).rows[0];
      if (duplicate)
        throw new ConflictException({
          code: 'PLATFORM_REFERENCE_EXISTS',
          message: `This platform reference already belongs to token #${duplicate.token_number}. Open its history; references cannot be reused, including cancelled entries.`,
          orderId: duplicate.id,
        });
      const menu = await this.menuOn(c, input.source);
      const catalog = await readCatalog(c);
      const lines = normalized.lines.map((line, index) => {
        const item = menu.categories
          .flatMap((c) => c.items)
          .find((i) => i.variants.some((v) => v.id === line.variantId));
        const variant = item?.variants.find((v) => v.id === line.variantId);
        if (!item || !variant?.available)
          throw new ConflictException({
            code: 'ITEM_NOT_AVAILABLE',
            message: `Line ${index + 1}: ${item?.name ?? 'selected portion'} is unavailable on ${input.source}.`,
          });
        const serving =
          line.serving.mode === 'NORMAL' ? variant.normal : variant.reduced;
        if (!serving)
          throw new ConflictException({
            code: 'SERVING_PROFILE_REQUIRED',
            message: `${item.name} / ${variant.name}: configure the selected serving in Menu first.`,
          });
        if (
          serving.amount !== line.serving.amount ||
          serving.unit !== line.serving.unit
        )
          throw new ConflictException({
            code: 'SERVING_PROFILE_CHANGED',
            message: `${item.name} / ${variant.name}: the serving size changed. Review the current menu before submitting.`,
          });
        return {
          ...line,
          serving,
          item,
          variant,
          kitchenName:
            catalog.items.find((i) => i.id === item.id)?.kitchenName ??
            item.name,
        };
      });
      const now = await this.clock.read(c);
      const token = (
        await c.query(
          'INSERT INTO order_daily_tokens(business_date,last_token) VALUES($1,1) ON CONFLICT(business_date) DO UPDATE SET last_token=order_daily_tokens.last_token+1 RETURNING last_token',
          [now.business_date],
        )
      ).rows[0].last_token;
      const id = randomUUID();
      await c.query(
        `INSERT INTO orders(id,source,status,business_date,token_number,confirmed_by,request_id,request_hash,queued_at,timezone,discount_total,rounding_adjustment,external_reference,discount_classification) VALUES($1,$2,'QUEUED',$3,$4,$5,$6,$7,$8,$9,NULL,NULL,$10,$11)`,
        [
          id,
          input.source,
          now.business_date,
          token,
          actor.user.id,
          input.requestId,
          hash,
          now.queued_at,
          this.clock.timezone,
          normalized.externalReference,
          input.discountClassification,
        ],
      );
      for (const [index, line] of lines.entries())
        await c.query(
          `INSERT INTO order_items(id,order_id,position,menu_item_id,variant_id,item_name_snapshot,kitchen_name_snapshot,variant_name_snapshot,quantity,instruction,serving_mode,serving_amount,serving_unit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            randomUUID(),
            id,
            index + 1,
            line.item.id,
            line.variantId,
            line.item.name,
            line.kitchenName,
            line.variant.name,
            line.quantity,
            line.instruction,
            line.serving.mode,
            line.serving.amount,
            line.serving.unit,
          ],
        );
      await c.query(
        "INSERT INTO order_status_history(id,order_id,from_status,to_status,actor_id,occurred_at,reason) VALUES($1,$2,'DRAFT','QUEUED',$3,$4,'Manual platform order submitted')",
        [randomUUID(), id, actor.user.id, now.queued_at],
      );
      return this.read(c, id);
    });
  }
  async get(id: string) {
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      return this.read(c, id);
    });
  }
  private async read(c: PoolClient, id: string): Promise<PlatformOrder> {
    const o = (
      await c.query(
        `SELECT id,source,external_reference AS "externalReference",discount_classification AS "discountClassification",business_date::text AS "businessDate",token_number AS "tokenNumber",status,queued_at AS "queuedAt",confirmed_by AS "confirmedBy" FROM orders WHERE id=$1 AND source IN ('ZOMATO','SWIGGY')`,
        [id],
      )
    ).rows[0];
    if (!o)
      throw new NotFoundException({
        code: 'PLATFORM_ORDER_NOT_FOUND',
        message: 'Platform order was not found.',
      });
    const items = (
      await c.query(
        `SELECT id,menu_item_id AS "menuItemId",variant_id AS "variantId",item_name_snapshot AS "itemName",variant_name_snapshot AS "variantName",quantity,instruction,jsonb_build_object('mode',serving_mode,'amount',serving_amount::text,'unit',serving_unit) AS serving FROM order_items WHERE order_id=$1 ORDER BY position`,
        [id],
      )
    ).rows;
    const history = (
      await c.query(
        `SELECT h.from_status AS "fromStatus",h.to_status AS "toStatus",h.actor_id AS "actorId",coalesce(u.name,'System') AS "actorName",h.occurred_at AS "occurredAt",h.reason FROM order_status_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.order_id=$1 ORDER BY h.occurred_at,h.id`,
        [id],
      )
    ).rows.map((h) => ({ ...h, occurredAt: h.occurredAt.toISOString() }));
    return { ...o, queuedAt: o.queuedAt.toISOString(), items, history };
  }
  async list(query: PlatformListDto): Promise<PlatformOrderList> {
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const search = query.search?.trim().toUpperCase() ?? '';
      const ids = (
        await c.query(
          `SELECT id FROM orders WHERE source IN ('ZOMATO','SWIGGY') AND ($1='' OR strpos(external_reference,$1)>0 OR token_number::text=regexp_replace($1,'^#','')) AND ($2::uuid IS NULL OR (queued_at,id)<(SELECT queued_at,id FROM orders WHERE id=$2 AND source<>'COUNTER')) ORDER BY queued_at DESC,id DESC LIMIT 51`,
          [search, query.after ?? null],
        )
      ).rows;
      const orders: PlatformOrder[] = [];
      for (const row of ids.slice(0, 50))
        orders.push(await this.read(c, row.id));
      return {
        orders,
        nextCursor: ids.length > 50 ? ids[49].id : null,
      };
    });
  }
  async cancel(id: string, reason: string, actor: AuthRequest) {
    if (reason.trim() === 'PREVIOUS_BUSINESS_DAY_AUTO_CANCEL')
      throw new BadRequestException({
        code: 'INVALID_CANCELLATION_REASON',
        message:
          'Enter the staff-observed reason; the maintenance reason is reserved for system cleanup.',
      });
    return this.db.transaction(async (c) => {
      await authorizeMutation(c, actor, 'platform_orders.cancel');
      const order = await this.read(c, id);
      if (!['QUEUED', 'PREPARING', 'READY'].includes(order.status))
        throw new ConflictException({
          code: 'INVALID_ORDER_TRANSITION',
          message:
            'Only unfinished platform orders can be cancelled. Completed handovers cannot be reversed.',
        });
      const time = (
        await c.query(
          'SELECT GREATEST(clock_timestamp(),max(occurred_at)) AS t FROM order_status_history WHERE order_id=$1',
          [id],
        )
      ).rows[0].t;
      await c.query(
        'INSERT INTO platform_order_cancellations(order_id,actor_id,occurred_at,reason) VALUES($1,$2,$3,$4)',
        [id, actor.user.id, time, reason.trim()],
      );
      await c.query(
        "INSERT INTO order_status_history(id,order_id,from_status,to_status,actor_id,occurred_at,reason) VALUES($1,$2,$3,'CANCELLED',$4,$5,$6)",
        [randomUUID(), id, order.status, actor.user.id, time, reason.trim()],
      );
      await c.query(
        "UPDATE kitchen_timers SET status='CANCELLED',resolved_by=$2,resolved_at=GREATEST($3::timestamptz,started_at) WHERE order_id=$1 AND status='ACTIVE'",
        [id, actor.user.id, time],
      );
      return this.read(c, id);
    });
  }
}
