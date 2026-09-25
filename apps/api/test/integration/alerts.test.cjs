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
  'Confirmation collections and persistent operational alerts',
  { timeout: 120000 },
  async (t) => {
    const original = process.env.DATABASE_URL;
    const admin = new Client({ connectionString: original });
    await admin.connect();
    const schema = 'alerts_test_' + randomUUID().replaceAll('-', '');
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
        .filter((f) => f.endsWith('.sql')))
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
        MULTI: ['CASHIER', 'KITCHEN', 'DISPATCH'],
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
      const input = (extra = {}) => ({
        requestId: randomUUID(),
        serviceType: 'DINE_IN',
        lines: [{ variantId, quantity: 1, instruction: 'Extra spicy' }],
        ...extra,
      });
      const confirm = async (payload, role = 'CASHIER') =>
        (await call('post', '/orders/counter', payload, role).expect(201)).body;
      const detail = async (id) =>
        (await call('get', '/bills/' + id).expect(200)).body;
      let billId, order;
      await t.test(
        'authoritative quote; full Cash/UPI; split and exact snapshots; replay',
        async () => {
          for (const method of ['cash', 'upi']) {
            const payload = input({
              payment: {
                expectedDue: '100',
                cash: '0',
                upi: '0',
                [method]: '100',
              },
            });
            const quote = (
              await call('post', '/orders/counter/quote', payload).expect(201)
            ).body;
            assert.equal(quote.amountDue, '100.00');
            const results = await Promise.all([
              confirm(payload),
              confirm(payload),
            ]);
            assert.equal(results[0].id, results[1].id);
            const bill = await detail(results[0].billId);
            assert.equal(bill.amountDue, '0.00');
            assert.equal(bill.payments.length, 1);
            assert.equal(bill.payments[0].method, method.toUpperCase());
            assert.equal(bill.orders[0].items[0].instruction, 'Extra spicy');
            assert.equal(bill.orders[0].items[0].itemName, 'Manchurian');
            await call('post', '/orders/counter', {
              ...payload,
              payment: { ...payload.payment, [method]: '50' },
            }).expect(409);
          }
          order = await confirm(
            input({
              payment: { expectedDue: '100.00', cash: '10.25', upi: '20.50' },
            }),
          );
          billId = order.billId;
          const b = await detail(billId);
          assert.equal(b.amountDue, '69.25');
          assert.equal(b.payments.length, 2);
          const next = input({
            billId,
            payment: { expectedDue: '169.25', cash: '0', upi: '150' },
          });
          delete next.serviceType;
          await confirm(next);
          assert.equal((await detail(billId)).amountDue, '19.25');
          const oldNames = (await detail(billId)).orders;
          await sql.query(
            "UPDATE menu_items SET name='Changed name' WHERE id=$1",
            [dish.id],
          );
          assert.deepEqual((await detail(billId)).orders, oldNames);
        },
      );
      await t.test(
        'Pay Later, stale due, validation, RBAC and rollback',
        async () => {
          const unpaid = await confirm(input());
          assert.equal((await detail(unpaid.billId)).payments.length, 0);
          for (const payment of [
            null,
            { expectedDue: '99', cash: '99', upi: '0' },
            { expectedDue: '100', cash: '101', upi: '0' },
            { expectedDue: '100', cash: '0', upi: '0' },
            { expectedDue: '100', cash: '1.001', upi: '0' },
            { expectedDue: '100', cash: '-1', upi: '0' },
          ]) {
            const r = await call('post', '/orders/counter', input({ payment }));
            assert.ok([400, 409].includes(r.status));
          }
          for (const role of ['KITCHEN', 'DISPATCH'])
            await call(
              'post',
              '/orders/counter',
              input({ payment: { expectedDue: '100', cash: '100', upi: '0' } }),
              role,
            ).expect(403);
          const before = (await sql.query('SELECT count(*)::int n FROM orders'))
            .rows[0].n;
          await sql.query(
            `CREATE FUNCTION fail_test_upi() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.method='UPI' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_fail BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION fail_test_upi()`,
          );
          await call(
            'post',
            '/orders/counter',
            input({ payment: { expectedDue: '100', cash: '10', upi: '10' } }),
          ).expect(500);
          await sql.query(
            'DROP TRIGGER test_fail ON payments; DROP FUNCTION fail_test_upi()',
          );
          assert.equal(
            (await sql.query('SELECT count(*)::int n FROM orders')).rows[0].n,
            before,
          );
        },
      );
      await t.test(
        'concurrent distinct confirmations reject stale reviewed due and cannot double collect',
        async () => {
          const first = await confirm(input());
          const next = () => {
            const p = input({
              billId: first.billId,
              payment: { expectedDue: '200', cash: '200', upi: '0' },
            });
            delete p.serviceType;
            return p;
          };
          const results = await Promise.all([
            call('post', '/orders/counter', next()),
            call('post', '/orders/counter', next()),
          ]);
          assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
          const bill = await detail(first.billId);
          assert.equal(bill.orders.length, 2);
          assert.equal(bill.payments.length, 1);
          assert.equal(bill.amountDue, '0.00');
          const ref = (
            await sql.query(
              'SELECT confirmation_order_id FROM payments WHERE bill_id=$1',
              [first.billId],
            )
          ).rows[0];
          assert.ok(
            bill.orders.some((o) => o.id === ref.confirmation_order_id),
          );
        },
      );
      await t.test(
        'reminder persistence, due, versioned snooze, settlement pause/resume and permissions',
        async () => {
          await call('post', `/bills/${billId}/reminder`, {
            intervalMinutes: 5,
          }).expect(201);
          let r = (await call('get', '/reminders/active').expect(200)).body
            .entries[0];
          assert.equal(r.billId, billId);
          await sql.query(
            "UPDATE bill_reminders SET next_due_at=clock_timestamp()-interval '6 minutes' WHERE bill_id=$1",
            [billId],
          );
          r = (
            await call('get', '/reminders/active', undefined, 'MANAGER').expect(
              200,
            )
          ).body.entries[0];
          assert.ok(Date.parse(r.nextDueAt) < Date.now());
          await call('post', `/bills/${billId}/reminder/snooze`, {
            version: r.version,
          }).expect(201);
          await call('post', `/bills/${billId}/reminder/snooze`, {
            version: r.version,
          }).expect(409);
          for (const role of ['KITCHEN', 'DISPATCH']) {
            await call('get', '/reminders/active', undefined, role).expect(403);
            await call(
              'post',
              `/bills/${billId}/reminder`,
              { intervalMinutes: 5 },
              role,
            ).expect(403);
          }
          await call('post', `/bills/${billId}/payments`, {
            requestId: randomUUID(),
            method: 'CASH',
            amount: '19.25',
          }).expect(201);
          assert.equal(
            (await call('get', '/reminders/active').expect(200)).body.entries
              .length,
            0,
          );
          const next = input({ billId });
          delete next.serviceType;
          await confirm(next);
          r = (
            await call('get', '/reminders/active', undefined, 'MULTI').expect(
              200,
            )
          ).body.entries[0];
          assert.equal(r.amountDue, '100.00');
          assert.equal(r.intervalMinutes, 5);
          assert.ok(Date.parse(r.nextDueAt) > Date.now());
          await call('post', `/bills/${billId}/reminder`, {
            intervalMinutes: 0,
          }).expect(400);
          const takeaway = await confirm(input({ serviceType: 'TAKEAWAY' }));
          await call('post', `/bills/${takeaway.billId}/reminder`, {
            intervalMinutes: 5,
          }).expect(409);
        },
      );
      await t.test(
        'timer creation, association, idempotency, clock state and concurrent acknowledgement',
        async () => {
          const payload = {
            requestId: randomUUID(),
            label: 'Soya Chaap microwave',
            durationSeconds: 120,
            orderId: order.id,
            orderItemId: order.items[0].id,
          };
          const made = await Promise.all([
            call('post', '/kitchen/timers', payload, 'KITCHEN').expect(201),
            call('post', '/kitchen/timers', payload, 'KITCHEN').expect(201),
          ]);
          assert.equal(made[0].body.id, made[1].body.id);
          const id = made[0].body.id;
          const state = (
            await call('get', '/kitchen/timers', undefined, 'MANAGER').expect(
              200,
            )
          ).body;
          assert.equal(state.entries.length, 1);
          assert.equal(state.entries[0].itemName, 'Manchurian');
          assert.equal(
            Date.parse(state.entries[0].dueAt) -
              Date.parse(state.entries[0].startedAt),
            120000,
          );
          await call(
            'post',
            `/kitchen/timers/${id}/acknowledge`,
            undefined,
            'KITCHEN',
          ).expect(409);
          // Only isolated fixtures fast-forward absolute timestamps; production timer edits remain forbidden.
          await sql.query(
            'ALTER TABLE kitchen_timers DISABLE TRIGGER immutable_kitchen_timer',
          );
          await sql.query(
            "UPDATE kitchen_timers SET started_at=started_at-interval '3 minutes',due_at=due_at-interval '3 minutes' WHERE id=$1",
            [id],
          );
          await sql.query(
            'ALTER TABLE kitchen_timers ENABLE TRIGGER immutable_kitchen_timer',
          );
          const due = (
            await call('get', '/kitchen/timers', undefined, 'MULTI').expect(200)
          ).body;
          assert.ok(
            Date.parse(due.entries[0].dueAt) < Date.parse(due.serverTime),
          );
          await Promise.all(
            ['KITCHEN', 'MANAGER'].map((role) =>
              call(
                'post',
                `/kitchen/timers/${id}/acknowledge`,
                undefined,
                role,
              ).expect(201),
            ),
          );
          assert.equal(
            (
              await call('get', '/kitchen/timers', undefined, 'KITCHEN').expect(
                200,
              )
            ).body.entries.length,
            0,
          );
          assert.equal(
            (
              await sql.query(
                'SELECT resolved_by FROM kitchen_timers WHERE id=$1',
                [id],
              )
            ).rows[0].resolved_by !== null,
            true,
          );
          await assert.rejects(
            sql.query("UPDATE kitchen_timers SET label='edited' WHERE id=$1", [
              id,
            ]),
          );
          const custom = (
            await call(
              'post',
              '/kitchen/timers',
              { requestId: randomUUID(), label: 'Bread', durationSeconds: 420 },
              'OWNER',
            ).expect(201)
          ).body;
          await call(
            'post',
            `/kitchen/timers/${custom.id}/cancel`,
            undefined,
            'OWNER',
          ).expect(201);
          for (const role of ['CASHIER', 'DISPATCH']) {
            await call('get', '/kitchen/timers', undefined, role).expect(403);
            await call('post', '/kitchen/timers', payload, role).expect(403);
          }
          for (const extra of [
            { durationSeconds: 0 },
            { durationSeconds: 1.5 },
            { durationSeconds: 86401 },
            { orderItemId: randomUUID() },
            { unknown: true },
          ])
            await call(
              'post',
              '/kitchen/timers',
              { ...payload, requestId: randomUUID(), ...extra },
              'KITCHEN',
            ).expect(extra.orderItemId ? 409 : 400);
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
