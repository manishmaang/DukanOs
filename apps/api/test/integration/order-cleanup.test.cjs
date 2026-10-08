require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { Client } = require('pg');
const { Test } = require('@nestjs/testing');
const request = require('supertest');
const { AppModule } = require('../../dist/app.module');
const { configureApp } = require('../../dist/configure-app');
const { UsersService } = require('../../dist/modules/users/users.service');
const { RestaurantClock } = require('../../dist/database/restaurant-clock');
const {
  BillRolloverService,
} = require('../../dist/modules/bills/bill-rollover.service');
const { DatabaseService } = require('../../dist/database/database.service');
const {
  previousDayCleanupTime,
} = require('../../dist/modules/orders/cleanup-configuration');
const reason = 'PREVIOUS_BUSINESS_DAY_AUTO_CANCEL';

test(
  'Previous-day cleanup: financial revisions, cutoff, restart and serialized operations',
  { timeout: 180000 },
  async (t) => {
    const env = {
      url: process.env.DATABASE_URL,
      zone: process.env.RESTAURANT_TIMEZONE,
      time: process.env.PREVIOUS_DAY_ORDER_CLEANUP_TIME,
      tax: process.env.ORDER_TAX_RATE,
    };
    const admin = new Client({ connectionString: env.url });
    await admin.connect();
    const schema = 'cleanup_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(env.url);
    url.searchParams.set(
      'options',
      `-csearch_path=${schema} -cTimeZone=America/Los_Angeles`,
    );
    process.env.DATABASE_URL = url.toString();
    process.env.RESTAURANT_TIMEZONE = 'Asia/Kolkata';
    process.env.PREVIOUS_DAY_ORDER_CLEANUP_TIME = '05:00';
    process.env.ORDER_TAX_RATE = '0';
    const sql = new Client({ connectionString: url.toString() });
    await sql.connect();
    let app;
    try {
      for (const f of fs
        .readdirSync('database/migrations')
        .sort()
        .filter((f) => f.endsWith('.sql') && !f.startsWith('019_')))
        await sql.query(fs.readFileSync('database/migrations/' + f, 'utf8'));
      const module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = module.createNestApplication();
      configureApp(app);
      await app.init();
      const password = randomUUID() + '!';
      await app.get(UsersService).create({
        username: 'owner',
        name: 'Owner',
        password,
        roles: ['OWNER'],
      });
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('X-DukanOS-Request', '1')
        .send({ username: 'owner', password })
        .expect(200);
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      const call = (method, path, body) => {
        const agent = request(app.getHttpServer());
        const r = agent[method]('/api' + path)
          .set('Cookie', cookie)
          .set('X-DukanOS-Request', '1');
        return body === undefined ? r : r.send(body);
      };
      const clock = app.get(RestaurantClock),
        real = clock.read.bind(clock);
      let instant = '2025-10-08T06:00:00Z';
      clock.read = (c) =>
        real({
          query: (q, v) =>
            c.query(q.replace('clock_timestamp()', '$2::timestamptz'), [
              ...v,
              instant,
            ]),
        });
      const worker = app.get(BillRolloverService);
      const cat = (
        await call('post', '/menu/categories', { name: 'Cleanup' }).expect(201)
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
      const variant = item.variants[0].id;
      async function create(quantity = 1, billId) {
        return (
          await call('post', '/orders/counter', {
            requestId: randomUUID(),
            ...(billId ? { billId } : { serviceType: 'DINE_IN' }),
            lines: [{ variantId: variant, quantity }],
          }).expect(201)
        ).body;
      }
      const get = async (o) =>
        (await call('get', '/bills/' + o.billId).expect(200)).body;
      const pay = (o, amount, method = 'CASH') =>
        call('post', `/bills/${o.billId}/payments`, {
          requestId: randomUUID(),
          amount,
          method,
        });
      const refund = (o, amount) =>
        call('post', `/bills/${o.billId}/refunds`, {
          requestId: randomUUID(),
          amount,
        });
      const action = (o, a) =>
        call(
          'post',
          a === 'complete'
            ? `/dispatch/orders/${o.id}/complete`
            : `/kitchen/orders/${o.id}/${a}`,
        );
      const status = async (o) =>
        (await sql.query('SELECT status FROM orders WHERE id=$1', [o.id]))
          .rows[0].status;
      async function amend(o, quantity, kind = 'CHANGE') {
        const input = {
          requestId: randomUUID(),
          expectedRevision: 0,
          kind,
          reason: 'CUSTOMER_CHANGE',
          lines:
            kind === 'CANCEL'
              ? []
              : [
                  {
                    id: o.items[0].id,
                    variantId: variant,
                    quantity,
                    instruction: '',
                  },
                ],
        };
        const q = (
          await call('post', `/orders/${o.id}/amendments/quote`, input).expect(
            201,
          )
        ).body;
        return call('post', `/orders/${o.id}/amendments`, {
          ...input,
          quoteHash: q.quoteHash,
        }).expect(201);
      }
      const completed = await create(2);
      await action(completed, 'start').expect(200);
      await action(completed, 'ready').expect(200);
      await action(completed, 'complete').expect(200);
      const preparing = await create(1, completed.billId);
      await action(preparing, 'start').expect(200);
      await pay(completed, '300').expect(201);
      const ready = await create(3);
      await action(ready, 'start').expect(200);
      await action(ready, 'ready').expect(200);
      await pay(ready, '300', 'UPI').expect(201);
      const cancelled = await create();
      await amend(cancelled, 0, 'CANCEL');
      const unpaid = await create(3),
        partial = await create(3),
        split = await create(3),
        amended = await create(3);
      await pay(partial, '120').expect(201);
      await pay(split, '100').expect(201);
      await pay(split, '200', 'UPI').expect(201);
      await pay(amended, '300').expect(201);
      await amend(amended, 2);
      await refund(amended, '40').expect(201);
      await call('post', `/bills/${partial.billId}/reminder`, {
        intervalMinutes: 5,
      }).expect(201);
      const timer = (
        await call('post', '/kitchen/timers', {
          requestId: randomUUID(),
          label: 'Meal',
          durationSeconds: 120,
          orderId: preparing.id,
        }).expect(201)
      ).body;
      const standalone = (
        await call('post', '/kitchen/timers', {
          requestId: randomUUID(),
          label: 'Standalone',
          durationSeconds: 120,
        }).expect(201)
      ).body;
      instant = '2025-10-06T06:00:00Z';
      const older = await create();
      instant = '2025-10-09T06:00:00Z';
      const current = await create();
      const originalItems = (
        await sql.query('SELECT * FROM order_items ORDER BY id')
      ).rows;
      const originalPayments = (
        await sql.query('SELECT * FROM payments ORDER BY id')
      ).rows;
      await t.test(
        'migration preserves populated orders, revisions, users, money and timer audit',
        async () => {
          const tables = [
            'users',
            'user_roles',
            'user_audit',
            'menu_items',
            'menu_audit',
            'orders',
            'order_items',
            'order_status_history',
            'order_amendments',
            'order_item_revisions',
            'bills',
            'payments',
            'bill_reminders',
            'kitchen_timers',
          ];
          const capture = async () => {
            const result = {};
            for (const table of tables)
              result[table] = (
                await sql.query(
                  `SELECT (to_jsonb(t)-ARRAY['cleanup_timezone','cleanup_time','resolution_reason']) AS record FROM "${table}" t ORDER BY (to_jsonb(t)-ARRAY['cleanup_timezone','cleanup_time','resolution_reason'])::text`,
                )
              ).rows;
            return result;
          };
          const before = await capture();
          await sql.query(
            fs.readFileSync(
              'database/migrations/019_previous_day_order_cleanup.sql',
              'utf8',
            ),
          );
          assert.deepEqual(await capture(), before);
        },
      );
      await t.test(
        'strict cleanup configuration accepts bounds and rejects malformed values',
        () => {
          assert.equal(previousDayCleanupTime({}), '05:00');
          for (const v of ['00:00', '05:00', '23:59'])
            assert.equal(
              previousDayCleanupTime({ PREVIOUS_DAY_ORDER_CLEANUP_TIME: v }),
              v,
            );
          for (const v of [
            '',
            '5am',
            '5:00',
            '25:00',
            '05:99',
            'abc',
            '05:00 ',
          ])
            assert.throws(() =>
              previousDayCleanupTime({ PREVIOUS_DAY_ORDER_CLEANUP_TIME: v }),
            );
        },
      );
      await t.test(
        'startup at 04:59 closes tabs but leaves yesterday and older work untouched',
        async () => {
          instant = '2025-10-08T23:29:00Z';
          await worker.start();
          for (const o of [unpaid, older])
            assert.equal(await status(o), 'QUEUED');
          assert.equal(await status(preparing), 'PREPARING');
          assert.equal(await status(ready), 'READY');
          assert.equal(
            (await get(unpaid)).closureReason,
            'BUSINESS_DAY_ROLLOVER',
          );
          await worker.onModuleDestroy();
        },
      );
      let snapshot;
      await t.test(
        'pre-cleanup Daily Report is generated as an immutable v1',
        async () => {
          snapshot = (
            await call('post', '/daily-reports', {
              requestId: randomUUID(),
              businessDate: '2025-10-08',
            }).expect(201)
          ).body;
          assert.ok(snapshot.id);
        },
      );
      await t.test(
        'exact 05:00 startup cancels previous-day QUEUED/PREPARING/READY and older work',
        async () => {
          instant = '2025-10-08T23:30:00Z';
          await worker.start();
          for (const o of [
            unpaid,
            partial,
            split,
            amended,
            older,
            preparing,
            ready,
          ])
            assert.equal(await status(o), 'CANCELLED');
          await worker.onModuleDestroy();
        },
      );
      await t.test(
        'current date and both terminal states remain unchanged',
        async () => {
          assert.equal(await status(current), 'QUEUED');
          assert.equal(await status(completed), 'COMPLETED');
          assert.equal(await status(cancelled), 'CANCELLED');
        },
      );
      await t.test(
        'unpaid cancellation has zero total/due and creates no payment',
        async () => {
          const b = await get(unpaid);
          assert.equal(b.billTotal, '0.00');
          assert.equal(b.amountDue, '0.00');
          assert.equal(b.refundDue, '0.00');
        },
      );
      await t.test(
        'full UPI payment remains and becomes cash refund entitlement',
        async () => {
          const b = await get(ready);
          assert.equal(b.refundDue, '300.00');
          assert.equal(b.amountDue, '0.00');
        },
      );
      await t.test(
        'partial and split payment cancellations retain their actual collection amounts',
        async () => {
          assert.equal((await get(partial)).refundDue, '120.00');
          assert.equal((await get(split)).refundDue, '300.00');
        },
      );
      await t.test(
        'mixed completed/unfinished rounds retain only completed food total',
        async () => {
          const b = await get(completed);
          assert.equal(b.billTotal, '200.00');
          assert.equal(b.refundDue, '100.00');
        },
      );
      await t.test(
        'previous amendment/refund audit persists and latest cancellation reconciles remaining net paid',
        async () => {
          assert.equal((await get(amended)).refundDue, '260.00');
          const h = (
            await call('get', `/orders/${amended.id}/amendments`).expect(200)
          ).body;
          assert.equal(h.length, 2);
          assert.equal(h[1].reason, reason);
          assert.equal(h[1].performedBy, null);
          assert.equal(h[1].actorName, 'System');
          assert.equal(h[1].beforeTotal, '200.00');
          assert.deepEqual(h[1].items, []);
        },
      );
      await t.test(
        'original item snapshots and complete payment/refund rows remain byte-for-byte unchanged',
        async () => {
          assert.deepEqual(
            (await sql.query('SELECT * FROM order_items ORDER BY id')).rows,
            originalItems,
          );
          assert.deepEqual(
            (await sql.query('SELECT * FROM payments ORDER BY id')).rows,
            originalPayments,
          );
        },
      );
      await t.test(
        'system history has null human actor, reason and preserved token identity',
        async () => {
          const h = (
            await sql.query(
              "SELECT * FROM order_status_history WHERE order_id=$1 AND to_status='CANCELLED'",
              [preparing.id],
            )
          ).rows[0];
          assert.equal(h.actor_id, null);
          assert.equal(h.reason, reason);
          assert.equal(h.from_status, 'PREPARING');
          assert.equal(
            (
              await sql.query('SELECT token_number FROM orders WHERE id=$1', [
                preparing.id,
              ])
            ).rows[0].token_number,
            preparing.tokenNumber,
          );
        },
      );
      await t.test(
        'linked timers cancel with a system reason; independent timer is retained',
        async () => {
          const row = (
            await sql.query('SELECT * FROM kitchen_timers WHERE id=$1', [
              timer.id,
            ])
          ).rows[0];
          assert.equal(row.status, 'CANCELLED');
          assert.equal(row.resolved_by, null);
          assert.equal(row.resolution_reason, reason);
          const entries = (await call('get', '/kitchen/timers').expect(200))
            .body.entries;
          assert.ok(entries.some((x) => x.id === standalone.id));
          assert.ok(!entries.some((x) => x.id === timer.id));
        },
      );
      await t.test(
        'Kitchen/production/FIFO and Dispatch exclude cancelled work',
        async () => {
          const k = (await call('get', '/kitchen/orders').expect(200)).body;
          const d = (await call('get', '/dispatch/orders').expect(200)).body;
          assert.ok(!JSON.stringify(k).includes(unpaid.id));
          assert.ok(!JSON.stringify(k).includes(preparing.id));
          assert.ok(!JSON.stringify(d).includes(ready.id));
          for (const [o, a] of [
            [unpaid, 'start'],
            [preparing, 'ready'],
            [ready, 'complete'],
          ])
            await action(o, a).expect(409);
        },
      );
      await t.test(
        'repeat/concurrent maintenance is idempotent after closed-tab cleanup',
        async () => {
          const before = (
            await sql.query('SELECT count(*)::int n FROM order_amendments')
          ).rows[0].n;
          const other = new BillRolloverService(
            app.get(DatabaseService),
            clock,
          );
          await Promise.all([worker.run(), worker.run(), other.run()]);
          assert.equal(
            (await sql.query('SELECT count(*)::int n FROM order_amendments'))
              .rows[0].n,
            before,
          );
        },
      );
      await t.test(
        'live historical sales change while v1 stays fixed; regeneration makes v2',
        async () => {
          const before = (
            await call('get', '/daily-reports/' + snapshot.id).expect(200)
          ).body;
          const regenerated = (
            await call('post', `/daily-reports/${snapshot.id}/regenerate`, {
              requestId: randomUUID(),
              reason: 'Review after automatic cleanup',
            }).expect(201)
          ).body;
          const after = (
            await call('get', '/daily-reports/' + snapshot.id).expect(200)
          ).body;
          assert.deepEqual(after.snapshot, before.snapshot);
          assert.equal(regenerated.version, 2);
          assert.equal(regenerated.snapshot.foodSold, '200.00');
          assert.notEqual(
            before.snapshot.foodSold,
            regenerated.snapshot.foodSold,
          );
          const sales = (
            await call(
              'get',
              '/reports/sales?from=2025-10-08&to=2025-10-08',
            ).expect(200)
          ).body;
          assert.equal(sales.summary.salesValue, '200.00');
          const items = (
            await call(
              'get',
              '/reports/items?from=2025-10-08&to=2025-10-08',
            ).expect(200)
          ).body;
          assert.equal(items.totalQuantity, '2');
          assert.equal(items.totalSalesValue, '200.00');
          const operations = (
            await call(
              'get',
              '/reports/operations?from=2025-10-08&to=2025-10-08',
            ).expect(200)
          ).body;
          assert.equal(
            operations.statuses.find((x) => x.status === 'COMPLETED').count,
            1,
          );
          assert.equal(
            operations.statuses.find((x) => x.status === 'CANCELLED').count,
            7,
          );
        },
      );
      await t.test(
        'authorized cash refund remains possible on rollover-closed cancelled bill',
        async () => {
          await refund(ready, '300').expect(201);
          assert.equal((await get(ready)).refundDue, '0.00');
          await refund(ready, '1').expect(409);
        },
      );
      await t.test(
        'same-day POS Kitchen Dispatch workflow remains valid',
        async () => {
          await action(current, 'start').expect(200);
          await action(current, 'ready').expect(200);
          await action(current, 'complete').expect(200);
          assert.equal(await status(current), 'COMPLETED');
        },
      );
      await t.test(
        'manual APIs cannot submit system reason or cancel preparation-started work',
        async () => {
          instant = '2025-10-09T06:00:00Z';
          const o = await create();
          await action(o, 'start').expect(200);
          await call('post', `/orders/${o.id}/amendments/quote`, {
            requestId: randomUUID(),
            expectedRevision: 0,
            kind: 'CANCEL',
            reason,
            lines: [],
          }).expect(400);
          await call('post', `/orders/${o.id}/amendments/quote`, {
            requestId: randomUUID(),
            expectedRevision: 0,
            kind: 'CANCEL',
            reason: 'CUSTOMER_CHANGE',
            lines: [],
          }).expect(409);
        },
      );
      for (const a of ['start', 'ready', 'complete'])
        await t.test(
          `cleanup racing Kitchen/Dispatch ${a} serializes without revival`,
          async () => {
            instant = '2025-10-08T06:00:00Z';
            const o = await create();
            if (a !== 'start') await action(o, 'start').expect(200);
            if (a === 'complete') await action(o, 'ready').expect(200);
            instant = '2025-10-08T23:30:00Z';
            const [, r] = await Promise.all([worker.run(), action(o, a)]);
            assert.ok([200, 409].includes(r.status));
            const st = await status(o);
            assert.equal(
              st,
              a === 'complete' && r.status === 200 ? 'COMPLETED' : 'CANCELLED',
            );
            await worker.run();
            assert.equal(await status(o), st);
          },
        );
      await t.test(
        'cleanup racing collection either records one receipt with refund due or rejects collection',
        async () => {
          instant = '2025-10-08T06:00:00Z';
          const o = await create();
          instant = '2025-10-08T23:30:00Z';
          const [, r] = await Promise.all([worker.run(), pay(o, '100')]);
          assert.ok([201, 409].includes(r.status));
          assert.equal(
            (await get(o)).refundDue,
            r.status === 201 ? '100.00' : '0.00',
          );
        },
      );
      await t.test(
        'cleanup racing cash refund preserves bounded entitlement and ledger',
        async () => {
          instant = '2025-10-08T06:00:00Z';
          const o = await create(3);
          await pay(o, '300').expect(201);
          await amend(o, 2);
          instant = '2025-10-08T23:30:00Z';
          await Promise.all([worker.run(), refund(o, '100').expect(201)]);
          assert.equal((await get(o)).refundDue, '200.00');
        },
      );
      await t.test(
        'cleanup racing stale manual amendment never rewrites or adds a second cancellation',
        async () => {
          instant = '2025-10-08T06:00:00Z';
          const o = await create();
          const input = {
            requestId: randomUUID(),
            expectedRevision: 0,
            kind: 'CANCEL',
            reason: 'CUSTOMER_CHANGE',
            lines: [],
          };
          const q = (
            await call(
              'post',
              `/orders/${o.id}/amendments/quote`,
              input,
            ).expect(201)
          ).body;
          instant = '2025-10-08T23:30:00Z';
          await Promise.all([
            worker.run(),
            call('post', `/orders/${o.id}/amendments`, {
              ...input,
              quoteHash: q.quoteHash,
            }).expect(409),
          ]);
          assert.equal(
            (
              await sql.query(
                'SELECT count(*)::int n FROM order_amendments WHERE order_id=$1',
                [o.id],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'multi-day downtime startup and periodic catch-up preserve current day',
        async () => {
          instant = '2025-10-09T06:00:00Z';
          const a = await create();
          instant = '2025-10-10T06:00:00Z';
          const b = await create();
          instant = '2025-10-11T06:00:00Z';
          const c = await create();
          await worker.start();
          assert.equal(await status(a), 'CANCELLED');
          assert.equal(await status(b), 'CANCELLED');
          assert.equal(await status(c), 'QUEUED');
          await worker.onModuleDestroy();
        },
      );
      await t.test(
        'database rejects rewriting system audit and standalone system timer cancellation',
        async () => {
          await assert.rejects(
            sql.query('UPDATE order_amendments SET note=$1 WHERE order_id=$2', [
              'x',
              unpaid.id,
            ]),
            /AMENDMENT_IMMUTABLE/,
          );
          await assert.rejects(
            sql.query(
              "UPDATE kitchen_timers SET status='CANCELLED',resolved_at=clock_timestamp(),resolution_reason=$2 WHERE id=$1",
              [standalone.id, reason],
            ),
            /INVALID_SYSTEM_TIMER_RESOLUTION/,
          );
        },
      );
      await t.test(
        'a cleanup failure rolls back Bill closure, revision, history and timer resolution',
        async () => {
          instant = '2025-10-12T06:00:00Z';
          const o = await create();
          const timer = (
            await call('post', '/kitchen/timers', {
              requestId: randomUUID(),
              label: 'Rollback',
              durationSeconds: 120,
              orderId: o.id,
            }).expect(201)
          ).body;
          await sql.query(
            `CREATE FUNCTION fail_cleanup_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resolution_reason='${reason}' THEN RAISE EXCEPTION 'CLEANUP_FIXTURE_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_cleanup_fixture BEFORE UPDATE ON kitchen_timers FOR EACH ROW EXECUTE FUNCTION fail_cleanup_fixture()`,
          );
          instant = '2025-10-12T23:30:00Z';
          await assert.rejects(worker.run(), /CLEANUP_FIXTURE_FAILURE/);
          assert.equal((await get(o)).status, 'OPEN');
          assert.equal(await status(o), 'QUEUED');
          assert.equal(
            (
              await sql.query(
                'SELECT count(*)::int n FROM order_amendments WHERE order_id=$1',
                [o.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await sql.query('SELECT status FROM kitchen_timers WHERE id=$1', [
                timer.id,
              ])
            ).rows[0].status,
            'ACTIVE',
          );
          await sql.query(
            'DROP TRIGGER fail_cleanup_fixture ON kitchen_timers; DROP FUNCTION fail_cleanup_fixture()',
          );
          await worker.run();
          assert.equal(await status(o), 'CANCELLED');
        },
      );
      await t.test(
        'configured non-default timezone and cutoff drive periodic maintenance without a browser',
        async () => {
          instant = '2025-10-14T06:00:00Z';
          const o = await create();
          process.env.RESTAURANT_TIMEZONE = 'America/New_York';
          process.env.PREVIOUS_DAY_ORDER_CLEANUP_TIME = '06:15';
          const otherClock = new RestaurantClock();
          const read = otherClock.read.bind(otherClock);
          otherClock.read = (c) =>
            read({
              query: (q, v) =>
                c.query(q.replace('clock_timestamp()', '$2::timestamptz'), [
                  ...v,
                  instant,
                ]),
            });
          const other = new BillRolloverService(
            app.get(DatabaseService),
            otherClock,
          );
          let tick;
          const interval = globalThis.setInterval;
          instant = '2025-10-15T10:14:00Z';
          globalThis.setInterval = (fn, ms) => {
            assert.equal(ms, 60000);
            tick = fn;
            return { unref() {} };
          };
          try {
            await other.start();
          } finally {
            globalThis.setInterval = interval;
          }
          try {
            assert.equal(await status(o), 'QUEUED');
            instant = '2025-10-15T10:15:00Z';
            tick();
            await other.run();
            assert.equal(await status(o), 'CANCELLED');
            const a = (
              await sql.query(
                'SELECT cleanup_timezone,cleanup_time FROM order_amendments WHERE order_id=$1',
                [o.id],
              )
            ).rows[0];
            assert.deepEqual(a, {
              cleanup_timezone: 'America/New_York',
              cleanup_time: '06:15',
            });
          } finally {
            await other.onModuleDestroy();
            process.env.RESTAURANT_TIMEZONE = 'Asia/Kolkata';
            process.env.PREVIOUS_DAY_ORDER_CLEANUP_TIME = '05:00';
          }
        },
      );
    } finally {
      if (app) await app.close();
      await sql.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      for (const [k, v] of Object.entries({
        DATABASE_URL: env.url,
        RESTAURANT_TIMEZONE: env.zone,
        PREVIOUS_DAY_ORDER_CLEANUP_TIME: env.time,
        ORDER_TAX_RATE: env.tax,
      })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  },
);
