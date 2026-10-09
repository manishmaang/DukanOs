require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { Client } = require('pg');
const { Test } = require('@nestjs/testing');
const request = require('supertest');
const { AppModule } = require('../../dist/app.module');
const { configureApp, trustedLocalProxy } = require('../../dist/configure-app');
const { ReleaseReadiness } = require('../../dist/health/release-readiness');
const { DatabaseService } = require('../../dist/database/database.service');
const { UsersService } = require('../../dist/modules/users/users.service');
const { RestaurantClock } = require('../../dist/database/restaurant-clock');
const {
  BillRolloverService,
} = require('../../dist/modules/bills/bill-rollover.service');
const {
  DailyWorkerService,
} = require('../../dist/modules/daily-reports/daily-worker.service');
const { readConfig } = require('../../dist/config');

test(
  'production prerequisites, restricted runtime and financial workflows',
  { timeout: 120000 },
  async (t) => {
    const saved = { ...process.env };
    const admin = new Client({ connectionString: saved.DATABASE_URL });
    await admin.connect();
    const id = randomUUID().replaceAll('-', ''),
      schema = 'hardening_' + id,
      role = 'runtime_' + id;
    const root = await fs.mkdtemp('/tmp/dukanos-hardening-');
    let app, runtime;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const pw = randomUUID();
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${pw}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(`SET search_path TO ${schema}`);
      await admin.query(
        'CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const name of (await fs.readdir('database/migrations'))
        .filter((n) => n.endsWith('.sql'))
        .sort()) {
        const sql = await fs.readFile('database/migrations/' + name, 'utf8');
        await admin.query(sql);
        await admin.query(
          'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
          [name, createHash('sha256').update(sql).digest('hex')],
        );
      }
      const { grantRuntime } =
        await import('../../../../scripts/runtime-grants.mjs');
      await grantRuntime(admin, schema, role);
      await grantRuntime(admin, schema, role);
      const url = new URL(saved.DATABASE_URL);
      url.username = role;
      url.password = pw;
      url.searchParams.set('options', `-csearch_path=${schema}`);
      process.env.DATABASE_URL = url.toString();
      process.env.NODE_ENV = 'production';
      process.env.HOST = '127.0.0.1';
      process.env.DUKANOS_DATA_DIR = root + '/data';
      process.env.SMTP_HOST = '';
      process.env.ORDER_TAX_RATE = '0';
      process.env.RESTAURANT_TIMEZONE = 'Asia/Kolkata';
      runtime = new Client({ connectionString: url.toString() });
      await runtime.connect();
      const module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = module.createNestApplication();
      configureApp(app);
      await app.init();
      const ready = app.get(ReleaseReadiness);
      await fs.cp('database', root + '/database', { recursive: true });
      await fs.cp('apps/web/dist', root + '/apps/web/dist', {
        recursive: true,
      });
      ready.root = root;
      await t.test(
        'healthy production release and non-superuser runtime are ready',
        async () => {
          await ready.check(true);
          const unsafe = new ReleaseReadiness({
            check: async () => {},
            query: admin.query.bind(admin),
          });
          unsafe.root = root;
          await assert.rejects(
            unsafe.check(true),
            /UNSAFE_RUNTIME_DATABASE_ROLE/,
          );
          await request(app.getHttpServer())
            .get('/api/health/ready')
            .expect(200);
        },
      );
      await t.test(
        'configuration and exact one-hop proxy trust reject unsafe boundaries',
        () => {
          for (const env of [
            { NODE_ENV: 'prod' },
            { NODE_ENV: 'production', HOST: '0.0.0.0' },
            { NODE_ENV: 'production', DUKANOS_DATA_DIR: 'relative' },
          ])
            assert.throws(() => readConfig({ ...process.env, ...env }));
          assert.equal(trustedLocalProxy('127.0.0.1', 0), true);
          assert.equal(trustedLocalProxy('127.0.0.1', 1), false);
          assert.equal(trustedLocalProxy('192.0.2.1', 0), false);
          assert.equal(trustedLocalProxy('::ffff:192.0.2.1', 0), false);
        },
      );
      await t.test(
        'missing migration and changed checksum fail readiness',
        async () => {
          const removed = (
            await admin.query(
              "DELETE FROM schema_migrations WHERE name LIKE '019_%' RETURNING name,checksum",
            )
          ).rows[0];
          await assert.rejects(ready.check(true), /VERSION/);
          await admin.query(
            'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
            [removed.name, removed.checksum],
          );
          // Checks use another connection, so committed fixture changes are required.
          const old = (
            await admin.query(
              "UPDATE schema_migrations SET checksum='incorrect' WHERE name LIKE '019_%' RETURNING name",
            )
          ).rows[0].name;
          await assert.rejects(ready.check(true), /CHECKSUM/);
          const sql = await fs.readFile('database/migrations/' + old, 'utf8');
          await admin.query(
            'UPDATE schema_migrations SET checksum=$1 WHERE name=$2',
            [createHash('sha256').update(sql).digest('hex'), old],
          );
        },
      );
      await t.test(
        'missing table, frontend asset and unwritable media fail readiness',
        async () => {
          await admin.query(
            'ALTER TABLE app_metadata RENAME TO missing_metadata',
          );
          await assert.rejects(ready.check(true), /OBJECT/);
          await admin.query(
            'ALTER TABLE missing_metadata RENAME TO app_metadata',
          );
          await fs.rename(
            root + '/apps/web/dist/index.html',
            root + '/index.html',
          );
          await assert.rejects(ready.check(true));
          await fs.rename(
            root + '/index.html',
            root + '/apps/web/dist/index.html',
          );
          await fs.chmod(root + '/data/uploads/menu', 0o500);
          await assert.rejects(ready.check(true));
          await fs.chmod(root + '/data/uploads/menu', 0o700);
          await ready.check(true);
        },
      );
      await t.test(
        'database outage fails readiness while process remains live',
        async () => {
          const db = app.get(DatabaseService),
            check = db.check.bind(db);
          db.check = async () => {
            throw new Error('secret connection');
          };
          const r = await request(app.getHttpServer())
            .get('/api/health/ready')
            .expect(503);
          assert.equal(r.body.code, 'SERVICE_NOT_READY');
          assert.ok(r.headers['x-request-id']);
          assert.ok(!JSON.stringify(r.body).includes('secret'));
          await request(app.getHttpServer()).get('/api/health').expect(200);
          db.check = check;
        },
      );
      await t.test(
        'runtime cannot alter schema, triggers, ledger or immutable money',
        async () => {
          for (const sql of [
            'CREATE TABLE forbidden(id int)',
            'ALTER TABLE orders DISABLE TRIGGER ALL',
            'TRUNCATE payments',
            "UPDATE schema_migrations SET checksum='bad'",
            'DELETE FROM payments',
          ])
            await assert.rejects(runtime.query(sql), (e) => e.code === '42501');
        },
      );
      const password = randomUUID() + 'Test!';
      await app.get(UsersService).create({
        username: 'owner',
        name: 'Owner',
        password,
        roles: ['OWNER'],
      });
      let cookie;
      await t.test('secure login cookie and CSRF protection', async () => {
        await request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ username: 'owner', password })
          .expect(403);
        const login = await request(app.getHttpServer())
          .post('/api/auth/login')
          .set('X-DukanOS-Request', '1')
          .set('X-Forwarded-For', '192.0.2.15, 192.0.2.16')
          .send({ username: 'owner', password })
          .expect(200);
        cookie = login.headers['set-cookie'][0];
        for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict'])
          assert.ok(cookie.includes(flag));
        cookie = cookie.split(';')[0];
        const hash = createHash('sha256').update('ip:192.0.2.16').digest('hex');
        assert.equal(
          (
            await admin.query(
              'SELECT attempts FROM login_attempts WHERE key=$1',
              [hash],
            )
          ).rows[0].attempts,
          1,
        );
      });
      const call = (method, path, body) => {
        const a = request(app.getHttpServer());
        const r = a[method]('/api' + path)
          .set('Cookie', cookie)
          .set('X-DukanOS-Request', '1');
        return body ? r.send(body) : r;
      };
      await t.test(
        'real HTTPS proxy overwrites spoofed forwarding, preserves API errors and rate limits',
        async (sub) => {
          if (!process.env.NGINX_BINARY) {
            sub.skip('Set NGINX_BINARY to run the local TLS proxy fixture');
            return;
          }
          await app.listen(0, '127.0.0.1');
          const {
            proxyFixture,
          } = require('../../../../scripts/proxy-fixture.cjs');
          const proxy = await proxyFixture(app.getHttpServer().address().port);
          try {
            const health = await proxy.call('/api/health');
            assert.equal(health.status, 200);
            assert.equal(health.headers['cache-control'], 'no-store');
            assert.ok(health.headers['strict-transport-security']);
            const spoof = {
              'X-Forwarded-For': '192.0.2.99',
              'X-Forwarded-Proto': 'http',
              'X-DukanOS-Request': '1',
            };
            const login = await proxy.call('/api/auth/login', {
              method: 'POST',
              headers: spoof,
              body: { username: 'owner', password },
            });
            assert.equal(login.status, 200);
            assert.ok(login.headers['set-cookie'][0].includes('Secure'));
            const bad = await proxy.call('/api/not-a-route?private=do-not-log');
            assert.equal(bad.status, 404);
            assert.equal(JSON.parse(bad.text).code, 'HTTP_404');
            assert.ok(!bad.text.includes('<html'));
            const oversized = await proxy.call('/api/menu/images', {
              method: 'POST',
              headers: spoof,
              body: { padding: 'x'.repeat(6 * 1024 * 1024) },
            });
            assert.equal(oversized.status, 413);
            assert.equal(
              (
                await proxy.call('/api/auth/login', {
                  method: 'POST',
                  body: { username: 'owner', password },
                })
              ).status,
              403,
            );
            const hash = createHash('sha256')
              .update('ip:127.0.0.1')
              .digest('hex');
            await admin.query(
              'UPDATE login_attempts SET attempts=60 WHERE key=$1',
              [hash],
            );
            assert.equal(
              (
                await proxy.call('/api/auth/login', {
                  method: 'POST',
                  headers: { ...spoof, 'X-Forwarded-For': '192.0.2.100' },
                  body: { username: 'owner', password },
                })
              ).status,
              429,
            );
            assert.equal(
              (
                await admin.query(
                  'SELECT count(*)::int n FROM login_attempts WHERE key=$1',
                  [createHash('sha256').update('ip:192.0.2.99').digest('hex')],
                )
              ).rows[0].n,
              0,
            );
            await admin.query('DELETE FROM login_attempts');
          } finally {
            await proxy.close();
          }
        },
      );
      let instant = '2025-10-08T12:00:00+05:30';
      const clock = app.get(RestaurantClock),
        read = clock.read.bind(clock);
      clock.read = (c) =>
        read({
          query: (q, v) =>
            c.query(q.replace('clock_timestamp()', '$2::timestamptz'), [
              ...v,
              instant,
            ]),
        });
      const cat = (
        await call('post', '/menu/categories', { name: 'Fixture' }).expect(201)
      ).body;
      const item = (
        await call('post', '/menu/items', {
          categoryId: cat.id,
          name: 'Meal',
          variants: [
            {
              name: 'Full',
              channels: [
                { channelCode: 'COUNTER', price: '100', available: true },
              ],
            },
          ],
        }).expect(201)
      ).body;
      const create = async () =>
        (
          await call('post', '/orders/counter', {
            requestId: randomUUID(),
            serviceType: 'DINE_IN',
            lines: [{ variantId: item.variants[0].id, quantity: 1 }],
          }).expect(201)
        ).body;
      await t.test(
        'restricted role creates, pays, cancels, refunds and records report snapshots',
        async () => {
          const order = await create();
          await call('post', `/bills/${order.billId}/payments`, {
            requestId: randomUUID(),
            amount: '100',
            method: 'UPI',
          }).expect(201);
          const input = {
            requestId: randomUUID(),
            expectedRevision: 0,
            kind: 'CANCEL',
            reason: 'CUSTOMER_CHANGE',
            lines: [],
          };
          const quote = (
            await call(
              'post',
              `/orders/${order.id}/amendments/quote`,
              input,
            ).expect(201)
          ).body;
          await call('post', `/orders/${order.id}/amendments`, {
            ...input,
            quoteHash: quote.quoteHash,
          }).expect(201);
          await call('post', `/bills/${order.billId}/refunds`, {
            requestId: randomUUID(),
            amount: '100',
          }).expect(201);
          const stale = await create();
          await call('post', `/bills/${stale.billId}/payments`, {
            requestId: randomUUID(),
            amount: '50',
            method: 'CASH',
          }).expect(201);
          instant = '2025-10-09T06:00:00+05:30';
          await app.get(BillRolloverService).run();
          await app.get(DailyWorkerService).run();
          assert.equal(
            (
              await admin.query('SELECT status FROM orders WHERE id=$1', [
                stale.id,
              ])
            ).rows[0].status,
            'CANCELLED',
          );
          assert.equal(
            (await admin.query('SELECT count(*)::int n FROM daily_reports'))
              .rows[0].n,
            1,
          );
          assert.equal(
            (await call('get', `/bills/${stale.billId}`).expect(200)).body
              .refundDue,
            '50.00',
          );
        },
      );
      await t.test(
        'runtime PostgreSQL statement and idle transaction timeouts are bounded',
        async () => {
          const db = app.get(DatabaseService);
          assert.equal(
            (await db.query('SHOW statement_timeout')).rows[0]
              .statement_timeout,
            '9s',
          );
          assert.equal(
            (await db.query('SHOW idle_in_transaction_session_timeout')).rows[0]
              .idle_in_transaction_session_timeout,
            '15s',
          );
          await assert.rejects(
            db.query('SELECT pg_sleep(12)'),
            (e) => e.code === '57014',
          );
          await db.check();
        },
      );
      await t.test(
        'compiled production bootstrap, graceful SIGTERM and failed startup do not accept unsafe traffic',
        async () => {
          const net = require('node:net'),
            { spawn } = require('node:child_process');
          const probe = net.createServer();
          await new Promise((r) => probe.listen(0, '127.0.0.1', r));
          const port = probe.address().port;
          await new Promise((r) => probe.close(r));
          async function boot(healthy) {
            const child = spawn(
              process.execPath,
              ['scripts/start-production.cjs'],
              {
                env: { ...process.env, PORT: String(port) },
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            );
            let output = '';
            child.stdout.on('data', (c) => {
              output += c;
            });
            child.stderr.on('data', (c) => {
              output += c;
            });
            const exited = new Promise((resolve) =>
              child.once('exit', (code, signal) => resolve({ code, signal })),
            );
            try {
              let listening = false;
              for (let i = 0; i < 100; i++) {
                try {
                  const r = await fetch(
                    `http://127.0.0.1:${port}/api/health/ready`,
                  );
                  if (r.ok) {
                    listening = true;
                    break;
                  }
                } catch {
                  /* not yet listening */
                }
                if (child.exitCode !== null) break;
                await new Promise((r) => setTimeout(r, 100));
              }
              assert.equal(listening, healthy);
              if (healthy) child.kill('SIGTERM');
              const result = await Promise.race([
                exited,
                new Promise((_, reject) => {
                  const timeout = setTimeout(
                    () => reject(new Error('Shutdown timeout')),
                    10000,
                  );
                  timeout.unref();
                }),
              ]);
              if (healthy) {
                assert.ok(output.includes('application_started'));
                assert.ok(output.includes('application_stopping'));
                assert.ok(!output.includes('shutdown_deadline'));
                assert.ok(result.code === 0 || result.signal === 'SIGTERM');
              } else {
                assert.equal(result.code, 1);
                assert.ok(output.includes('startup_failed'));
              }
              assert.ok(!output.includes(process.env.DATABASE_URL));
            } finally {
              if (child.exitCode === null && child.signalCode === null)
                child.kill('SIGKILL');
            }
          }
          await boot(true);
          const last = (
            await admin.query(
              "DELETE FROM schema_migrations WHERE name LIKE '019_%' RETURNING name,checksum",
            )
          ).rows[0];
          try {
            await boot(false);
          } finally {
            await admin.query(
              'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
              [last.name, last.checksum],
            );
          }
        },
      );
    } finally {
      if (app) await app.close();
      if (runtime) await runtime.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
      await fs.rm(root, { recursive: true, force: true });
      for (const key of Object.keys(process.env))
        if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  },
);
