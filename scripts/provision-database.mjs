import pg from 'pg';
import { identifier, grantRuntime } from './runtime-grants.mjs';
// Run with an administrative connection against a dedicated DukanOS database.
// No passwords are accepted in argv, generated or printed. Set login passwords
// separately using psql's hidden \password prompt.
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
try {
  const owner = process.env.DUKANOS_MIGRATION_ROLE;
  const runtime = process.env.DUKANOS_RUNTIME_ROLE;
  const schema = process.env.DUKANOS_DB_SCHEMA;
  const o = identifier(owner),
    r = identifier(runtime),
    s = identifier(schema);
  if (
    owner === runtime ||
    schema === 'public' ||
    !['setup', 'grant'].includes(process.argv[2])
  )
    throw new Error('Invalid provisioning configuration');
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(742019325)');
  if (process.argv[2] === 'setup') {
    for (const name of [owner, runtime]) {
      const existing = (
        await client.query(
          'SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',
          [name],
        )
      ).rows[0];
      if (existing && Object.values(existing).some(Boolean))
        throw new Error('Existing privileged role refused');
      if (!existing)
        await client.query(
          `CREATE ROLE ${identifier(name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
        );
    }
    if (
      (
        await client.query(
          'SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)',
          [runtime],
        )
      ).rowCount
    )
      throw new Error('Runtime role membership refused');
    const database = (await client.query('SELECT current_database() AS name'))
      .rows[0].name;
    await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await client.query(
      `REVOKE ALL ON DATABASE ${identifier(database)} FROM PUBLIC`,
    );
    await client.query(
      `GRANT CONNECT ON DATABASE ${identifier(database)} TO ${o},${r}`,
    );
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s} AUTHORIZATION ${o}`);
    if (
      (
        await client.query(
          'SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1',
          [schema],
        )
      ).rows[0].owner !== owner
    )
      throw new Error('Existing schema owner mismatch');
    for (const name of [owner, runtime])
      await client.query(
        `ALTER ROLE ${identifier(name)} IN DATABASE ${identifier(database)} SET search_path TO ${s}`,
      );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA ${s} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
    );
  } else await grantRuntime(client, schema, runtime);
  await client.query('COMMIT');
  console.log('Database role provisioning complete. No passwords were set.');
} catch {
  await client.query('ROLLBACK').catch(() => {});
  console.error(
    'Database provisioning failed; verify dedicated database, role separation and reviewed settings.',
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
