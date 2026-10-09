import pg from 'pg';
import { statfs, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const failures = [];
async function check(name, action) {
  try {
    if (!(await action())) failures.push(name);
  } catch {
    failures.push(name);
  }
}
await check(
  'api_readiness',
  async () =>
    (
      await fetch('http://127.0.0.1:3000/api/health/ready', {
        signal: globalThis.AbortSignal.timeout(5000),
      })
    ).ok,
);
await check('disk_space', async () => {
  const s = await statfs(process.env.DUKANOS_DATA_DIR);
  return (
    s.bavail * s.bsize > 1024 ** 3 &&
    s.bavail / s.blocks > 0.1 &&
    (!s.files || s.ffree / s.files > 0.1)
  );
});
await check('backup_freshness', async () => {
  const s = JSON.parse(
    await readFile(join(process.env.BACKUP_DIR, 'last-success.json'), 'utf8'),
  );
  const age = Date.now() - Date.parse(s.completedAt);
  return age >= 0 && age < 26 * 3600000;
});
await check('database_and_reports', async () => {
  const c = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  try {
    await c.connect();
    const r = (
      await c.query(
        'SELECT next_date >= (clock_timestamp() AT TIME ZONE $1)::date-1 AS fresh FROM daily_report_settings WHERE id',
        [process.env.RESTAURANT_TIMEZONE || 'Asia/Kolkata'],
      )
    ).rows[0];
    return r?.fresh === true;
  } finally {
    await c.end().catch(() => {});
  }
});
await check('unexpected_restart', async () => {
  const value = execFileSync(
    'systemctl',
    ['show', 'dukanos.service', '--property=NRestarts', '--value'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
  return value === '0';
});
await check('workers_restarts_http_errors', async () => {
  const text = execFileSync(
    'journalctl',
    [
      '-u',
      'dukanos.service',
      '--since',
      '10 minutes ago',
      '--output=cat',
      '--no-pager',
    ],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
  );
  const events = text.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  return (
    ['rollover_ok', 'daily_worker_ok'].every((name) =>
      events.some(
        (e) => e.event === name && Date.now() - Date.parse(e.time) < 180000,
      ),
    ) &&
    events.filter((e) => e.event === 'application_started').length <= 1 &&
    events.filter((e) => e.event === 'http_error').length < 5 &&
    !events.some((e) =>
      ['rollover_failed', 'daily_worker_failed', 'shutdown_deadline'].includes(
        e.event,
      ),
    )
  );
});
console.log(
  JSON.stringify({
    time: new Date().toISOString(),
    event: 'pilot_monitor',
    ok: !failures.length,
    failures,
  }),
);
if (failures.length) process.exitCode = 1;
