require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const { Client } = require('pg');
const { Test } = require('@nestjs/testing');
const request = require('supertest');
const { AppModule } = require('../../dist/app.module');
const { configureApp } = require('../../dist/configure-app');
const { UsersService } = require('../../dist/modules/users/users.service');
const { RestaurantClock } = require('../../dist/database/restaurant-clock');
const {
  DailyReportsService,
} = require('../../dist/modules/daily-reports/daily-reports.service');
const {
  DailyWorkerService,
} = require('../../dist/modules/daily-reports/daily-worker.service');
const {
  EmailDeliveryAdapter,
} = require('../../dist/modules/daily-reports/email-adapter');
const {
  renderReport,
} = require('../../dist/modules/daily-reports/report-email');
function smtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 local test\r\n');
    let buffer = '',
      data = false,
      body = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (data) {
          if (line === '.') {
            messages.push(body);
            body = '';
            data = false;
            socket.write('250 accepted\r\n');
          } else body += line + '\r\n';
        } else if (line.startsWith('EHLO'))
          socket.write('250-local\r\n250 8BITMIME\r\n');
        else if (line === 'DATA') {
          data = true;
          socket.write('354 data\r\n');
        } else if (line === 'QUIT') {
          socket.end('221 bye\r\n');
        } else socket.write('250 ok\r\n');
      }
    });
  });
  return { server, messages };
}
test(
  'Daily owner reports: immutable versions, current data, delivery, catch-up and permissions',
  { timeout: 180000 },
  async (t) => {
    const original = process.env.DATABASE_URL,
      oldZone = process.env.RESTAURANT_TIMEZONE,
      oldTax = process.env.ORDER_TAX_RATE;
    process.env.RESTAURANT_TIMEZONE = 'Asia/Kolkata';
    process.env.ORDER_TAX_RATE = '0';
    const admin = new Client({ connectionString: original });
    await admin.connect();
    const schema = 'daily_' + randomUUID().replaceAll('-', '');
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
    const mail = smtp();
    await new Promise((r) => mail.server.listen(0, '127.0.0.1', r));
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
      const cookies = {};
      for (const role of [
        'OWNER',
        'MANAGER',
        'CASHIER',
        'KITCHEN',
        'DISPATCH',
      ]) {
        if (role !== 'OWNER')
          await users.create(
            {
              username: role.toLowerCase(),
              name: role,
              password,
              roles: [role],
            },
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
        real = clock.read.bind(clock),
        now = await real(sql),
        day = now.business_date,
        next = (await sql.query('SELECT ($1::date+1)::text AS d', [day]))
          .rows[0].d;
      let instant = now.queued_at.toISOString();
      clock.read = (c) =>
        real({
          query: (q, v) =>
            c.query(q.replace('clock_timestamp()', '$2::timestamptz'), [
              ...v,
              instant,
            ]),
        });
      const category = (
        await call('post', '/menu/categories', {
          name: 'Daily fixture',
        }).expect(201)
      ).body;
      const dish = (
        await call('post', '/menu/items', {
          name: 'Manchurian',
          categoryId: category.id,
          variants: ['Half', 'Full'].map((name) => ({
            name,
            channels: [
              { channelCode: 'COUNTER', price: '1000', available: true },
            ],
          })),
        }).expect(201)
      ).body;
      const order = (
        await call('post', '/orders/counter', {
          requestId: randomUUID(),
          serviceType: 'DINE_IN',
          lines: dish.variants.map((v, i) => ({
            variantId: v.id,
            quantity: i ? 6 : 4,
          })),
        }).expect(201)
      ).body;
      const cancelled = (
        await call('post', '/orders/counter', {
          requestId: randomUUID(),
          serviceType: 'DINE_IN',
          lines: [{ variantId: dish.variants[0].id, quantity: 1 }],
        }).expect(201)
      ).body;
      await call('post', `/bills/${cancelled.billId}/payments`, {
        requestId: randomUUID(),
        amount: '1000',
        method: 'UPI',
      }).expect(201);
      const amend = {
        requestId: randomUUID(),
        expectedRevision: 0,
        kind: 'CANCEL',
        reason: 'CUSTOMER_CHANGE',
        lines: [],
      };
      const quote = (
        await call(
          'post',
          `/orders/${cancelled.id}/amendments/quote`,
          amend,
        ).expect(201)
      ).body;
      await call('post', `/orders/${cancelled.id}/amendments`, {
        ...amend,
        quoteHash: quote.quoteHash,
      }).expect(201);
      await call('post', `/bills/${cancelled.billId}/refunds`, {
        requestId: randomUUID(),
        amount: '500',
      }).expect(201);
      const cats = (await call('get', '/expense-categories').expect(200)).body
        .categories;
      let bread;
      for (const [i, amount] of ['1250', '600', '150'].entries()) {
        const e = (
          await call('post', '/expenses', {
            requestId: randomUUID(),
            amount,
            categoryId: cats[i].id,
            paymentMethod: i === 1 ? 'UPI' : 'CASH',
            vendor: 'Vendor <safe>',
            note: 'Purchase & supplies',
          }).expect(201)
        ).body;
        if (i === 1) bread = e;
      }
      const service = app.get(DailyReportsService),
        worker = app.get(DailyWorkerService),
        adapter = app.get(EmailDeliveryAdapter);
      let v1, v2;
      await t.test(
        'current date cannot finalize; unauthenticated and operational roles denied',
        async () => {
          await call('post', '/daily-reports', {
            requestId: randomUUID(),
            businessDate: day,
          }).expect(400);
          await request(app.getHttpServer())
            .get('/api/daily-reports')
            .expect(401);
          for (const role of ['CASHIER', 'KITCHEN', 'DISPATCH'])
            for (const path of [
              '/daily-reports',
              '/daily-reports/settings',
              '/daily-reports/deliveries',
            ])
              await call('get', path, undefined, role).expect(403);
          await call('get', '/daily-reports', undefined, 'MANAGER').expect(200);
          await call('patch', '/daily-reports/settings', {
            enabled: true,
            recipients: ['x@example.com', 'X@example.com'],
            version: 1,
          }).expect(400);
          await call('patch', '/daily-reports/settings', {
            enabled: false,
            recipients: [],
            version: 1,
            unknown: 1,
          }).expect(400);
        },
      );
      instant = next + 'T03:30:00.000Z';
      await t.test(
        'single consistent source snapshot: 10000 food, 500 actual returned, 2000 expenses; all portions',
        async () => {
          const tables = [
            'bills',
            'orders',
            'order_items',
            'payments',
            'expenses',
            'order_amendments',
          ];
          const before = {};
          for (const table of tables)
            before[table] = (
              await sql.query(
                `SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) AS hash FROM ${table} t`,
              )
            ).rows[0].hash;
          v1 = (
            await call('post', '/daily-reports', {
              requestId: randomUUID(),
              businessDate: day,
            }).expect(201)
          ).body;
          assert.equal(v1.version, 1);
          assert.equal(v1.snapshot.foodSold, '10000.00');
          assert.equal(v1.snapshot.cashReturned, '500.00');
          assert.equal(v1.snapshot.recordedExpenses, '2000.00');
          assert.equal(v1.snapshot.bestSeller.quantity, '10');
          assert.deepEqual(
            v1.snapshot.bestSeller.variants
              .map((v) => [v.name, v.quantity])
              .sort(),
            [
              ['Full', '6'],
              ['Half', '4'],
            ],
          );
          assert.equal(v1.snapshot.expenseEntries.length, 3);
          for (const table of tables)
            assert.equal(
              (
                await sql.query(
                  `SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) AS hash FROM ${table} t`,
                )
              ).rows[0].hash,
              before[table],
            );
        },
      );
      await t.test(
        'historical addition updates live to 2500, not v1; explicit v2 preserves reason; concurrent revisions unique',
        async () => {
          await call('post', '/expenses', {
            requestId: randomUUID(),
            amount: '500',
            categoryId: cats[0].id,
            paymentMethod: 'CASH',
            businessDate: day,
          }).expect(201);
          assert.equal(
            (
              await call(
                'get',
                `/reports/expenses?from=${day}&to=${day}`,
              ).expect(200)
            ).body.total,
            '2500.00',
          );
          assert.deepEqual(
            (await call('get', '/daily-reports/' + v1.id).expect(200)).body
              .snapshot,
            v1.snapshot,
          );
          const body = {
            requestId: randomUUID(),
            reason: 'Missing historical expense added',
          };
          const results = await Promise.all(
            Array.from({ length: 4 }, () =>
              call('post', `/daily-reports/${v1.id}/regenerate`, body).expect(
                201,
              ),
            ),
          );
          assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
          v2 = results[0].body;
          assert.equal(v2.version, 2);
          assert.equal(v2.snapshot.recordedExpenses, '2500.00');
          assert.equal(v2.reason, body.reason);
          const versions = await Promise.all(
            Array.from({ length: 2 }, () =>
              call('post', `/daily-reports/${v1.id}/regenerate`, {
                requestId: randomUUID(),
                reason: 'Concurrent review',
              }).expect(201),
            ),
          );
          assert.deepEqual(versions.map((r) => r.body.version).sort(), [3, 4]);
          await assert.rejects(
            sql.query("UPDATE daily_reports SET snapshot='{}' WHERE id=$1", [
              v1.id,
            ]),
            /IMMUTABLE/,
          );
          await assert.rejects(
            sql.query('DELETE FROM daily_reports WHERE id=$1', [v1.id]),
            /IMMUTABLE/,
          );
          await call('post', `/daily-reports/${v1.id}/regenerate`, {
            ...body,
            reason: 'Changed intent',
          }).expect(409);
        },
      );
      await t.test(
        'void restates only live/new snapshots; renderer escapes HTML and revisions',
        async () => {
          await call('post', `/expenses/${bread.id}/void`, {
            requestId: randomUUID(),
            reason: 'WRONG_AMOUNT',
          }).expect(201);
          assert.equal(
            (
              await call(
                'get',
                `/reports/expenses?from=${day}&to=${day}`,
              ).expect(200)
            ).body.total,
            '1900.00',
          );
          assert.deepEqual((await service.detail(v1.id)).snapshot, v1.snapshot);
          const email = renderReport(v1.snapshot, 1);
          assert.ok(email.text.includes('2000.00'));
          assert.ok(email.html.includes('&lt;safe&gt;'));
          assert.ok(!email.html.includes('src='));
          assert.ok(renderReport(v2.snapshot, 2).subject.includes('v2'));
          assert.ok(
            renderReport(v2.snapshot, 2).text.includes('REVISED DAILY REPORT'),
          );
        },
      );
      await t.test(
        'SMTP absent is optional; settings audited and version checked; test jobs are not reports',
        async () => {
          assert.equal((await service.settings()).smtpStatus, 'NOT_CONFIGURED');
          await call('patch', '/daily-reports/settings', {
            enabled: true,
            recipients: ['owner@example.com'],
            version: 1,
          }).expect(200);
          await call('patch', '/daily-reports/settings', {
            enabled: false,
            recipients: [],
            version: 1,
          }).expect(409);
          const before = (
            await sql.query('SELECT count(*)::int n FROM daily_reports')
          ).rows[0].n;
          await call('post', '/daily-reports/test-email', {
            requestId: randomUUID(),
            recipient: 'owner@example.com',
          }).expect(201);
          assert.equal(await worker.deliverOne(), false);
          assert.equal(
            (await sql.query('SELECT count(*)::int n FROM daily_reports'))
              .rows[0].n,
            before,
          );
          adapter.config.smtp = {
            host: '127.0.0.1',
            port: mail.server.address().port,
            secure: false,
            from: 'dukanos@example.com',
            name: 'DukanOS',
          };
          assert.equal(await worker.deliverOne(), true);
          assert.ok(mail.messages[0].includes('DukanOS Email Test'));
        },
      );
      await t.test(
        'real local SMTP sends selected v1 and v2; duplicate requests replay; recipient history immutable',
        async () => {
          const body = { requestId: randomUUID(), confirmResend: false };
          const jobs = await Promise.all(
            Array.from({ length: 3 }, () =>
              call('post', `/daily-reports/${v1.id}/send`, body).expect(201),
            ),
          );
          assert.equal(new Set(jobs.map((r) => r.body.deliveryIds[0])).size, 1);
          await Promise.all([worker.deliverOne(), worker.deliverOne()]);
          let d = (await service.detail(v1.id)).deliveries;
          assert.equal(d.length, 1);
          assert.equal(d[0].status, 'SENT');
          assert.equal(mail.messages.length, 2);
          assert.ok(mail.messages[1].includes('2000.00'));
          await call('post', `/daily-reports/${v1.id}/send`, {
            requestId: randomUUID(),
            confirmResend: false,
          }).expect(409);
          await call('post', `/daily-reports/${v1.id}/send`, {
            requestId: randomUUID(),
            confirmResend: true,
          }).expect(201);
          await worker.deliverOne();
          assert.equal((await service.detail(v1.id)).deliveries.length, 2);
          await call('patch', '/daily-reports/settings', {
            enabled: true,
            recipients: ['partner@example.com'],
            version: 2,
          }).expect(200);
          await call('post', `/daily-reports/${v2.id}/send`, {
            requestId: randomUUID(),
            confirmResend: false,
          }).expect(201);
          await worker.deliverOne();
          const second = (await service.detail(v2.id)).deliveries[0];
          assert.equal(second.recipient, 'partner@example.com');
          assert.ok(mail.messages.at(-1).includes('2500.00'));
          assert.equal(
            (await service.detail(v1.id)).deliveries[0].recipient,
            'owner@example.com',
          );
          await assert.rejects(
            sql.query('UPDATE report_deliveries SET report_id=$1 WHERE id=$2', [
              v2.id,
              d[0].id,
            ]),
            /IMMUTABLE/,
          );
        },
      );
      await t.test(
        'network failure persists retry; new worker resumes; manual retry audit and lease recovery',
        async () => {
          const realSend = adapter.send.bind(adapter);
          adapter.send = async () => {
            throw Object.assign(new Error('must not expose smtp-secret'), {
              code: 'ECONNECTION',
            });
          };
          const job = (
            await call('post', '/daily-reports/test-email', {
              requestId: randomUUID(),
              recipient: 'partner@example.com',
            }).expect(201)
          ).body.deliveryIds[0];
          await worker.deliverOne();
          let row = (
            await sql.query('SELECT * FROM report_deliveries WHERE id=$1', [
              job,
            ])
          ).rows[0];
          assert.equal(row.status, 'RETRY_PENDING');
          assert.equal(row.last_error_code, 'SMTP_UNAVAILABLE');
          assert.ok(row.next_attempt_at > row.created_at);
          adapter.send = realSend;
          const restartedWorker = new DailyWorkerService(
            app.get(
              require('../../dist/database/database.service').DatabaseService,
            ),
            clock,
            app.get(
              require('../../dist/modules/bills/bill-rollover.service')
                .BillRolloverService,
            ),
            service,
            adapter,
          );
          const body = { requestId: randomUUID() };
          await call(
            'post',
            `/daily-reports/deliveries/${job}/retry`,
            body,
          ).expect(201);
          await call(
            'post',
            `/daily-reports/deliveries/${job}/retry`,
            body,
          ).expect(201);
          await restartedWorker.deliverOne();
          assert.equal(
            (
              await sql.query(
                'SELECT status FROM report_deliveries WHERE id=$1',
                [job],
              )
            ).rows[0].status,
            'SENT',
          );
          assert.equal(
            (
              await sql.query(
                'SELECT count(*)::int n FROM report_delivery_attempts WHERE delivery_id=$1',
                [job],
              )
            ).rows[0].n,
            2,
          );
          const lease = (
            await call('post', '/daily-reports/test-email', {
              requestId: randomUUID(),
              recipient: 'partner@example.com',
            }).expect(201)
          ).body.deliveryIds[0];
          await sql.query(
            "UPDATE report_deliveries SET status='SENDING',attempt_count=1,lease_until=clock_timestamp()-interval '1 minute',claim_id=$2 WHERE id=$1",
            [lease, randomUUID()],
          );
          await worker.deliverOne();
          assert.equal(
            (
              await sql.query(
                "SELECT count(*)::int n FROM report_delivery_attempts WHERE delivery_id=$1 AND outcome='LEASE_EXPIRED'",
                [lease],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'delay, multi-day chronological catch-up, zero days, repeated workers and no automatic corrections',
        async () => {
          const before = (
            await sql.query(
              'SELECT count(*)::int n FROM daily_reports WHERE business_date=$1',
              [day],
            )
          ).rows[0].n;
          await worker.catchUp();
          assert.equal(
            (
              await sql.query(
                'SELECT count(*)::int n FROM daily_reports WHERE business_date=$1',
                [day],
              )
            ).rows[0].n,
            before,
          );
          const future = (
            await sql.query('SELECT ($1::date+3)::text d', [next])
          ).rows[0].d;
          instant = future + 'T00:00:00+05:30';
          await worker.catchUp();
          let dates = (
            await sql.query(
              'SELECT business_date::text d FROM daily_reports WHERE business_date>$1 ORDER BY business_date',
              [day],
            )
          ).rows.map((r) => r.d);
          assert.equal(dates.length, 2);
          instant = future + 'T00:05:00+05:30';
          await Promise.all([worker.catchUp(), worker.catchUp()]);
          dates = (
            await sql.query(
              'SELECT business_date::text d FROM daily_reports WHERE business_date>$1 ORDER BY business_date',
              [day],
            )
          ).rows.map((r) => r.d);
          assert.equal(dates.length, 3);
          const zero = await service.detail(
            (
              await sql.query(
                'SELECT id FROM daily_reports WHERE business_date=$1',
                [next],
              )
            ).rows[0].id,
          );
          assert.equal(zero.snapshot.foodSold, '0.00');
          assert.equal(zero.snapshot.cashReturned, '0.00');
          assert.equal(zero.snapshot.bestSeller, null);
          assert.equal(zero.deliveries.length, 1);
          await worker.catchUp();
          assert.equal(
            (
              await sql.query(
                'SELECT count(*)::int n FROM daily_reports WHERE business_date>$1',
                [day],
              )
            ).rows[0].n,
            3,
          );
        },
      );
      await t.test(
        'dish quantities aggregate across every portion; tie uses revenue; replacements and reductions use effective lines',
        async () => {
          const date2 = (await sql.query('SELECT ($1::date+8)::text d', [day]))
            .rows[0].d;
          instant = date2 + 'T12:00:00+05:30';
          const noodle = (
            await call('post', '/menu/items', {
              categoryId: category.id,
              name: 'Noodles',
              variants: ['Half', 'Full'].map((name) => ({
                name,
                channels: [
                  { channelCode: 'COUNTER', price: '1001', available: true },
                ],
              })),
            }).expect(201)
          ).body;
          const pasta = (
            await call('post', '/menu/items', {
              categoryId: category.id,
              name: 'Pasta',
              variants: [
                {
                  name: 'Full',
                  channels: [
                    { channelCode: 'COUNTER', price: '1001', available: true },
                  ],
                },
              ],
            }).expect(201)
          ).body;
          const createLines = async (lines) =>
            (
              await call('post', '/orders/counter', {
                requestId: randomUUID(),
                serviceType: 'DINE_IN',
                lines,
              }).expect(201)
            ).body;
          await createLines(
            dish.variants.map((v, i) => ({
              variantId: v.id,
              quantity: i ? 7 : 8,
            })),
          );
          const n = await createLines(
            noodle.variants.map((v, i) => ({
              variantId: v.id,
              quantity: i ? 9 : 5,
            })),
          );
          const db = app.get(
              require('../../dist/database/database.service').DatabaseService,
            ),
            reports = app.get(
              require('../../dist/modules/reports/reports.service')
                .ReportsService,
            );
          const snapshot = () =>
            db.transaction((c) => reports.dailySnapshot(c, date2));
          assert.equal((await snapshot()).bestSeller.name, 'Manchurian');
          await createLines([
            { variantId: noodle.variants[0].id, quantity: 1 },
          ]);
          assert.equal((await snapshot()).bestSeller.name, 'Noodles');
          const change = {
            requestId: randomUUID(),
            expectedRevision: 0,
            kind: 'CHANGE',
            reason: 'CUSTOMER_CHANGE',
            lines: n.items.map((line, i) => ({
              id: line.id,
              variantId: i ? pasta.variants[0].id : line.variantId,
              quantity: i ? 8 : line.quantity,
              instruction: '',
            })),
          };
          const preview = (
            await call(
              'post',
              `/orders/${n.id}/amendments/quote`,
              change,
            ).expect(201)
          ).body;
          await call('post', `/orders/${n.id}/amendments`, {
            ...change,
            quoteHash: preview.quoteHash,
          }).expect(201);
          assert.equal((await snapshot()).bestSeller.name, 'Manchurian');
          const live = (
            await call(
              'get',
              `/reports/items?from=${date2}&to=${date2}`,
            ).expect(200)
          ).body.items;
          assert.equal(live.find((i) => i.itemName === 'Pasta').quantity, '8');
          assert.ok(
            !live.some(
              (i) => i.itemName === 'Noodles' && i.variantName === 'Full',
            ),
          );
        },
      );
      assert.ok(order.id);
      assert.equal(
        (
          await sql.query(
            'SELECT count(*)::int n FROM daily_report_settings_audit',
          )
        ).rows[0].n,
        2,
      );
    } finally {
      if (app) await app.close();
      await new Promise((r) => mail.server.close(r));
      await sql.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      process.env.DATABASE_URL = original;
      if (oldZone === undefined) delete process.env.RESTAURANT_TIMEZONE;
      else process.env.RESTAURANT_TIMEZONE = oldZone;
      if (oldTax === undefined) delete process.env.ORDER_TAX_RATE;
      else process.env.ORDER_TAX_RATE = oldTax;
    }
  },
);
