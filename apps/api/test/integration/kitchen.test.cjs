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
  'Kitchen lifecycle, projections and database concurrency',
  { timeout: 120000 },
  async (t) => {
    const original = process.env.DATABASE_URL;
    const admin = new Client({ connectionString: original });
    await admin.connect();
    const schema = 'kitchen_test_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(original);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    const sql = new Client({ connectionString: url.toString() });
    await sql.connect();
    let app;
    try {
      // Populate real pre-Kitchen schema before applying the new migration.
      for (const file of fs
        .readdirSync('database/migrations')
        .sort()
        .filter((f) => f.endsWith('.sql') && f < '009'))
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
        MULTI: ['CASHIER', 'KITCHEN'],
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
      const call = (method, path, body, role = 'KITCHEN') => {
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
        { variantId: half, quantity: 1, instruction: 'Nothing spicy' },
        { variantId: full, quantity: 1 },
      ]);
      const two = await confirm([
        { variantId: full, quantity: 2, instruction: 'Extra spicy' },
      ]);
      const three = await confirm([{ variantId: half, quantity: 2 }]);
      const state = async () =>
        (await call('get', '/kitchen/orders').expect(200)).body;
      const transition = (o, action, role = 'KITCHEN') =>
        call('post', `/kitchen/orders/${o.id}/${action}`, undefined, role);
      await t.test(
        '009 preserves existing rows including orders, items, histories, menu, users and audits',
        async () => {
          const tables = [
            'users',
            'user_roles',
            'auth_sessions',
            'user_audit',
            'menu_categories',
            'menu_items',
            'item_variants',
            'variant_channel_settings',
            'menu_audit',
            'menu_images',
            'orders',
            'order_items',
            'order_status_history',
            'order_daily_tokens',
          ];
          const snapshot = async () => {
            const out = {};
            for (const table of tables)
              out[table] = (
                await sql.query(
                  `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
                )
              ).rows;
            return out;
          };
          const before = await snapshot();
          await sql.query('BEGIN');
          await sql.query(
            fs.readFileSync(
              'database/migrations/009_kitchen_lifecycle.sql',
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
                f.endsWith('.sql') && f > '009' + String.fromCharCode(65535),
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
        'FIFO Kitchen projection and instruction-aware production have no financial fields',
        async () => {
          const s = await state();
          assert.deepEqual(
            s.queued.map((o) => o.orderId),
            [one.id, two.id, three.id],
          );
          assert.equal(s.nextOrderId, one.id);
          assert.equal(s.preparing.length, 0);
          assert.deepEqual(
            s.queued[0].items.map((i) => i.instruction),
            ['Nothing spicy', ''],
          );
          assert.equal(s.queued[0].tokenNumber, one.tokenNumber);
          assert.equal(s.production.queued.length, 2);
          assert.deepEqual(
            s.production.queued.map((g) => [g.itemName, g.totalQuantity]),
            [
              ['Manchurian', 3],
              ['Soya Chaap Gravy', 3],
            ],
          );
          assert.deepEqual(
            s.production.queued[0].sources.map((x) => [
              x.orderId,
              x.quantity,
              x.instruction,
            ]),
            [
              [one.id, 1, 'Nothing spicy'],
              [three.id, 2, ''],
            ],
          );
          assert.equal(
            s.production.queued[1].sources[1].instruction,
            'Extra spicy',
          );
          assert.doesNotMatch(
            JSON.stringify(s),
            /price|subtotal|tax|paymentLedger|grandTotal|requestHash/i,
          );
          const p = (await call('get', '/kitchen/production').expect(200)).body;
          assert.deepEqual(p.queued, s.production.queued);
        },
      );
      await t.test(
        'authorization, multi-role unions and strict body/query/identifier boundaries',
        async () => {
          await request(app.getHttpServer())
            .get('/api/kitchen/orders')
            .expect(401);
          await request(app.getHttpServer())
            .post(`/api/kitchen/orders/${one.id}/start`)
            .set('X-DukanOS-Request', '1')
            .expect(401);
          for (const role of ['CASHIER', 'DISPATCH']) {
            await call('get', '/kitchen/orders', undefined, role).expect(403);
            await transition(one, 'start', role).expect(403);
          }
          for (const role of ['OWNER', 'MANAGER', 'MULTI'])
            await call('get', '/kitchen/orders', undefined, role).expect(200);
          await call('get', '/kitchen/orders?status=READY').expect(400);
          await call('get', '/kitchen/production?unexpected=1').expect(400);
          await call('post', `/kitchen/orders/${one.id}/start`, {
            status: 'READY',
          }).expect(400);
          await call('post', '/kitchen/orders/invalid/start').expect(400);
          await call('post', `/kitchen/orders/${randomUUID()}/start`).expect(
            404,
          );
          await request(app.getHttpServer())
            .post(`/api/kitchen/orders/${one.id}/start`)
            .set('Cookie', cookies.KITCHEN)
            .expect(403);
        },
      );
      await t.test(
        'FIFO rejects younger token, concurrent START creates exactly one audited transition',
        async () => {
          await transition(two, 'start')
            .expect(409)
            .expect((r) => assert.equal(r.body.code, 'OLDER_ORDER_WAITING'));
          await transition(one, 'ready')
            .expect(409)
            .expect((r) =>
              assert.equal(r.body.code, 'INVALID_ORDER_TRANSITION'),
            );
          const results = await Promise.all([
            transition(one, 'start'),
            transition(one, 'start'),
          ]);
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
          assert.equal(
            results.find((r) => r.status === 409).body.code,
            'ORDER_ALREADY_STARTED',
          );
          const s = await state();
          assert.equal(s.nextOrderId, two.id);
          assert.deepEqual(
            s.preparing.map((o) => o.orderId),
            [one.id],
          );
          assert.ok(s.preparing[0].preparingAt);
          assert.deepEqual(
            s.production.queued.map((g) => g.totalQuantity),
            [2, 2],
          );
          assert.deepEqual(
            s.production.preparing.map((g) => g.totalQuantity),
            [1, 1],
          );
          const h = (
            await sql.query(
              'SELECT * FROM order_status_history WHERE order_id=$1 ORDER BY occurred_at',
              [one.id],
            )
          ).rows;
          assert.equal(h.length, 2);
          assert.equal(h[1].actor_id, identities.KITCHEN.id);
          assert.equal(h[1].from_status, 'QUEUED');
          assert.equal(h[1].to_status, 'PREPARING');
        },
      );
      await t.test(
        'parallel preparing, concurrent READY, terminal rejection and immutable financials',
        async () => {
          await transition(two, 'start', 'MANAGER').expect(200);
          const results = await Promise.all([
            transition(one, 'ready', 'OWNER'),
            transition(one, 'ready', 'OWNER'),
          ]);
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
          const s = await state();
          assert.deepEqual(
            s.queued.map((o) => o.orderId),
            [three.id],
          );
          assert.deepEqual(
            s.preparing.map((o) => o.orderId),
            [two.id],
          );
          assert.equal(s.production.preparing[0].totalQuantity, 2);
          assert.ok(!JSON.stringify(s).includes(one.id));
          const saved = (
            await call('get', '/orders/' + one.id, undefined, 'CASHIER').expect(
              200,
            )
          ).body;
          assert.deepEqual({ ...saved, status: one.status }, one);
          await transition(one, 'start').expect(409);
          await transition(one, 'ready').expect(409);
          assert.equal(
            (
              await sql.query(
                'SELECT count(*)::int AS n FROM order_status_history WHERE order_id=$1',
                [one.id],
              )
            ).rows[0].n,
            3,
          );
          await transition(three, 'start', 'MULTI').expect(200);
        },
      );
      await t.test(
        'snapshotted variants and independent notes survive menu renames and pricing edits',
        async () => {
          const four = await confirm(
            [
              { variantId: half, quantity: 1, instruction: 'Nothing spicy' },
              {
                variantId: manchurian.variants.find((v) => v.name === 'Full')
                  .id,
                quantity: 1,
                instruction: 'Extra spicy',
              },
            ],
            'MULTI',
          );
          await call(
            'patch',
            '/menu/items/' + manchurian.id,
            { version: manchurian.version, name: 'Changed menu name' },
            'OWNER',
          ).expect(200);
          const s = await state();
          const o = s.queued.find((o) => o.orderId === four.id);
          assert.deepEqual(
            o.items.map((i) => [i.itemName, i.variantName, i.instruction]),
            [
              ['Manchurian', 'Half', 'Nothing spicy'],
              ['Manchurian', 'Full', 'Extra spicy'],
            ],
          );
          assert.equal(s.production.queued.length, 2);
          await transition(four, 'start').expect(200);
        },
      );
      await t.test(
        'database independently rejects unaudited changes, illegal history, FIFO bypass and snapshot changes',
        async () => {
          const a = await confirm([{ variantId: full, quantity: 1 }]),
            b = await confirm([{ variantId: full, quantity: 1 }]);
          for (const query of [
            "UPDATE orders SET status='PREPARING' WHERE id=$1",
            'UPDATE orders SET subtotal=subtotal+1,grand_total=grand_total+1 WHERE id=$1',
            "UPDATE order_items SET instruction='changed' WHERE order_id=$1",
            'DELETE FROM orders WHERE id=$1',
            'DELETE FROM order_status_history WHERE order_id=$1',
          ])
            await assert.rejects(
              sql.query(query, [a.id]),
              (e) => e.code === '23514',
            );
          await assert.rejects(
            sql.query(
              "INSERT INTO order_status_history VALUES($1,$2,'QUEUED','PREPARING',$3,clock_timestamp(),'invalid skip')",
              [randomUUID(), b.id, owner.id],
            ),
            (e) => e.message === 'OLDER_ORDER_WAITING',
          );
          await assert.rejects(
            sql.query(
              "INSERT INTO order_status_history VALUES($1,$2,'QUEUED','READY',$3,clock_timestamp(),'invalid jump')",
              [randomUUID(), a.id, owner.id],
            ),
            (e) => e.code === '23514',
          );
          await sql.query('BEGIN');
          await sql.query(
            "INSERT INTO order_status_history VALUES($1,$2,'QUEUED','PREPARING',$3,clock_timestamp(),'rollback test')",
            [randomUUID(), a.id, owner.id],
          );
          await sql.query('ROLLBACK');
          assert.equal((await state()).nextOrderId, a.id);
          await transition(a, 'start').expect(200);
          await transition(b, 'start').expect(200);
        },
      );
      await t.test(
        'old business dates remain active and equal queued timestamps use UUID tie-breaking',
        async () => {
          const ids = [
            '10000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000002',
          ];
          for (const [index, id] of ids.entries()) {
            await sql.query('BEGIN');
            await sql.query(
              `INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,to_jsonb(o)||jsonb_build_object('id',$2::text,'request_id',$3::text,'status','QUEUED','business_date','2000-01-01','queued_at','2000-01-01T10:00:00Z','token_number',$4::int))).* FROM orders o WHERE id=$1`,
              [one.id, id, randomUUID(), index + 1],
            );
            await sql.query(
              `INSERT INTO order_items SELECT (jsonb_populate_record(NULL::order_items,to_jsonb(i)||jsonb_build_object('id',gen_random_uuid(),'order_id',$2::text))).* FROM order_items i WHERE order_id=$1`,
              [one.id, id],
            );
            await sql.query(
              "INSERT INTO order_status_history VALUES($1,$2,'DRAFT','QUEUED',$3,'2000-01-01T10:00:00Z','Old order fixture')",
              [randomUUID(), id, one.confirmedBy],
            );
            await sql.query('COMMIT');
          }
          assert.deepEqual(
            (await state()).queued.map((o) => o.orderId),
            ids,
          );
          await transition({ id: ids[1] }, 'start').expect(409);
          await transition({ id: ids[0] }, 'start').expect(200);
          await transition({ id: ids[1] }, 'start').expect(200);
        },
      );
      await t.test(
        'session revocation while START waits is rechecked inside the transaction',
        async () => {
          const target = await confirm([{ variantId: full, quantity: 1 }]);
          await sql.query('BEGIN');
          await sql.query('SELECT pg_advisory_xact_lock(742019323)');
          const pending = transition(target, 'start', 'MULTI').then((r) => r);
          try {
            for (let i = 0; i < 100; i++) {
              const waiting = await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%pg_advisory_xact_lock(742019323)%'",
              );
              if (waiting.rowCount) break;
              if (i === 99) assert.fail('START did not reach transaction lock');
              await new Promise((r) => setTimeout(r, 20));
            }
            await sql.query('DELETE FROM auth_sessions WHERE user_id=$1', [
              identities.MULTI.id,
            ]);
            await sql.query('COMMIT');
          } catch (error) {
            await sql.query('ROLLBACK');
            throw error;
          }
          assert.equal((await pending).status, 401);
          assert.equal((await state()).nextOrderId, target.id);
        },
      );
      await t.test(
        'late transition failure rolls status/history back; expired sessions cannot mutate',
        async () => {
          const s = await state(),
            target = s.preparing[0];
          await sql.query(
            "CREATE FUNCTION kitchen_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$",
          );
          await sql.query(
            'CREATE TRIGGER kitchen_test_fail AFTER INSERT ON order_status_history FOR EACH ROW EXECUTE FUNCTION kitchen_test_fail()',
          );
          await call('post', `/kitchen/orders/${target.orderId}/ready`).expect(
            500,
          );
          await sql.query(
            'DROP TRIGGER kitchen_test_fail ON order_status_history',
          );
          assert.ok(
            (await state()).preparing.some((o) => o.orderId === target.orderId),
          );
          await sql.query('DELETE FROM auth_sessions WHERE user_id=$1', [
            identities.KITCHEN.id,
          ]);
          await call('post', `/kitchen/orders/${target.orderId}/ready`).expect(
            401,
          );
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
