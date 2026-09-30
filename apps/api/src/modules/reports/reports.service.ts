import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  DashboardReport,
  ItemsReport,
  OperationsReport,
  PaymentsReport,
  ReportPeriod,
  SalesReport,
} from '@dukanos/shared-types';
import { DatabaseService } from '../../database/database.service';
import { RestaurantClock } from '../../database/restaurant-clock';
import { amount, paise } from '../orders/order-policy';
import type { ReportItemsDto, ReportPeriodDto } from './reports.dto';
// Select the Bill cohort first. All dependent food/financial projections use this
// same cohort, including the rare pre-cutoff Bill whose rounds span dates.
const cohort = `WITH selected_bills AS (SELECT * FROM bills WHERE business_date BETWEEN $1::date AND $2::date)`;
const foods = `${cohort}, selected_items AS (
 SELECT i.*,o.queued_at FROM selected_bills b JOIN orders o ON o.bill_id=b.id
 JOIN effective_order_items i ON i.order_id=o.id WHERE o.status<>'CANCELLED'
), grouped AS (
 SELECT menu_item_id,variant_id,sum(quantity) AS quantity,sum(line_subtotal) AS sales_value FROM selected_items GROUP BY menu_item_id,variant_id
), labels AS (
 SELECT DISTINCT ON(menu_item_id,variant_id) menu_item_id,variant_id,item_name_snapshot,variant_name_snapshot
 FROM selected_items ORDER BY menu_item_id,variant_id,queued_at DESC,order_id DESC,position DESC
)`;
const eventWindow = `created_at >= ($1::date::timestamp AT TIME ZONE $3) AND created_at < (($2::date+1)::timestamp AT TIME ZONE $3)`;
@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly clock: RestaurantClock,
  ) {}
  private async period(
    c: PoolClient,
    q: ReportPeriodDto,
  ): Promise<ReportPeriod> {
    const now = await this.clock.read(c);
    const preset =
      q.period ??
      (q.from !== undefined || q.to !== undefined ? 'CUSTOM' : 'TODAY');
    let from: string, to: string;
    if (preset === 'CUSTOM') {
      const valid = (v: string | undefined) => {
        if (!v || v < '0001-01-01') return false;
        const d = new Date(v + 'T00:00:00Z');
        return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
      };
      if (
        !valid(q.from) ||
        !valid(q.to) ||
        q.from! > q.to! ||
        (Date.parse(q.to!) - Date.parse(q.from!)) / 86400000 > 365
      )
        throw new BadRequestException({
          code: 'INVALID_REPORT_PERIOD',
          message:
            'Choose valid inclusive From/To dates, in order, up to 366 days.',
        });
      from = q.from!;
      to = q.to!;
    } else {
      if (q.from !== undefined || q.to !== undefined)
        throw new BadRequestException({
          code: 'INVALID_REPORT_PERIOD',
          message: 'Custom dates cannot be combined with a quick period.',
        });
      const r = (
        await c.query(
          `SELECT (CASE $2 WHEN 'YESTERDAY' THEN $1::date-1 WHEN 'LAST_7_DAYS' THEN $1::date-6 WHEN 'THIS_MONTH' THEN date_trunc('month',$1::date)::date ELSE $1::date END)::text AS "from", (CASE WHEN $2='YESTERDAY' THEN $1::date-1 ELSE $1::date END)::text AS "to"`,
          [now.business_date, preset],
        )
      ).rows[0];
      from = r.from;
      to = r.to;
    }
    return {
      preset,
      from,
      to,
      currentBusinessDate: now.business_date,
      timezone: this.clock.timezone,
      asOf: now.queued_at.toISOString(),
    };
  }
  private read<T>(
    q: ReportPeriodDto,
    work: (c: PoolClient, p: ReportPeriod) => Promise<T>,
  ) {
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      await c.query("SET LOCAL statement_timeout='8s'");
      return work(c, await this.period(c, q));
    });
  }
  private async salesData(
    c: PoolClient,
    p: ReportPeriod,
  ): Promise<SalesReport> {
    const values = [p.from, p.to];
    const r = (
      await c.query(
        `${cohort}
      SELECT coalesce(sum(f.bill_total),0)::text AS sales, count(*)::int AS bills,
      count(*) FILTER(WHERE b.status='OPEN')::int AS open, count(*) FILTER(WHERE b.status='CLOSED')::int AS closed,
      count(*) FILTER(WHERE b.legacy)::int AS legacy,
      coalesce(sum(f.amount_due) FILTER(WHERE NOT b.legacy),0)::text AS due,
      count(*) FILTER(WHERE NOT b.legacy AND f.amount_due>0)::int AS due_count,
      coalesce(sum(f.amount_due) FILTER(WHERE b.legacy),0)::text AS legacy_due,
      coalesce(sum(f.refund_due),0)::text AS refund
      FROM selected_bills b JOIN bill_balances f ON f.id=b.id`,
        values,
      )
    ).rows[0];
    const financial = (
      await c.query(
        `${cohort} SELECT coalesce(sum(e.subtotal),0)::text AS subtotal,coalesce(sum(e.tax_total),0)::text AS tax FROM selected_bills b JOIN effective_orders e ON e.bill_id=b.id`,
        values,
      )
    ).rows[0];
    const services = (
      await c.query(
        `${cohort} SELECT coalesce(b.service_type,'UNKNOWN') AS "serviceType",count(*)::int AS "billCount",coalesce(sum(f.bill_total),0)::text AS "salesValue" FROM selected_bills b JOIN bill_balances f ON f.id=b.id GROUP BY b.service_type ORDER BY b.service_type NULLS LAST`,
        values,
      )
    ).rows;
    const single = p.from === p.to;
    const buckets = (
      await c.query(
        `${cohort} SELECT
      CASE WHEN o.business_date NOT BETWEEN $1::date AND $2::date THEN 'OUTSIDE_PERIOD'
      ELSE ${single ? "to_char(o.queued_at AT TIME ZONE o.timezone,'HH24')" : 'o.business_date::text'} END AS key,
      sum(e.grand_total)::text AS value FROM selected_bills b JOIN orders o ON o.bill_id=b.id
      JOIN effective_orders e ON e.id=o.id GROUP BY key ORDER BY key`,
        values,
      )
    ).rows;
    const keys = single
      ? Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))
      : (
          await c.query(
            "SELECT d::date::text AS key FROM generate_series($1::date::timestamp,$2::date::timestamp,interval '1 day') d",
            values,
          )
        ).rows.map((r) => r.key as string);
    const count = BigInt(r.bills);
    return {
      period: p,
      summary: {
        salesValue: amount(paise(r.sales)),
        foodSubtotal: amount(paise(financial.subtotal)),
        taxValue: amount(paise(financial.tax)),
        billCount: r.bills,
        averageBill: amount(count ? (paise(r.sales) + count / 2n) / count : 0n),
        openBills: r.open,
        closedBills: r.closed,
        legacyBills: r.legacy,
        outstandingDue: amount(paise(r.due)),
        billsWithDue: r.due_count,
        refundDue: amount(paise(r.refund)),
        legacyDue: amount(paise(r.legacy_due)),
      },
      serviceTypes: services.map((r) => ({
        ...r,
        salesValue: amount(paise(r.salesValue)),
      })),
      trend: {
        granularity: single ? 'HOUR' : 'DAY',
        buckets: keys.map((key) => ({
          key,
          salesValue: amount(
            paise(buckets.find((b) => b.key === key)?.value ?? '0'),
          ),
        })),
        outsidePeriodSales: amount(
          paise(buckets.find((b) => b.key === 'OUTSIDE_PERIOD')?.value ?? '0'),
        ),
      },
    };
  }
  private async paymentsData(
    c: PoolClient,
    p: ReportPeriod,
  ): Promise<PaymentsReport> {
    const r = (
      await c.query(
        `SELECT
      coalesce(sum(amount) FILTER(WHERE type='COLLECTION' AND method='CASH'),0)::text AS cash,
      coalesce(sum(amount) FILTER(WHERE type='COLLECTION' AND method='UPI'),0)::text AS upi,
      coalesce(sum(amount) FILTER(WHERE type='REFUND'),0)::text AS refund,
      count(*) FILTER(WHERE type='COLLECTION' AND method='CASH')::int AS cash_count,
      count(*) FILTER(WHERE type='COLLECTION' AND method='UPI')::int AS upi_count,
      count(*) FILTER(WHERE type='REFUND')::int AS refund_count FROM payments WHERE ${eventWindow}`,
        [p.from, p.to, p.timezone],
      )
    ).rows[0];
    const f = (
      await c.query(
        `${cohort} SELECT coalesce(sum(f.amount_due) FILTER(WHERE NOT b.legacy),0)::text AS due,coalesce(sum(f.refund_due),0)::text AS refund,coalesce(sum(f.amount_due) FILTER(WHERE b.legacy),0)::text AS legacy_due FROM selected_bills b JOIN bill_balances f ON f.id=b.id`,
        [p.from, p.to],
      )
    ).rows[0];
    const collected = paise(r.cash) + paise(r.upi),
      net = collected - paise(r.refund);
    // Refund-only days can have negative cash flow. Existing amount() formats nonnegative sale values.
    const signed = (n: bigint) => (n < 0n ? '-' + amount(-n) : amount(n));
    return {
      period: p,
      cashCollections: amount(paise(r.cash)),
      upiCollections: amount(paise(r.upi)),
      totalCollections: amount(collected),
      cashRefunds: amount(paise(r.refund)),
      netCollected: signed(net),
      cashTransactions: r.cash_count,
      upiTransactions: r.upi_count,
      refundTransactions: r.refund_count,
      outstandingDue: amount(paise(f.due)),
      refundDue: amount(paise(f.refund)),
      legacyDue: amount(paise(f.legacy_due)),
    };
  }
  private async itemsData(
    c: PoolClient,
    p: ReportPeriod,
    q: ReportItemsDto = {},
    pageSize = 50,
  ): Promise<ItemsReport> {
    const page = Number(q.page ?? 1),
      sort = q.sort ?? 'QUANTITY';
    const rows = (
      await c.query(
        `${foods} SELECT g.menu_item_id AS "menuItemId",g.variant_id AS "variantId",l.item_name_snapshot AS "itemName",l.variant_name_snapshot AS "variantName",g.quantity::text,g.sales_value::text AS "salesValue" FROM grouped g JOIN labels l USING(menu_item_id,variant_id) ORDER BY ${sort === 'QUANTITY' ? 'g.quantity' : 'g.sales_value'} DESC,g.menu_item_id,g.variant_id LIMIT $3 OFFSET $4`,
        [p.from, p.to, pageSize, (page - 1) * pageSize],
      )
    ).rows;
    const total = (
      await c.query(
        `${foods} SELECT count(*)::int AS count,coalesce(sum(quantity),0)::text AS quantity,coalesce(sum(sales_value),0)::text AS sales FROM grouped`,
        [p.from, p.to],
      )
    ).rows[0];
    return {
      period: p,
      items: rows.map((r) => ({
        ...r,
        salesValue: amount(paise(r.salesValue)),
      })),
      page,
      pageSize,
      sort,
      totalItems: total.count,
      totalQuantity: total.quantity,
      totalSalesValue: amount(paise(total.sales)),
    };
  }
  private async operationsData(
    c: PoolClient,
    p: ReportPeriod,
  ): Promise<OperationsReport> {
    const statuses = (
      await c.query(
        `${cohort} SELECT o.status,count(*)::int AS count FROM selected_bills b JOIN orders o ON o.bill_id=b.id GROUP BY o.status ORDER BY o.status`,
        [p.from, p.to],
      )
    ).rows;
    const reasons = (
      await c.query(
        `SELECT reason,count(*)::int AS count FROM order_amendments WHERE ${eventWindow} GROUP BY reason ORDER BY reason`,
        [p.from, p.to, p.timezone],
      )
    ).rows;
    const r = (
      await c.query(
        `${cohort} SELECT count(h.id)::int AS samples,round(avg(extract(epoch FROM (h.occurred_at-o.queued_at))))::text AS seconds FROM selected_bills b JOIN orders o ON o.bill_id=b.id LEFT JOIN order_status_history h ON h.order_id=o.id AND h.to_status='READY'`,
        [p.from, p.to],
      )
    ).rows[0];
    const services = (
      await c.query(
        `${cohort} SELECT coalesce(service_type,'UNKNOWN') AS "serviceType",count(*)::int AS "billCount" FROM selected_bills GROUP BY service_type ORDER BY service_type NULLS LAST`,
        [p.from, p.to],
      )
    ).rows;
    return {
      period: p,
      billCount: services.reduce((n, s) => n + s.billCount, 0),
      serviceTypes: services,
      kitchenRounds: statuses.reduce((s, r) => s + r.count, 0),
      statuses: ['QUEUED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'].map(
        (status) => ({
          status,
          count: statuses.find((r) => r.status === status)?.count ?? 0,
        }),
      ),
      amendments: reasons.reduce((s, r) => s + r.count, 0),
      amendmentReasons: reasons,
      averageQueuedToReadySeconds:
        r.seconds === null ? null : Number(r.seconds),
      readySampleCount: r.samples,
    };
  }
  sales(q: ReportPeriodDto) {
    return this.read(q, (c, p) => this.salesData(c, p));
  }
  payments(q: ReportPeriodDto) {
    return this.read(q, (c, p) => this.paymentsData(c, p));
  }
  items(q: ReportItemsDto) {
    return this.read(q, (c, p) => this.itemsData(c, p, q));
  }
  operations(q: ReportPeriodDto) {
    return this.read(q, (c, p) => this.operationsData(c, p));
  }
  dashboard(q: ReportPeriodDto): Promise<DashboardReport> {
    return this.read(q, async (c, p) => ({
      period: p,
      sales: await this.salesData(c, p),
      payments: await this.paymentsData(c, p),
      topItems: (await this.itemsData(c, p, {}, 5)).items,
      operations: await this.operationsData(c, p),
    }));
  }
}
