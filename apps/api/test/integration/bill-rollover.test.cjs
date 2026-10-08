require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const { Client } = require('pg');
const { Test } = require('@nestjs/testing');
const request = require('supertest');
const { AppModule } = require('../../dist/app.module');
const { configureApp } = require('../../dist/configure-app');
const { UsersService } = require('../../dist/modules/users/users.service');
const { RestaurantClock } = require('../../dist/database/restaurant-clock');
const { DatabaseService } = require('../../dist/database/database.service');
const {
  BillRolloverService,
} = require('../../dist/modules/bills/bill-rollover.service');
test(
  'Bill session rollover: audit, balances, reminders, lifecycle, clock and concurrency',
  { timeout: 180000 },
  async (t) => {
    const original = process.env.DATABASE_URL,
      oldZone = process.env.RESTAURANT_TIMEZONE,
      oldTax = process.env.ORDER_TAX_RATE,
      oldCleanup = process.env.PREVIOUS_DAY_ORDER_CLEANUP_TIME;
    // These cases isolate midnight Bill closure, before the configured cleanup.
    process.env.PREVIOUS_DAY_ORDER_CLEANUP_TIME = '23:59';
    process.env.RESTAURANT_TIMEZONE = 'Asia/Kolkata';
    process.env.ORDER_TAX_RATE = '0';
    const admin = new Client({ connectionString: original });
    await admin.connect();
    const schema = 'rollover_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(original);
    url.searchParams.set(
      'options',
      `-csearch_path=${schema} -cTimeZone=America/Los_Angeles`,
    );
    process.env.DATABASE_URL = url.toString();
    const sql = new Client({ connectionString: url.toString() });
    await sql.connect();
    let app;
    try {
      for (const file of fs
        .readdirSync('database/migrations')
        .sort()
        .filter((f) => f.endsWith('.sql') && !f.startsWith('016_')))
        await sql.query(fs.readFileSync('database/migrations/' + file, 'utf8'));
      const module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = module.createNestApplication();
      configureApp(app);
      await app.init();
      const password = randomUUID() + '!';
      const owner = await app.get(UsersService).create({
        username: 'owner',
        name: 'Owner',
        password,
        roles: ['OWNER'],
      });
      const historic = randomUUID();
      await sql.query(
        "INSERT INTO bills(id,business_date,bill_number,service_type,status,opened_by,opened_at,closed_by,closed_at) VALUES($1,'2020-01-01',999,'DINE_IN','CLOSED',$2,'2020-01-01T00:00:00Z',$2,'2020-01-01T01:00:00Z')",
        [historic, owner.id],
      );
      const beforeMigration = (
        await sql.query('SELECT to_jsonb(b) AS row FROM bills b WHERE id=$1', [
          historic,
        ])
      ).rows[0].row;
      await sql.query(
        fs.readFileSync(
          'database/migrations/016_bill_session_rollover.sql',
          'utf8',
        ),
      );
      await t.test(
        'migration preserves prior closure identity and adds only manual reason metadata',
        async () => {
          const after = (
            await sql.query(
              'SELECT to_jsonb(b) AS row FROM bills b WHERE id=$1',
              [historic],
            )
          ).rows[0].row;
          assert.equal(after.closure_reason, 'MANUAL');
          assert.equal(after.closure_timezone, null);
          delete after.closure_reason;
          delete after.closure_timezone;
          assert.deepEqual(after, beforeMigration);
        },
      );
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
        realRead = clock.read.bind(clock);
      let instant = '2025-09-29T12:00:00Z';
      clock.read = (c) =>
        realRead({
          query: (text, values) =>
            c.query(text.replace('clock_timestamp()', '$2::timestamptz'), [
              ...values,
              instant,
            ]),
        });
      const rollover = app.get(BillRolloverService);
      const cat = (
        await call('post', '/menu/categories', {
          name: 'Rollover dishes',
        }).expect(201)
      ).body;
      const menu = {};
      for (const price of ['100', '120', '170', '500', '650'])
        menu[price] = (
          await call('post', '/menu/items', {
            categoryId: cat.id,
            name: 'Dish ' + price,
            variants: [
              {
                name: 'Full',
                channels: [{ channelCode: 'COUNTER', price, available: true }],
              },
            ],
          }).expect(201)
        ).body.variants[0].id;
      const create = async (price = '500', serviceType = 'DINE_IN') =>
        (
          await call('post', '/orders/counter', {
            requestId: randomUUID(),
            serviceType,
            lines: [{ variantId: menu[price], quantity: 1 }],
          }).expect(201)
        ).body;
      const pay = (o, amount, method = 'CASH') =>
        call('post', `/bills/${o.billId}/payments`, {
          requestId: randomUUID(),
          amount,
          method,
        }).expect(201);
      const get = async (o) =>
        (await call('get', `/bills/${o.billId}`).expect(200)).body;
      const change = async (o) => {
        const input = {
          requestId: randomUUID(),
          expectedRevision: 0,
          kind: 'CHANGE',
          reason: 'CUSTOMER_CHANGE',
          lines: [
            {
              id: o.items[0].id,
              variantId: menu['120'],
              quantity: 1,
              instruction: '',
            },
          ],
        };
        const q = (
          await call('post', `/orders/${o.id}/amendments/quote`, input).expect(
            201,
          )
        ).body;
        await call('post', `/orders/${o.id}/amendments`, {
          ...input,
          quoteHash: q.quoteHash,
        }).expect(201);
        return input;
      };
      const paid = await create();
      await pay(paid, '500');
      instant = '2025-09-29T12:00:01Z';
      const unpaid = await create();
      await pay(unpaid, '200');
      await call('post', `/bills/${unpaid.billId}/reminder`, {
        intervalMinutes: 5,
      }).expect(201);
      instant = '2025-09-29T12:00:02Z';
      const refund = await create('170');
      await pay(refund, '170', 'UPI');
      const amendment = await change(refund);
      instant = '2025-09-29T12:00:03Z';
      const takeaway = await create('100', 'TAKEAWAY');
      instant = '2025-09-29T12:00:04Z';
      const takeawayRefund = await create('170', 'TAKEAWAY');
      await pay(takeawayRefund, '170', 'UPI');
      await change(takeawayRefund);
      await call('post', `/kitchen/orders/${paid.id}/start`).expect(200);
      async function snapshot(tables) {
        const h = createHash('sha256');
        for (const table of tables)
          h.update(
            JSON.stringify(
              (
                await sql.query(
                  `SELECT to_jsonb(t)::text AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
                )
              ).rows,
            ),
          );
        return h.digest('hex');
      }
      const protectedTables = (
        await sql.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name NOT IN ('bills','bill_reminders') ORDER BY table_name",
        )
      ).rows.map((r) => r.table_name);
      let originalDomain, originalBalances, originalReminder, closureStamp;
      await t.test(
        'restaurant midnight, not database/browser timezone, determines historical eligibility',
        async () => {
          instant = '2025-09-29T18:29:59.999Z';
          assert.equal(await rollover.run(), 0);
          originalDomain = await snapshot(protectedTables);
          originalBalances = (
            await sql.query('SELECT * FROM bill_balances ORDER BY id')
          ).rows;
          originalReminder = (
            await sql.query('SELECT * FROM bill_reminders WHERE bill_id=$1', [
              unpaid.billId,
            ])
          ).rows[0];
          instant = '2025-09-29T18:30:00.000Z';
          assert.equal(await rollover.run(), 5);
          closureStamp = instant;
          for (const o of [paid, unpaid, refund, takeaway, takeawayRefund]) {
            const b = await get(o);
            assert.equal(b.status, 'CLOSED');
            assert.equal(b.closureReason, 'BUSINESS_DAY_ROLLOVER');
            assert.equal(b.closedAt, closureStamp);
            assert.equal(b.canChangeFood, false);
          }
        },
      );
      await t.test(
        'closure changes no money, food, actors, timers or order/dispatch history',
        async () => {
          assert.equal(await snapshot(protectedTables), originalDomain);
          assert.deepEqual(
            (await sql.query('SELECT * FROM bill_balances ORDER BY id')).rows,
            originalBalances,
          );
          assert.equal((await get(unpaid)).amountDue, '300.00');
          assert.equal((await get(refund)).refundDue, '50.00');
          const audit = (
            await sql.query(
              'SELECT closed_by,closure_timezone FROM bills WHERE id=$1',
              [unpaid.billId],
            )
          ).rows[0];
          assert.equal(audit.closed_by, null);
          assert.equal(audit.closure_timezone, 'Asia/Kolkata');
        },
      );
      await t.test(
        'reminder pauses for rollover, not fictitious payment; repeat checks are idempotent',
        async () => {
          const r = (
            await sql.query('SELECT * FROM bill_reminders WHERE bill_id=$1', [
              unpaid.billId,
            ])
          ).rows[0];
          assert.equal(r.next_due_at, null);
          assert.equal(r.pause_reason, 'BUSINESS_DAY_ROLLOVER');
          assert.equal(r.updated_by, originalReminder.updated_by);
          assert.equal(r.version, originalReminder.version + 1);
          assert.equal(
            (await call('get', '/reminders/active').expect(200)).body.entries
              .length,
            0,
          );
          const before = await snapshot(['bills', 'bill_reminders']);
          assert.deepEqual(
            await Promise.all([rollover.run(), rollover.run()]),
            [0, 0],
          );
          assert.equal(await snapshot(['bills', 'bill_reminders']), before);
          await call('post', `/bills/${unpaid.billId}/reminder`, {
            intervalMinutes: 5,
          }).expect(409);
        },
      );
      await t.test(
        'historical closed tabs retain settlement/refunds and refuse food/reopening/audit rewriting',
        async () => {
          await call('post', '/orders/counter', {
            requestId: randomUUID(),
            billId: unpaid.billId,
            lines: [{ variantId: menu['100'], quantity: 1 }],
          }).expect(409);
          await call('post', `/orders/${refund.id}/amendments/quote`, {
            ...amendment,
            requestId: randomUUID(),
            expectedRevision: 1,
          }).expect(409);
          await assert.rejects(
            sql.query("UPDATE bills SET status='OPEN' WHERE id=$1", [
              unpaid.billId,
            ]),
            /BILL_IMMUTABLE/,
          );
          await assert.rejects(
            sql.query(
              "UPDATE bills SET closed_at=closed_at+interval '1 minute' WHERE id=$1",
              [unpaid.billId],
            ),
            /BILL_IMMUTABLE/,
          );
          await pay(unpaid, '300', 'UPI');
          await call('post', `/bills/${refund.billId}/refunds`, {
            requestId: randomUUID(),
            amount: '50',
          }).expect(201);
          assert.equal((await get(unpaid)).amountDue, '0.00');
          assert.equal((await get(refund)).refundDue, '0.00');
          assert.equal((await get(unpaid)).closedAt, closureStamp);
          assert.equal(
            (
              await sql.query(
                'SELECT pause_reason FROM bill_reminders WHERE bill_id=$1',
                [unpaid.billId],
              )
            ).rows[0].pause_reason,
            'BUSINESS_DAY_ROLLOVER',
          );
        },
      );
      await t.test(
        'existing Kitchen rounds finish; Takeaway due AND refund entitlement still block handover',
        async () => {
          for (const o of [paid, unpaid, refund, takeaway, takeawayRefund]) {
            if (o !== paid)
              await call('post', `/kitchen/orders/${o.id}/start`).expect(200);
            await call('post', `/kitchen/orders/${o.id}/ready`).expect(200);
            if (o === takeaway) {
              await call('post', `/dispatch/orders/${o.id}/complete`).expect(
                409,
              );
              await pay(o, '100');
            }
            if (o === takeawayRefund) {
              await call('post', `/dispatch/orders/${o.id}/complete`).expect(
                409,
              );
              await call('post', `/bills/${o.billId}/refunds`, {
                requestId: randomUUID(),
                amount: '50',
              }).expect(201);
            }
            await call('post', `/dispatch/orders/${o.id}/complete`).expect(200);
          }
        },
      );
      await t.test(
        'same-day manual closure remains strict, audited and idempotent',
        async () => {
          const o = await create('100');
          await call('post', `/bills/${o.billId}/close`).expect(409);
          await pay(o, '100');
          await call('post', `/bills/${o.billId}/close`).expect(409);
          for (const action of ['start', 'ready'])
            await call('post', `/kitchen/orders/${o.id}/${action}`).expect(200);
          await call('post', `/dispatch/orders/${o.id}/complete`).expect(200);
          const closed = (
            await call('post', `/bills/${o.billId}/close`).expect(201)
          ).body;
          assert.equal(closed.closureReason, 'MANUAL');
          assert.equal(closed.status, 'CLOSED');
          assert.equal(
            (await call('post', `/bills/${o.billId}/close`).expect(201)).body
              .closedAt,
            closed.closedAt,
          );
          await call('post', `/bills/${o.billId}/payments`, {
            requestId: randomUUID(),
            method: 'CASH',
            amount: '1',
          }).expect(409);
        },
      );
      await t.test(
        'startup catch-up records processing time and periodic check runs without requests',
        async () => {
          instant = '2025-09-30T12:00:00Z';
          const o = await create('100');
          instant = '2025-10-01T03:30:00Z';
          const worker = new BillRolloverService(
            app.get(DatabaseService),
            clock,
          );
          let tick;
          const interval = globalThis.setInterval;
          globalThis.setInterval = (fn, ms) => {
            assert.equal(ms, 60000);
            tick = fn;
            return { unref() {} };
          };
          try {
            await worker.start();
          } finally {
            globalThis.setInterval = interval;
          }
          assert.equal((await get(o)).closedAt, '2025-10-01T03:30:00.000Z');
          const next = await create('100');
          instant = '2025-10-02T03:30:00Z';
          tick();
          await worker.run();
          assert.equal((await get(next)).status, 'CLOSED');
          await worker.onModuleDestroy();
        },
      );
      await t.test(
        'concurrent settlement and independent rollover workers serialize without lost money',
        async () => {
          const o = await create('500');
          instant = '2025-10-03T03:30:00Z';
          const other = new BillRolloverService(
            app.get(DatabaseService),
            clock,
          );
          await Promise.all([rollover.run(), other.run(), pay(o, '200')]);
          assert.equal((await get(o)).status, 'CLOSED');
          assert.equal((await get(o)).amountDue, '300.00');
          assert.equal(
            (
              await sql.query(
                'SELECT count(*)::int AS n FROM payments WHERE bill_id=$1',
                [o.billId],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'clock is read after lock wait; same-day system closures are rejected by database',
        async () => {
          const o = await create('100');
          await sql.query('BEGIN');
          await sql.query('SELECT pg_advisory_xact_lock(742019323)');
          const pending = rollover.run();
          instant = '2025-10-04T00:00:00Z';
          await sql.query('COMMIT');
          await pending;
          assert.equal((await get(o)).closedAt, instant.replace('Z', '.000Z'));
          const today = await create('100');
          await assert.rejects(
            sql.query(
              "UPDATE bills SET status='CLOSED',closed_at=$2,closure_reason='BUSINESS_DAY_ROLLOVER',closure_timezone='Asia/Kolkata' WHERE id=$1",
              [today.billId, instant],
            ),
            /bill_session_closure/,
          );
          await assert.rejects(
            sql.query(
              "UPDATE bills SET status='CLOSED',closed_at=$2,closed_by=$3,closure_reason='MANUAL' WHERE id=$1",
              [today.billId, instant, owner.id],
            ),
            /BILL_NOT_SETTLED/,
          );
        },
      );
      await t.test(
        'failed rollover rolls back every session and reminder, then retries cleanly',
        async () => {
          const o = await create('500');
          await call('post', `/bills/${o.billId}/reminder`, {
            intervalMinutes: 5,
          }).expect(201);
          instant = '2025-10-05T03:30:00Z';
          const before = await snapshot([
            'bills',
            'bill_reminders',
            'payments',
          ]);
          await sql.query(`CREATE FUNCTION fail_rollover_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ROLLOVER_FIXTURE_FAILURE'; END $$;
          CREATE TRIGGER fail_rollover_fixture AFTER UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION fail_rollover_fixture()`);
          await assert.rejects(rollover.run(), /ROLLOVER_FIXTURE_FAILURE/);
          assert.equal(
            await snapshot(['bills', 'bill_reminders', 'payments']),
            before,
          );
          await sql.query(
            'DROP TRIGGER fail_rollover_fixture ON bills; DROP FUNCTION fail_rollover_fixture()',
          );
          assert.ok((await rollover.run()) > 0);
          assert.equal((await get(o)).status, 'CLOSED');
          assert.equal((await get(o)).amountDue, '500.00');
          assert.equal(await rollover.run(), 0);
        },
      );
    } finally {
      if (app) await app.close();
      await sql.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      process.env.DATABASE_URL = original;
      if (oldCleanup === undefined)
        delete process.env.PREVIOUS_DAY_ORDER_CLEANUP_TIME;
      else process.env.PREVIOUS_DAY_ORDER_CLEANUP_TIME = oldCleanup;
      if (oldZone === undefined) delete process.env.RESTAURANT_TIMEZONE;
      else process.env.RESTAURANT_TIMEZONE = oldZone;
      if (oldTax === undefined) delete process.env.ORDER_TAX_RATE;
      else process.env.ORDER_TAX_RATE = oldTax;
    }
  },
);
