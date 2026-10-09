import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  rm,
  stat,
  rename,
  cp,
} from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { identifier } from './runtime-grants.mjs';
import { fileURLToPath } from 'node:url';

export function command(binary, args, env = process.env) {
  const r = spawnSync(binary, args, {
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 600000,
  });
  if (r.status !== 0) throw new Error('BACKUP_COMMAND_FAILED'); // child output may contain secrets
  return r.stdout;
}
export function postgresEnv(urlString) {
  const u = new URL(urlString);
  if (
    !['postgres:', 'postgresql:'].includes(u.protocol) ||
    u.searchParams.has('host') ||
    u.searchParams.has('hostaddr') ||
    (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) &&
      u.searchParams.get('sslmode') !== 'verify-full')
  )
    throw new Error('VERIFIED_DATABASE_CONNECTION_REQUIRED');
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGCONNECT_TIMEOUT: '5',
    PGOPTIONS: u.searchParams.get('options') || '',
    PGSSLMODE: u.searchParams.get('sslmode') || 'prefer',
    PGSSLROOTCERT: u.searchParams.get('sslrootcert') || '',
  };
}
export async function digest(file) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
}
export async function inventory(c, schema) {
  const s = identifier(schema);
  const tables = (
    await c.query(
      'SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',
      [schema],
    )
  ).rows;
  const counts = {};
  for (const { tablename } of tables)
    counts[tablename] = (
      await c.query(
        `SELECT count(*)::text n FROM ${s}.${identifier(tablename)}`,
      )
    ).rows[0].n;
  const financial = (
    await c.query(
      `SELECT (SELECT coalesce(sum(grand_total),0)::text FROM ${s}.effective_orders) food,(SELECT coalesce(sum(amount),0)::text FROM ${s}.payments WHERE type='COLLECTION') collections,(SELECT coalesce(sum(amount),0)::text FROM ${s}.payments WHERE type='REFUND') refunds,(SELECT coalesce(sum(amount),0)::text FROM ${s}.expenses WHERE status='ACTIVE') expenses`,
    )
  ).rows[0];
  const ledger = (
    await c.query(
      `SELECT name,checksum FROM ${s}.schema_migrations ORDER BY name`,
    )
  ).rows;
  const roles = (
    await c.query(
      `SELECT u.username,array_agg(r.code ORDER BY r.code) roles FROM ${s}.users u JOIN ${s}.user_roles ur ON ur.user_id=u.id JOIN ${s}.roles r ON r.code=ur.role_code GROUP BY u.username ORDER BY u.username`,
    )
  ).rows;
  const objects = (
    await c.query(
      `SELECT 'relation' kind,c.relname name,c.relkind::text detail FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','v','i','S')
    UNION ALL SELECT 'function',p.proname,p.pronargs::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1
    UNION ALL SELECT 'trigger',c.relname||'.'||t.tgname,t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal
    UNION ALL SELECT 'constraint',c.relname||'.'||k.conname,k.contype::text FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY 1,2,3`,
      [schema],
    )
  ).rows;
  return { counts, financial, ledger, roles, objects };
}
export async function makeBackup({
  url,
  schema,
  data,
  config,
  release,
  destination,
  recipient,
  fixture = false,
}) {
  if (
    ![data, config, release, destination].every(isAbsolute) ||
    !/^[A-Fa-f0-9]{40,64}$/.test(recipient || '')
  )
    throw new Error('BACKUP_CONFIGURATION_INVALID');
  identifier(schema);
  const dbEnvironment = postgresEnv(url);
  const dbname = decodeURIComponent(new URL(url).pathname.slice(1));
  if (fixture) {
    if (!dbname.startsWith('dukanos_fixture_'))
      throw new Error('FIXTURE_DATABASE_REQUIRED');
  } else {
    if (
      command('systemctl', [
        'show',
        'dukanos.service',
        '--property=ActiveState',
        '--value',
      ]).trim() !== 'inactive'
    )
      throw new Error('STOP_APPLICATION_BEFORE_BACKUP');
  }
  const c = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
  });
  let staging;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  try {
    await c.connect();
    if (
      (
        await c.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND coalesce(backend_type,'client backend')='client backend'",
        )
      ).rowCount
    )
      throw new Error('OTHER_DATABASE_CLIENTS_PRESENT');
    if (
      !fixture &&
      command('git', ['-C', release, 'status', '--porcelain']).trim()
    )
      throw new Error('RELEASE_HAS_UNCOMMITTED_CHANGES');
    staging = await mkdtemp(join(destination, '.working-'));
    const manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      schema,
      release: command('git', ['-C', release, 'rev-parse', 'HEAD']).trim(),
      inventory: await inventory(c, schema),
      files: {},
    };
    manifest.media = {};
    const references = (
      await c.query(
        `SELECT 'menu' folder,image_key::text key FROM ${identifier(schema)}.menu_items WHERE image_key IS NOT NULL UNION ALL SELECT 'expenses',receipt_key::text FROM ${identifier(schema)}.expenses WHERE receipt_key IS NOT NULL`,
      )
    ).rows;
    for (const ref of references)
      manifest.media[`uploads/${ref.folder}/${ref.key}.webp`] = await digest(
        join(data, 'uploads', ref.folder, ref.key + '.webp'),
      );
    // Record role flags/ACLs without password hashes. Restore uses reviewed
    // provisioning and fresh credentials, not indiscriminate global role import.
    const grants = (
      await c.query(
        `SELECT n.nspname schema,c.relname relation,pg_get_userbyid(c.relowner) owner,c.relacl::text acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname`,
        [schema],
      )
    ).rows;
    const roles = (
      await c.query(
        `SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE oid IN (SELECT nspowner FROM pg_namespace WHERE nspname=$1 UNION SELECT (aclexplode(c.relacl)).grantee FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1)`,
        [schema],
      )
    ).rows;
    await writeFile(
      join(staging, 'grants.json'),
      JSON.stringify({ grants, roles }),
      { mode: 0o600 },
    );
    command(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-acl',
        '--file',
        join(staging, 'database.dump'),
      ],
      dbEnvironment,
    );
    command('pg_restore', ['--list', join(staging, 'database.dump')]);
    command('tar', [
      '-czf',
      join(staging, 'media.tar.gz'),
      '-C',
      data,
      'uploads',
    ]);
    command('tar', [
      '-czf',
      join(staging, 'configuration.tar.gz'),
      '-C',
      config,
      '.',
    ]);
    command('tar', [
      '-czf',
      join(staging, 'release.tar.gz'),
      '-C',
      release,
      '--exclude=.env',
      '--exclude=.env.*',
      '--exclude=*.log',
      'apps',
      'packages',
      'database',
      'scripts',
      'deploy',
      'package.json',
      'package-lock.json',
      'node_modules',
    ]);
    for (const name of await readdir(staging))
      manifest.files[name] = await digest(join(staging, name));
    await writeFile(
      join(staging, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    const archive = join(
      destination,
      `dukanos-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.tar.gpg`,
    );
    const plain = join(staging, 'bundle.tar');
    command('tar', [
      '-cf',
      plain,
      '-C',
      staging,
      ...Object.keys(manifest.files),
      'manifest.json',
    ]);
    command('gpg', [
      '--batch',
      '--yes',
      '--trust-model',
      'always',
      '--recipient',
      recipient,
      '--output',
      archive + '.partial',
      '--encrypt',
      plain,
    ]);
    await rename(archive + '.partial', archive);
    await writeFile(archive + '.sha256', (await digest(archive)) + '\n', {
      mode: 0o600,
    });
    return archive;
  } finally {
    await c.end().catch(() => {});
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
export async function validateBundle(directory) {
  const m = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8'),
  );
  const expected = [
    'configuration.tar.gz',
    'database.dump',
    'grants.json',
    'media.tar.gz',
    'release.tar.gz',
  ];
  if (
    m.format !== 1 ||
    JSON.stringify(Object.keys(m.files).sort()) !== JSON.stringify(expected)
  )
    throw new Error('INVALID_BACKUP_MANIFEST');
  for (const name of expected)
    if ((await digest(join(directory, name))) !== m.files[name])
      throw new Error('BACKUP_CHECKSUM_MISMATCH');
  command('pg_restore', ['--list', join(directory, 'database.dump')]);
  return m;
}
export async function restoreFixture({ bundle, url, output }) {
  const dbEnvironment = postgresEnv(url);
  if (
    !decodeURIComponent(new URL(url).pathname.slice(1)).startsWith(
      'dukanos_restore_',
    ) ||
    !isAbsolute(output)
  )
    throw new Error('ISOLATED_RESTORE_DATABASE_REQUIRED');
  // Caller creates an empty isolated database. Never DROP, --clean or overwrite.
  await mkdir(output, { mode: 0o700 });
  const plain = join(output, 'bundle.tar');
  command('gpg', ['--batch', '--output', plain, '--decrypt', bundle]);
  const entries = command('tar', ['-tf', plain]).trim().split('\n');
  if (
    entries.some(
      (n) =>
        ![
          'configuration.tar.gz',
          'database.dump',
          'grants.json',
          'media.tar.gz',
          'release.tar.gz',
          'manifest.json',
        ].includes(n),
    )
  )
    throw new Error('UNSAFE_BACKUP_ARCHIVE');
  command('tar', ['--no-same-owner', '-xf', plain, '-C', output]);
  const manifest = await validateBundle(output);
  const c = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
  await c.connect();
  try {
    if (
      (
        await c.query(
          "SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')",
        )
      ).rowCount
    )
      throw new Error('RESTORE_DATABASE_NOT_EMPTY');
    command(
      'pg_restore',
      [
        '--exit-on-error',
        '--no-owner',
        '--no-acl',
        '--dbname',
        decodeURIComponent(new URL(url).pathname.slice(1)),
        join(output, 'database.dump'),
      ],
      dbEnvironment,
    );
    if (
      JSON.stringify(await inventory(c, manifest.schema)) !==
      JSON.stringify(manifest.inventory)
    )
      throw new Error('RESTORE_INVENTORY_MISMATCH');
    for (const [archive, folder] of [
      ['media.tar.gz', 'media'],
      ['configuration.tar.gz', 'protected-config'],
      ['release.tar.gz', 'release'],
    ]) {
      await mkdir(join(output, folder), { mode: 0o700 });
      command('tar', [
        '--no-same-owner',
        '-xzf',
        join(output, archive),
        '-C',
        join(output, folder),
      ]);
    }
    for (const [path, hash] of Object.entries(manifest.media)) {
      if (
        !/^uploads\/(menu|expenses)\/[0-9a-f-]{36}\.webp$/.test(path) ||
        (await digest(join(output, 'media', path))) !== hash
      )
        throw new Error('RESTORED_MEDIA_MISMATCH');
    }
    // Do NOT boot an app or load restored credentials. SMTP remains disabled.
    return manifest;
  } finally {
    await c.end();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.umask(0o077);
  try {
    if (process.argv[2] === 'create') {
      const artifact = await makeBackup({
        url: process.env.DATABASE_URL,
        schema: process.env.DUKANOS_DB_SCHEMA,
        data: process.env.DUKANOS_DATA_DIR,
        config: process.env.BACKUP_CONFIG_DIR,
        release: process.cwd(),
        destination: process.env.BACKUP_DIR,
        recipient: process.env.BACKUP_GPG_RECIPIENT,
      });
      // Off-instance target is a pre-mounted encrypted/secured separate host or
      // AWS S3 via the documented upload step. Local copy alone is not success.
      if (process.env.BACKUP_S3_URI) {
        if (
          !/^s3:\/\/[a-z0-9.-]+\/[a-zA-Z0-9/_-]*\/$/.test(
            process.env.BACKUP_S3_URI,
          )
        )
          throw new Error('INVALID_S3_DESTINATION');
        const target = process.env.BACKUP_S3_URI + artifact.split('/').at(-1);
        command('aws', [
          's3',
          'cp',
          artifact,
          target,
          '--sse',
          'AES256',
          '--checksum-algorithm',
          'SHA256',
          '--only-show-errors',
        ]);
        command('aws', [
          's3',
          'cp',
          artifact + '.sha256',
          target + '.sha256',
          '--sse',
          'AES256',
          '--only-show-errors',
        ]);
      } else {
        if (
          !process.env.BACKUP_OFFSITE_DIR ||
          !isAbsolute(process.env.BACKUP_OFFSITE_DIR) ||
          process.env.BACKUP_OFFSITE_DIR === process.env.BACKUP_DIR
        )
          throw new Error('OFFSITE_DESTINATION_REQUIRED');
        const dest = join(
          process.env.BACKUP_OFFSITE_DIR,
          artifact.split('/').at(-1),
        );
        await cp(artifact, dest, { errorOnExist: true, force: false });
        if ((await digest(dest)) !== (await digest(artifact)))
          throw new Error('OFFSITE_CHECKSUM_MISMATCH');
        await cp(artifact + '.sha256', dest + '.sha256');
      }
      const state = {
        completedAt: new Date().toISOString(),
        artifact: artifact.split('/').at(-1),
      };
      await writeFile(
        join(process.env.BACKUP_DIR, 'last-success.json'),
        JSON.stringify(state),
        { mode: 0o600 },
      );
      const keep = Number(process.env.BACKUP_RETENTION_DAYS || '14');
      if (!Number.isInteger(keep) || keep < 7 || keep > 3650)
        throw new Error('INVALID_RETENTION');
      // Prune only local timestamped artifacts after a verified offsite copy.
      for (const name of await readdir(process.env.BACKUP_DIR))
        if (/^dukanos-[0-9T:.Za-f-]+\.tar\.gpg(?:\.sha256)?$/.test(name)) {
          const path = join(process.env.BACKUP_DIR, name);
          if (Date.now() - (await stat(path)).mtimeMs > keep * 86400000)
            await rm(path);
        }
      console.log('Encrypted full backup and off-instance copy completed.');
    } else if (process.argv[2] === 'restore-fixture') {
      await restoreFixture({
        bundle: process.env.BACKUP_ARTIFACT,
        url: process.env.DATABASE_URL,
        output: process.env.RESTORE_DIRECTORY,
      });
      console.log(
        'Isolated restore verified. No application or SMTP worker was started.',
      );
    } else throw new Error('INVALID_COMMAND');
  } catch {
    console.error(
      'Backup/restore failed. Inspect configuration, connectivity, free space, keys and service state. Sensitive child output was suppressed.',
    );
    process.exitCode = 1;
  }
}
