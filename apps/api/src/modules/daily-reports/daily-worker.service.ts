import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { RestaurantClock } from '../../database/restaurant-clock';
import { BillRolloverService } from '../bills/bill-rollover.service';
import { DailyReportsService } from './daily-reports.service';
import { EmailDeliveryAdapter, deliveryError } from './email-adapter';
import { renderReport } from './report-email';
import { diagnostic } from '../../diagnostics';
@Injectable()
export class DailyWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(DailyWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly db: DatabaseService,
    private readonly clock: RestaurantClock,
    private readonly rollover: BillRolloverService,
    private readonly reports: DailyReportsService,
    private readonly email: EmailDeliveryAdapter,
  ) {}
  start() {
    if (this.timer) return;
    this.stopped = false;
    const tick = () =>
      void this.run().catch(() =>
        this.logger.error(
          'Daily report worker failed; retrying at the next check.',
        ),
      );
    this.timer = setInterval(tick, 60000);
    this.timer.unref();
    tick();
  }
  run() {
    if (this.running) return this.running;
    this.running = this.cycle()
      .then(
        () => {
          diagnostic('daily_worker_ok');
        },
        (error) => {
          diagnostic('daily_worker_failed');
          throw error;
        },
      )
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async cycle() {
    await this.rollover.run();
    await this.catchUp();
    if (this.email.configured)
      for (let i = 0; i < 10 && !this.stopped; i++)
        if (!(await this.deliverOne())) break;
  }
  async catchUp() {
    await this.db.transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(742019324)');
      const now = await this.clock.read(c);
      await c.query(
        'UPDATE daily_report_settings SET start_date=$1::date-1,next_date=$1::date-1 WHERE id AND start_date IS NULL',
        [now.business_date],
      );
    });
    for (let i = 0; i < 7 && !this.stopped; i++) {
      const due = await this.db.transaction(async (c) => {
        const now = await this.clock.read(c);
        return (
          await c.query(
            `SELECT next_date::text AS date FROM daily_report_settings WHERE id AND next_date<$1::date AND $2::timestamptz >= ((next_date+1)::timestamp AT TIME ZONE $3)+($4::int*interval '1 minute')`,
            [
              now.business_date,
              now.queued_at,
              this.clock.timezone,
              this.email.config.delay,
            ],
          )
        ).rows[0];
      });
      if (!due) break;
      await this.reports.generate({
        businessDate: due.date,
        requestId: randomUUID(),
      });
      await this.db.query(
        'UPDATE daily_report_settings SET next_date=next_date+1 WHERE id AND next_date=$1::date',
        [due.date],
      );
    }
  }
  async deliverOne() {
    if (!this.email.configured) return false;
    const claimed = await this.db.transaction(async (c) => {
      const d = (
        await c.query(
          `SELECT * FROM report_deliveries WHERE (status IN ('PENDING','RETRY_PENDING') AND next_attempt_at<=clock_timestamp()) OR (status='SENDING' AND lease_until<clock_timestamp()) ORDER BY next_attempt_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        )
      ).rows[0];
      if (!d) return null;
      if (d.status === 'SENDING')
        await c.query(
          "INSERT INTO report_delivery_attempts(id,delivery_id,attempt,outcome,error_code) VALUES($1,$2,$3,'LEASE_EXPIRED','DELIVERY_UNCERTAIN') ON CONFLICT DO NOTHING",
          [randomUUID(), d.id, d.attempt_count],
        );
      const claim = randomUUID();
      await c.query(
        "UPDATE report_deliveries SET status='SENDING',attempt_count=attempt_count+1,claim_id=$2,lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1",
        [d.id, claim],
      );
      return { ...d, claim, attempt_count: d.attempt_count + 1 };
    });
    if (!claimed) return false;
    // Heartbeat prevents another process reclaiming a healthy but slow SMTP send.
    const heartbeat = setInterval(() => {
      void this.db
        .query(
          "UPDATE report_deliveries SET lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1 AND claim_id=$2 AND status='SENDING'",
          [claimed.id, claimed.claim],
        )
        .catch(() => {});
    }, 30000);
    heartbeat.unref();
    let provider: string | null = null,
      error: string | null = null;
    try {
      const message =
        claimed.kind === 'TEST'
          ? {
              subject: 'DukanOS Email Test',
              text: 'DukanOS Email Test\nYour SMTP delivery configuration is working.',
              html: '<p>DukanOS Email Test</p><p>Your SMTP delivery configuration is working.</p>',
            }
          : await (async () => {
              const r = await this.reports.detail(claimed.report_id);
              return renderReport(r.snapshot, r.version);
            })();
      provider = await this.email.send(claimed.recipient, message, claimed.id);
    } catch (e) {
      error = deliveryError(e);
    } finally {
      clearInterval(heartbeat);
    }
    await this.db.transaction(async (c) => {
      const d = (
        await c.query(
          'SELECT claim_id,status FROM report_deliveries WHERE id=$1 FOR UPDATE',
          [claimed.id],
        )
      ).rows[0];
      if (d.claim_id !== claimed.claim || d.status !== 'SENDING') return;
      const status = error
        ? error === 'RECIPIENT_REJECTED'
          ? 'FAILED'
          : 'RETRY_PENDING'
        : 'SENT';
      const delay = [1, 5, 15, 30, 60][Math.min(claimed.attempt_count - 1, 4)];
      await c.query(
        "UPDATE report_deliveries SET status=$2,sent_at=CASE WHEN $2='SENT' THEN clock_timestamp() ELSE NULL END,last_error_code=$3,provider_message_id=$4,lease_until=NULL,claim_id=NULL,next_attempt_at=clock_timestamp()+($5::int*interval '1 minute') WHERE id=$1",
        [claimed.id, status, error, provider, delay],
      );
      await c.query(
        'INSERT INTO report_delivery_attempts(id,delivery_id,attempt,outcome,error_code,provider_message_id) VALUES($1,$2,$3,$4,$5,$6)',
        [
          randomUUID(),
          claimed.id,
          claimed.attempt_count,
          status,
          error,
          provider,
        ],
      );
    });
    return true;
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => {});
  }
}
