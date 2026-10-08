import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  AmendmentHistory,
  AmendmentQuote,
  ConfirmedOrder,
} from '@dukanos/shared-types';
import { DatabaseService } from '../../database/database.service';
import { BillsService } from '../bills/bills.service';
import { MenuService } from '../menu/menu.service';
import type { AuthRequest } from '../auth/access';
import type { AmendmentDto, CommitAmendmentDto } from './amendments.dto';
import { amount, paise, totals } from './order-policy';
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = `id,menu_item_id AS "menuItemId",variant_id AS "variantId",item_name_snapshot AS "itemName",kitchen_name_snapshot AS "kitchenName",variant_name_snapshot AS "variantName",quantity,unit_price_snapshot::text AS "unitPrice",line_subtotal::text AS "lineSubtotal",instruction`;
@Injectable()
export class AmendmentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly bills: BillsService,
    private readonly menu: MenuService,
  ) {}
  private conflict(code: string, message: string): never {
    throw new ConflictException({ code, message });
  }
  private input(input: AmendmentDto) {
    return {
      requestId: input.requestId.toLowerCase(),
      expectedRevision: input.expectedRevision,
      kind: input.kind,
      reason: input.reason,
      note: (input.note ?? '').trim(),
      lines: input.lines.map((l) => ({
        ...l,
        id: l.id.toLowerCase(),
        variantId: l.variantId.toLowerCase(),
        instruction: l.instruction.trim(),
      })),
    };
  }
  private async preview(
    c: PoolClient,
    id: string,
    input: AmendmentDto,
  ): Promise<AmendmentQuote> {
    const o = (
      await c.query(
        'SELECT o.*,e.revision,e.grand_total AS effective_total FROM orders o JOIN effective_orders e ON e.id=o.id WHERE o.id=$1 FOR UPDATE OF o',
        [id],
      )
    ).rows[0];
    if (!o)
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Order was not found.',
      });
    if (o.status !== 'QUEUED')
      this.conflict(
        'ORDER_NOT_AMENDABLE',
        'Preparation has started or this order is terminal. Add replacement food as a new Kitchen round.',
      );
    await this.bills.lockForFood(c, o.bill_id);
    if (o.revision !== input.expectedRevision)
      this.conflict(
        'ORDER_REVISION_CHANGED',
        'Another cashier changed this order. Refresh and review again.',
      );
    if (
      (
        await c.query(
          "SELECT 1 FROM kitchen_timers WHERE order_id=$1 AND status='ACTIVE'",
          [id],
        )
      ).rowCount
    )
      this.conflict(
        'ORDER_HAS_ACTIVE_TIMER',
        'Resolve the associated Kitchen timer before changing this queued order.',
      );
    const beforeItems = (
      await c.query(
        `SELECT ${fields} FROM effective_order_items WHERE order_id=$1 ORDER BY position`,
        [id],
      )
    ).rows as ConfirmedOrder['items'];
    if (
      (input.kind === 'CANCEL' && input.lines.length !== 0) ||
      (input.kind === 'CHANGE' && input.lines.length === 0) ||
      new Set(input.lines.map((l) => l.id)).size !== input.lines.length
    )
      throw new BadRequestException({
        code: 'INVALID_AMENDMENT',
        message:
          'Keep at least one unique line, or explicitly cancel the round.',
      });
    const needsReplacement = input.lines.some((l) =>
      beforeItems.some((i) => i.id === l.id && i.variantId !== l.variantId),
    );
    const menu = needsReplacement
      ? await this.menu.counterForConfirmation(c)
      : { categories: [] };
    const items = input.lines.map((l) => {
      const old = beforeItems.find((i) => i.id === l.id);
      if (!old || l.quantity > old.quantity)
        throw new BadRequestException({
          code: 'USE_NEW_ROUND',
          message:
            'Additional food or quantity requires Add Items and a new Kitchen round.',
        });
      let next = { ...old, quantity: l.quantity, instruction: l.instruction };
      if (l.variantId !== old.variantId) {
        const item = menu.categories
          .flatMap((c) => c.items)
          .find((i) => i.variants.some((v) => v.id === l.variantId));
        const variant = item?.variants.find((v) => v.id === l.variantId);
        if (!item || !variant || !variant.available)
          this.conflict(
            'ITEM_NOT_AVAILABLE',
            `Replacement for ${old.itemName} / ${old.variantName} is no longer available at Counter.`,
          );
        next = {
          ...next,
          menuItemId: item.id,
          variantId: variant.id,
          itemName: item.name,
          kitchenName: item.kitchenName || item.name,
          variantName: variant.name,
          unitPrice: amount(paise(variant.price)),
        };
      }
      return {
        ...next,
        lineSubtotal: amount(paise(next.unitPrice) * BigInt(next.quantity)),
      };
    });
    if (
      input.kind === 'CHANGE' &&
      JSON.stringify(items) === JSON.stringify(beforeItems)
    )
      throw new BadRequestException({
        code: 'NO_ORDER_CHANGE',
        message: 'Select a change before requesting a preview.',
      });
    const total = totals(
      items.reduce((n, i) => n + paise(i.lineSubtotal), 0n),
      o.tax_rate,
    );
    const bill = await this.bills.summary(c, o.bill_id);
    const after =
      paise(bill.billTotal) -
      paise(o.effective_total) +
      paise(total.grandTotal);
    const balance = after - paise(bill.netPaid);
    const quote = {
      orderId: id,
      revision: o.revision,
      beforeItems,
      items,
      oldRoundTotal: amount(paise(o.effective_total)),
      newRoundTotal: total.grandTotal,
      subtotal: total.subtotal,
      taxTotal: total.taxTotal,
      billTotalBefore: bill.billTotal,
      billTotalAfter: amount(after),
      netPaid: bill.netPaid,
      amountDueAfter: amount(balance > 0n ? balance : 0n),
      refundDueAfter: amount(balance < 0n ? -balance : 0n),
    };
    return { ...quote, quoteHash: hash([input, quote]) };
  }
  quote(id: string, raw: AmendmentDto, actor: AuthRequest) {
    return this.db.transaction(async (c) => {
      await this.bills.authorize(c, actor, 'orders.amend');
      await this.bills.authorize(c, actor, 'bills.read');
      await this.bills.authorize(c, actor, 'payments.read');
      if (raw.kind === 'CANCEL')
        await this.bills.authorize(c, actor, 'orders.cancel');
      return this.preview(c, id, this.input(raw));
    });
  }
  commit(id: string, raw: CommitAmendmentDto, actor: AuthRequest) {
    return this.db.transaction(async (c) => {
      await this.bills.authorize(c, actor, 'orders.amend');
      await this.bills.authorize(c, actor, 'bills.read');
      await this.bills.authorize(c, actor, 'payments.read');
      if (raw.kind === 'CANCEL')
        await this.bills.authorize(c, actor, 'orders.cancel');
      const input = this.input(raw),
        fingerprint = hash([id, input, raw.quoteHash]);
      const prior = (
        await c.query(
          'SELECT id,order_id,request_hash,revision FROM order_amendments WHERE performed_by=$1 AND request_id=$2',
          [actor.user.id, input.requestId],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== fingerprint)
          this.conflict(
            'IDEMPOTENCY_CONFLICT',
            'This amendment request was used with different details.',
          );
        return {
          id: prior.id,
          orderId: prior.order_id,
          revision: prior.revision,
        };
      }
      const q = await this.preview(c, id, input);
      if (q.quoteHash !== raw.quoteHash)
        this.conflict(
          'AMENDMENT_QUOTE_CHANGED',
          'The order, replacement price or Bill balance changed. Review a fresh preview before confirming.',
        );
      const amendmentId = randomUUID();
      await c.query(
        `INSERT INTO order_amendments(id,order_id,bill_id,revision,kind,performed_by,reason,note,request_id,request_hash,before_total,subtotal,tax_total,grand_total) SELECT $1,id,bill_id,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13 FROM orders WHERE id=$2`,
        [
          amendmentId,
          id,
          q.revision + 1,
          input.kind,
          actor.user.id,
          input.reason,
          input.note,
          input.requestId,
          fingerprint,
          q.oldRoundTotal,
          q.subtotal,
          q.taxTotal,
          q.newRoundTotal,
        ],
      );
      for (const [position, i] of q.items.entries())
        await c.query(
          `INSERT INTO order_item_revisions(amendment_id,order_id,id,position,menu_item_id,variant_id,item_name_snapshot,kitchen_name_snapshot,variant_name_snapshot,quantity,unit_price_snapshot,line_subtotal,instruction) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            amendmentId,
            id,
            i.id,
            position + 1,
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
      if (input.kind === 'CANCEL')
        await c.query(
          `INSERT INTO order_status_history(id,order_id,from_status,to_status,actor_id,occurred_at,reason) VALUES($1,$2,'QUEUED','CANCELLED',$3,GREATEST(clock_timestamp(),(SELECT max(occurred_at) FROM order_status_history WHERE order_id=$2)),$4)`,
          [randomUUID(), id, actor.user.id, input.reason],
        );
      return { id: amendmentId, orderId: id, revision: q.revision + 1 };
    });
  }
  history(id: string): Promise<AmendmentHistory[]> {
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      let before = (
        await c.query(
          `SELECT ${fields} FROM order_items WHERE order_id=$1 ORDER BY position`,
          [id],
        )
      ).rows as ConfirmedOrder['items'];
      const rows = (
        await c.query(
          `SELECT a.id,a.revision,a.kind,a.reason,a.note,a.performed_by AS "performedBy",coalesce(u.name,'System') AS "actorName",a.created_at AS "createdAt",a.before_total::text AS "beforeTotal",a.grand_total::text AS "grandTotal" FROM order_amendments a LEFT JOIN users u ON u.id=a.performed_by WHERE a.order_id=$1 ORDER BY a.revision`,
          [id],
        )
      ).rows;
      const result: AmendmentHistory[] = [];
      for (const r of rows) {
        const items = (
          await c.query(
            `SELECT ${fields} FROM order_item_revisions WHERE amendment_id=$1 ORDER BY position`,
            [r.id],
          )
        ).rows as ConfirmedOrder['items'];
        result.push({
          ...r,
          createdAt: r.createdAt.toISOString(),
          beforeItems: before,
          items,
        });
        before = items;
      }
      return result;
    });
  }
}
