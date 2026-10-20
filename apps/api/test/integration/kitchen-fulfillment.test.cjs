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
const {
  cancelPreviousDayOrders,
} = require('../../dist/modules/orders/previous-day-cleanup');
test(
  'Kitchen fulfillment, serving and preserved overnight finances',
  { timeout: 120000 },
  async (t) => {
    const original = process.env.DATABASE_URL;
    const admin = new Client({ connectionString: original });
    await admin.connect();
    const schema = 'serving_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(original);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    const sql = new Client({ connectionString: url.toString() });
    await sql.connect();
    let app;
    try {
      for (const file of fs
        .readdirSync('database/migrations')
        .filter((f) => f.endsWith('.sql') && f < '022')
        .sort())
        await sql.query(fs.readFileSync('database/migrations/' + file, 'utf8'));
      const m = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = m.createNestApplication();
      configureApp(app);
      await app.init();
      const users = app.get(UsersService),
        password = randomUUID();
      const owner = await users.create({
        username: 'owner',
        name: 'Owner',
        roles: ['OWNER'],
        password,
      });
      for (const role of ['MANAGER', 'CASHIER', 'KITCHEN', 'DISPATCH'])
        await users.create(
          { username: role.toLowerCase(), name: role, roles: [role], password },
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
      const call = (role, method, path, body) => {
        const agent = request(app.getHttpServer());
        let r = agent[method]('/api' + path)
          .set('Cookie', cookies[role] ?? '')
          .set('X-DukanOS-Request', '1');
        return body === undefined ? r : r.send(body);
      };
      const cat = (
        await call('owner', 'post', '/menu/categories', {
          name: 'Serving fixtures',
        }).expect(201)
      ).body;
      const item = (
        await call('owner', 'post', '/menu/items', {
          categoryId: cat.id,
          name: 'Long Paneer Sandwich',
          variants: [
            {
              name: 'Full',
              channels: ['COUNTER', 'SWIGGY', 'ZOMATO'].map((channelCode) => ({
                channelCode,
                price: '100',
                available: true,
              })),
            },
          ],
        }).expect(201)
      ).body;
      const create = async (serviceType = 'DINE_IN', quantity = 3) =>
        (
          await call('cashier', 'post', '/orders/counter', {
            requestId: randomUUID(),
            serviceType,
            reference: 'Table 4',
            lines: [
              {
                variantId: item.variants[0].id,
                quantity,
                instruction: 'No onion',
              },
            ],
          }).expect(201)
        ).body;
      await t.test(
        '022 preserves populated menu, financial snapshots, users and existing order history',
        async () => {
          const existing = await create('DINE_IN', 1);
          const tables = (
            await sql.query(
              "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename NOT IN ('permissions','role_permissions') ORDER BY tablename",
            )
          ).rows;
          const capture = async () => {
            const data = {};
            for (const { tablename } of tables)
              data[tablename] = (
                await sql.query(
                  `SELECT to_jsonb(t) row FROM "${tablename}" t ORDER BY to_jsonb(t)::text`,
                )
              ).rows;
            return data;
          };
          const before = await capture();
          await sql.query(
            fs.readFileSync(
              'database/migrations/022_kitchen_serving.sql',
              'utf8',
            ),
          );
          assert.deepEqual(await capture(), before);
          await call(
            'kitchen',
            'post',
            `/kitchen/orders/${existing.id}/lines/${existing.items[0].id}/serve`,
            {
              requestId: randomUUID(),
              expectedRevision: 0,
              expectedServedQuantity: 0,
              quantity: 1,
            },
          ).expect(200);
        },
      );
      const state = async () =>
        (await call('kitchen', 'get', '/kitchen/orders').expect(200)).body;
      const serve = (
        order,
        quantity,
        expected = 0,
        role = 'kitchen',
        extras = {},
      ) =>
        call(
          role,
          'post',
          `/kitchen/orders/${order.id}/lines/${order.items[0].id}/serve`,
          {
            requestId: randomUUID(),
            expectedRevision: 0,
            expectedServedQuantity: expected,
            quantity,
            ...extras,
          },
        );
      await t.test(
        'partial serving, production metadata, correction and automatic completion preserve unpaid Bill',
        async () => {
          const o = await create();
          const initial = (await state()).pending.find(
            (r) => r.orderId === o.id,
          );
          assert.equal(initial.serviceType, 'DINE_IN');
          assert.equal(initial.reference, 'Table 4');
          await serve(o, 1).expect(200);
          const s = await state();
          const line = s.pending.find((r) => r.orderId === o.id).items[0];
          assert.equal(line.servedQuantity, 1);
          assert.equal(line.pendingQuantity, 2);
          assert.equal(
            s.production.pending.find((g) =>
              g.sources.some((x) => x.orderId === o.id),
            ).totalQuantity,
            2,
          );
          await serve(o, -1, 1, 'kitchen', {
            reason: 'Tapped wrong line',
          }).expect(200);
          await serve(o, 3).expect(200);
          assert.equal(
            (await sql.query('SELECT status FROM orders WHERE id=$1', [o.id]))
              .rows[0].status,
            'COMPLETED',
          );
          assert.deepEqual(
            (
              await sql.query('SELECT status FROM bills WHERE id=$1', [
                o.billId,
              ])
            ).rows[0],
            { status: 'OPEN' },
          );
          assert.equal(
            (
              await sql.query(
                'SELECT amount_due::text FROM bill_balances WHERE id=$1',
                [o.billId],
              )
            ).rows[0].amount_due,
            '300.00',
          );
          assert.deepEqual(
            (
              await sql.query(
                'SELECT to_status FROM order_status_history WHERE order_id=$1 ORDER BY occurred_at',
                [o.id],
              )
            ).rows.map((r) => r.to_status),
            ['QUEUED', 'COMPLETED'],
          );
          await serve(o, -1, 3, 'kitchen', { reason: 'Too late' }).expect(409);
        },
      );
      await t.test(
        'idempotent replay and two-device stale quantities cannot double serve',
        async () => {
          const o = await create();
          const key = randomUUID();
          const r = await Promise.all([
            serve(o, 1, 0, 'kitchen', { requestId: key }),
            serve(o, 1, 0, 'kitchen', { requestId: key }),
          ]);
          assert.deepEqual(
            r.map((x) => x.status),
            [200, 200],
          );
          const concurrent = await Promise.all([
            serve(o, 1, 1),
            serve(o, 1, 1, 'manager'),
          ]);
          assert.deepEqual(concurrent.map((x) => x.status).sort(), [200, 409]);
          await serve(o, 2, 0, 'kitchen', { requestId: key }).expect(409);
          assert.equal(
            (
              await sql.query(
                'SELECT sum(quantity)::int n FROM order_serving_events WHERE order_id=$1',
                [o.id],
              )
            ).rows[0].n,
            2,
          );
        },
      );
      await t.test(
        'permission, malformed input, revision, correction and quantity boundaries',
        async () => {
          const o = await create();
          await serve(o, 1, 0, 'cashier').expect(403);
          await serve(o, 1, 0, 'unknown').expect(401);
          await serve(o, 1, 0, 'dispatch').expect(200);
          await serve(o, 1.5, 1).expect(400);
          await serve(o, 0, 1).expect(400);
          await serve(o, 3, 1).expect(409);
          await serve(o, -1, 1).expect(400);
          await serve(o, 1, 1, 'kitchen', { expectedRevision: 1 }).expect(409);
          await serve(o, 1, 1, 'kitchen', { price: 1 }).expect(400);
          await assert.rejects(
            sql.query(
              'UPDATE order_serving_events SET quantity=2 WHERE order_id=$1',
              [o.id],
            ),
            /SERVING_HISTORY_IMMUTABLE/,
          );
        },
      );
      await t.test(
        'Parcel rejects unsettled handover and idempotently completes after payment',
        async () => {
          const o = await create('TAKEAWAY', 1);
          const path = `/kitchen/orders/${o.id}/fulfill`;
          const body = { requestId: randomUUID(), expectedRevision: 0 };
          await call('kitchen', 'post', path, body).expect(409);
          await call('cashier', 'post', `/bills/${o.billId}/payments`, {
            requestId: randomUUID(),
            method: 'CASH',
            amount: '100',
          }).expect(201);
          await call('kitchen', 'post', path, {
            ...body,
            expectedRevision: 1,
          }).expect(409);
          await call('kitchen', 'post', path, body).expect(200);
          await call('kitchen', 'post', path, body).expect(200);
          assert.equal(
            (
              await sql.query(
                'SELECT count(*)::int n FROM kitchen_fulfillments WHERE order_id=$1',
                [o.id],
              )
            ).rows[0].n,
            1,
          );
        },
      );

      await t.test(
        'serving conflicts with amendments and new requests cannot change completed rounds',
        async () => {
          const o = await create();
          const change = {
            requestId: randomUUID(),
            expectedRevision: 0,
            kind: 'CHANGE',
            reason: 'CUSTOMER_CHANGE',
            lines: [
              {
                id: o.items[0].id,
                variantId: item.variants[0].id,
                quantity: 2,
                instruction: '',
              },
            ],
          };
          const quote = (
            await call(
              'cashier',
              'post',
              `/orders/${o.id}/amendments/quote`,
              change,
            ).expect(201)
          ).body;
          await serve(o, 1).expect(200);
          const stale = await call(
            'cashier',
            'post',
            `/orders/${o.id}/amendments`,
            { ...change, quoteHash: quote.quoteHash },
          ).expect(409);
          assert.equal(stale.body.code, 'ORDER_HAS_SERVING_HISTORY');
          await serve(o, -1, 1, 'kitchen', { reason: 'Wrong table' }).expect(
            200,
          );
          await call(
            'cashier',
            'post',
            `/orders/${o.id}/amendments/quote`,
            change,
          ).expect(409);
          await serve(o, 3).expect(200);
          await serve(o, 1, 3).expect(409);
        },
      );
      await t.test(
        'platform handover is one real transition and leaves financial records absent',
        async () => {
          for (const source of ['ZOMATO', 'SWIGGY']) {
            const o = (
              await call('cashier', 'post', '/platform-orders', {
                requestId: randomUUID(),
                source,
                externalReference: randomUUID(),
                preparationMode: 'NORMAL',
                lines: [{ variantId: item.variants[0].id, quantity: 2 }],
              }).expect(201)
            ).body;
            await call('dispatch', 'post', `/kitchen/orders/${o.id}/fulfill`, {
              requestId: randomUUID(),
              expectedRevision: 0,
            }).expect(200);
            const saved = (
              await sql.query(
                'SELECT status,bill_id,grand_total FROM orders WHERE id=$1',
                [o.id],
              )
            ).rows[0];
            assert.deepEqual(saved, {
              status: 'COMPLETED',
              bill_id: null,
              grand_total: null,
            });
            assert.equal(
              (
                await sql.query(
                  'SELECT count(*)::int n FROM order_status_history WHERE order_id=$1',
                  [o.id],
                )
              ).rows[0].n,
              2,
            );
          }
        },
      );
      await t.test(
        'legacy preparing and ready rounds are visible and can be served without fabricated history',
        async () => {
          // All earlier active rounds must finish before the compatible FIFO START command.
          const active = (await state()).pending;
          for (const order of active) {
            if (order.serviceType === 'DINE_IN')
              for (const line of order.items)
                if (line.pendingQuantity)
                  await call(
                    'kitchen',
                    'post',
                    `/kitchen/orders/${order.orderId}/lines/${line.id}/serve`,
                    {
                      requestId: randomUUID(),
                      expectedRevision: order.revision,
                      expectedServedQuantity: line.servedQuantity,
                      quantity: line.pendingQuantity,
                    },
                  ).expect(200);
          }
          for (const ready of [false, true]) {
            const o = await create();
            await call(
              'kitchen',
              'post',
              `/kitchen/orders/${o.id}/start`,
            ).expect(200);
            if (ready)
              await call(
                'kitchen',
                'post',
                `/kitchen/orders/${o.id}/ready`,
              ).expect(200);
            assert.equal(
              (await state()).pending.find((x) => x.orderId === o.id).status,
              ready ? 'READY' : 'PREPARING',
            );
            await serve(o, 3).expect(200);
            assert.equal(
              (await sql.query('SELECT status FROM orders WHERE id=$1', [o.id]))
                .rows[0].status,
              'COMPLETED',
            );
          }
        },
      );
      await t.test(
        'late completion failure rolls back serving evidence and terminal history together',
        async () => {
          const o = await create();
          await sql.query(
            `CREATE FUNCTION fail_serving_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.to_status='COMPLETED' THEN RAISE EXCEPTION 'fixture completion failure'; END IF; RETURN NEW; END $$`,
          );
          await sql.query(
            'CREATE TRIGGER fail_serving_completion AFTER INSERT ON order_status_history FOR EACH ROW EXECUTE FUNCTION fail_serving_completion()',
          );
          try {
            await serve(o, 3).expect(500);
          } finally {
            await sql.query(
              'DROP TRIGGER fail_serving_completion ON order_status_history',
            );
          }
          assert.equal(
            (
              await sql.query(
                'SELECT count(*)::int n FROM order_serving_events WHERE order_id=$1',
                [o.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (await sql.query('SELECT status FROM orders WHERE id=$1', [o.id]))
              .rows[0].status,
            'QUEUED',
          );
          await serve(o, 3).expect(200);
        },
      );
      await t.test(
        'partly served prior-day order completes at cutoff preserving full value, payments and serving evidence',
        async () => {
          const o = await create();
          await serve(o, 1).expect(200);
          const timer = (
            await call('kitchen', 'post', '/kitchen/timers', {
              requestId: randomUUID(),
              label: 'Linked preparation',
              durationSeconds: 120,
              orderId: o.id,
              orderItemId: o.items[0].id,
            }).expect(201)
          ).body;
          const before = (
            await sql.query('SELECT * FROM effective_orders WHERE id=$1', [
              o.id,
            ])
          ).rows[0];
          const date = (
            await sql.query(
              "SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text d",
            )
          ).rows[0].d;
          await sql.query('BEGIN');
          await sql.query('SELECT pg_advisory_xact_lock(742019323)');
          await sql.query(
            "UPDATE bills SET status='CLOSED',closed_at=$1,closed_by=NULL,closure_reason='BUSINESS_DAY_ROLLOVER',closure_timezone='Asia/Kolkata' WHERE status='OPEN'",
            [new Date(date + 'T05:00:00+05:30')],
          );
          await cancelPreviousDayOrders(
            sql,
            {
              queued_at: new Date(date + 'T05:00:00+05:30'),
              business_date: date,
              local_time: '05:00',
            },
            'Asia/Kolkata',
            '05:00',
          );
          await sql.query('COMMIT');
          assert.equal(
            (await sql.query('SELECT status FROM orders WHERE id=$1', [o.id]))
              .rows[0].status,
            'COMPLETED',
          );
          assert.deepEqual(
            (
              await sql.query('SELECT * FROM effective_orders WHERE id=$1', [
                o.id,
              ])
            ).rows[0],
            before,
          );
          assert.equal(
            (
              await sql.query(
                'SELECT sum(quantity)::int n FROM order_serving_events WHERE order_id=$1',
                [o.id],
              )
            ).rows[0].n,
            1,
          );
          const history = (
            await sql.query(
              "SELECT actor_id,reason FROM order_status_history WHERE order_id=$1 AND to_status='COMPLETED'",
              [o.id],
            )
          ).rows[0];
          const resolved = (
            await sql.query(
              'SELECT status,resolved_by,resolution_reason FROM kitchen_timers WHERE id=$1',
              [timer.id],
            )
          ).rows[0];
          assert.deepEqual(resolved, {
            status: 'CANCELLED',
            resolved_by: null,
            resolution_reason: 'PREVIOUS_BUSINESS_DAY_PART_SERVED_COMPLETE',
          });
          assert.equal(history.actor_id, null);
          assert.equal(
            history.reason,
            'PREVIOUS_BUSINESS_DAY_PART_SERVED_COMPLETE',
          );
        },
      );
    } finally {
      if (app) await app.close();
      await sql.query('ROLLBACK');
      await sql.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      process.env.DATABASE_URL = original;
    }
  },
);
