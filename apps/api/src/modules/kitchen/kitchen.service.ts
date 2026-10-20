import { kitchenConfiguration } from './kitchen-config';
import { Injectable } from '@nestjs/common';
import type { KitchenOrder, KitchenState } from '@dukanos/shared-types';
import { DatabaseService } from '../../database/database.service';
import { aggregateProduction } from './production';
@Injectable()
export class KitchenService {
  private readonly configuration = kitchenConfiguration();
  constructor(private readonly db: DatabaseService) {}
  state(): Promise<KitchenState> {
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const rows = (
        await c.query(`SELECT e.revision,b.service_type AS "serviceType",b.reference,o.source,o.external_reference AS "externalReference",o.id AS "orderId",o.business_date::text AS "businessDate",o.token_number AS "tokenNumber",o.status,o.queued_at AS "queuedAt",
        (SELECT occurred_at FROM order_status_history h WHERE h.order_id=o.id AND h.to_status='PREPARING') AS "preparingAt",
        (SELECT jsonb_agg(jsonb_build_object('id',i.id,'menuItemId',i.menu_item_id,'variantId',i.variant_id,
          'itemName',i.item_name_snapshot,'kitchenName',i.kitchen_name_snapshot,'variantName',i.variant_name_snapshot,
          'quantity',i.quantity,'servedQuantity',(SELECT coalesce(sum(quantity),0) FROM order_serving_events WHERE order_id=i.order_id AND line_id=i.id),'pendingQuantity',i.quantity-(SELECT coalesce(sum(quantity),0) FROM order_serving_events WHERE order_id=i.order_id AND line_id=i.id),'instruction',i.instruction,'serving',CASE WHEN coalesce(o.preparation_mode,i.serving_mode) IS NULL THEN NULL ELSE jsonb_build_object('mode',coalesce(o.preparation_mode,i.serving_mode),'amount',i.serving_amount::text,'unit',i.serving_unit) END) ORDER BY i.position) FROM effective_order_items i WHERE i.order_id=o.id) AS items
        FROM orders o LEFT JOIN bills b ON b.id=o.bill_id JOIN effective_orders e ON e.id=o.id WHERE o.status IN ('QUEUED','PREPARING','READY') ORDER BY o.queued_at,o.id`)
      ).rows;
      const orders: KitchenOrder[] = rows.map((r) => ({
        ...r,
        queuedAt: r.queuedAt.toISOString(),
        preparingAt: r.preparingAt?.toISOString() ?? null,
      })) as KitchenOrder[];
      const queued = orders.filter((o) => o.status === 'QUEUED');
      const preparing = orders.filter((o) => o.status === 'PREPARING');
      const timing = (
        await c.query<{ now: Date; business_date: string }>(
          'SELECT t AS now,(t AT TIME ZONE $1)::date::text AS business_date FROM (SELECT clock_timestamp() AS t) stamp',
          [this.configuration.timezone],
        )
      ).rows[0]!;
      return {
        serverTime: timing.now.toISOString(),
        businessDate: timing.business_date,
        lateThresholdMinutes: this.configuration.lateThresholdMinutes,
        nextOrderId: queued[0]?.orderId ?? null,
        pending: orders,
        queued,
        preparing,
        production: {
          pending: aggregateProduction(orders),
          queued: aggregateProduction(queued),
          preparing: aggregateProduction(preparing),
        },
      };
    });
  }
}
