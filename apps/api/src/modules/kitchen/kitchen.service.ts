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
        await c.query(`SELECT o.id AS "orderId",o.business_date::text AS "businessDate",o.token_number AS "tokenNumber",o.status,o.queued_at AS "queuedAt",
        (SELECT occurred_at FROM order_status_history h WHERE h.order_id=o.id AND h.to_status='PREPARING') AS "preparingAt",
        (SELECT jsonb_agg(jsonb_build_object('id',i.id,'menuItemId',i.menu_item_id,'variantId',i.variant_id,
          'itemName',i.item_name_snapshot,'kitchenName',i.kitchen_name_snapshot,'variantName',i.variant_name_snapshot,
          'quantity',i.quantity,'instruction',i.instruction) ORDER BY i.position) FROM order_items i WHERE i.order_id=o.id) AS items
        FROM orders o WHERE o.status IN ('QUEUED','PREPARING') ORDER BY o.queued_at,o.id`)
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
        queued,
        preparing,
        production: {
          queued: aggregateProduction(queued),
          preparing: aggregateProduction(preparing),
        },
      };
    });
  }
}
