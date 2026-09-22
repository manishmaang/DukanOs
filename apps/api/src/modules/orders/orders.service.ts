import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ConfirmedOrder, OrderList } from '@dukanos/shared-types';
import { DatabaseService } from '../../database/database.service';
import { MenuService } from '../menu/menu.service';
import type { AuthRequest } from '../auth/access';
import type { ConfirmOrderDto, OrdersQueryDto } from './orders.dto';
import { amount, orderConfiguration, paise, totals } from './order-policy';
@Injectable()
export class OrdersService {
  private readonly configuration = orderConfiguration();
  constructor(
    private readonly db: DatabaseService,
    private readonly menu: MenuService,
  ) {}
  config() {
    return this.configuration;
  }
  async confirm(
    input: ConfirmOrderDto,
    actor: AuthRequest,
  ): Promise<ConfirmedOrder> {
    const lines = input.lines.map((l) => ({
      variantId: l.variantId.toLowerCase(),
      quantity: l.quantity,
      instruction: (l.instruction ?? '').trim(),
    }));
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(lines))
      .digest('hex');
    return this.db.transaction(async (client) => {
      // Same lock as all Menu writes; also serializes same-request confirmation retries.
      await this.menu.lockForConfirmation(client);
      await client.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [
        actor.user.id,
      ]);
      const session = await client.query(
        'SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND u.id=$2 AND u.active AND s.expires_at>clock_timestamp() FOR SHARE OF s',
        [actor.sessionHash, actor.user.id],
      );
      if (!session.rowCount)
        throw new UnauthorizedException({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Please sign in again.',
        });
      const permission = await client.query(
        'SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_code=ur.role_code WHERE ur.user_id=$1 AND rp.permission_code=$2',
        [actor.user.id, 'orders.create'],
      );
      if (!permission.rowCount)
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message: 'Order creation permission is required.',
        });
      const existing = await client.query<{ id: string; request_hash: string }>(
        'SELECT id,request_hash FROM orders WHERE confirmed_by=$1 AND request_id=$2',
        [actor.user.id, input.requestId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== fingerprint)
          throw new ConflictException({
            code: 'IDEMPOTENCY_CONFLICT',
            message:
              'This request was already used for a different order. Retrieve the original order before starting another.',
          });
        return this.read(client, existing.rows[0].id);
      }
      const menu = await this.menu.counterForConfirmation(client);
      const items = lines.map((line, index) => {
        const item = menu.categories
          .flatMap((c) => c.items)
          .find((i) => i.variants.some((v) => v.id === line.variantId));
        const variant = item?.variants.find((v) => v.id === line.variantId);
        if (!item || !variant || !variant.available)
          throw new ConflictException({
            code: 'ITEM_NOT_AVAILABLE',
            message: `Line ${index + 1}${item && variant ? ` (${item.name} / ${variant.name})` : ` (variant ${line.variantId})`} is no longer available at Counter. Review the cart.`,
          });
        return {
          id: randomUUID(),
          menuItemId: item.id,
          variantId: variant.id,
          itemName: item.name,
          kitchenName: item.kitchenName || item.name,
          variantName: variant.name,
          quantity: line.quantity,
          unitPrice: amount(paise(variant.price)),
          lineSubtotal: amount(paise(variant.price) * BigInt(line.quantity)),
          instruction: line.instruction,
        };
      });
      const sum = items.reduce((n, i) => n + paise(i.lineSubtotal), 0n);
      const total = totals(sum, this.configuration.taxRate);
      const timing = (
        await client.query<{ queued_at: Date; business_date: string }>(
          'SELECT t AS queued_at,(t AT TIME ZONE $1)::date::text AS business_date FROM (SELECT clock_timestamp() AS t) stamp',
          [this.configuration.timezone],
        )
      ).rows[0]!;
      const token = (
        await client.query<{ last_token: number }>(
          'INSERT INTO order_daily_tokens(business_date,last_token) VALUES($1,1) ON CONFLICT(business_date) DO UPDATE SET last_token=order_daily_tokens.last_token+1 RETURNING last_token',
          [timing.business_date],
        )
      ).rows[0]!.last_token;
      const id = randomUUID();
      await client.query(
        `INSERT INTO orders(id,source,status,business_date,token_number,confirmed_by,request_id,request_hash,queued_at,subtotal,tax_total,grand_total,tax_rate,tax_label,timezone,tax_mode,tax_rounding)
      VALUES($1,'COUNTER','QUEUED',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'EXCLUSIVE','HALF_UP_PAISE')`,
        [
          id,
          timing.business_date,
          token,
          actor.user.id,
          input.requestId,
          fingerprint,
          timing.queued_at,
          total.subtotal,
          total.taxTotal,
          total.grandTotal,
          this.configuration.taxRate,
          this.configuration.taxLabel,
          this.configuration.timezone,
        ],
      );
      for (const [index, i] of items.entries())
        await client.query(
          `INSERT INTO order_items(id,order_id,position,menu_item_id,variant_id,item_name_snapshot,kitchen_name_snapshot,variant_name_snapshot,quantity,unit_price_snapshot,line_subtotal,instruction) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            i.id,
            id,
            index + 1,
            i.menuItemId,
            i.variantId,
            i.itemName,
            i.kitchenName,
            i.variantName,
            i.quantity,
            i.unitPrice,
            i.lineSubtotal,
            i.instruction,
          ],
        );
      await client.query(
        "INSERT INTO order_status_history(id,order_id,from_status,to_status,actor_id,occurred_at,reason) VALUES($1,$2,'DRAFT','QUEUED',$3,$4,'Counter confirmation')",
        [randomUUID(), id, actor.user.id, timing.queued_at],
      );
      return this.read(client, id);
    });
  }
  private async read(client: PoolClient, id: string): Promise<ConfirmedOrder> {
    const row = (
      await client.query(
        `SELECT id,source,status,business_date::text AS "businessDate",token_number AS "tokenNumber",queued_at AS "queuedAt",confirmed_by AS "confirmedBy",subtotal::text,discount_total::text AS "discountTotal",tax_total::text AS "taxTotal",rounding_adjustment::text AS "roundingAdjustment",grand_total::text AS "grandTotal",jsonb_build_object('timezone',timezone,'taxLabel',tax_label,'taxRate',tax_rate::text,'taxMode',tax_mode,'rounding',tax_rounding) AS tax FROM orders WHERE id=$1`,
        [id],
      )
    ).rows[0];
    if (!row)
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Order was not found.',
      });
    const items = (
      await client.query(
        `SELECT id,menu_item_id AS "menuItemId",variant_id AS "variantId",item_name_snapshot AS "itemName",kitchen_name_snapshot AS "kitchenName",variant_name_snapshot AS "variantName",quantity,unit_price_snapshot::text AS "unitPrice",line_subtotal::text AS "lineSubtotal",instruction FROM order_items WHERE order_id=$1 ORDER BY position`,
        [id],
      )
    ).rows;
    return {
      ...row,
      queuedAt: row.queuedAt.toISOString(),
      discountTotal: amount(paise(row.discountTotal)),
      roundingAdjustment: amount(paise(row.roundingAdjustment)),
      items,
    } as ConfirmedOrder;
  }
  get(id: string) {
    return this.db.transaction((c) => this.read(c, id));
  }
  token(date: string, token: string) {
    this.validateDate(date);
    if (!/^[1-9]\d{0,9}$/.test(token) || BigInt(token) > 2147483647n)
      throw new BadRequestException({
        code: 'INVALID_INPUT',
        message: 'Invalid token number.',
      });
    return this.db.transaction(async (c) => {
      const row = (
        await c.query<{ id: string }>(
          'SELECT id FROM orders WHERE business_date=$1 AND token_number=$2',
          [date, token],
        )
      ).rows[0];
      if (!row)
        throw new NotFoundException({
          code: 'ORDER_NOT_FOUND',
          message: 'Order was not found.',
        });
      return this.read(c, row.id);
    });
  }
  private validateDate(date: string) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      date.startsWith('0000') ||
      Number.isNaN(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      throw new BadRequestException({
        code: 'INVALID_INPUT',
        message: 'Use a valid business date YYYY-MM-DD.',
      });
  }
  list(query: OrdersQueryDto): Promise<OrderList> {
    if (query.businessDate) this.validateDate(query.businessDate);
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (
        query.after &&
        !(await c.query('SELECT 1 FROM orders WHERE id=$1', [query.after]))
          .rowCount
      )
        throw new BadRequestException({
          code: 'INVALID_INPUT',
          message: 'Unknown order cursor.',
        });
      const rows = (
        await c.query<{ id: string }>(
          `SELECT id FROM orders WHERE ($1::text IS NULL OR status=$1) AND ($2::date IS NULL OR business_date=$2) AND ($3::uuid IS NULL OR (queued_at,id)>(SELECT queued_at,id FROM orders WHERE id=$3)) ORDER BY queued_at,id LIMIT 101`,
          [
            query.status ?? null,
            query.businessDate ?? null,
            query.after ?? null,
          ],
        )
      ).rows;
      const ids = rows.slice(0, 100);
      const orders: ConfirmedOrder[] = [];
      for (const row of ids) orders.push(await this.read(c, row.id));
      return { orders, nextCursor: rows.length > 100 ? ids[99]!.id : null };
    });
  }
}
