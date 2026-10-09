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
test(
  'Manual platform orders preserve financial isolation and shared operations',
  { timeout: 120000 },
  async (t) => {
    const old = process.env.DATABASE_URL;
    const admin = new Client({ connectionString: old });
    await admin.connect();
    const schema = 'platform_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(old);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    const sql = new Client({ connectionString: url.toString() });
    await sql.connect();
    let app;
    try {
      for (const f of fs
        .readdirSync('database/migrations')
        .filter((f) => f.endsWith('.sql') && f < '020')
        .sort())
        await sql.query(fs.readFileSync('database/migrations/' + f, 'utf8'));
      const module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = module.createNestApplication();
      configureApp(app);
      await app.init();
      const users = app.get(UsersService);
      const password = randomUUID();
      const owner = await users.create({
        username: 'owner',
        name: 'Owner',
        password,
        roles: ['OWNER'],
      });
      for (const role of ['MANAGER', 'CASHIER', 'KITCHEN', 'DISPATCH'])
        await users.create(
          { username: role.toLowerCase(), name: role, password, roles: [role] },
          owner,
        );
      const cookies = {};
      for (const name of [
        'owner',
        'manager',
        'cashier',
        'kitchen',
        'dispatch',
      ]) {
        const r = await request(app.getHttpServer())
          .post('/api/auth/login')
          .set('X-DukanOS-Request', '1')
          .send({ username: name, password })
          .expect(200);
        cookies[name] = r.headers['set-cookie'][0].split(';')[0];
      }
      const call = (who, method, path, body) => {
        const agent = request(app.getHttpServer());
        let r = agent[method]('/api' + path)
          .set('Cookie', cookies[who] ?? '')
          .set('X-DukanOS-Request', '1');
        return body === undefined ? r : r.send(body);
      };
      const cat = (
        await call('owner', 'post', '/menu/categories', {
          name: 'Platform food',
        }).expect(201)
      ).body;
      await t.test(
        '020 preserves populated Counter food, payments, users, menu and audit records',
        async () => {
          const dish = (
            await call('owner', 'post', '/menu/items', {
              categoryId: cat.id,
              name: 'Preserved Counter meal',
              variants: [
                {
                  name: 'Full',
                  channels: [
                    { channelCode: 'COUNTER', price: '50', available: true },
                  ],
                },
              ],
            }).expect(201)
          ).body;
          const order = (
            await call('cashier', 'post', '/orders/counter', {
              requestId: randomUUID(),
              serviceType: 'DINE_IN',
              lines: [{ variantId: dish.variants[0].id, quantity: 1 }],
              payment: { expectedDue: '50', cash: '50', upi: '0' },
            }).expect(201)
          ).body;
          await call(
            'owner',
            'post',
            `/kitchen/orders/${order.id}/start`,
          ).expect(200);
          await call(
            'owner',
            'post',
            `/kitchen/orders/${order.id}/ready`,
          ).expect(200);
          await call(
            'owner',
            'post',
            `/dispatch/orders/${order.id}/complete`,
          ).expect(200);
          const tables = (
            await sql.query(
              'SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename',
            )
          ).rows.map((r) => r.tablename);
          const capture = async () => {
            const result = {};
            for (const table of tables) {
              const rows = (
                await sql.query(
                  `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
                )
              ).rows.map((r) => r.row);
              result[table] = rows
                .filter(
                  (r) =>
                    !String(r.code ?? r.permission_code ?? '').startsWith(
                      'platform_orders.',
                    ),
                )
                .map((row) => {
                  for (const key of [
                    'normal_amount',
                    'reduced_amount',
                    'serving_unit',
                    'serving_mode',
                    'serving_amount',
                    'external_reference',
                    'discount_classification',
                  ])
                    delete row[key];
                  return row;
                })
                .sort((a, b) =>
                  JSON.stringify(a).localeCompare(JSON.stringify(b)),
                );
            }
            return result;
          };
          const beforeMigration = await capture();
          await sql.query(
            fs.readFileSync(
              'database/migrations/020_manual_platform_orders.sql',
              'utf8',
            ),
          );
          assert.deepEqual(await capture(), beforeMigration);
        },
      );
      const item = (
        await call('manager', 'post', '/menu/items', {
          categoryId: cat.id,
          name: 'Manchurian',
          variants: [
            {
              name: 'Half',
              channels: [
                { channelCode: 'COUNTER', price: '120', available: true },
                {
                  channelCode: 'ZOMATO',
                  price: null,
                  available: true,
                  normalAmount: '300',
                  reducedAmount: '250',
                  servingUnit: 'g',
                },
                {
                  channelCode: 'SWIGGY',
                  price: null,
                  available: true,
                  normalAmount: '350',
                  reducedAmount: '275',
                  servingUnit: 'ml',
                },
              ],
            },
          ],
        }).expect(201)
      ).body;
      const variantId = item.variants[0].id;
      const input = (source = 'ZOMATO', reference = randomUUID()) => ({
        requestId: randomUUID(),
        source,
        externalReference: reference,
        discountClassification: 'UNKNOWN',
        lines: [
          {
            variantId,
            quantity: 2,
            instruction: 'Extra spicy',
            serving: {
              mode: 'NORMAL',
              amount: source === 'ZOMATO' ? '300' : '350',
              unit: source === 'ZOMATO' ? 'g' : 'ml',
            },
          },
        ],
      });
      let zomato, swiggy;
      await t.test(
        'Counter order still has bill and authoritative prices',
        async () => {
          const o = (
            await call('cashier', 'post', '/orders/counter', {
              requestId: randomUUID(),
              serviceType: 'TAKEAWAY',
              lines: [{ variantId, quantity: 1 }],
            }).expect(201)
          ).body;
          assert.ok(o.billId);
          assert.equal(o.grandTotal, '120.00');
        },
      );
      const finances = async () =>
        (
          await sql.query(
            'SELECT (SELECT count(*) FROM bills)::text AS bills,(SELECT count(*) FROM payments)::text AS payments,(SELECT sum(grand_total) FROM effective_orders)::text AS food,(SELECT count(*) FROM order_amendments)::text AS amendments',
          )
        ).rows[0];
      const before = await finances();
      await t.test(
        'Zomato normal and Swiggy volume are bill-less and unpriced',
        async () => {
          zomato = (
            await call(
              'cashier',
              'post',
              '/platform-orders',
              input('ZOMATO', 'z-123'),
            ).expect(201)
          ).body;
          swiggy = (
            await call(
              'cashier',
              'post',
              '/platform-orders',
              input('SWIGGY', 'z-123'),
            ).expect(201)
          ).body;
          assert.equal(zomato.externalReference, 'Z-123');
          assert.equal(swiggy.items[0].serving.unit, 'ml');
          assert.equal(zomato.items[0].serving.amount, '300.00');
          assert.ok(!('grandTotal' in zomato));
          assert.deepEqual(await finances(), before);
        },
      );
      await t.test(
        'duplicate reference and idempotency are serialized',
        async () => {
          const payload = input();
          const [a, b] = await Promise.all([
            call('cashier', 'post', '/platform-orders', payload),
            call('cashier', 'post', '/platform-orders', payload),
          ]);
          assert.equal(a.status, 201, JSON.stringify(a.body));
          assert.equal(b.body.id, a.body.id);
          assert.equal(b.body.tokenNumber, a.body.tokenNumber);
          await call('cashier', 'post', '/platform-orders', {
            ...payload,
            requestId: randomUUID(),
          }).expect(409);
          await call('cashier', 'post', '/platform-orders', {
            ...payload,
            discountClassification: 'APPLIED',
          }).expect(409);
        },
      );
      await t.test(
        'mixed explicitly selected profiles with discount and no-discount',
        async () => {
          for (const discountClassification of ['NONE', 'APPLIED']) {
            const p = input();
            p.discountClassification = discountClassification;
            p.lines.push({
              ...p.lines[0],
              instruction: 'No onion',
              serving: { mode: 'REDUCED', amount: '250', unit: 'g' },
            });
            const o = (
              await call('cashier', 'post', '/platform-orders', p).expect(201)
            ).body;
            assert.equal(o.items.length, 2);
            assert.equal(o.items[1].serving.mode, 'REDUCED');
          }
        },
      );
      await t.test(
        'strict validation, roles and Counter API separation',
        async () => {
          for (const who of ['kitchen', 'dispatch'])
            await call(who, 'post', '/platform-orders', input()).expect(403);
          await call('nobody', 'post', '/platform-orders', input()).expect(401);
          for (const extra of [
            { billId: randomUUID() },
            { price: '1' },
            { source: 'COUNTER' },
          ])
            await call('cashier', 'post', '/platform-orders', {
              ...input(),
              ...extra,
            }).expect(400);
          const p = input();
          delete p.lines[0].serving;
          await call('cashier', 'post', '/platform-orders', p).expect(400);
          await call('cashier', 'get', '/orders/' + zomato.id).expect(404);
          await call(
            'kitchen',
            'post',
            `/platform-orders/${zomato.id}/cancel`,
            { reason: 'Platform cancelled' },
          ).expect(403);
          await call('cashier', 'post', '/menu/items', {
            categoryId: cat.id,
            name: 'Not allowed',
            variants: [{ name: 'Full' }],
          }).expect(403);
        },
      );
      await t.test('shared FIFO and production separation', async () => {
        const k = (await call('kitchen', 'get', '/kitchen/orders').expect(200))
          .body;
        assert.equal(k.queued[0].source, 'COUNTER');
        assert.ok(
          k.production.queued.some(
            (g) => g.source === 'ZOMATO' && g.serving.mode === 'REDUCED',
          ),
        );
        assert.ok(
          k.production.queued.some(
            (g) => g.source === 'SWIGGY' && g.serving.unit === 'ml',
          ),
        );
        await call(
          'kitchen',
          'post',
          `/kitchen/orders/${zomato.id}/start`,
        ).expect(409);
        await call(
          'kitchen',
          'post',
          `/kitchen/orders/${k.queued[0].orderId}/start`,
        ).expect(200);
        await call(
          'kitchen',
          'post',
          `/kitchen/orders/${k.queued[0].orderId}/ready`,
        ).expect(200);
        await call(
          'dispatch',
          'post',
          `/dispatch/orders/${k.queued[0].orderId}/complete`,
        ).expect(409);
      });
      await t.test(
        'platform handover needs no settlement and duplicate cannot complete',
        async () => {
          await call(
            'kitchen',
            'post',
            `/kitchen/orders/${zomato.id}/start`,
          ).expect(200);
          await call(
            'kitchen',
            'post',
            `/kitchen/orders/${zomato.id}/ready`,
          ).expect(200);
          const d = (
            await call('dispatch', 'get', '/dispatch/orders').expect(200)
          ).body.orders.find((o) => o.orderId === zomato.id);
          assert.equal(d.billId, null);
          assert.equal(d.paymentStatus, null);
          assert.equal(d.externalReference, 'Z-123');
          const r = await Promise.all([
            call('dispatch', 'post', `/dispatch/orders/${zomato.id}/complete`),
            call('dispatch', 'post', `/dispatch/orders/${zomato.id}/complete`),
          ]);
          assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
          await call(
            'cashier',
            'post',
            `/platform-orders/${zomato.id}/cancel`,
            { reason: 'Mistaken cancellation' },
          ).expect(409);
        },
      );
      await t.test(
        'manual cancellation preserves audit and excludes active production',
        async () => {
          await call(
            'cashier',
            'post',
            `/platform-orders/${swiggy.id}/cancel`,
            { reason: 'Cancelled on platform' },
          ).expect(201);
          const o = (
            await call(
              'cashier',
              'get',
              '/platform-orders/' + swiggy.id,
            ).expect(200)
          ).body;
          assert.equal(o.status, 'CANCELLED');
          assert.equal(o.history.at(-1).reason, 'Cancelled on platform');
          const k = (
            await call('kitchen', 'get', '/kitchen/orders').expect(200)
          ).body;
          assert.ok(!k.queued.some((o) => o.orderId === swiggy.id));
          assert.deepEqual(await finances(), before);
        },
      );
      const save = async (change) => {
        const current = (
          await call('manager', 'get', '/menu/items/' + item.id).expect(200)
        ).body;
        const body = {
          version: current.version,
          categoryId: current.categoryId,
          name: current.name,
          active: current.active,
          variants: current.variants.map((v) => ({
            id: v.id,
            name: v.name,
            active: v.active,
            channels: v.channels,
          })),
        };
        change(body);
        return call('manager', 'put', '/menu/items/' + item.id, body);
      };
      await t.test(
        'serving validation rejects zero, negative, precision, equal/reversed sizes and unknown units',
        async () => {
          for (const bad of [
            { normalAmount: '0' },
            { normalAmount: '-1' },
            { normalAmount: '300.001' },
            { reducedAmount: '300' },
            { reducedAmount: '350' },
            { servingUnit: 'kg' },
          ]) {
            const r = await save((b) =>
              Object.assign(
                b.variants[0].channels.find((c) => c.channelCode === 'ZOMATO'),
                bad,
              ),
            );
            assert.equal(r.status, 400, JSON.stringify(r.body));
          }
          for (const quantity of [0, -1, 1.5, 100]) {
            const p = input();
            p.lines[0].quantity = quantity;
            await call('cashier', 'post', '/platform-orders', p).expect(400);
          }
          const p = input();
          p.lines[0].serving.amount = '299';
          await call('cashier', 'post', '/platform-orders', p).expect(409);
        },
      );
      await t.test(
        'missing configuration and sold-out/deactivated selections fail without token allocation',
        async () => {
          const count = (await sql.query('SELECT count(*) FROM orders')).rows[0]
            .count;
          await await save(
            (b) =>
              (b.variants[0].channels.find(
                (c) => c.channelCode === 'ZOMATO',
              ).available = false),
          );
          await call('cashier', 'post', '/platform-orders', input()).expect(
            409,
          );
          await save(
            (b) =>
              (b.variants[0].channels.find(
                (c) => c.channelCode === 'ZOMATO',
              ).available = true),
          );
          await save((b) => (b.active = false));
          await call('cashier', 'post', '/platform-orders', input()).expect(
            409,
          );
          await save((b) => (b.active = true));
          await save((b) => (b.variants[0].active = false));
          await call('cashier', 'post', '/platform-orders', input()).expect(
            409,
          );
          await save((b) => (b.variants[0].active = true));
          await save((b) =>
            Object.assign(
              b.variants[0].channels.find((c) => c.channelCode === 'ZOMATO'),
              { normalAmount: null, reducedAmount: null, servingUnit: null },
            ),
          );
          const missing = await call(
            'cashier',
            'post',
            '/platform-orders',
            input(),
          ).expect(409);
          assert.equal(missing.body.code, 'SERVING_PROFILE_REQUIRED');
          await save((b) =>
            Object.assign(
              b.variants[0].channels.find((c) => c.channelCode === 'ZOMATO'),
              { normalAmount: '300', reducedAmount: '250', servingUnit: 'g' },
            ),
          );
          assert.equal(
            (await sql.query('SELECT count(*) FROM orders')).rows[0].count,
            count,
          );
        },
      );
      await t.test(
        'menu edits retain historical names and exact profile snapshots and reject stale review',
        async () => {
          await save((b) => {
            b.name = 'Renamed Manchurian';
            b.variants[0].name = 'Half renamed';
            b.variants[0].channels.find(
              (c) => c.channelCode === 'ZOMATO',
            ).normalAmount = '320';
          });
          const o = (
            await call(
              'cashier',
              'get',
              '/platform-orders/' + zomato.id,
            ).expect(200)
          ).body;
          assert.equal(o.items[0].itemName, 'Manchurian');
          assert.equal(o.items[0].serving.amount, '300.00');
          const stale = await call(
            'cashier',
            'post',
            '/platform-orders',
            input(),
          ).expect(409);
          assert.equal(stale.body.code, 'SERVING_PROFILE_CHANGED');
          await save((b) => {
            b.name = 'Manchurian';
            b.variants[0].name = 'Half';
            b.variants[0].channels.find(
              (c) => c.channelCode === 'ZOMATO',
            ).normalAmount = '300';
          });
        },
      );
      await t.test(
        'concurrent different submissions get distinct daily tokens; same-reference different requests conflict',
        async () => {
          const results = await Promise.all(
            Array.from({ length: 4 }, () =>
              call('cashier', 'post', '/platform-orders', input()),
            ),
          );
          results.forEach((r) => assert.equal(r.status, 201));
          assert.equal(new Set(results.map((r) => r.body.tokenNumber)).size, 4);
          const reference = randomUUID();
          const r = await Promise.all([
            call(
              'cashier',
              'post',
              '/platform-orders',
              input('ZOMATO', reference),
            ),
            call(
              'cashier',
              'post',
              '/platform-orders',
              input('ZOMATO', reference),
            ),
          ]);
          assert.deepEqual(r.map((r) => r.status).sort(), [201, 409]);
        },
      );
      await t.test(
        'DB rejects fake platform financials, wrong bill/source, invalid sizes and snapshot rewrites',
        async () => {
          for (const patch of [
            {
              bill_id: (await sql.query('SELECT id FROM bills LIMIT 1')).rows[0]
                .id,
            },
            { grand_total: 0 },
            { external_reference: '' },
            { source: 'COUNTER' },
          ]) {
            await assert.rejects(
              sql.query(
                `INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,to_jsonb(o)||$2::jsonb)).* FROM orders o WHERE id=$1`,
                [
                  zomato.id,
                  JSON.stringify({
                    id: randomUUID(),
                    request_id: randomUUID(),
                    token_number: 999999,
                    ...patch,
                  }),
                ],
              ),
              (e) => e.code === '23514',
            );
          }
          await assert.rejects(
            sql.query("UPDATE orders SET source='SWIGGY' WHERE id=$1", [
              zomato.id,
            ]),
            (e) => e.code === '23514',
          );
          await assert.rejects(
            sql.query(
              'UPDATE order_items SET serving_amount=1 WHERE order_id=$1',
              [zomato.id],
            ),
            (e) => e.code === '23514',
          );
          await assert.rejects(
            sql.query(
              "UPDATE variant_channel_settings SET reduced_amount=normal_amount WHERE variant_id=$1 AND channel_code='ZOMATO'",
              [variantId],
            ),
            (e) => e.code === '23514',
          );
        },
      );
      await t.test(
        'manual cancellation resolves timers atomically and leaves completed orders intact',
        async () => {
          const o = (
            await call('cashier', 'post', '/platform-orders', input()).expect(
              201,
            )
          ).body;
          const timer = (
            await call('kitchen', 'post', '/kitchen/timers', {
              requestId: randomUUID(),
              label: 'Platform timer',
              durationSeconds: 120,
              orderId: o.id,
            }).expect(201)
          ).body;
          await call('cashier', 'post', `/platform-orders/${o.id}/cancel`, {
            reason: 'Customer cancelled on platform',
          }).expect(201);
          assert.equal(
            (
              await sql.query('SELECT status FROM kitchen_timers WHERE id=$1', [
                timer.id,
              ])
            ).rows[0].status,
            'CANCELLED',
          );
          await call('kitchen', 'post', `/kitchen/orders/${o.id}/start`).expect(
            409,
          );
          await call('cashier', 'post', '/platform-orders', {
            ...input(),
            externalReference: o.externalReference,
          }).expect(409);
          assert.equal(
            (
              await call(
                'cashier',
                'get',
                '/platform-orders/' + zomato.id,
              ).expect(200)
            ).body.status,
            'COMPLETED',
          );
        },
      );
      await t.test(
        'availability changes while submission waits for the restaurant lock are authoritative',
        async () => {
          await sql.query('BEGIN');
          await sql.query('SELECT pg_advisory_xact_lock(742019323)');
          const pending = call(
            'cashier',
            'post',
            '/platform-orders',
            input(),
          ).then((r) => r);
          await new Promise((r) => setTimeout(r, 50));
          await sql.query(
            "UPDATE variant_channel_settings SET available=false WHERE variant_id=$1 AND channel_code='ZOMATO'",
            [variantId],
          );
          await sql.query('COMMIT');
          const rejected = await pending;
          assert.equal(rejected.status, 409);
          assert.equal(rejected.body.code, 'ITEM_NOT_AVAILABLE');
          await save(
            (b) =>
              (b.variants[0].channels.find(
                (c) => c.channelCode === 'ZOMATO',
              ).available = true),
          );
        },
      );
      await t.test(
        'PREPARING cancellation and READY handover/cancellation races preserve one terminal history',
        async () => {
          const queue = (
            await call('kitchen', 'get', '/kitchen/orders').expect(200)
          ).body.queued;
          for (const o of queue)
            await call(
              'kitchen',
              'post',
              `/kitchen/orders/${o.orderId}/start`,
            ).expect(200);
          const first = queue[0];
          await call(
            'cashier',
            'post',
            `/platform-orders/${first.orderId}/cancel`,
            { reason: 'Platform cancelled during preparation' },
          ).expect(201);
          const second = queue[1];
          await call(
            'kitchen',
            'post',
            `/kitchen/orders/${second.orderId}/ready`,
          ).expect(200);
          const results = await Promise.all([
            call(
              'dispatch',
              'post',
              `/dispatch/orders/${second.orderId}/complete`,
            ),
            call(
              'cashier',
              'post',
              `/platform-orders/${second.orderId}/cancel`,
              { reason: 'Platform cancellation race' },
            ),
          ]);
          assert.equal(
            results.filter((r) => r.status === 200 || r.status === 201).length,
            1,
          );
          assert.equal(results.filter((r) => r.status === 409).length, 1);
          assert.equal(
            (
              await sql.query(
                "SELECT count(*)::int n FROM order_status_history WHERE order_id=$1 AND to_status IN ('COMPLETED','CANCELLED')",
                [second.orderId],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'reports and daily financial snapshots exclude platform records entirely',
        async () => {
          const {
            ReportsService,
          } = require('../../dist/modules/reports/reports.service');
          const date = (
            await sql.query(
              'SELECT business_date::text AS d FROM bills LIMIT 1',
            )
          ).rows[0].d;
          const beforeReport = await app
            .get(ReportsService)
            .dailySnapshot(sql, date);
          const beforeDashboard = (
            await call('owner', 'get', '/dashboard?period=TODAY').expect(200)
          ).body;
          const o = (
            await call('cashier', 'post', '/platform-orders', input()).expect(
              201,
            )
          ).body;
          await call('cashier', 'post', `/platform-orders/${o.id}/cancel`, {
            reason: 'Cancelled',
          }).expect(201);
          assert.deepEqual(
            await app.get(ReportsService).dailySnapshot(sql, date),
            beforeReport,
          );
          const afterDashboard = (
            await call('owner', 'get', '/dashboard?period=TODAY').expect(200)
          ).body;
          const stable = (v) =>
            JSON.parse(
              JSON.stringify(v, (k, value) =>
                k === 'asOf' ? undefined : value,
              ),
            );
          for (const field of ['sales', 'payments', 'explanation', 'topItems'])
            assert.deepEqual(
              stable(afterDashboard[field]),
              stable(beforeDashboard[field]),
            );
          assert.deepEqual(await finances(), before);
        },
      );
      await t.test(
        'cleanup respects cutoff/current date/terminal states, cancels platform timers without financial revisions, and is repeat-safe',
        async () => {
          const {
            RestaurantClock,
          } = require('../../dist/database/restaurant-clock');
          const {
            BillRolloverService,
          } = require('../../dist/modules/bills/bill-rollover.service');
          const clock = app.get(RestaurantClock),
            original = clock.read.bind(clock);
          let instant = '2020-01-01T06:00:00Z';
          clock.read = (c) =>
            original({
              query: (q, v) =>
                c.query(q.replace('clock_timestamp()', '$2::timestamptz'), [
                  ...v,
                  instant,
                ]),
            });
          try {
            const old = (
              await call('cashier', 'post', '/platform-orders', input()).expect(
                201,
              )
            ).body;
            const timer = (
              await call('kitchen', 'post', '/kitchen/timers', {
                requestId: randomUUID(),
                label: 'Old platform timer',
                durationSeconds: 120,
                orderId: old.id,
              }).expect(201)
            ).body;
            instant = '2020-01-01T23:29:00Z';
            const current = (
              await call('cashier', 'post', '/platform-orders', input()).expect(
                201,
              )
            ).body;
            const worker = app.get(BillRolloverService);
            await worker.run();
            assert.equal(
              (
                await call(
                  'cashier',
                  'get',
                  '/platform-orders/' + old.id,
                ).expect(200)
              ).body.status,
              'QUEUED',
            );
            instant = '2020-01-01T23:30:00Z';
            await worker.run();
            await worker.run();
            const cancelled = (
              await call('cashier', 'get', '/platform-orders/' + old.id).expect(
                200,
              )
            ).body;
            assert.equal(cancelled.status, 'CANCELLED');
            assert.equal(cancelled.history.at(-1).actorId, null);
            assert.equal(
              cancelled.history.at(-1).reason,
              'PREVIOUS_BUSINESS_DAY_AUTO_CANCEL',
            );
            assert.equal(
              (
                await call(
                  'cashier',
                  'get',
                  '/platform-orders/' + current.id,
                ).expect(200)
              ).body.status,
              'QUEUED',
            );
            assert.equal(
              (
                await sql.query(
                  'SELECT status FROM kitchen_timers WHERE id=$1',
                  [timer.id],
                )
              ).rows[0].status,
              'CANCELLED',
            );
            assert.equal(
              (
                await sql.query(
                  'SELECT count(*)::int n FROM platform_order_cancellations WHERE order_id=$1',
                  [old.id],
                )
              ).rows[0].n,
              1,
            );
            assert.deepEqual(await finances(), before);
          } finally {
            clock.read = original;
          }
        },
      );
    } finally {
      if (app) await app.close();
      await sql.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      process.env.DATABASE_URL = old;
    }
  },
);
