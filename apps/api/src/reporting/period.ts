import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ReportPeriod } from '@dukanos/shared-types';
import { RestaurantClock } from '../database/restaurant-clock';
import type { ReportPeriodDto } from './period.dto';
export async function reportPeriod(
  c: PoolClient,
  clock: RestaurantClock,
  q: ReportPeriodDto,
): Promise<ReportPeriod> {
  const now = await clock.read(c);
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
    timezone: clock.timezone,
    asOf: now.queued_at.toISOString(),
  };
}
