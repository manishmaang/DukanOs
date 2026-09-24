const { legacyOrder } = require('../fixtures/legacy-order.cjs');
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
  'Dispatch handover, history, permissions and concurrency',
  { timeout: 120000 },
  async (t) => {
    const original = process.env.DATABASE_URL;
    const admin = new Client({ connectionString: original });
    await admin.connect();
    const schema = 'dispatch_test_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(original);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    const sql = new Client({ connectionString: url.toString() });
    await sql.connect();
    let app;
    try {
      // Seed existing READY orders before applying Dispatch migration.
      for (const file of fs
        .readdirSync('database/migrations')
        .sort()
        .filter((f) => f.endsWith('.sql') && f < '011'))
        await sql.query(fs.readFileSync('database/migrations/' + file, 'utf8'));
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
      for (const [name, roles] of Object.entries({
        OWNER: ['OWNER'],
        MANAGER: ['MANAGER'],
        CASHIER: ['CASHIER'],
        KITCHEN: ['KITCHEN'],
        DISPATCH: ['DISPATCH'],
        MULTI: ['CASHIER', 'DISPATCH'],
        COOK_DISPATCH: ['KITCHEN', 'DISPATCH'],
      })) {
        if (name !== 'OWNER')
          identities[name] = await users.create(
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
      const call = (method, path, body, role = 'DISPATCH') => {
        const agent = request(app.getHttpServer());
        let r = agent[method]('/api' + path)
          .set('Cookie', cookies[role])
          .set('X-DukanOS-Request', '1');
        if (body !== undefined) r = r.send(body);
        return r;
      };
      const cat = (
        await call(
          'post',
          '/menu/categories',
          { name: 'Kitchen fixture' },
          'OWNER',
        ).expect(201)
      ).body;
      const make = async (name, portions) =>
        (
          await call(
            'post',
            '/menu/items',
            {
              categoryId: cat.id,
              name,
              variants: portions.map((name) => ({
                name,
                channels: [
                  { channelCode: 'COUNTER', price: '100', available: true },
                ],
              })),
            },
            'OWNER',
          ).expect(201)
        ).body;
      const manchurian = await make('Manchurian', ['Half', 'Full']);
      const soya = await make('Soya Chaap Gravy', ['Full']);
      const half = manchurian.variants.find((v) => v.name === 'Half').id,
        full = soya.variants[0].id;
      let upgraded = false;
      const confirm = async (lines, role = 'CASHIER') =>
        !upgraded
          ? legacyOrder(sql, identities[role].id, lines)
          : (
              await call(
                'post',
                '/orders/counter',
                { requestId: randomUUID(), serviceType: 'DINE_IN', lines },
                role,
              ).expect(201)
            ).body;
      const one = await confirm([
        { variantId: half, quantity: 1, instruction: 'No onion' },
        { variantId: half, quantity: 2 },
        { variantId: full, quantity: 1, instruction: 'Extra spicy' },
      ]);
      const two = await confirm([{ variantId: full, quantity: 2 }]);
      const three = await confirm([{ variantId: half, quantity: 3 }]);
      const transition = (o, action) =>
        call('post', `/kitchen/orders/${o.id}/${action}`, undefined, 'KITCHEN');
      const complete = (o, role = 'DISPATCH') =>
        call('post', `/dispatch/orders/${o.id}/complete`, undefined, role);
      const state = async (role = 'DISPATCH') =>
        (await call('get', '/dispatch/orders', undefined, role).expect(200))
          .body;
      await transition(one, 'start').expect(200);
      await transition(two, 'start').expect(200);
      // Ready order is deliberately different from token/queued order.
      await transition(two, 'ready').expect(200);
      await transition(one, 'ready').expect(200);
      await t.test(
        '011 preserves all existing tables and existing READY orders',
        async () => {
          const tables = (
            await sql.query(
              'SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename',
            )
          ).rows;
          const snapshot = async () => {
            const result = {};
            for (const { tablename } of tables)
              result[tablename] = (
                await sql.query(
                  `SELECT to_jsonb(t) AS row FROM "${tablename}" t ORDER BY to_jsonb(t)::text`,
                )
              ).rows;
            return result;
          };
          const before = await snapshot();
          await sql.query('BEGIN');
          await sql.query(
            fs.readFileSync(
              'database/migrations/011_dispatch_handoff.sql',
              'utf8',
            ),
          );
          await sql.query('COMMIT');
          assert.deepEqual(await snapshot(), before);
          for (const file of fs
            .readdirSync('database/migrations')
            .sort()
            .filter(
              (f) =>
                f.endsWith('.sql') && f > '011' + String.fromCharCode(65535),
            ))
            await sql.query(
              fs.readFileSync('database/migrations/' + file, 'utf8'),
            );
          upgraded = true;
          for (const order of [one, two, three])
            Object.assign(
              order,
              (
                await call(
                  'get',
                  '/orders/' + order.id,
                  undefined,
                  'CASHIER',
                ).expect(200)
              ).body,
            );
        },
      );
      await t.test(
        'READY only ordered by ready timestamp, immutable item/portion/note snapshots and no financials',
        async () => {
          const s = await state();
          assert.deepEqual(
            s.orders.map((o) => o.orderId),
            [two.id, one.id],
          );
          assert.equal(s.lateThresholdMinutes, 5);
          assert.ok(s.serverTime && s.businessDate);
          assert.equal(s.orders[1].source, 'COUNTER');
          assert.deepEqual(
            s.orders[1].items.map((i) => [
              i.itemName,
              i.variantName,
              i.quantity,
              i.instruction,
            ]),
            [
              ['Manchurian', 'Half', 1, 'No onion'],
              ['Manchurian', 'Half', 2, ''],
              ['Soya Chaap Gravy', 'Full', 1, 'Extra spicy'],
            ],
          );
          await call(
            'patch',
            '/menu/items/' + manchurian.id,
            { version: manchurian.version, name: 'Renamed dish' },
            'OWNER',
          ).expect(200);
          assert.equal(
            (await state()).orders[1].items[0].itemName,
            'Manchurian',
          );
          assert.doesNotMatch(
            JSON.stringify(s),
            /price|subtotal|tax|paymentLedger|grandTotal|requestHash|confirmedBy|kitchenName/i,
          );
          await transition(three, 'start').expect(200);
          assert.deepEqual(
            (await state()).orders.map((o) => o.orderId),
            [two.id, one.id],
          );
        },
      );
      await t.test(
        'RBAC, sessions, mutation header, UUID and strict empty input boundaries',
        async () => {
          await request(app.getHttpServer())
            .get('/api/dispatch/orders')
            .expect(401);
          await request(app.getHttpServer())
            .post(`/api/dispatch/orders/${one.id}/complete`)
            .set('X-DukanOS-Request', '1')
            .expect(401);
          for (const role of ['CASHIER', 'KITCHEN']) {
            await call('get', '/dispatch/orders', undefined, role).expect(403);
            await complete(one, role).expect(403);
          }
          for (const role of [
            'OWNER',
            'MANAGER',
            'DISPATCH',
            'MULTI',
            'COOK_DISPATCH',
          ])
            await state(role);
          await call('get', '/dispatch/orders?status=READY').expect(400);
          await call('post', `/dispatch/orders/${one.id}/complete`, {}).expect(
            400,
          );
          await call('post', `/dispatch/orders/${one.id}/complete`, {
            status: 'COMPLETED',
          }).expect(400);
          await call(
            'post',
            `/dispatch/orders/${one.id}/complete?force=true`,
          ).expect(400);
          await call('post', '/dispatch/orders/invalid/complete').expect(400);
          await complete({ id: randomUUID() }).expect(404);
          await request(app.getHttpServer())
            .post(`/api/dispatch/orders/${one.id}/complete`)
            .set('Cookie', cookies.DISPATCH)
            .expect(403);
          await call('get', '/orders/' + one.id).expect(403);
        },
      );
      await t.test(
        'non-READY rejection, concurrent completion exactly once and full lifecycle history',
        async () => {
          const queued = await confirm([{ variantId: half, quantity: 1 }]);
          for (const o of [queued, three])
            await complete(o)
              .expect(409)
              .expect((r) =>
                assert.equal(r.body.code, 'INVALID_ORDER_TRANSITION'),
              );
          const before = (
            await sql.query(
              'SELECT * FROM order_items WHERE order_id=$1 ORDER BY position',
              [one.id],
            )
          ).rows;
          const results = await Promise.all([complete(one), complete(one)]);
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
          assert.equal(
            results.find((r) => r.status === 409).body.code,
            'ORDER_ALREADY_COMPLETED',
          );
          assert.equal(
            results.find((r) => r.status === 200).body.status,
            'COMPLETED',
          );
          await complete(one).expect(409);
          const h = (
            await sql.query(
              'SELECT * FROM order_status_history WHERE order_id=$1 ORDER BY occurred_at',
              [one.id],
            )
          ).rows;
          assert.deepEqual(
            h.map((x) => x.to_status),
            ['QUEUED', 'PREPARING', 'READY', 'COMPLETED'],
          );
          assert.equal(h[3].from_status, 'READY');
          assert.equal(h[3].actor_id, identities.DISPATCH.id);
          assert.ok(h[3].occurred_at >= h[2].occurred_at);
          assert.deepEqual(
            (
              await sql.query(
                'SELECT * FROM order_items WHERE order_id=$1 ORDER BY position',
                [one.id],
              )
            ).rows,
            before,
          );
          const saved = (
            await call('get', '/orders/' + one.id, undefined, 'CASHIER').expect(
              200,
            )
          ).body;
          assert.deepEqual({ ...saved, status: one.status }, one);
          assert.deepEqual(
            (await state()).orders.map((o) => o.orderId),
            [two.id],
          );
          assert.equal(
            (await state('MULTI')).orders.some((o) => o.orderId === one.id),
            false,
          );
          await transition(queued, 'start').expect(200);
        },
      );
      await t.test(
        'OWNER, MANAGER and multi-role handovers use the same capability union',
        async () => {
          for (const role of ['OWNER', 'MANAGER', 'MULTI', 'COOK_DISPATCH']) {
            const o = await confirm([{ variantId: half, quantity: 1 }]);
            await transition(o, 'start').expect(200);
            await transition(o, 'ready').expect(200);
            assert.ok(
              (await state(role)).orders.some((x) => x.orderId === o.id),
            );
            await complete(o, role).expect(200);
            assert.equal(
              (
                await sql.query(
                  "SELECT actor_id FROM order_status_history WHERE order_id=$1 AND to_status='COMPLETED'",
                  [o.id],
                )
              ).rows[0].actor_id,
              identities[role].id,
            );
          }
        },
      );
      await t.test(
        'database guards prevent unaudited completion, rewinds, changes and late failure rolls back',
        async () => {
          for (const query of [
            "UPDATE orders SET status='COMPLETED' WHERE id=$1",
            'UPDATE orders SET grand_total=grand_total+1 WHERE id=$1',
            'DELETE FROM order_status_history WHERE order_id=$1',
          ])
            await assert.rejects(
              sql.query(query, [two.id]),
              (e) => e.code === '23514',
            );
          await assert.rejects(
            sql.query("UPDATE orders SET status='READY' WHERE id=$1", [one.id]),
            (e) => e.code === '23514',
          );
          await assert.rejects(
            sql.query(
              "INSERT INTO order_status_history VALUES($1,$2,'PREPARING','COMPLETED',$3,clock_timestamp(),'Invalid jump')",
              [randomUUID(), three.id, owner.id],
            ),
            (e) => e.code === '23514',
          );
          await sql.query(
            "CREATE FUNCTION dispatch_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$",
          );
          await sql.query(
            'CREATE TRIGGER dispatch_test_fail AFTER INSERT ON order_status_history FOR EACH ROW EXECUTE FUNCTION dispatch_test_fail()',
          );
          await complete(two).expect(500);
          await sql.query(
            'DROP TRIGGER dispatch_test_fail ON order_status_history',
          );
          assert.ok((await state()).orders.some((o) => o.orderId === two.id));
          assert.equal(
            (
              await sql.query(
                "SELECT count(*)::int n FROM order_status_history WHERE order_id=$1 AND to_status='COMPLETED'",
                [two.id],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'equal READY timestamps sort by UUID deterministically',
        async () => {
          const orders = [];
          for (let i = 0; i < 2; i++) {
            const o = await confirm([{ variantId: full, quantity: 1 }]);
            await transition(o, 'start').expect(200);
            orders.push(o);
          }
          const stamp = (
            await sql.query("SELECT clock_timestamp()+interval '1 second' AS t")
          ).rows[0].t;
          for (const o of orders)
            await sql.query(
              "INSERT INTO order_status_history VALUES($1,$2,'PREPARING','READY',$3,$4,'Tie fixture')",
              [randomUUID(), o.id, owner.id, stamp],
            );
          const expected = orders.map((o) => o.id).sort();
          assert.deepEqual(
            (await state()).orders
              .filter((o) => expected.includes(o.orderId))
              .map((o) => o.orderId),
            expected,
          );
        },
      );
      await t.test(
        'session revoked while completion waits cannot mutate',
        async () => {
          await sql.query('BEGIN');
          await sql.query('SELECT pg_advisory_xact_lock(742019323)');
          const pending = complete(two, 'MULTI').then((r) => r);
          try {
            for (let i = 0; i < 100; i++) {
              const waiting = await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%pg_advisory_xact_lock(742019323)%'",
              );
              if (waiting.rowCount) break;
              if (i === 99) assert.fail('Completion did not reach lock');
              await new Promise((r) => setTimeout(r, 20));
            }
            await sql.query('DELETE FROM auth_sessions WHERE user_id=$1', [
              identities.MULTI.id,
            ]);
            await sql.query('COMMIT');
          } catch (e) {
            await sql.query('ROLLBACK');
            throw e;
          }
          assert.equal((await pending).status, 401);
          assert.ok((await state()).orders.some((o) => o.orderId === two.id));
        },
      );
    } finally {
      if (app) await app.close();
      await sql.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      process.env.DATABASE_URL = original;
    }
  },
);
