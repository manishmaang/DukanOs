import { RestaurantClock } from '../../database/restaurant-clock';
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
import type {
  ConfirmationPayment,
  BillDetail,
  BillList,
  BillSummary,
  PermissionCode,
  ServiceType,
} from '@dukanos/shared-types';
import { DatabaseService } from '../../database/database.service';
import type { AuthRequest } from '../auth/access';
import { amount, paise } from '../orders/order-policy';
import type { BillsQueryDto, CollectPaymentDto, RefundDto } from './bills.dto';
@Injectable()
export class BillsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly clock: RestaurantClock,
  ) {}
  async authorize(
    c: PoolClient,
    actor: AuthRequest,
    capability: PermissionCode,
  ) {
    await c.query('SELECT pg_advisory_xact_lock(742019323)');
    await c.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [
      actor.user.id,
    ]);
    const session = await c.query(
      'SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND u.id=$2 AND u.active AND s.expires_at>clock_timestamp() FOR SHARE OF s',
      [actor.sessionHash, actor.user.id],
    );
    if (!session.rowCount)
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Please sign in again.',
      });
    if (
      !(
        await c.query(
          'SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_code=ur.role_code WHERE ur.user_id=$1 AND rp.permission_code=$2',
          [actor.user.id, capability],
        )
      ).rowCount
    )
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'Permission is required.',
      });
  }
  async lockOpen(c: PoolClient, id: string, allowRolloverSettlement = false) {
    const row = (
      await c.query(
        'SELECT status,closure_reason,business_date::text AS business_date FROM bills WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!row)
      throw new NotFoundException({
        code: 'BILL_NOT_FOUND',
        message: 'Bill was not found.',
      });
    if (
      row.status !== 'OPEN' &&
      !(
        allowRolloverSettlement &&
        row.status === 'CLOSED' &&
        row.closure_reason === 'BUSINESS_DAY_ROLLOVER'
      )
    )
      throw new ConflictException({
        code: 'BILL_CLOSED',
        message: 'This bill is closed. Start a new bill.',
      });
    return row;
  }
  async lockForFood(c: PoolClient, id: string, date?: string) {
    const row = await this.lockOpen(c, id);
    const current = date ?? (await this.clock.read(c)).business_date;
    if (row.business_date !== current)
      throw new ConflictException({
        code: 'BILL_NOT_CURRENT_BUSINESS_DATE',
        message:
          'Food cannot be added or changed on a bill from another business date. Start a new bill.',
      });
  }
  async createForOrder(
    c: PoolClient,
    actor: string,
    date: string,
    time: Date,
    service: ServiceType,
    reference: string,
  ) {
    const number = (
      await c.query(
        'INSERT INTO bill_daily_numbers(business_date,last_number) VALUES($1,1) ON CONFLICT(business_date) DO UPDATE SET last_number=bill_daily_numbers.last_number+1 RETURNING last_number',
        [date],
      )
    ).rows[0].last_number;
    const id = randomUUID();
    await c.query(
      'INSERT INTO bills(id,business_date,bill_number,service_type,reference,opened_by,opened_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, date, number, service, reference, actor, time],
    );
    return id;
  }
  async summary(
    c: PoolClient,
    id: string,
    currentBusinessDate?: string,
  ): Promise<BillSummary> {
    currentBusinessDate ??= (await this.clock.read(c)).business_date;
    const r = (
      await c.query(
        `SELECT b.id,b.business_date::text AS "businessDate",b.bill_number AS "billNumber",b.service_type AS "serviceType",b.legacy,b.reference,b.status,b.opened_at AS "openedAt",b.closed_at AS "closedAt",b.closure_reason AS "closureReason",f.bill_total::text AS "billTotal",f.total_collected::text AS "totalCollected",f.total_refunded::text AS "totalRefunded",f.net_paid::text AS "netPaid",f.amount_due::text AS "amountDue",f.refund_due::text AS "refundDue" FROM bills b JOIN bill_balances f ON f.id=b.id WHERE b.id=$1`,
        [id],
      )
    ).rows[0];
    if (!r)
      throw new NotFoundException({
        code: 'BILL_NOT_FOUND',
        message: 'Bill was not found.',
      });
    for (const key of [
      'billTotal',
      'totalCollected',
      'totalRefunded',
      'netPaid',
      'amountDue',
      'refundDue',
    ])
      r[key] = amount(paise(r[key]));
    return {
      ...r,
      currentBusinessDate,
      canChangeFood:
        r.status === 'OPEN' && r.businessDate === currentBusinessDate,
      openedAt: r.openedAt.toISOString(),
      closedAt: r.closedAt?.toISOString() ?? null,
      paymentStatus:
        paise(r.refundDue) > 0n
          ? 'REFUND_DUE'
          : paise(r.amountDue) === 0n
            ? 'PAID'
            : paise(r.netPaid) === 0n
              ? 'UNPAID'
              : 'PARTIALLY_PAID',
    };
  }
  async detail(c: PoolClient, id: string): Promise<BillDetail> {
    const bill = await this.summary(c, id);
    const orders = (
      await c.query(
        `SELECT o.id,e.revision,token_number AS "tokenNumber",business_date::text AS "businessDate",status,e.grand_total::text AS "grandTotal" FROM orders o JOIN effective_orders e ON e.id=o.id WHERE o.bill_id=$1 ORDER BY queued_at,o.id`,
        [id],
      )
    ).rows;
    for (const order of orders)
      order.items = (
        await c.query(
          `SELECT id,variant_id AS "variantId",unit_price_snapshot::text AS "unitPrice",line_subtotal::text AS "lineSubtotal",item_name_snapshot AS "itemName",variant_name_snapshot AS "variantName",quantity,instruction FROM effective_order_items WHERE order_id=$1 ORDER BY position`,
          [order.id],
        )
      ).rows;
    const payments = (
      await c.query(
        `SELECT p.id,p.type,p.method,p.amount::text,p.performed_by AS "performedBy",u.name AS "actorName",p.created_at AS "createdAt" FROM payments p JOIN users u ON u.id=p.performed_by WHERE p.bill_id=$1 ORDER BY p.created_at,p.id`,
        [id],
      )
    ).rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    return { ...bill, orders, payments };
  }
  get(id: string) {
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      return this.detail(c, id);
    });
  }
  list(q: BillsQueryDto): Promise<BillList> {
    const search = q.search?.trim() ?? '';
    const from = q.fromBusinessDate,
      to = q.toBusinessDate;
    const validDate = (value: string) => {
      const parsed = new Date(value + 'T00:00:00Z');
      return (
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === value &&
        value >= '0001-01-01'
      );
    };
    if (
      (from === undefined) !== (to === undefined) ||
      (from !== undefined &&
        to !== undefined &&
        (!validDate(from) || !validDate(to) || from > to))
    )
      throw new BadRequestException({
        code: 'INVALID_DATE_RANGE',
        message:
          'Provide valid From and To business dates, with From no later than To.',
      });
    const parsedNumber = /^#?\d+$/.test(search)
      ? BigInt(search.replace(/^#/, ''))
      : null;
    const number =
      parsedNumber === null
        ? null
        : parsedNumber <= 2147483647n
          ? parsedNumber.toString()
          : '0';
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const currentBusinessDate = (await this.clock.read(c)).business_date;
      const scope = from
        ? ('RANGE' as const)
        : search
          ? ('HISTORY' as const)
          : ('TODAY' as const);
      const lower = from ?? (search ? null : currentBusinessDate);
      const upper = to ?? (search ? null : currentBusinessDate);
      if (
        q.after &&
        !(await c.query('SELECT 1 FROM bills WHERE id=$1', [q.after])).rowCount
      )
        throw new BadRequestException({
          code: 'INVALID_INPUT',
          message: 'Unknown bill cursor.',
        });
      const rows = (
        await c.query(
          `SELECT id FROM bills
         WHERE ($1::uuid IS NULL OR (business_date,opened_at,id)<(SELECT business_date,opened_at,id FROM bills WHERE id=$1))
         AND ($2::date IS NULL OR business_date >= $2) AND ($3::date IS NULL OR business_date <= $3)
         AND ($4='' OR CASE WHEN $5::text IS NOT NULL THEN bill_number=$5::integer ELSE strpos(lower(reference),lower($4))>0 END)
         ORDER BY business_date DESC,opened_at DESC,id DESC LIMIT 101`,
          [q.after ?? null, lower, upper, search, number],
        )
      ).rows;
      const bills: BillSummary[] = [];
      for (const r of rows.slice(0, 100))
        bills.push(await this.summary(c, r.id, currentBusinessDate));
      return {
        bills,
        nextCursor: rows.length > 100 ? bills[99]!.id : null,
        currentBusinessDate,
        scope,
        fromBusinessDate: lower,
        toBusinessDate: upper,
      };
    });
  }
  /** Called by Orders only on its existing authorized confirmation transaction. */
  async collectForConfirmation(
    c: PoolClient,
    billId: string,
    orderId: string,
    payment: ConfirmationPayment,
    fingerprint: string,
    actorId: string,
  ) {
    for (const method of ['CASH', 'UPI'] as const) {
      const value = payment[method === 'CASH' ? 'cash' : 'upi'];
      if (paise(value) > 0n)
        await c.query(
          `INSERT INTO payments(id,bill_id,type,method,amount,performed_by,request_id,request_hash,confirmation_order_id) VALUES($1,$2,'COLLECTION',$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            billId,
            method,
            amount(paise(value)),
            actorId,
            randomUUID(),
            fingerprint,
            orderId,
          ],
        );
    }
  }
  refund(id: string, input: RefundDto, actor: AuthRequest) {
    return this.postPayment(id, { ...input, method: 'CASH' }, actor, 'REFUND');
  }
  collect(id: string, input: CollectPaymentDto, actor: AuthRequest) {
    return this.postPayment(id, input, actor, 'COLLECTION');
  }
  private postPayment(
    id: string,
    input: CollectPaymentDto,
    actor: AuthRequest,
    type: 'COLLECTION' | 'REFUND',
  ) {
    return this.db.transaction(async (c) => {
      await this.authorize(
        c,
        actor,
        type === 'REFUND' ? 'payments.refund' : 'payments.collect',
      );
      const value = paise(input.amount);
      if (value <= 0n)
        throw new BadRequestException({
          code: 'INVALID_AMOUNT',
          message:
            'Enter a positive amount in rupees with at most two decimal places.',
        });
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify(
            type === 'REFUND'
              ? ['REFUND', id, input.method, amount(value)]
              : [id, input.method, amount(value)],
          ),
        )
        .digest('hex');
      const prior = (
        await c.query(
          'SELECT bill_id,request_hash FROM payments WHERE performed_by=$1 AND request_id=$2',
          [actor.user.id, input.requestId],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== fingerprint)
          throw new ConflictException({
            code: 'IDEMPOTENCY_CONFLICT',
            message:
              'This payment request was already used with different details.',
          });
        return this.detail(c, prior.bill_id);
      }
      await this.lockOpen(c, id, true);
      const bill = await this.summary(c, id);
      const due = type === 'REFUND' ? bill.refundDue : bill.amountDue;
      if (value > paise(due))
        throw new ConflictException({
          code:
            type === 'REFUND' ? 'REFUND_EXCEEDS_DUE' : 'PAYMENT_EXCEEDS_DUE',
          message: `${type === 'REFUND' ? 'Cash refund' : 'Payment'} exceeds the current due (₹${due}). Refresh and review the bill.`,
        });
      await c.query(
        `INSERT INTO payments(id,bill_id,type,method,amount,performed_by,request_id,request_hash) VALUES($1,$2,$8,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          id,
          input.method,
          amount(value),
          actor.user.id,
          input.requestId,
          fingerprint,
          type,
        ],
      );
      return this.detail(c, id);
    });
  }
  close(id: string, actor: AuthRequest) {
    return this.db.transaction(async (c) => {
      await this.authorize(c, actor, 'bills.manage');
      const r = (
        await c.query('SELECT status FROM bills WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!r)
        throw new NotFoundException({
          code: 'BILL_NOT_FOUND',
          message: 'Bill was not found.',
        });
      if (r.status === 'CLOSED') return this.detail(c, id);
      const bill = await this.detail(c, id);
      if (
        paise(bill.amountDue) !== 0n ||
        paise(bill.refundDue) !== 0n ||
        bill.orders.some((o) => !['COMPLETED', 'CANCELLED'].includes(o.status))
      )
        throw new ConflictException({
          code: 'BILL_NOT_SETTLED',
          message:
            'Settle the bill and complete all Kitchen rounds before closing.',
        });
      await c.query(
        "UPDATE bills SET status='CLOSED',closed_at=clock_timestamp(),closed_by=$2,closure_reason='MANUAL' WHERE id=$1",
        [id, actor.user.id],
      );
      return this.detail(c, id);
    });
  }
}
