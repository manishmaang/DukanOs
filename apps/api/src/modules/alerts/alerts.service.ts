import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { BillsService } from '../bills/bills.service';
import type { AuthRequest } from '../auth/access';
import type { TimerDto } from './alerts.dto';
@Injectable()
export class AlertsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly bills: BillsService,
  ) {}
  reminders() {
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const entries = (
        await c.query(
          `SELECT r.bill_id AS "billId",b.bill_number AS "billNumber",b.business_date::text AS "businessDate",b.reference,f.amount_due::text AS "amountDue",r.interval_minutes AS "intervalMinutes",r.next_due_at AS "nextDueAt",r.version FROM bill_reminders r JOIN bills b ON b.id=r.bill_id JOIN bill_balances f ON f.id=b.id WHERE r.next_due_at IS NOT NULL AND b.status='OPEN' AND f.amount_due>0 ORDER BY r.next_due_at,r.bill_id`,
        )
      ).rows;
      return {
        serverTime: (await c.query('SELECT clock_timestamp() AS t')).rows[0].t,
        entries,
      };
    });
  }
  configure(id: string, minutes: number, actor: AuthRequest) {
    return this.db.transaction(async (c) => {
      await this.bills.authorize(c, actor, 'bills.reminders.manage');
      await this.bills.lockOpen(c, id);
      const b = await this.bills.summary(c, id);
      if (b.serviceType !== 'DINE_IN' || b.amountDue === '0.00')
        throw new ConflictException({
          code: 'REMINDER_NOT_APPLICABLE',
          message: 'Payment reminders require an open unpaid Dine In bill.',
        });
      await c.query(
        `INSERT INTO bill_reminders(bill_id,interval_minutes,next_due_at,created_by,updated_by) VALUES($1,$2,clock_timestamp()+make_interval(mins=>$2),$3,$3) ON CONFLICT(bill_id) DO UPDATE SET interval_minutes=$2,next_due_at=clock_timestamp()+make_interval(mins=>$2),updated_by=$3`,
        [id, minutes, actor.user.id],
      );
      return { saved: true };
    });
  }
  snooze(id: string, version: number, actor: AuthRequest) {
    return this.db.transaction(async (c) => {
      await this.bills.authorize(c, actor, 'bills.reminders.manage');
      const result = await c.query(
        `UPDATE bill_reminders SET next_due_at=clock_timestamp()+make_interval(mins=>interval_minutes),updated_by=$3 WHERE bill_id=$1 AND version=$2 AND next_due_at IS NOT NULL RETURNING bill_id`,
        [id, version, actor.user.id],
      );
      if (!result.rowCount)
        throw new ConflictException({
          code: 'REMINDER_CHANGED',
          message:
            'Reminder changed or bill was paid. Refresh before snoozing.',
        });
      return { saved: true };
    });
  }
  timers() {
    return this.db.transaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const entries = (
        await c.query(
          `SELECT t.id,t.label,t.duration_seconds AS "durationSeconds",t.started_at AS "startedAt",t.due_at AS "dueAt",t.status,t.order_id AS "orderId",t.order_item_id AS "orderItemId",o.token_number AS "tokenNumber",o.business_date::text AS "businessDate",i.item_name_snapshot AS "itemName",i.variant_name_snapshot AS "variantName" FROM kitchen_timers t LEFT JOIN orders o ON o.id=t.order_id LEFT JOIN order_items i ON i.id=t.order_item_id WHERE t.status='ACTIVE' ORDER BY t.due_at,t.id`,
        )
      ).rows;
      return {
        serverTime: (await c.query('SELECT clock_timestamp() AS t')).rows[0].t,
        entries,
      };
    });
  }
  create(input: TimerDto, actor: AuthRequest) {
    return this.db.transaction(async (c) => {
      await this.bills.authorize(c, actor, 'kitchen.timers.manage');
      const hash = createHash('sha256')
        .update(
          JSON.stringify([
            input.label.trim(),
            input.durationSeconds,
            input.orderId?.toLowerCase() ?? null,
            input.orderItemId?.toLowerCase() ?? null,
          ]),
        )
        .digest('hex');
      const prior = (
        await c.query(
          'SELECT id,request_hash FROM kitchen_timers WHERE created_by=$1 AND request_id=$2',
          [actor.user.id, input.requestId],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash)
          throw new ConflictException({
            code: 'IDEMPOTENCY_CONFLICT',
            message:
              'This timer request was already used with different details.',
          });
        return { id: prior.id };
      }
      if (input.orderItemId && !input.orderId)
        throw new BadRequestException({
          code: 'INVALID_TIMER_ASSOCIATION',
          message: 'Select the order for this item.',
        });
      if (
        input.orderId &&
        !(
          await c.query(
            `SELECT 1 FROM orders o WHERE o.id=$1 AND o.status IN ('QUEUED','PREPARING') AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM order_items WHERE id=$2 AND order_id=o.id))`,
            [input.orderId, input.orderItemId ?? null],
          )
        ).rowCount
      )
        throw new ConflictException({
          code: 'INVALID_TIMER_ASSOCIATION',
          message: 'Select an active Kitchen order and one of its items.',
        });
      const id = randomUUID();
      await c.query(
        `INSERT INTO kitchen_timers(id,label,duration_seconds,started_at,due_at,created_by,request_id,request_hash,order_id,order_item_id) SELECT $1,$2,$3::integer,t,t+$3::integer*interval '1 second',$4,$5,$6,$7,$8 FROM (SELECT clock_timestamp() t) stamp`,
        [
          id,
          input.label.trim(),
          input.durationSeconds,
          actor.user.id,
          input.requestId,
          hash,
          input.orderId ?? null,
          input.orderItemId ?? null,
        ],
      );
      return { id };
    });
  }
  resolve(
    id: string,
    status: 'ACKNOWLEDGED' | 'CANCELLED',
    actor: AuthRequest,
  ) {
    return this.db.transaction(async (c) => {
      await this.bills.authorize(c, actor, 'kitchen.timers.manage');
      const t = (
        await c.query(
          'SELECT status,due_at<=clock_timestamp() AS due FROM kitchen_timers WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!t)
        throw new NotFoundException({
          code: 'TIMER_NOT_FOUND',
          message: 'Timer was not found.',
        });
      if (t.status === status) return { saved: true };
      if (t.status !== 'ACTIVE')
        throw new ConflictException({
          code: 'TIMER_RESOLVED',
          message: 'This timer was already resolved.',
        });
      if (status === 'ACKNOWLEDGED' && !t.due)
        throw new ConflictException({
          code: 'TIMER_NOT_DUE',
          message: 'Timer has not finished. Cancel it if no longer needed.',
        });
      await c.query(
        'UPDATE kitchen_timers SET status=$2,resolved_by=$3,resolved_at=clock_timestamp() WHERE id=$1',
        [id, status, actor.user.id],
      );
      return { saved: true };
    });
  }
}
