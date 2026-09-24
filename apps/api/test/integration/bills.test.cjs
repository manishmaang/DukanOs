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
const { legacyOrder } = require('../fixtures/legacy-order.cjs');
test(
  'Bills, payment ledger and service-aware handover',
  { timeout: 120000 },
  async (t) => {
    const original = process.env.DATABASE_URL;
    const admin = new Client({ connectionString: original });
    await admin.connect();
    const schema = 'bills_test_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(original);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    const sql = new Client({ connectionString: url.toString() });
    await sql.connect();
    let app;
    try {
      for (const f of fs
        .readdirSync('database/migrations')
        .sort()
        .filter((f) => f.endsWith('.sql') && f < '012'))
        await sql.query(fs.readFileSync('database/migrations/' + f, 'utf8'));
      const m = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = m.createNestApplication();
      configureApp(app);
      await app.init();
      const users = app.get(UsersService),
        password = randomUUID() + '!',
        cookies = {},
        identities = {};
      const owner = await users.create({
        username: 'owner',
        name: 'Owner',
        password,
        roles: ['OWNER'],
      });
      for (const [name, roles] of Object.entries({
        OWNER: ['OWNER'],
        MANAGER: ['MANAGER'],
        CASHIER: ['CASHIER'],
        KITCHEN: ['KITCHEN'],
        DISPATCH: ['DISPATCH'],
        MULTI: ['CASHIER', 'DISPATCH'],
      })) {
        identities[name] =
          name === 'OWNER'
            ? owner
            : await users.create(
                { username: name.toLowerCase(), name, password, roles },
                owner,
              );
        const r = await request(app.getHttpServer())
          .post('/api/auth/login')
          .set('X-DukanOS-Request', '1')
          .send({ username: name.toLowerCase(), password })
          .expect(200);
        cookies[name] = r.headers['set-cookie'][0].split(';')[0];
      }
      const call = (method, path, body, role = 'CASHIER') => {
        const agent = request(app.getHttpServer());
        let r = agent[method]('/api' + path)
          .set('X-DukanOS-Request', '1')
          .set('Cookie', cookies[role]);
        return body === undefined ? r : r.send(body);
      };
      const cat = (
        await call(
          'post',
          '/menu/categories',
          { name: 'Bill fixtures' },
          'OWNER',
        ).expect(201)
      ).body;
      const dish = (
        await call(
          'post',
          '/menu/items',
          {
            categoryId: cat.id,
            name: 'Manchurian',
            variants: [
              {
                name: 'Full',
                channels: [
                  { channelCode: 'COUNTER', price: '100.00', available: true },
                ],
              },
            ],
          },
          'OWNER',
        ).expect(201)
      ).body;
      const variantId = dish.variants[0].id;
      const old = await legacyOrder(sql, owner.id, [
        { variantId, quantity: 1 },
      ]);
      await t.test(
        '012 backfills legacy bills without altering order snapshots/history or fabricating payments',
        async () => {
          const before = (
            await sql.query('SELECT to_jsonb(o) AS row FROM orders o')
          ).rows;
          const history = (
            await sql.query('SELECT * FROM order_status_history')
          ).rows;
          await sql.query('BEGIN');
          await sql.query(
            fs.readFileSync(
              'database/migrations/012_bills_payments.sql',
              'utf8',
            ),
          );
          await sql.query('COMMIT');
          assert.deepEqual(
            (
              await sql.query(
                "SELECT to_jsonb(o)-'bill_id' AS row FROM orders o",
              )
            ).rows,
            before,
          );
          assert.deepEqual(
            (await sql.query('SELECT * FROM order_status_history')).rows,
            history,
          );
          assert.equal(
            (await sql.query('SELECT count(*)::int n FROM payments')).rows[0].n,
            0,
          );
          const b = (await call('get', '/bills/' + old.id).expect(200)).body;
          assert.equal(b.legacy, true);
          assert.equal(b.serviceType, null);
          assert.equal(b.amountDue, '100.00');
          const originalRequest = (
            await sql.query('SELECT request_id FROM orders WHERE id=$1', [
              old.id,
            ])
          ).rows[0].request_id;
          const replay = (
            await call(
              'post',
              '/orders/counter',
              {
                requestId: originalRequest,
                lines: [{ variantId, quantity: 1 }],
              },
              'OWNER',
            ).expect(201)
          ).body;
          assert.equal(replay.id, old.id);
          assert.equal(replay.billId, old.id);
        },
      );
      const confirm = (extra = {}, qty = 1, role = 'CASHIER') =>
        call(
          'post',
          '/orders/counter',
          {
            requestId: randomUUID(),
            lines: [{ variantId, quantity: qty }],
            ...extra,
          },
          role,
        );
      const get = async (id) =>
        (await call('get', '/bills/' + id).expect(200)).body;
      const collect = (
        id,
        amount,
        method = 'CASH',
        key = randomUUID(),
        role = 'CASHIER',
      ) =>
        call(
          'post',
          `/bills/${id}/payments`,
          { requestId: key, amount, method },
          role,
        );
      const serve = async (o) => {
        await call(
          'post',
          `/kitchen/orders/${o.id}/start`,
          undefined,
          'KITCHEN',
        ).expect(200);
        await call(
          'post',
          `/kitchen/orders/${o.id}/ready`,
          undefined,
          'KITCHEN',
        ).expect(200);
        return call(
          'post',
          `/dispatch/orders/${o.id}/complete`,
          undefined,
          'DISPATCH',
        );
      };
      // Drain the preserved legacy round so subsequent FIFO is intentional.
      assert.equal((await serve(old)).status, 200);
      let dine, take;
      await t.test(
        'two Dine In rounds retain independent tokens, serve unpaid, then partial UPI/Cash settlement and explicit close',
        async () => {
          dine = (
            await confirm(
              { serviceType: 'DINE_IN', reference: 'Table 4' },
              3,
            ).expect(201)
          ).body;
          assert.equal((await serve(dine)).status, 200);
          const second = (await confirm({ billId: dine.billId }, 2).expect(201))
            .body;
          assert.notEqual(second.id, dine.id);
          assert.notEqual(second.tokenNumber, dine.tokenNumber);
          assert.equal(second.billId, dine.billId);
          assert.equal((await serve(second)).status, 200);
          assert.equal((await get(dine.billId)).billTotal, '500.00');
          await collect(dine.billId, '200', 'UPI').expect(201);
          let b = (await collect(dine.billId, '100').expect(201)).body;
          assert.equal(b.netPaid, '300.00');
          assert.equal(b.amountDue, '200.00');
          assert.equal(b.paymentStatus, 'PARTIALLY_PAID');
          await call('post', `/bills/${dine.billId}/close`).expect(409);
          b = (await collect(dine.billId, '200').expect(201)).body;
          assert.equal(b.paymentStatus, 'PAID');
          assert.equal(b.status, 'OPEN');
          await call('post', `/bills/${dine.billId}/close`).expect(201);
          await call('post', `/bills/${dine.billId}/close`).expect(201);
          await confirm({ billId: dine.billId }).expect(409);
          await collect(dine.billId, '1').expect(409);
        },
      );
      await t.test(
        'Takeaway handover is denied by backend and database until settlement; close requires all rounds complete',
        async () => {
          take = (await confirm({ serviceType: 'TAKEAWAY' }).expect(201)).body;
          assert.equal((await serve(take)).status, 409);
          await assert.rejects(
            sql.query(
              "INSERT INTO order_status_history VALUES($1,$2,'READY','COMPLETED',$3,clock_timestamp(),'test')",
              [randomUUID(), take.id, identities.DISPATCH.id],
            ),
            /PAYMENT_REQUIRED/,
          );
          let state = (
            await call('get', '/dispatch/orders', undefined, 'DISPATCH').expect(
              200,
            )
          ).body;
          const r = state.orders.find((o) => o.orderId === take.id);
          assert.equal(r.serviceType, 'TAKEAWAY');
          assert.equal(r.amountDue, '100.00');
          assert.equal(r.paymentStatus, 'UNPAID');
          assert.equal(r.payments, undefined);
          await collect(
            take.billId,
            '100',
            'UPI',
            randomUUID(),
            'MULTI',
          ).expect(201);
          await call('post', `/bills/${take.billId}/close`).expect(409);
          await call(
            'post',
            `/dispatch/orders/${take.id}/complete`,
            undefined,
            'MULTI',
          ).expect(200);
          await call('post', `/bills/${take.billId}/close`).expect(201);
        },
      );
      await t.test(
        'same request replays once, changed payload conflicts, concurrent full collections cannot overpay',
        async () => {
          const o = (await confirm({ serviceType: 'DINE_IN' }, 2).expect(201))
            .body;
          const key = randomUUID();
          const rs = await Promise.all([
            collect(o.billId, '50', 'UPI', key),
            collect(o.billId, '50.00', 'UPI', key),
          ]);
          assert.deepEqual(
            rs.map((r) => r.status),
            [201, 201],
          );
          assert.equal((await get(o.billId)).payments.length, 1);
          await collect(o.billId, '60', 'UPI', key).expect(409);
          const race = await Promise.all([
            collect(o.billId, '150'),
            collect(o.billId, '150', 'UPI', randomUUID(), 'MANAGER'),
          ]);
          assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
          assert.equal((await get(o.billId)).netPaid, '200.00');
          assert.equal((await serve(o)).status, 200);
          await call('post', `/bills/${o.billId}/close`).expect(201);
          await collect(o.billId, '50', 'UPI', key).expect(201);
        },
      );
      await t.test(
        'paid open bill can gain a new round; payment history stays intact and tax uses child snapshots',
        async () => {
          const o = (await confirm({ serviceType: 'DINE_IN' }).expect(201))
            .body;
          await collect(o.billId, '100').expect(201);
          assert.equal((await serve(o)).status, 200);
          const next = (await confirm({ billId: o.billId }).expect(201)).body;
          const b = await get(o.billId);
          assert.equal(b.amountDue, '100.00');
          const originalRequest = (
            await sql.query('SELECT request_id FROM orders WHERE id=$1', [
              old.id,
            ])
          ).rows[0].request_id;
          const replay = (
            await call(
              'post',
              '/orders/counter',
              {
                requestId: originalRequest,
                lines: [{ variantId, quantity: 1 }],
              },
              'OWNER',
            ).expect(201)
          ).body;
          assert.equal(replay.id, old.id);
          assert.equal(replay.billId, old.id);

          assert.equal(b.payments.length, 1);
          assert.equal(b.billTotal, '200.00');
          assert.equal((await serve(next)).status, 200);
        },
      );
      await t.test(
        'permissions: owner/manager/cashier collect, Kitchen and Dispatch have no financial detail or collection',
        async () => {
          const o = (await confirm({ serviceType: 'DINE_IN' }).expect(201))
            .body;
          for (const role of ['OWNER', 'MANAGER', 'CASHIER'])
            await collect(o.billId, '10', 'CASH', randomUUID(), role).expect(
              201,
            );
          for (const role of ['KITCHEN', 'DISPATCH']) {
            await collect(o.billId, '1', 'CASH', randomUUID(), role).expect(
              403,
            );
            await call('get', '/bills/' + o.billId, undefined, role).expect(
              403,
            );
            await call('get', '/orders/' + o.id, undefined, role).expect(403);
          }
          await request(app.getHttpServer())
            .post(`/api/bills/${o.billId}/payments`)
            .set('X-DukanOS-Request', '1')
            .send({ requestId: randomUUID(), method: 'CASH', amount: '1' })
            .expect(401);
          assert.equal((await serve(o)).status, 200);
        },
      );
      await t.test(
        'strict DTOs, scale, amounts, methods, queries and mutually exclusive bill selection',
        async () => {
          for (const extra of [
            {},
            { serviceType: 'CARD' },
            { serviceType: null },
            { billId: dine.billId, serviceType: 'DINE_IN' },
            { serviceType: 'DINE_IN', reference: 'x'.repeat(81) },
          ])
            await confirm(extra).expect(400);
          for (const value of [
            '0',
            '-1',
            'NaN',
            '1.001',
            '1e2',
            '1000000000000',
            1,
            null,
          ])
            await collect(dine.billId, value).expect(400);
          for (const method of ['CARD', 'REFUND', null])
            await collect(dine.billId, '1', method).expect(400);
          await call('post', `/bills/${dine.billId}/payments`, {
            requestId: randomUUID(),
            amount: '1',
            method: 'CASH',
            type: 'REFUND',
          }).expect(400);
          await call('get', '/bills?bad=true').expect(400);
          await call('get', '/bills?after=bad').expect(400);
          await call('get', '/bills/not-a-uuid').expect(400);
        },
      );
      await t.test(
        'ledger immutable, positive two-decimal money, cash-only future refunds and closed bill guards',
        async () => {
          const payment = (await sql.query('SELECT id FROM payments LIMIT 1'))
            .rows[0];
          await assert.rejects(
            sql.query('UPDATE payments SET amount=1 WHERE id=$1', [payment.id]),
            /PAYMENT_IMMUTABLE/,
          );
          await assert.rejects(
            sql.query('DELETE FROM payments WHERE id=$1', [payment.id]),
            /PAYMENT_IMMUTABLE/,
          );
          const o = (await confirm({ serviceType: 'DINE_IN' }).expect(201))
            .body;
          for (const [type, method, amount] of [
            ['COLLECTION', 'CASH', '-1'],
            ['COLLECTION', 'CASH', '1.001'],
            ['COLLECTION', 'CARD', '1'],
            ['REFUND', 'UPI', '1'],
            ['REFUND', 'CASH', '1'],
            ['COLLECTION', 'CASH', '101'],
          ])
            await assert.rejects(
              sql.query(
                'INSERT INTO payments(id,bill_id,type,method,amount,performed_by,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
                [
                  randomUUID(),
                  o.billId,
                  type,
                  method,
                  amount,
                  owner.id,
                  randomUUID(),
                  'a'.repeat(64),
                ],
              ),
            );
          await assert.rejects(
            sql.query(
              "UPDATE bills SET status='CLOSED',closed_at=clock_timestamp(),closed_by=$2 WHERE id=$1",
              [o.billId, owner.id],
            ),
            /BILL_NOT_SETTLED/,
          );
          assert.equal((await serve(o)).status, 200);
        },
      );
      await t.test(
        'zero price yields PAID without fake payment; new bill/token creation idempotency is atomic',
        async () => {
          const free = (
            await call(
              'post',
              '/menu/items',
              {
                categoryId: cat.id,
                name: 'Free',
                variants: [
                  {
                    name: 'One',
                    channels: [
                      { channelCode: 'COUNTER', price: '0', available: true },
                    ],
                  },
                ],
              },
              'OWNER',
            ).expect(201)
          ).body;
          const input = {
            requestId: randomUUID(),
            serviceType: 'TAKEAWAY',
            lines: [{ variantId: free.variants[0].id, quantity: 1 }],
          };
          const rs = await Promise.all([
            call('post', '/orders/counter', input),
            call('post', '/orders/counter', input),
          ]);
          assert.equal(rs[0].status, 201);
          assert.equal(rs[1].status, 201);
          assert.equal(rs[0].body.billId, rs[1].body.billId);
          const b = await get(rs[0].body.billId);
          assert.equal(b.paymentStatus, 'PAID');
          assert.equal(b.payments.length, 0);
          await call('post', '/orders/counter', {
            ...input,
            serviceType: 'DINE_IN',
          }).expect(409);
          assert.equal((await serve(rs[0].body)).status, 200);
        },
      );
      await t.test(
        'bill numbering and close/add races serialize without losing a round',
        async () => {
          const results = await Promise.all([
            confirm({ serviceType: 'DINE_IN' }),
            confirm({ serviceType: 'DINE_IN' }),
          ]);
          assert.deepEqual(
            results.map((r) => r.status),
            [201, 201],
          );
          const a = results[0].body,
            b = results[1].body;
          assert.notEqual(a.billId, b.billId);
          await assert.rejects(
            sql.query(
              'UPDATE bill_daily_numbers SET last_number=last_number-1',
            ),
            /BILL_NUMBER_IMMUTABLE/,
          );
          assert.notEqual(
            (await get(a.billId)).billNumber,
            (await get(b.billId)).billNumber,
          );
          for (const o of [a, b].sort((x, y) => x.tokenNumber - y.tokenNumber))
            assert.equal((await serve(o)).status, 200);
          await collect(a.billId, '100').expect(201);
          const race = await Promise.all([
            call('post', `/bills/${a.billId}/close`),
            confirm({ billId: a.billId }),
          ]);
          assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
          if (race[1].status === 201) {
            assert.equal((await get(a.billId)).status, 'OPEN');
            assert.equal((await serve(race[1].body)).status, 200);
          } else assert.equal((await get(a.billId)).status, 'CLOSED');
        },
      );
      await t.test(
        'bill aggregates child tax snapshots and paise without recalculating tax after configuration changes',
        async () => {
          const first = (await confirm({ serviceType: 'DINE_IN' }).expect(201))
            .body;
          assert.equal((await serve(first)).status, 200);
          const oldTax = process.env.ORDER_TAX_RATE;
          try {
            await app.close();
            process.env.ORDER_TAX_RATE = '5.50';
            const nextApp = await Test.createTestingModule({
              imports: [AppModule],
            }).compile();
            app = nextApp.createNestApplication();
            configureApp(app);
            await app.init();
            const second = (await confirm({ billId: first.billId }).expect(201))
              .body;
            assert.equal(second.grandTotal, '105.50');
            const bill = await get(first.billId);
            assert.equal(bill.billTotal, '205.50');
            process.env.ORDER_TAX_RATE = '99';
            assert.equal((await get(first.billId)).billTotal, '205.50');
            const paid = (
              await collect(first.billId, '205.50', 'UPI').expect(201)
            ).body;
            assert.equal(paid.netPaid, '205.50');
            assert.equal(paid.amountDue, '0.00');
            assert.equal((await serve(second)).status, 200);
          } finally {
            if (oldTax === undefined) delete process.env.ORDER_TAX_RATE;
            else process.env.ORDER_TAX_RATE = oldTax;
          }
        },
      );
    } finally {
      await app?.close();
      await sql.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      process.env.DATABASE_URL = original;
    }
  },
);
