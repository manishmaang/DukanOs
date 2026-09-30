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
test(
  'Bill business-date protection and scoped history',
  { timeout: 120000 },
  async (t) => {
    const original = process.env.DATABASE_URL,
      originalTimezone = process.env.RESTAURANT_TIMEZONE;
    process.env.RESTAURANT_TIMEZONE = 'Asia/Kolkata';
    const admin = new Client({ connectionString: original });
    await admin.connect();
    const schema = 'bill_scope_' + randomUUID().replaceAll('-', '');
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
      const clock = app.get(RestaurantClock),
        realRead = clock.read.bind(clock);
      let instant = '2025-09-27T06:00:00Z';
      // Substitute only PostgreSQL's wall clock; exercise production timezone conversion.
      clock.read = (c) =>
        realRead({
          query: (text, values) =>
            c.query(text.replace('clock_timestamp()', '$2::timestamptz'), [
              ...values,
              instant,
            ]),
        });
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
      const cat = (
        await call('post', '/menu/categories', {
          name: 'Scope fixtures',
        }).expect(201)
      ).body;
      const item = (
        await call('post', '/menu/items', {
          categoryId: cat.id,
          name: 'Noodles',
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
      const variantId = item.variants[0].id;
      const body = (extra = {}) => ({
        requestId: randomUUID(),
        lines: [{ variantId, quantity: 1 }],
        ...extra,
      });
      const create = async (extra = {}) =>
        (
          await call(
            'post',
            '/orders/counter',
            body({ serviceType: 'DINE_IN', ...extra }),
          ).expect(201)
        ).body;
      const dates = {};
      for (const date of ['27', '28', '29', '30']) {
        instant = `2025-09-${date}T06:00:00Z`;
        dates[date] = [
          await create({ reference: 'Table ' + date }),
          await create({ reference: 'Second ' + date }),
        ];
      }
      await t.test(
        'default is current restaurant date, not database timezone; scopes include open and closed bills',
        async () => {
          const r = (await call('get', '/bills').expect(200)).body;
          assert.equal(r.currentBusinessDate, '2025-09-30');
          assert.equal(r.scope, 'TODAY');
          assert.equal(r.bills.length, 2);
          assert.ok(
            r.bills.every(
              (b) => b.businessDate === '2025-09-30' && b.canChangeFood,
            ),
          );
          assert.deepEqual(
            r.bills.map((b) => b.id),
            r.bills
              .map((b) => b.id)
              .sort()
              .reverse(),
          );
          assert.equal(
            (await call('get', '/bills?search=%20%20').expect(200)).body.scope,
            'TODAY',
          );
        },
      );
      await t.test(
        'inclusive range, global bill-number forms, references, clearing and no token conflation',
        async () => {
          const ranged = (
            await call(
              'get',
              '/bills?fromBusinessDate=2025-09-28&toBusinessDate=2025-09-29',
            ).expect(200)
          ).body;
          assert.equal(ranged.scope, 'RANGE');
          assert.deepEqual(
            ranged.bills.map((b) => b.businessDate),
            ['2025-09-29', '2025-09-29', '2025-09-28', '2025-09-28'],
          );
          for (const search of ['1', '%231', '0001']) {
            const r = (await call('get', '/bills?search=' + search).expect(200))
              .body;
            assert.equal(r.scope, 'HISTORY');
            assert.equal(r.bills.length, 4);
            assert.ok(r.bills.every((b) => b.billNumber === 1));
          }
          const r = (
            await call(
              'get',
              '/bills?search=%231&fromBusinessDate=2025-09-29&toBusinessDate=2025-09-30',
            ).expect(200)
          ).body;
          assert.deepEqual(
            r.bills.map((b) => b.businessDate),
            ['2025-09-30', '2025-09-29'],
          );
          assert.equal(
            (await call('get', '/bills?search=tAbLe').expect(200)).body.bills
              .length,
            4,
          );
          assert.equal(
            (await call('get', '/bills?search=%27%20OR%201%3D1--').expect(200))
              .body.bills.length,
            0,
          );
          assert.equal(
            (await call('get', '/bills?search=' + '9'.repeat(80)).expect(200))
              .body.bills.length,
            0,
          );
          // Token #3 belongs to Bill #1; searching #3 must not find it.
          await call(
            'post',
            '/orders/counter',
            body({ billId: dates['30'][0].billId }),
          ).expect(201);
          assert.equal(
            (await call('get', '/bills?search=%233').expect(200)).body.bills
              .length,
            0,
          );
          assert.equal(
            (await call('get', '/bills').expect(200)).body.bills.length,
            2,
          );
        },
      );
      await t.test(
        'strict dates, range order, unknown fields, repeated params and cursors',
        async () => {
          for (const q of [
            'fromBusinessDate=2025-09-29',
            'toBusinessDate=2025-09-30',
            'fromBusinessDate=2025-09-30&toBusinessDate=2025-09-29',
            'fromBusinessDate=2025-02-30&toBusinessDate=2025-03-01',
            'fromBusinessDate=2025-9-2&toBusinessDate=2025-09-30',
            'fromBusinessDate=0000-01-01&toBusinessDate=2025-09-30',
            'fromBusinessDate=2025-09-29&fromBusinessDate=2025-09-30&toBusinessDate=2025-09-30',
            'search=x&bad=true',
            'after=bad',
            'after=' + randomUUID(),
          ])
            await call('get', '/bills?' + q).expect(400);
        },
      );
      await t.test(
        'historical open bills reject new orders, quotes, notes, replacements and cancellation; history unchanged',
        async () => {
          const old = dates['29'][0],
            detail = (await call('get', '/bills/' + old.billId).expect(200))
              .body;
          assert.equal(detail.canChangeFood, false);
          assert.equal(detail.orders[0].items[0].itemName, 'Noodles');
          for (const route of ['/orders/counter', '/orders/counter/quote']) {
            const r = await call(
              'post',
              route,
              body({ billId: old.billId }),
            ).expect(409);
            assert.equal(r.body.code, 'BILL_NOT_CURRENT_BUSINESS_DATE');
          }
          const change = {
            requestId: randomUUID(),
            expectedRevision: 0,
            kind: 'CHANGE',
            reason: 'CUSTOMER_CHANGE',
            lines: old.items.map((i) => ({
              id: i.id,
              variantId: i.variantId,
              quantity: i.quantity,
              instruction: 'No onion',
            })),
          };
          for (const input of [
            change,
            { ...change, kind: 'CANCEL', lines: [] },
          ]) {
            const r = await call(
              'post',
              `/orders/${old.id}/amendments/quote`,
              input,
            ).expect(409);
            assert.equal(r.body.code, 'BILL_NOT_CURRENT_BUSINESS_DATE');
            await call('post', `/orders/${old.id}/amendments`, {
              ...input,
              quoteHash: '0'.repeat(64),
            }).expect(409);
          }
          assert.deepEqual(
            (await call('get', '/bills/' + old.billId).expect(200)).body,
            detail,
          );
        },
      );
      await t.test(
        'midnight invalidates old quotes; successful idempotent replay and financial reconciliation remain allowed',
        async () => {
          instant = '2025-09-30T18:29:59.999Z';
          const requestBody = body({
            serviceType: 'DINE_IN',
            reference: 'Midnight',
          });
          const o = (
            await call('post', '/orders/counter', requestBody).expect(201)
          ).body;
          assert.equal(o.businessDate, '2025-09-30');
          const input = {
            requestId: randomUUID(),
            expectedRevision: 0,
            kind: 'CHANGE',
            reason: 'CUSTOMER_CHANGE',
            lines: o.items.map((i) => ({
              id: i.id,
              variantId: i.variantId,
              quantity: i.quantity,
              instruction: 'Extra spicy',
            })),
          };
          const q = (
            await call(
              'post',
              `/orders/${o.id}/amendments/quote`,
              input,
            ).expect(201)
          ).body;
          const committed = { ...input, quoteHash: q.quoteHash };
          await call('post', `/orders/${o.id}/amendments`, committed).expect(
            201,
          );
          const next = {
            ...input,
            requestId: randomUUID(),
            expectedRevision: 1,
            lines: input.lines.map((i) => ({ ...i, instruction: 'No onion' })),
          };
          const nextQuote = (
            await call('post', `/orders/${o.id}/amendments/quote`, next).expect(
              201,
            )
          ).body;
          instant = '2025-09-30T18:30:00.000Z';
          assert.equal(
            (await call('get', '/bills').expect(200)).body.currentBusinessDate,
            '2025-10-01',
          );
          assert.equal(
            (await call('get', '/bills').expect(200)).body.bills.length,
            0,
          );
          assert.equal(
            (await call('get', '/bills/' + o.billId).expect(200)).body
              .canChangeFood,
            false,
          );
          await call('post', `/orders/${o.id}/amendments`, {
            ...next,
            quoteHash: nextQuote.quoteHash,
          }).expect(409);
          await call('post', `/orders/${o.id}/amendments`, committed).expect(
            201,
          );
          assert.equal(
            (await call('post', '/orders/counter', requestBody).expect(201))
              .body.id,
            o.id,
          );
          const paid = (
            await call('post', `/bills/${o.billId}/payments`, {
              requestId: randomUUID(),
              method: 'CASH',
              amount: '100',
            }).expect(201)
          ).body;
          assert.equal(paid.amountDue, '0.00');
          assert.equal(paid.canChangeFood, false);
          const fresh = await create();
          assert.equal(fresh.businessDate, '2025-10-01');
          assert.equal(fresh.tokenNumber, 1);
          await call(
            'post',
            '/orders/counter',
            body({ billId: o.billId }),
          ).expect(409);
        },
      );
      await t.test(
        'historical refund and closure survive; closed bills are searchable and cannot accept food',
        async () => {
          instant = '2025-10-02T06:00:00Z';
          const o = await create({ reference: 'Historical refund' });
          await call('post', `/bills/${o.billId}/payments`, {
            requestId: randomUUID(),
            method: 'UPI',
            amount: '100',
          }).expect(201);
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
          await call('post', `/orders/${o.id}/amendments`, {
            ...input,
            quoteHash: q.quoteHash,
          }).expect(201);
          instant = '2025-10-03T06:00:00Z';
          const refund = (
            await call('post', `/bills/${o.billId}/refunds`, {
              requestId: randomUUID(),
              amount: '100',
            }).expect(201)
          ).body;
          assert.equal(refund.refundDue, '0.00');
          assert.equal(refund.payments.length, 2);
          await call('post', `/bills/${o.billId}/close`).expect(201);
          assert.equal(
            (await call('get', '/bills?search=Historical%20refund').expect(200))
              .body.bills[0].status,
            'CLOSED',
          );
          assert.equal(
            (
              await call(
                'post',
                '/orders/counter',
                body({ billId: o.billId }),
              ).expect(409)
            ).body.code,
            'BILL_CLOSED',
          );
        },
      );
      await t.test(
        'date is checked after waiting for the restaurant lock across midnight',
        async () => {
          instant = '2025-10-03T18:29:59Z';
          const o = await create();
          await sql.query('SELECT pg_advisory_lock(742019323)');
          try {
            const waiting = call(
              'post',
              '/orders/counter',
              body({ billId: o.billId }),
            ).then((r) => r);
            // Observe the actual database lock wait rather than relying on a sleep.
            for (let n = 0; n < 100; n++) {
              if (
                (
                  await sql.query(
                    "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=742019323 AND NOT granted",
                  )
                ).rowCount
              )
                break;
              await new Promise((r) => setTimeout(r, 10));
              if (n === 99) throw Error('Request did not wait for lock');
            }
            instant = '2025-10-03T18:30:00Z';
            await sql.query('SELECT pg_advisory_unlock(742019323)');
            const result = await waiting;
            assert.equal(result.status, 409);
            assert.equal(result.body.code, 'BILL_NOT_CURRENT_BUSINESS_DATE');
          } finally {
            await sql.query('SELECT pg_advisory_unlock_all()');
          }
        },
      );
      await t.test(
        'bounded deterministic pagination traverses global and Today results without duplicates',
        async () => {
          instant = '2025-10-05T06:00:00Z';
          for (let n = 0; n < 103; n++)
            await create({ reference: 'Pagination' });
          const first = (await call('get', '/bills').expect(200)).body;
          assert.equal(first.bills.length, 100);
          assert.ok(first.nextCursor);
          const next = (
            await call('get', '/bills?after=' + first.nextCursor).expect(200)
          ).body;
          assert.equal(next.bills.length, 3);
          assert.equal(next.nextCursor, null);
          assert.equal(
            new Set([...first.bills, ...next.bills].map((b) => b.id)).size,
            103,
          );
          const global = (
            await call('get', '/bills?search=Pagination').expect(200)
          ).body;
          const rest = (
            await call(
              'get',
              '/bills?search=Pagination&after=' + global.nextCursor,
            ).expect(200)
          ).body;
          assert.deepEqual(
            [...global.bills, ...rest.bills].map((b) => b.id),
            [...first.bills, ...next.bills].map((b) => b.id),
          );
        },
      );
    } finally {
      if (app) await app.close();
      await sql.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      process.env.DATABASE_URL = original;
      if (originalTimezone === undefined)
        delete process.env.RESTAURANT_TIMEZONE;
      else process.env.RESTAURANT_TIMEZONE = originalTimezone;
    }
  },
);
