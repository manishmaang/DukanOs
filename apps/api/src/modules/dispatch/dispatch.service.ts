import { Injectable } from '@nestjs/common';
import type { DispatchOrder, DispatchState } from '@dukanos/shared-types';
import { DatabaseService } from '../../database/database.service';
import { dispatchConfiguration } from './dispatch-config';
@Injectable()
export class DispatchService {
  private readonly configuration = dispatchConfiguration();
  constructor(private readonly db: DatabaseService) {}
  state(): Promise<DispatchState> {
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const rows = (
        await c.query(`SELECT o.id AS "orderId",o.business_date::text AS "businessDate",
        o.token_number AS "tokenNumber",o.source,h.occurred_at AS "readyAt",
        (SELECT jsonb_agg(jsonb_build_object('id',i.id,'menuItemId',i.menu_item_id,
          'itemName',i.item_name_snapshot,'variantName',i.variant_name_snapshot,
          'quantity',i.quantity,'instruction',i.instruction) ORDER BY i.position)
          FROM order_items i WHERE i.order_id=o.id) AS items
        FROM orders o JOIN order_status_history h ON h.order_id=o.id AND h.to_status='READY'
        WHERE o.status='READY' ORDER BY h.occurred_at,o.id`)
      ).rows;
      const orders = rows.map((r) => ({
        ...r,
        readyAt: r.readyAt.toISOString(),
      })) as DispatchOrder[];
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
        orders,
      };
    });
  }
}
