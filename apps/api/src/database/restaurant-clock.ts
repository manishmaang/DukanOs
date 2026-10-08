import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
export function restaurantTimezone(env: NodeJS.ProcessEnv = process.env) {
  const timezone = env.RESTAURANT_TIMEZONE ?? 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    throw new Error('RESTAURANT_TIMEZONE must be a valid IANA timezone');
  }
  return timezone;
}
@Injectable()
export class RestaurantClock {
  readonly timezone = restaurantTimezone();
  async read(c: PoolClient) {
    return (
      await c.query<{
        queued_at: Date;
        business_date: string;
        local_time: string;
      }>(
        "SELECT t AS queued_at,(t AT TIME ZONE $1)::date::text AS business_date,to_char(t AT TIME ZONE $1,'HH24:MI:SS') AS local_time FROM (SELECT clock_timestamp() AS t) stamp",
        [this.timezone],
      )
    ).rows[0]!;
  }
}
