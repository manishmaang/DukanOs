import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RestaurantClock } from '../../database/restaurant-clock';
import { previousDayCleanupTime } from '../orders/cleanup-configuration';
import { cancelPreviousDayOrders } from '../orders/previous-day-cleanup';
import { diagnostic } from '../../diagnostics';
@Injectable()
export class BillRolloverService implements OnModuleDestroy {
  private readonly logger = new Logger(BillRolloverService.name);
  readonly cleanupTime = previousDayCleanupTime();
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<number>;
  constructor(
    private readonly db: DatabaseService,
    private readonly clock: RestaurantClock,
  ) {}
  // Started explicitly by the HTTP bootstrap; read-only CLI contexts do not run jobs.
  async start() {
    if (this.timer) return;
    await this.run();
    this.timer = setInterval(() => {
      void this.run().catch(() =>
        this.logger.error('Bill rollover failed; retrying at the next check.'),
      );
    }, 60000);
    this.timer.unref();
  }
  run(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.db
      .transaction(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(742019323)');
        const now = await this.clock.read(c);
        const result = await c.query(
          `UPDATE bills SET status='CLOSED',closed_at=$2,closed_by=NULL,closure_reason='BUSINESS_DAY_ROLLOVER',closure_timezone=$3 WHERE status='OPEN' AND business_date<$1::date`,
          [now.business_date, now.queued_at, this.clock.timezone],
        );
        await cancelPreviousDayOrders(
          c,
          now,
          this.clock.timezone,
          this.cleanupTime,
        );
        return result.rowCount ?? 0;
      })
      .then(
        (count) => {
          diagnostic('rollover_ok');
          return count;
        },
        (error) => {
          diagnostic('rollover_failed');
          throw error;
        },
      )
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }
}
