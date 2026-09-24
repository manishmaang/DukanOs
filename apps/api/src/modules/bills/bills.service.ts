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
  BillDetail,
  BillList,
  BillSummary,
  PermissionCode,
  ServiceType,
} from '@dukanos/shared-types';
import { DatabaseService } from '../../database/database.service';
import type { AuthRequest } from '../auth/access';
import { amount, paise } from '../orders/order-policy';
import type { BillsQueryDto, CollectPaymentDto } from './bills.dto';
@Injectable()
export class BillsService {
  constructor(private readonly db: DatabaseService) {}
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
  async lockOpen(c: PoolClient, id: string) {
    const row = (
      await c.query('SELECT status FROM bills WHERE id=$1 FOR UPDATE', [id])
    ).rows[0];
    if (!row)
      throw new NotFoundException({
        code: 'BILL_NOT_FOUND',
        message: 'Bill was not found.',
      });
    if (row.status !== 'OPEN')
      throw new ConflictException({
        code: 'BILL_CLOSED',
        message: 'This bill is closed. Start a new bill.',
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
  async summary(c: PoolClient, id: string): Promise<BillSummary> {
    const r = (
      await c.query(
        `SELECT b.id,b.business_date::text AS "businessDate",b.bill_number AS "billNumber",b.service_type AS "serviceType",b.legacy,b.reference,b.status,b.opened_at AS "openedAt",b.closed_at AS "closedAt",f.bill_total::text AS "billTotal",f.total_collected::text AS "totalCollected",f.total_refunded::text AS "totalRefunded",f.net_paid::text AS "netPaid",f.amount_due::text AS "amountDue",f.refund_due::text AS "refundDue" FROM bills b JOIN bill_balances f ON f.id=b.id WHERE b.id=$1`,
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
        `SELECT id,token_number AS "tokenNumber",business_date::text AS "businessDate",status,grand_total::text AS "grandTotal" FROM orders WHERE bill_id=$1 ORDER BY queued_at,id`,
        [id],
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
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
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
          `SELECT id FROM bills WHERE status='OPEN' AND ($1::uuid IS NULL OR (opened_at,id)>(SELECT opened_at,id FROM bills WHERE id=$1)) AND ($2='' OR strpos(lower(reference),lower($2))>0 OR bill_number::text=$2) ORDER BY opened_at,id LIMIT 101`,
          [q.after ?? null, q.search?.trim() ?? ''],
        )
      ).rows;
      const bills: BillSummary[] = [];
      for (const r of rows.slice(0, 100))
        bills.push(await this.summary(c, r.id));
      return { bills, nextCursor: rows.length > 100 ? bills[99]!.id : null };
    });
  }
  collect(id: string, input: CollectPaymentDto, actor: AuthRequest) {
    return this.db.transaction(async (c) => {
      await this.authorize(c, actor, 'payments.collect');
      const value = paise(input.amount);
      if (value <= 0n)
        throw new BadRequestException({
          code: 'INVALID_AMOUNT',
          message:
            'Enter a positive amount in rupees with at most two decimal places.',
        });
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([id, input.method, amount(value)]))
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
      await this.lockOpen(c, id);
      const bill = await this.summary(c, id);
      if (value > paise(bill.amountDue))
        throw new ConflictException({
          code: 'PAYMENT_EXCEEDS_DUE',
          message: `Payment exceeds the current amount due (₹${bill.amountDue}). Refresh and review the bill.`,
        });
      await c.query(
        `INSERT INTO payments(id,bill_id,type,method,amount,performed_by,request_id,request_hash) VALUES($1,$2,'COLLECTION',$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          id,
          input.method,
          amount(value),
          actor.user.id,
          input.requestId,
          fingerprint,
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
        bill.orders.some((o) => o.status !== 'COMPLETED')
      )
        throw new ConflictException({
          code: 'BILL_NOT_SETTLED',
          message:
            'Settle the bill and complete all Kitchen rounds before closing.',
        });
      await c.query(
        "UPDATE bills SET status='CLOSED',closed_at=clock_timestamp(),closed_by=$2 WHERE id=$1",
        [id, actor.user.id],
      );
      return this.detail(c, id);
    });
  }
}
