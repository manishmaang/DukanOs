import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
let transaction = false;
try {
  await client.connect();
  await client.query('BEGIN');
  transaction = true;
  // Transaction lock serializes concurrent migration runners, including first setup.
  await client.query('SELECT pg_advisory_xact_lock(742019321)');
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const directory = fileURLToPath(
    new URL('../database/migrations/', import.meta.url),
  );
  const files = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const applied = (
    await client.query(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    )
  ).rows;
  for (const entry of applied)
    if (!files.includes(entry.name))
      throw new Error('An applied migration is missing');
  for (const name of files) {
    const sql = await readFile(`${directory}/${name}`, 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = applied.find((entry) => entry.name === name);
    if (previous) {
      if (previous.checksum !== checksum)
        throw new Error('An applied migration was modified');
      continue;
    }
    if (applied.some((entry) => entry.name > name))
      throw new Error('Cannot insert migrations before applied migrations');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
      [name, checksum],
    );
    console.log(`Applied ${name}`);
  }
  await client.query('COMMIT');
  transaction = false;
  console.log('Migrations are up to date');
} catch {
  if (transaction) await client.query('ROLLBACK').catch(() => {});
  console.error(
    'Migration failed. Verify connectivity and unchanged, ordered migration files. No pending changes were committed.',
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
