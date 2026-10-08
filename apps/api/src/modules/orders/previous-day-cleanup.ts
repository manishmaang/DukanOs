import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export const PREVIOUS_DAY_AUTO_CANCEL = 'PREVIOUS_BUSINESS_DAY_AUTO_CANCEL';

// Internal maintenance operation only. Caller owns the restaurant write lock and
// has closed historical Bills in this same transaction. No HTTP/role bypass.
export async function cancelPreviousDayOrders(
  c: PoolClient,
  now: { queued_at: Date; business_date: string; local_time: string },
  timezone: string,
  cleanupTime: string,
) {
  if (now.local_time < cleanupTime) return 0;
  const orders = (
    await c.query(
      `SELECT o.id,o.status,e.revision,e.grand_total FROM orders o JOIN effective_orders e ON e.id=o.id
       WHERE o.business_date<$1::date AND o.status IN ('QUEUED','PREPARING','READY') ORDER BY o.queued_at,o.id FOR UPDATE OF o`,
      [now.business_date],
    )
  ).rows;
  for (const order of orders) {
    const id = randomUUID();
    await c.query(
      `INSERT INTO order_amendments(id,order_id,bill_id,revision,kind,performed_by,created_at,reason,note,request_id,request_hash,before_total,subtotal,tax_total,grand_total,cleanup_timezone,cleanup_time)
       SELECT $1,id,bill_id,$3,'CANCEL',NULL,$4,$5,'',$1,$6,$7,0,0,0,$8,$9 FROM orders WHERE id=$2`,
      [
        id,
        order.id,
        order.revision + 1,
        now.queued_at,
        PREVIOUS_DAY_AUTO_CANCEL,
        createHash('sha256')
          .update(`${PREVIOUS_DAY_AUTO_CANCEL}:${order.id}`)
          .digest('hex'),
        order.grand_total,
        timezone,
        cleanupTime,
      ],
    );
    await c.query(
      `INSERT INTO order_status_history(id,order_id,from_status,to_status,actor_id,occurred_at,reason)
       VALUES($1,$2,$3,'CANCELLED',NULL,GREATEST($4::timestamptz,(SELECT max(occurred_at) FROM order_status_history WHERE order_id=$2)),$5)`,
      [
        randomUUID(),
        order.id,
        order.status,
        now.queued_at,
        PREVIOUS_DAY_AUTO_CANCEL,
      ],
    );
    await c.query(
      `UPDATE kitchen_timers SET status='CANCELLED',resolved_by=NULL,resolved_at=GREATEST($2::timestamptz,started_at),resolution_reason=$3 WHERE order_id=$1 AND status='ACTIVE'`,
      [order.id, now.queued_at, PREVIOUS_DAY_AUTO_CANCEL],
    );
  }
  return orders.length;
}
