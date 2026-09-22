require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { Test } = require('@nestjs/testing');
const request = require('supertest');
const { AppModule } = require('../../dist/app.module');
const { configureApp } = require('../../dist/configure-app');
const { UsersService } = require('../../dist/modules/users/users.service');
test(
  'Counter orders PostgreSQL transactions and HTTP contracts',
  { timeout: 120000 },
  async (t) => {
    const original = process.env.DATABASE_URL;
    const admin = new Client({ connectionString: original });
    await admin.connect();
    const schema = 'orders_test_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(original);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    const sql = new Client({ connectionString: url.toString() });
    let app;
    async function start() {
      const m = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = m.createNestApplication();
      configureApp(app);
      await app.init();
    }
    try {
      for (let i = 0; i < 2; i++) {
        const run = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
          env: process.env,
          encoding: 'utf8',
        });
        assert.equal(run.status, 0, run.stdout + run.stderr);
      }
      await sql.connect();
      await start();
      const users = app.get(UsersService),
        password = 'orders test password 123!';
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
        const login = await request(app.getHttpServer())
          .post('/api/auth/login')
          .set('X-DukanOS-Request', '1')
          .send({ username: role.toLowerCase(), password })
          .expect(200);
        cookies[role] = login.headers['set-cookie'][0].split(';')[0];
      }
      const call = (method, path, body, role = 'CASHIER') => {
        const agent = request(app.getHttpServer());
        let req = agent[method]('/api' + path)
          .set('Cookie', cookies[role])
          .set('X-DukanOS-Request', '1');
        if (body !== undefined) req = req.send(body);
        return req;
      };
      const category = (
        await call(
          'post',
          '/menu/categories',
          { name: 'Soya Chaap' },
          'OWNER',
        ).expect(201)
      ).body;
      let item = (
        await call(
          'post',
          '/menu/items',
          {
            categoryId: category.id,
            name: 'Soya Chaap Gravy',
            kitchenName: 'Chaap',
            variants: [
              {
                name: 'Full',
                channels: [
                  { channelCode: 'COUNTER', price: '181.50', available: true },
                  { channelCode: 'SWIGGY', price: '250', available: true },
                ],
              },
              {
                name: 'Half',
                channels: [
                  { channelCode: 'COUNTER', price: '120', available: true },
                ],
              },
            ],
          },
          'OWNER',
        ).expect(201)
      ).body;
      const full = item.variants.find((v) => v.name === 'Full').id,
        half = item.variants.find((v) => v.name === 'Half').id;
      const input = (
        lines = [{ variantId: full, quantity: 2, instruction: 'Extra spicy' }],
      ) => ({ requestId: randomUUID(), lines });
      const confirm = (body = input(), role) =>
        call('post', '/orders/counter', body, role);
      const refresh = async () =>
        (item = (
          await call(
            'get',
            '/menu/items/' + item.id,
            undefined,
            'OWNER',
          ).expect(200)
        ).body);
      let first, firstInput;
      await t.test(
        'Counter snapshots, multiple variants, plain instructions, exact totals and actor/history',
        async () => {
          firstInput = input([
            { variantId: full, quantity: 2, instruction: 'Extra spicy' },
            { variantId: half, quantity: 1, instruction: '<b>No onion</b>' },
            { variantId: full, quantity: 1, instruction: 'No vegetables' },
          ]);
          first = (await confirm(firstInput).expect(201)).body;
          assert.equal(first.status, 'QUEUED');
          assert.equal(first.tokenNumber, 1);
          assert.equal(first.subtotal, '664.50');
          assert.equal(first.grandTotal, '664.50');
          assert.equal(first.taxTotal, '0.00');
          assert.equal(first.roundingAdjustment, '0.00');
          assert.equal(first.items.length, 3);
          assert.equal(first.items[1].instruction, '<b>No onion</b>');
          assert.equal(first.items[0].unitPrice, '181.50');
          assert.equal(first.items[0].kitchenName, 'Chaap');
          const history = (
            await sql.query(
              'SELECT * FROM order_status_history WHERE order_id=$1',
              [first.id],
            )
          ).rows;
          assert.equal(history.length, 1);
          assert.equal(history[0].from_status, 'DRAFT');
          assert.equal(history[0].to_status, 'QUEUED');
          assert.equal(history[0].actor_id, first.confirmedBy);
          assert.equal(
            (
              await call(
                'get',
                `/orders/tokens/${first.businessDate}/1`,
              ).expect(200)
            ).body.id,
            first.id,
          );
        },
      );
      await t.test(
        'authentication, capability and strict malformed/money payload boundaries',
        async () => {
          await request(app.getHttpServer())
            .post('/api/orders/counter')
            .set('X-DukanOS-Request', '1')
            .send(input())
            .expect(401);
          for (const role of ['KITCHEN', 'DISPATCH'])
            await confirm(input(), role).expect(403);
          for (const role of ['OWNER', 'MANAGER'])
            await confirm(input(), role).expect(201);
          await call(
            'get',
            '/orders?status=QUEUED',
            undefined,
            'KITCHEN',
          ).expect(200);
          for (const quantity of [0, -1, 1.5, 100, 99999999, '2', null])
            await confirm(input([{ variantId: full, quantity }])).expect(400);
          for (const body of [
            { ...input(), price: 1 },
            input([{ variantId: full, quantity: 1, price: 1 }]),
            input([]),
            input([{ variantId: 'bad', quantity: 1 }]),
            input([
              { variantId: full, quantity: 1, instruction: 'x'.repeat(501) },
            ]),
            input([{ variantId: full, quantity: 1, instruction: null }]),
            { ...input(), requestId: 'invalid' },
          ])
            await confirm(body).expect(400);
          await call('get', '/orders?unexpected=1').expect(400);
          await call('get', '/orders?businessDate=2026-02-30').expect(400);
          await call('get', '/orders/tokens/2026-02-30/1').expect(400);
          await call('get', '/orders/tokens/2026-09-22/9999999999').expect(400);
          await call('patch', '/orders/' + first.id, {
            status: 'READY',
          }).expect(404);
        },
      );
      await t.test(
        'concurrent confirmations allocate unique consecutive daily tokens; repeated request once only',
        async () => {
          const responses = await Promise.all(
            Array.from({ length: 8 }, () => confirm().expect(201)),
          );
          assert.equal(
            new Set(responses.map((r) => r.body.tokenNumber)).size,
            8,
          );
          const retry = input();
          const repeated = await Promise.all(
            Array.from({ length: 5 }, () => confirm(retry).expect(201)),
          );
          assert.equal(new Set(repeated.map((r) => r.body.id)).size, 1);
          assert.equal(
            (
              await sql.query(
                'SELECT count(*)::int AS n FROM orders WHERE request_id=$1',
                [retry.requestId],
              )
            ).rows[0].n,
            1,
          );
          await confirm({ ...retry, lines: [{ variantId: half, quantity: 1 }] })
            .expect(409)
            .expect((r) => assert.equal(r.body.code, 'IDEMPOTENCY_CONFLICT'));
          const tokens = (
            await sql.query(
              'SELECT token_number FROM orders ORDER BY token_number',
            )
          ).rows.map((r) => r.token_number);
          assert.deepEqual(
            tokens,
            Array.from({ length: tokens.length }, (_, i) => i + 1),
          );
          const date = (
            await sql.query(
              "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date::text AS date",
            )
          ).rows[0].date;
          assert.equal(first.businessDate, date);
          await sql.query(
            "INSERT INTO order_daily_tokens VALUES ('2020-01-01',47)",
          );
          assert.equal(
            (await confirm().expect(201)).body.tokenNumber,
            tokens.length + 1,
          );
        },
      );
      await t.test(
        'menu edits never change history; idempotent replay ignores later prices and unavailable state',
        async () => {
          await refresh();
          item = (
            await call(
              'patch',
              '/menu/items/' + item.id,
              { version: item.version, name: 'Renamed Chaap' },
              'OWNER',
            ).expect(200)
          ).body;
          item = (
            await call(
              'put',
              `/menu/variants/${full}/channels/COUNTER/price`,
              { itemVersion: item.version, price: '200' },
              'OWNER',
            ).expect(200)
          ).body;
          assert.deepEqual(
            (await call('get', '/orders/' + first.id).expect(200)).body,
            first,
          );
          assert.equal(
            (await confirm().expect(201)).body.items[0].unitPrice,
            '200.00',
          );
          await call('patch', `/menu/counter/items/${item.id}/availability`, {
            version: item.version,
            available: false,
          }).expect(200);
          await confirm()
            .expect(409)
            .expect((r) => assert.equal(r.body.code, 'ITEM_NOT_AVAILABLE'));
          assert.deepEqual((await confirm(firstInput).expect(201)).body, first);
          await refresh();
          await call('patch', `/menu/counter/items/${item.id}/availability`, {
            version: item.version,
            available: true,
          }).expect(200);
        },
      );
      await t.test(
        'sold out transaction wins race before confirmation; no partial order or token consumption',
        async () => {
          const before = (
            await sql.query('SELECT count(*)::int AS n FROM orders')
          ).rows[0].n;
          await sql.query('BEGIN');
          await sql.query('SELECT pg_advisory_xact_lock(742019323)');
          const pending = confirm().then((r) => r);
          // Wait until confirmation is actually blocked on our lock.
          for (let i = 0; i < 100; i++) {
            const waiting = await admin.query(
              "SELECT 1 FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%pg_advisory_xact_lock(742019323)%'",
            );
            if (waiting.rowCount) break;
            await new Promise((r) => setTimeout(r, 20));
            if (i === 99)
              assert.fail('Confirmation never waited for menu lock');
          }
          await sql.query(
            "UPDATE variant_channel_settings SET available=false WHERE variant_id=$1 AND channel_code='COUNTER'",
            [full],
          );
          await sql.query('COMMIT');
          const response = await pending;
          assert.equal(response.status, 409);
          assert.equal(response.body.code, 'ITEM_NOT_AVAILABLE');
          assert.match(response.body.message, /Line 1/);
          assert.equal(
            (await sql.query('SELECT count(*)::int AS n FROM orders')).rows[0]
              .n,
            before,
          );
          await refresh();
          await call('patch', `/menu/counter/items/${item.id}/availability`, {
            version: item.version,
            available: true,
          }).expect(200);
          await refresh();
          item = (
            await call(
              'patch',
              '/menu/items/' + item.id,
              { version: item.version, active: false },
              'OWNER',
            ).expect(200)
          ).body;
          await confirm().expect(409);
          item = (
            await call(
              'patch',
              '/menu/items/' + item.id,
              { version: item.version, active: true },
              'OWNER',
            ).expect(200)
          ).body;
        },
      );
      await t.test(
        'PostgreSQL snapshots, history and sealed aggregates cannot be rewritten or appended',
        async () => {
          for (const query of [
            'UPDATE orders SET grand_total=1 WHERE id=$1',
            'DELETE FROM orders WHERE id=$1',
            'UPDATE order_items SET quantity=2 WHERE order_id=$1',
            'DELETE FROM order_status_history WHERE order_id=$1',
            `INSERT INTO order_items SELECT gen_random_uuid(),order_id,99,menu_item_id,variant_id,item_name_snapshot,kitchen_name_snapshot,variant_name_snapshot,quantity,unit_price_snapshot,line_subtotal,instruction FROM order_items WHERE order_id=$1 LIMIT 1`,
          ])
            await assert.rejects(
              sql.query(query, [first.id]),
              (e) => e.code === '23514',
            );
          await sql.query('BEGIN');

          await assert.rejects(
            sql.query("INSERT INTO order_daily_tokens VALUES('2021-01-01',0)"),
            (e) => e.code === '23514',
          );
          await sql.query('ROLLBACK');
          const listing = (
            await call('get', '/orders?status=QUEUED').expect(200)
          ).body;
          assert.equal(listing.orders[0].id, first.id);
          assert.equal(listing.nextCursor, null);
          assert.ok(listing.orders.every((o) => o.status === 'QUEUED'));
          const after = (
            await call('get', '/orders?status=QUEUED&after=' + first.id).expect(
              200,
            )
          ).body;
          assert.ok(after.orders.every((o) => o.id !== first.id));
        },
      );
      await t.test(
        'late insert failure rolls back order, history and token; counters cannot rewind',
        async () => {
          const before = (
            await sql.query('SELECT count(*)::int AS n FROM orders')
          ).rows[0].n;
          const counters = (
            await sql.query(
              'SELECT business_date::text,last_token FROM order_daily_tokens ORDER BY business_date',
            )
          ).rows;
          await sql.query(
            `CREATE FUNCTION test_order_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$`,
          );
          await sql.query(
            'CREATE TRIGGER test_order_failure BEFORE INSERT ON order_status_history FOR EACH ROW EXECUTE FUNCTION test_order_failure()',
          );
          await confirm().expect(500);
          await sql.query(
            'DROP TRIGGER test_order_failure ON order_status_history',
          );
          await sql.query('DROP FUNCTION test_order_failure()');
          assert.equal(
            (await sql.query('SELECT count(*)::int AS n FROM orders')).rows[0]
              .n,
            before,
          );
          assert.deepEqual(
            (
              await sql.query(
                'SELECT business_date::text,last_token FROM order_daily_tokens ORDER BY business_date',
              )
            ).rows,
            counters,
          );
          await assert.rejects(
            sql.query(
              'UPDATE order_daily_tokens SET last_token=1 WHERE business_date=$1',
              [first.businessDate],
            ),
            (e) => e.code === '23514',
          );
          await assert.rejects(
            sql.query('DELETE FROM order_daily_tokens WHERE business_date=$1', [
              first.businessDate,
            ]),
            (e) => e.code === '23514',
          );
          await assert.rejects(
            sql.query(
              `INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,to_jsonb(o)||jsonb_build_object('id',gen_random_uuid(),'request_id',gen_random_uuid(),'token_number',100000))).* FROM orders o WHERE id=$1`,
              [first.id],
            ),
            (e) => e.code === '23514',
          );
        },
      );
      await t.test(
        'variant/category/channel inactivity and missing prices reject confirmation',
        async () => {
          for (const [table, where, values] of [
            ['item_variants', 'id=$1', [full]],
            ['menu_categories', 'id=$1', [category.id]],
            ['sales_channels', 'code=$1', ['COUNTER']],
          ]) {
            await sql.query(
              `UPDATE ${table} SET active=false WHERE ${where}`,
              values,
            );
            await confirm().expect(table === 'sales_channels' ? 400 : 409);
            // A committed replay remains retrievable even with an inactive channel.
            assert.equal(
              (await confirm(firstInput).expect(201)).body.id,
              first.id,
            );
            await sql.query(
              `UPDATE ${table} SET active=true WHERE ${where}`,
              values,
            );
          }
          const noPrice = (
            await call(
              'post',
              '/menu/items',
              {
                categoryId: category.id,
                name: 'Not priced',
                variants: [{ name: 'Single' }],
              },
              'OWNER',
            ).expect(201)
          ).body;
          await confirm(
            input([{ variantId: noPrice.variants[0].id, quantity: 1 }]),
          ).expect(409);
        },
      );
      await t.test(
        'configured tax snapshots and paise remain immutable across application configuration changes',
        async () => {
          await app.close();
          process.env.ORDER_TAX_RATE = '5';
          process.env.ORDER_TAX_LABEL = 'Configured restaurant tax';
          await start();
          const taxed = (
            await confirm(input([{ variantId: half, quantity: 1 }])).expect(201)
          ).body;
          assert.equal(taxed.taxTotal, '6.00');
          assert.equal(taxed.grandTotal, '126.00');
          assert.equal(taxed.tax.taxRate, '5.00');
          assert.equal(taxed.tax.taxLabel, 'Configured restaurant tax');
          await app.close();
          process.env.ORDER_TAX_RATE = '7.5';
          await start();
          assert.deepEqual(
            (await call('get', '/orders/' + taxed.id).expect(200)).body,
            taxed,
          );
          assert.deepEqual(
            (await call('get', '/orders/' + first.id).expect(200)).body,
            first,
          );
        },
      );
      await t.test(
        'timezone business dates have independent daily sequences',
        async () => {
          const dates = [];
          for (const timezone of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
            await app.close();
            process.env.RESTAURANT_TIMEZONE = timezone;
            await start();
            const date = (
              await sql.query(
                'SELECT (clock_timestamp() AT TIME ZONE $1)::date::text AS date',
                [timezone],
              )
            ).rows[0].date;
            const last =
              (
                await sql.query(
                  'SELECT last_token FROM order_daily_tokens WHERE business_date=$1',
                  [date],
                )
              ).rows[0]?.last_token ?? 0;
            const next = (await confirm().expect(201)).body;
            assert.equal(next.businessDate, date);
            assert.equal(next.tokenNumber, last + 1);
            dates.push(date);
            assert.equal(
              (await confirm().expect(201)).body.tokenNumber,
              last + 2,
            );
          }
          assert.notEqual(dates[0], dates[1]);
        },
      );
    } finally {
      if (app) await app.close();
      await sql.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      process.env.DATABASE_URL = original;
      delete process.env.ORDER_TAX_RATE;
      delete process.env.ORDER_TAX_LABEL;
      delete process.env.RESTAURANT_TIMEZONE;
    }
  },
);
