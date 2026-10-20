import { canTransition } from '../orders/order-policy';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import type { AuthRequest } from '../auth/access';
import { authorizeMutation } from '../auth/mutation-access';
import type { FulfillmentDto, ServeLineDto } from './fulfillment.dto';
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = (code: string, message: string): never => {
  throw new ConflictException({ code, message });
};
@Injectable()
export class FulfillmentService {
  constructor(private readonly db: DatabaseService) {}
  private async order(c: PoolClient, id: string) {
    const o = (
      await c.query(
        `SELECT o.*,b.service_type,e.revision FROM orders o LEFT JOIN bills b ON b.id=o.bill_id JOIN effective_orders e ON e.id=o.id WHERE o.id=$1 FOR UPDATE OF o`,
        [id],
      )
    ).rows[0];
    if (!o)
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Order was not found.',
      });
    if (!canTransition(o.status, 'COMPLETED'))
      conflict(
        'ORDER_NOT_PENDING',
        'This round is already finished. Refresh Kitchen.',
      );
    return o;
  }
  private async complete(
    c: PoolClient,
    id: string,
    status: string,
    actorId: string,
    reason: string,
    time?: Date,
  ) {
    await c.query(
      `INSERT INTO order_status_history(id,order_id,from_status,to_status,actor_id,occurred_at,reason) VALUES($1,$2,$3,'COMPLETED',$4,coalesce($5::timestamptz,GREATEST(clock_timestamp(),(SELECT max(occurred_at) FROM order_status_history WHERE order_id=$2),(SELECT max(occurred_at) FROM order_serving_events WHERE order_id=$2))),$6)`,
      [randomUUID(), id, status, actorId, time ?? null, reason],
    );
  }
  serve(id: string, line: string, input: ServeLineDto, actor: AuthRequest) {
    const reason = (input.reason ?? '').trim();
    if (input.quantity < 0 && !reason)
      throw new BadRequestException({
        code: 'CORRECTION_REASON_REQUIRED',
        message: 'Explain the serving correction.',
      });
    const digest = hash([
      id,
      line,
      input.expectedRevision,
      input.expectedServedQuantity,
      input.quantity,
      reason,
    ]);
    return this.db.transaction(async (c) => {
      await authorizeMutation(c, actor, 'kitchen.fulfill');
      const prior = (
        await c.query(
          'SELECT * FROM order_serving_events WHERE actor_id=$1 AND request_id=$2',
          [actor.user.id, input.requestId],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== digest)
          conflict(
            'IDEMPOTENCY_CONFLICT',
            'This request was already used for a different serving action.',
          );
        return {
          orderId: id,
          lineId: line,
          servedQuantity: prior.expected_served + prior.quantity,
        };
      }
      const o = await this.order(c, id);
      if (o.service_type !== 'DINE_IN')
        conflict('DINE_IN_REQUIRED', 'Use Ready & Handed Over for this round.');
      if (o.revision !== input.expectedRevision)
        conflict(
          'ORDER_REVISION_CHANGED',
          'This order changed. Refresh before serving.',
        );
      const i = (
        await c.query(
          `SELECT i.quantity,(SELECT coalesce(sum(quantity),0)::int FROM order_serving_events WHERE order_id=i.order_id AND line_id=i.id) served FROM effective_order_items i WHERE order_id=$1 AND id=$2`,
          [id, line],
        )
      ).rows[0];
      if (
        !i ||
        i.served !== input.expectedServedQuantity ||
        i.served + input.quantity < 0 ||
        i.served + input.quantity > i.quantity
      )
        conflict(
          'SERVING_CONFLICT',
          'Serving quantities changed. Refresh before trying again.',
        );
      await c.query(
        `INSERT INTO order_serving_events(id,order_id,line_id,revision,quantity,expected_served,reason,actor_id,request_id,request_hash,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,GREATEST(clock_timestamp(),(SELECT max(occurred_at) FROM order_status_history WHERE order_id=$2),(SELECT max(occurred_at) FROM order_serving_events WHERE order_id=$2)))`,
        [
          randomUUID(),
          id,
          line,
          o.revision,
          input.quantity,
          i.served,
          reason,
          actor.user.id,
          input.requestId,
          digest,
        ],
      );
      const remaining = (
        await c.query(
          `SELECT 1 FROM effective_order_items i WHERE order_id=$1 AND i.quantity>(SELECT coalesce(sum(quantity),0) FROM order_serving_events WHERE order_id=i.order_id AND line_id=i.id)`,
          [id],
        )
      ).rowCount;
      if (!remaining)
        await this.complete(
          c,
          id,
          o.status,
          actor.user.id,
          'All Dine-In items served',
        );
      return {
        orderId: id,
        lineId: line,
        servedQuantity: i.served + input.quantity,
      };
    });
  }
  fulfill(id: string, input: FulfillmentDto, actor: AuthRequest) {
    const digest = hash([id, input.expectedRevision, 'KITCHEN_HANDOVER']);
    return this.db.transaction(async (c) => {
      await authorizeMutation(c, actor, 'kitchen.fulfill');
      const prior = (
        await c.query(
          'SELECT * FROM kitchen_fulfillments WHERE actor_id=$1 AND request_id=$2',
          [actor.user.id, input.requestId],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== digest)
          conflict('IDEMPOTENCY_CONFLICT', 'Request identity already used.');
        return { orderId: id, status: 'COMPLETED' as const };
      }
      const o = await this.order(c, id);
      if (o.revision !== input.expectedRevision)
        conflict(
          'ORDER_REVISION_CHANGED',
          'This order changed. Refresh before handover.',
        );
      if (o.service_type === 'DINE_IN')
        conflict('SERVE_DINE_IN_LINES', 'Serve individual Dine-In lines.');
      if (
        o.service_type === 'TAKEAWAY' &&
        (
          await c.query(
            'SELECT 1 FROM bill_balances WHERE id=$1 AND (amount_due>0 OR refund_due>0)',
            [o.bill_id],
          )
        ).rowCount
      )
        conflict(
          'PAYMENT_REQUIRED',
          'Settle the Parcel bill collection or cash refund at Counter before handover.',
        );
      const time = (
        await c.query(
          'SELECT GREATEST(clock_timestamp(),max(occurred_at)) t FROM order_status_history WHERE order_id=$1',
          [id],
        )
      ).rows[0].t;
      await c.query(
        `INSERT INTO kitchen_fulfillments(order_id,actor_id,request_id,request_hash,occurred_at,reason,revision) VALUES($1,$2,$3,$4,$5,'KITCHEN_HANDOVER',$6)`,
        [id, actor.user.id, input.requestId, digest, time, o.revision],
      );
      await this.complete(
        c,
        id,
        o.status,
        actor.user.id,
        'KITCHEN_HANDOVER',
        time,
      );
      return { orderId: id, status: 'COMPLETED' as const };
    });
  }
}
