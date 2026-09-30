require('reflect-metadata');
const { test } = require('node:test');
const { performance } = require('node:perf_hooks');
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
const { OrdersService } = require('../../dist/modules/orders/orders.service');
const exact = (v) => BigInt(v.replace('.', ''));
test(
  'Owner reports: effective sales, independent cash flow, identity, periods and read-only performance',
  { timeout: 240000 },
  async (t) => {
    const original = process.env.DATABASE_URL,
      oldZone = process.env.RESTAURANT_TIMEZONE,
      oldTax = process.env.ORDER_TAX_RATE;
    process.env.RESTAURANT_TIMEZONE = 'Asia/Kolkata';
    process.env.ORDER_TAX_RATE = '0';
    const admin = new Client({ connectionString: original });
    await admin.connect();
    const schema = 'reports_test_' + randomUUID().replaceAll('-', '');
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
      for (const f of fs
        .readdirSync('database/migrations')
        .sort()
        .filter((f) => f.endsWith('.sql')))
        await sql.query(fs.readFileSync('database/migrations/' + f, 'utf8'));
      const m = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = m.createNestApplication();
      configureApp(app);
      await app.init();
      const users = app.get(UsersService),
        password = randomUUID() + '!';
      const owner = await users.create({
        username: 'owner',
        name: 'Owner',
        password,
        roles: ['OWNER'],
      });
      const cookies = {},
        identities = { OWNER: owner };
      for (const [role, roles] of Object.entries({
        OWNER: ['OWNER'],
        MANAGER: ['MANAGER'],
        CASHIER: ['CASHIER'],
        KITCHEN: ['KITCHEN'],
        DISPATCH: ['DISPATCH'],
        MULTI: ['CASHIER', 'KITCHEN', 'DISPATCH'],
      })) {
        if (role !== 'OWNER')
          identities[role] = await users.create(
            { username: role.toLowerCase(), name: role, password, roles },
            owner,
          );
        const r = await request(app.getHttpServer())
          .post('/api/auth/login')
          .set('X-DukanOS-Request', '1')
          .send({ username: role.toLowerCase(), password })
          .expect(200);
        cookies[role] = r.headers['set-cookie'][0].split(';')[0];
      }
      const call = (method, path, body, role = 'OWNER') => {
        const agent = request(app.getHttpServer());
        const r = agent[method]('/api' + path)
          .set('Cookie', cookies[role])
          .set('X-DukanOS-Request', '1');
        return body === undefined ? r : r.send(body);
      };
      const clock = app.get(RestaurantClock),
        realRead = clock.read.bind(clock),
        now = await realRead(sql);
      let instant = now.queued_at.toISOString();
      clock.read = (c) =>
        realRead({
          query: (text, values) =>
            c.query(text.replace('clock_timestamp()', '$2::timestamptz'), [
              ...values,
              instant,
            ]),
        });
      const cat = (
        await call('post', '/menu/categories', {
          name: 'Report fixtures',
        }).expect(201)
      ).body;
      const menu = {};
      for (const [name, price] of [
        ['Meal', '500'],
        ['Snack', '300'],
        ['Small', '200'],
        ['Noodles', '120'],
        ['Pasta', '170'],
        ['Manchurian', '100'],
      ])
        menu[name] = (
          await call('post', '/menu/items', {
            categoryId: cat.id,
            name,
            variants: [
              {
                name: 'Full',
                channels: [{ channelCode: 'COUNTER', price, available: true }],
              },
            ],
          }).expect(201)
        ).body;
      const create = async (name = 'Manchurian', quantity = 1, extra = {}) =>
        (
          await call('post', '/orders/counter', {
            requestId: randomUUID(),
            ...(extra.billId ? {} : { serviceType: 'DINE_IN' }),
            ...extra,
            lines: [{ variantId: menu[name].variants[0].id, quantity }],
          }).expect(201)
        ).body;
      const pay = (o, amount, method = 'CASH') =>
        call('post', `/bills/${o.billId}/payments`, {
          requestId: randomUUID(),
          amount,
          method,
        }).expect(201);
      async function amend(o, name, quantity = 1, cancel = false) {
        const body = {
          requestId: randomUUID(),
          expectedRevision: 0,
          kind: cancel ? 'CANCEL' : 'CHANGE',
          reason: 'CUSTOMER_CHANGE',
          lines: cancel
            ? []
            : [
                {
                  id: o.items[0].id,
                  variantId: menu[name].variants[0].id,
                  quantity,
                  instruction: 'No onion',
                },
              ],
        };
        const q = (
          await call('post', `/orders/${o.id}/amendments/quote`, body).expect(
            201,
          )
        ).body;
        return call('post', `/orders/${o.id}/amendments`, {
          ...body,
          quoteHash: q.quoteHash,
        }).expect(201);
      }
      const get = async (path = '/dashboard') =>
        (await call('get', path).expect(200)).body;
      const reconcile = (d) => {
        assert.equal(
          d.sales.trend.buckets.reduce(
            (n, b) => n + exact(b.salesValue),
            exact(d.sales.trend.outsidePeriodSales),
          ),
          exact(d.sales.summary.salesValue),
        );
        assert.equal(
          exact(d.payments.netCollected),
          exact(d.payments.cashCollections) +
            exact(d.payments.upiCollections) -
            exact(d.payments.cashRefunds),
        );
      };
      await t.test(
        'empty current-day dashboard is intentional and finite',
        async () => {
          const d = await get();
          assert.equal(d.sales.summary.billCount, 0);
          assert.equal(d.sales.summary.averageBill, '0.00');
          assert.equal(d.sales.trend.buckets.length, 24);
          assert.equal(d.topItems.length, 0);
          reconcile(d);
        },
      );
      await t.test(
        'basic Today: sales 800, bills 2, average 400, cash 500, UPI 200, due 100',
        async () => {
          const a = await create('Meal');
          const b = await create('Snack', 1, { serviceType: 'TAKEAWAY' });
          await pay(a, '500');
          await pay(b, '200', 'UPI');
          const d = await get();
          assert.equal(d.sales.summary.salesValue, '800.00');
          assert.equal(d.sales.summary.billCount, 2);
          assert.equal(d.sales.summary.averageBill, '400.00');
          assert.deepEqual(d.operations.serviceTypes, [
            { serviceType: 'DINE_IN', billCount: 1 },
            { serviceType: 'TAKEAWAY', billCount: 1 },
          ]);
          assert.equal(d.payments.cashCollections, '500.00');
          assert.equal(d.payments.upiCollections, '200.00');
          assert.equal(d.sales.summary.outstandingDue, '100.00');
          assert.deepEqual(
            d.sales.serviceTypes.map((s) => [s.serviceType, s.salesValue]),
            [
              ['DINE_IN', '500.00'],
              ['TAKEAWAY', '300.00'],
            ],
          );
          reconcile(d);
        },
      );
      await t.test(
        'mandatory cheaper amendment/refund: sales 120, UPI 170, refund 50, net 120, never sales 70',
        async () => {
          const before = await get();
          const o = await create('Pasta');
          await pay(o, '170', 'UPI');
          await amend(o, 'Noodles');
          assert.equal((await get()).sales.summary.refundDue, '50.00');
          await call('post', `/bills/${o.billId}/refunds`, {
            requestId: randomUUID(),
            amount: '50',
          }).expect(201);
          const after = await get();
          assert.equal(
            exact(after.sales.summary.salesValue) -
              exact(before.sales.summary.salesValue),
            12000n,
          );
          assert.equal(
            exact(after.payments.upiCollections) -
              exact(before.payments.upiCollections),
            17000n,
          );
          assert.equal(
            exact(after.payments.cashRefunds) -
              exact(before.payments.cashRefunds),
            5000n,
          );
          assert.equal(
            exact(after.payments.netCollected) -
              exact(before.payments.netCollected),
            12000n,
          );
          assert.equal(after.sales.summary.refundDue, '0.00');
          const i = await get('/reports/items');
          assert.ok(!i.items.some((i) => i.itemName === 'Pasta'));
          reconcile(after);
        },
      );
      await t.test(
        'split payment does not reduce sales; more expensive replacement changes effective identity',
        async () => {
          const before = await get();
          const o = await create('Meal');
          await pay(o, '100');
          await pay(o, '200', 'UPI');
          const after = await get();
          assert.equal(
            exact(after.sales.summary.salesValue) -
              exact(before.sales.summary.salesValue),
            50000n,
          );
          assert.equal(
            exact(after.sales.summary.outstandingDue) -
              exact(before.sales.summary.outstandingDue),
            20000n,
          );
          const replacement = await create('Noodles');
          await amend(replacement, 'Pasta');
          const items = (await get('/reports/items')).items;
          assert.equal(items.find((i) => i.itemName === 'Pasta').quantity, '1');
          assert.equal(
            items.find((i) => i.itemName === 'Pasta').salesValue,
            '170.00',
          );
          assert.equal(
            items.find((i) => i.itemName === 'Noodles').quantity,
            '1',
          );
          reconcile(await get());
        },
      );
      await t.test(
        'quantity reduction, cancellation and multi-round bills never double count',
        async () => {
          const o = await create('Manchurian', 3);
          await amend(o, 'Manchurian', 2);
          const cancelled = await create('Snack');
          await amend(cancelled, 'Snack', 1, true);
          const multi = await create('Small');
          await create('Snack', 1, { billId: multi.billId });
          const d = await get();
          assert.equal(d.sales.summary.billCount, 8);
          assert.equal(d.operations.kitchenRounds, 9);
          assert.equal(d.sales.summary.salesValue, '2290.00');
          assert.equal(
            d.operations.statuses.find((s) => s.status === 'CANCELLED').count,
            1,
          );
          assert.equal(d.operations.amendments, 4);
          const items = await get('/reports/items');
          assert.equal(
            items.items.find((i) => i.itemName === 'Manchurian').quantity,
            '2',
          );
          assert.equal(
            items.items.find((i) => i.itemName === 'Snack').quantity,
            '2',
          );
          reconcile(d);
        },
      );
      await t.test(
        'snapshot price/name and stable variant identity survive Menu edits',
        async () => {
          const before = await get('/reports/items');
          await sql.query(
            "UPDATE menu_items SET name='Renamed noodles' WHERE id=$1",
            [menu.Noodles.id],
          );
          await sql.query(
            "UPDATE variant_channel_settings SET price=999 WHERE variant_id=$1 AND channel_code='COUNTER'",
            [menu.Noodles.variants[0].id],
          );
          assert.deepEqual((await get('/reports/items')).items, before.items);
          const newOrder = await create('Noodles');
          const items = (await get('/reports/items')).items;
          const n = items.find((i) => i.menuItemId === menu.Noodles.id);
          assert.equal(n.quantity, '2');
          assert.equal(n.salesValue, '1119.00');
          assert.equal(n.itemName, 'Renamed noodles');
          assert.equal(newOrder.items[0].unitPrice, '999.00');
        },
      );
      await t.test(
        'owner/manager only by capability; unauthorized direct calls and strict DTOs',
        async () => {
          for (const route of [
            '/dashboard',
            '/reports/sales',
            '/reports/payments',
            '/reports/items',
            '/reports/operations',
          ]) {
            await request(app.getHttpServer())
              .get('/api' + route)
              .expect(401);
            await call('get', route, undefined, 'MANAGER').expect(200);
            for (const role of ['CASHIER', 'KITCHEN', 'DISPATCH', 'MULTI'])
              await call('get', route, undefined, role).expect(403);
            for (const suffix of [
              '?bad=1',
              '?from=2025-01-01',
              '?from=2025-02-30&to=2025-03-01',
              '?from=2025-01-02&to=2025-01-01',
              '?period=TODAY&from=2025-01-01&to=2025-01-02',
              '?period=TODAY&period=YESTERDAY',
              '?from=2024-01-01&to=2025-12-31',
              '?period=ALL',
            ])
              await call('get', route + suffix).expect(400);
            await call('get', route, { price: 1 }).expect(400);
          }
          for (const suffix of [
            '?page=0',
            '?page=-1',
            '?page=1.5',
            '?sort=price',
            '?page=1&page=2',
            '?page=100000',
          ])
            await call('get', '/reports/items' + suffix).expect(400);
          await sql.query(
            "INSERT INTO role_permissions VALUES('DISPATCH','reports.read')",
          );
          await call('get', '/dashboard', undefined, 'MULTI').expect(200);
          await sql.query(
            "DELETE FROM role_permissions WHERE role_code='DISPATCH' AND permission_code='reports.read'",
          );
        },
      );
      await t.test(
        'read-only reports do not mutate any domain or access records',
        async () => {
          const tables = (
            await sql.query(
              "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name",
            )
          ).rows.map((r) => r.table_name);
          async function fingerprint() {
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
          const before = await fingerprint();
          for (const route of [
            '/dashboard',
            '/reports/sales',
            '/reports/payments',
            '/reports/items',
            '/reports/operations',
          ])
            await get(route);
          assert.equal(await fingerprint(), before);
        },
      );
      await t.test(
        'Kitchen turnaround uses recorded READY history',
        async () => {
          const first = (
            await sql.query(
              "SELECT id FROM orders WHERE status='QUEUED' ORDER BY queued_at,id LIMIT 1",
            )
          ).rows[0];
          await call('post', `/kitchen/orders/${first.id}/start`).expect(200);
          await call('post', `/kitchen/orders/${first.id}/ready`).expect(200);
          const o = await get('/reports/operations');
          const expected = (
            await sql.query(
              "SELECT round(extract(epoch FROM (h.occurred_at-o.queued_at)))::int AS seconds FROM orders o JOIN order_status_history h ON h.order_id=o.id WHERE o.id=$1 AND h.to_status='READY'",
              [first.id],
            )
          ).rows[0].seconds;
          assert.equal(o.readySampleCount, 1);
          assert.equal(o.averageQueuedToReadySeconds, expected);
          assert.equal(o.statuses.find((s) => s.status === 'READY').count, 1);
        },
      );
      await t.test(
        'report period presets, midnight, event cash dates and negative refund-only cash flow',
        async () => {
          instant = '2025-01-30T18:29:59.999Z';
          const old = await create('Small');
          await sql.query(
            "INSERT INTO payments(id,bill_id,type,method,amount,performed_by,created_at,request_id,request_hash) VALUES($1,$2,'COLLECTION','UPI',200,$3,'2025-01-30T18:29:59Z',$4,$5)",
            [randomUUID(), old.billId, owner.id, randomUUID(), '0'.repeat(64)],
          );
          await amend(old, 'Small', 1, true);
          instant = '2025-01-30T18:30:00Z';
          await sql.query(
            "INSERT INTO payments(id,bill_id,type,method,amount,performed_by,created_at,request_id,request_hash) VALUES($1,$2,'REFUND','CASH',200,$3,'2025-01-30T18:30:00Z',$4,$5)",
            [randomUUID(), old.billId, owner.id, randomUUID(), '0'.repeat(64)],
          );
          const d = await get();
          assert.equal(d.period.currentBusinessDate, '2025-01-31');
          assert.equal(d.sales.summary.salesValue, '0.00');
          assert.equal(d.payments.netCollected, '-200.00');
          assert.equal(d.payments.cashRefunds, '200.00');
          assert.equal(
            (await get('/dashboard?period=YESTERDAY')).payments.upiCollections,
            '200.00',
          );
          assert.equal(
            (await get('/dashboard?period=LAST_7_DAYS')).period.from,
            '2025-01-25',
          );
          assert.equal(
            (await get('/dashboard?period=THIS_MONTH')).period.from,
            '2025-01-01',
          );
          const custom = await get('/dashboard?from=2025-01-30&to=2025-01-31');
          assert.equal(custom.payments.netCollected, '0.00');
          assert.equal(custom.sales.trend.granularity, 'DAY');
          assert.equal(custom.sales.trend.buckets.length, 2);
          reconcile(custom);
        },
      );
      await t.test(
        'tax snapshots and average paise; legacy sales are unknown service, never invented receipts/debt',
        async () => {
          instant = '2025-02-01T06:00:00Z';
          const orders = app.get(OrdersService);
          const previous = orders.configuration.taxRate;
          orders.configuration.taxRate = '2.50';
          await create('Manchurian', 1);
          orders.configuration.taxRate = previous;
          const d = await get();
          assert.equal(d.sales.summary.salesValue, '102.50');
          assert.equal(d.sales.summary.taxValue, '2.50');
          assert.equal((await get('/reports/items')).totalSalesValue, '100.00');
          reconcile(d);
          // Valid imported Bill fixture with a known sale, without guessed service/payment records.
          const legacy = randomUUID();
          await sql.query(
            "INSERT INTO bills(id,business_date,bill_number,legacy,opened_by,opened_at) VALUES($1,'2025-02-01',999,true,$2,'2025-02-01T06:00:00Z')",
            [legacy, owner.id],
          );
          await create('Manchurian', 1, { billId: legacy });
          const after = await get();
          assert.equal(after.sales.summary.legacyBills, 1);
          assert.equal(after.sales.summary.legacyDue, '100.00');
          assert.equal(after.sales.summary.outstandingDue, '102.50');
          assert.equal(after.sales.summary.averageBill, '101.25');
          assert.equal(after.payments.totalCollections, '0.00');
          assert.equal(
            after.sales.serviceTypes.find((s) => s.serviceType === 'UNKNOWN')
              .salesValue,
            '100.00',
          );
        },
      );
      await t.test(
        'pre-cutoff cross-date rounds reconcile via an explicit outside-period trend bucket',
        async () => {
          instant = '2025-03-01T06:00:00Z';
          const o = await create('Small');
          // Domain guard is intentionally bypassed only in this historical fixture:
          // reconstruct a valid old pre-cutoff transaction using existing DB guards.
          const id = randomUUID();
          await sql.query('BEGIN');
          try {
            await sql.query(
              `INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,to_jsonb(o)||jsonb_build_object('id',$2::text,'request_id',$3::text,'business_date','2025-03-02','queued_at','2025-03-02T06:00:00Z','token_number',1))).* FROM orders o WHERE id=$1`,
              [o.id, id, randomUUID()],
            );
            await sql.query(
              `INSERT INTO order_items SELECT (jsonb_populate_record(NULL::order_items,to_jsonb(i)||jsonb_build_object('id',$2::text,'order_id',$3::text))).* FROM order_items i WHERE order_id=$1`,
              [o.id, randomUUID(), id],
            );
            await sql.query(
              "INSERT INTO order_status_history VALUES($1,$2,'DRAFT','QUEUED',$3,'2025-03-02T06:00:00Z','Historical fixture')",
              [randomUUID(), id, owner.id],
            );
            await sql.query('COMMIT');
          } catch (e) {
            await sql.query('ROLLBACK');
            throw e;
          }
          const d = await get();
          assert.equal(d.sales.summary.salesValue, '400.00');
          assert.equal(d.sales.trend.outsidePeriodSales, '200.00');
          assert.equal(d.operations.billCount, 1);
          assert.equal(d.operations.kitchenRounds, 2);
          reconcile(d);
        },
      );
      await t.test(
        'four months of realistic history: bounded reports, query plans and item pagination',
        async () => {
          const start = Date.parse('2024-01-01T06:00:00Z');
          for (let day = 0; day < 120; day++) {
            instant = new Date(start + day * 86400000).toISOString();
            for (let n = 0; n < 10; n++) {
              const o = await create('Manchurian');
              await sql.query(
                "INSERT INTO payments(id,bill_id,type,method,amount,performed_by,created_at,request_id,request_hash) VALUES($1,$2,'COLLECTION','CASH',100,$3,$4,$5,$6)",
                [
                  randomUUID(),
                  o.billId,
                  owner.id,
                  instant,
                  randomUUID(),
                  '0'.repeat(64),
                ],
              );
            }
          }
          await sql.query('ANALYZE');
          const db = app.get(DatabaseService);
          const captured = [];
          const originalTransaction = db.transaction.bind(db);
          db.transaction = (work) =>
            originalTransaction((c) =>
              work({
                query: async (text, values) => {
                  if (
                    text.includes('selected_bills') ||
                    text.includes('FROM payments WHERE') ||
                    text.includes('FROM order_amendments WHERE')
                  )
                    captured.push({ text, values });
                  return c.query(text, values);
                },
              }),
            );
          let d;
          const startQuery = performance.now();
          try {
            d = await get('/dashboard?from=2024-01-01&to=2024-04-29');
          } finally {
            db.transaction = originalTransaction;
          }
          const elapsed = performance.now() - startQuery;
          // Also inspect a selective single-day cohort, where date indexes matter.
          const broadQueries = [...captured];
          for (const query of broadQueries) {
            if (
              query.values?.length >= 2 &&
              query.text.includes('selected_bills')
            )
              captured.push({
                text: query.text,
                values: ['2024-04-29', '2024-04-29', ...query.values.slice(2)],
              });
          }
          assert.equal(d.sales.summary.billCount, 1200);
          assert.equal(d.sales.summary.salesValue, '120000.00');
          assert.equal(d.payments.totalCollections, '120000.00');
          reconcile(d);
          assert.ok(elapsed < 8000, `Dashboard took ${elapsed}ms`);
          console.log(
            'Reports 1200-bill/4-month dashboard milliseconds:',
            Math.round(elapsed),
          );
          const plans = [];
          for (const [index, query] of captured.entries()) {
            const plan = (
              await sql.query(
                'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + query.text,
                query.values,
              )
            ).rows[0]['QUERY PLAN'][0];
            const scans = [];
            function walk(node) {
              if (node['Node Type'].includes('Scan'))
                scans.push({
                  type: node['Node Type'],
                  relation: node['Relation Name'],
                  index: node['Index Name'],
                  rows: node['Actual Rows'],
                  loops: node['Actual Loops'],
                });
              for (const child of node.Plans ?? []) walk(child);
            }
            walk(plan.Plan);
            plans.push({ index, milliseconds: plan['Execution Time'], scans });
          }
          assert.ok(plans.length >= 10);
          fs.writeFileSync(
            '/tmp/dukanos-report-query-plans.json',
            JSON.stringify(plans, null, 2),
          );
          console.log(
            'Actual report query plans:',
            plans.map((p) => ({ query: p.index, ms: p.milliseconds })),
            'details /tmp/dukanos-report-query-plans.json',
          );
          for (let n = 0; n < 52; n++) {
            const name = 'Page fixture ' + n;
            menu[name] = (
              await call('post', '/menu/items', {
                categoryId: cat.id,
                name,
                variants: [
                  {
                    name: 'Size ' + n,
                    channels: [
                      {
                        channelCode: 'COUNTER',
                        price: '1.01',
                        available: true,
                      },
                    ],
                  },
                ],
              }).expect(201)
            ).body;
            await create(name);
          }
          const a = await get('/reports/items?sort=SALES'),
            b = await get('/reports/items?sort=SALES&page=2');
          assert.equal(a.items.length, 50);
          assert.equal(a.totalItems, 53);
          assert.equal(b.items.length, 3);
          assert.equal(
            new Set([...a.items, ...b.items].map((i) => i.variantId)).size,
            53,
          );
          assert.equal(a.totalQuantity, '62');
        },
      );
    } finally {
      if (app) await app.close();
      await sql.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      process.env.DATABASE_URL = original;
      for (const [key, value] of [
        ['RESTAURANT_TIMEZONE', oldZone],
        ['ORDER_TAX_RATE', oldTax],
      ]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
