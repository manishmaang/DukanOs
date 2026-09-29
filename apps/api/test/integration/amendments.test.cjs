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
  'Queued amendments, effective projections and cash refunds',
  { timeout: 120000 },
  async (t) => {
    const original = process.env.DATABASE_URL;
    const admin = new Client({ connectionString: original });
    await admin.connect();
    const schema = 'amendments_test_' + randomUUID().replaceAll('-', '');
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
          { name: 'Amendment fixtures' },
          'OWNER',
        ).expect(201)
      ).body;
      const variants = {};
      for (const [name, price] of [
        ['Noodles', '120'],
        ['Pasta', '170'],
        ['Meal', '500'],
        ['Small Meal', '450'],
      ]) {
        const item = (
          await call(
            'post',
            '/menu/items',
            {
              categoryId: cat.id,
              name,
              variants: [
                {
                  name: 'Full',
                  channels: [
                    { channelCode: 'COUNTER', price, available: true },
                  ],
                },
              ],
            },
            'OWNER',
          ).expect(201)
        ).body;
        variants[name] = item.variants[0].id;
      }
      const create = async (
        name = 'Noodles',
        quantity = 1,
        paid = '0',
        serviceType = 'DINE_IN',
      ) => {
        const input = {
          requestId: randomUUID(),
          serviceType,
          lines: [
            { variantId: variants[name], quantity, instruction: 'Extra spicy' },
          ],
        };
        const o = (await call('post', '/orders/counter', input).expect(201))
          .body;
        if (paid !== '0')
          await call('post', `/bills/${o.billId}/payments`, {
            requestId: randomUUID(),
            method: 'UPI',
            amount: paid,
          }).expect(201);
        return o;
      };
      const bill = async (o) =>
        (await call('get', `/bills/${o.billId}`).expect(200)).body;
      const change = (o, name, extra = {}) => ({
        requestId: randomUUID(),
        expectedRevision: o.revision,
        kind: 'CHANGE',
        reason: 'CUSTOMER_CHANGE',
        lines: o.items.map((i) => ({
          id: i.id,
          variantId: name ? variants[name] : i.variantId,
          quantity: i.quantity,
          instruction: i.instruction,
        })),
        ...extra,
      });
      const quote = async (o, p, role = 'CASHIER') =>
        (
          await call(
            'post',
            `/orders/${o.id}/amendments/quote`,
            p,
            role,
          ).expect(201)
        ).body;
      const commit = (o, p, q, role = 'CASHIER') =>
        call(
          'post',
          `/orders/${o.id}/amendments`,
          { ...p, quoteHash: q.quoteHash },
          role,
        );
      const amend = async (o, p, role = 'CASHIER') => {
        const q = await quote(o, p, role);
        await commit(o, p, q, role).expect(201);
        return q;
      };
      const refund = (o, value, key = randomUUID(), role = 'CASHIER') =>
        call(
          'post',
          `/bills/${o.billId}/refunds`,
          { requestId: key, amount: value },
          role,
        );
      const current = async (o) =>
        (await call('get', `/orders/${o.id}`).expect(200)).body;
      const finish = async (o) => {
        // Drain prior fixtures FIFO through the actual lifecycle, no status rewriting.
        let k = (await call('get', '/kitchen/orders', undefined, 'KITCHEN'))
          .body;
        for (const item of k.queued)
          await call(
            'post',
            `/kitchen/orders/${item.orderId}/start`,
            undefined,
            'KITCHEN',
          ).expect(200);
        await call(
          'post',
          `/kitchen/orders/${o.id}/ready`,
          undefined,
          'KITCHEN',
        ).expect(200);
      };
      await t.test(
        'more expensive replacement retains identity, snapshots/history and updates Kitchen/bill; UPI collects extra',
        async () => {
          const o = await create('Noodles', 1, '120');
          const original = JSON.stringify(
            (
              await sql.query('SELECT * FROM order_items WHERE order_id=$1', [
                o.id,
              ])
            ).rows,
          );
          const p = change(o, 'Pasta');
          const q = await amend(o, p);
          assert.equal(q.amountDueAfter, '50.00');
          assert.equal(q.refundDueAfter, '0.00');
          const next = await current(o);
          assert.equal(next.tokenNumber, o.tokenNumber);
          assert.equal(next.revision, 1);
          assert.equal(next.items[0].itemName, 'Pasta');
          assert.equal(
            JSON.stringify(
              (
                await sql.query('SELECT * FROM order_items WHERE order_id=$1', [
                  o.id,
                ])
              ).rows,
            ),
            original,
          );
          const k = (await call('get', '/kitchen/orders', undefined, 'KITCHEN'))
            .body;
          assert.equal(
            k.queued.find((x) => x.orderId === o.id).items[0].itemName,
            'Pasta',
          );
          assert.ok(
            k.production.queued.some(
              (g) =>
                g.itemName === 'Pasta' &&
                g.sources.some((s) => s.orderId === o.id),
            ),
          );
          assert.ok(
            !k.production.queued.some(
              (g) =>
                g.itemName === 'Noodles' &&
                g.sources.some((s) => s.orderId === o.id),
            ),
          );
          const history = (await call('get', `/orders/${o.id}/amendments`))
            .body;
          assert.equal(history[0].beforeItems[0].itemName, 'Noodles');
          assert.equal(history[0].items[0].itemName, 'Pasta');
          await call('post', `/bills/${o.billId}/payments`, {
            requestId: randomUUID(),
            method: 'UPI',
            amount: '50',
          }).expect(201);
          assert.equal((await bill(o)).paymentStatus, 'PAID');
        },
      );
      await t.test(
        'cheaper fully paid replacement; partial cash refunds, idempotent retry and immutable UPI collection',
        async () => {
          const o = await create('Pasta', 1, '170');
          await amend(o, change(o, 'Noodles'));
          assert.equal((await bill(o)).refundDue, '50.00');
          const key = randomUUID();
          await refund(o, '30', key).expect(201);
          await refund(o, '30.00', key).expect(201);
          assert.equal((await bill(o)).refundDue, '20.00');
          await refund(o, '21').expect(409);
          await refund(o, '20').expect(201);
          const b = await bill(o);
          assert.equal(b.netPaid, '120.00');
          assert.equal(b.paymentStatus, 'PAID');
          assert.equal(b.payments.length, 3);
          assert.equal(b.payments[0].method, 'UPI');
          assert.ok(
            b.payments
              .filter((p) => p.type === 'REFUND')
              .every((p) => p.method === 'CASH'),
          );
          await refund(o, '1', key).expect(409);
          await refund(o, '1').expect(409);
          await assert.rejects(
            sql.query('UPDATE payments SET amount=1 WHERE bill_id=$1', [
              o.billId,
            ]),
            /PAYMENT_IMMUTABLE/,
          );
        },
      );
      await t.test(
        'partially paid cheaper bills derive due or refund only from net paid',
        async () => {
          for (const [paid, due, ref] of [
            ['300', '150.00', '0.00'],
            ['480', '0.00', '30.00'],
          ]) {
            const o = await create('Meal', 1, paid);
            await amend(o, change(o, 'Small Meal'));
            const b = await bill(o);
            assert.equal(b.amountDue, due);
            assert.equal(b.refundDue, ref);
          }
        },
      );
      await t.test(
        'reduction uses old price; note and removal retain audit and current-only production',
        async () => {
          let o = await create('Noodles', 3);
          await sql.query(
            "UPDATE variant_channel_settings SET price=140 WHERE variant_id=$1 AND channel_code='COUNTER'",
            [variants.Noodles],
          );
          const p = change(o);
          p.lines[0].quantity = 2;
          p.lines[0].instruction = 'No onion';
          await amend(o, p);
          o = await current(o);
          assert.equal(o.grandTotal, '240.00');
          assert.equal(o.items[0].unitPrice, '120.00');
          assert.equal(o.items[0].instruction, 'No onion');
          const extra = (
            await call('post', '/orders/counter', {
              requestId: randomUUID(),
              serviceType: 'DINE_IN',
              lines: [
                { variantId: variants.Noodles, quantity: 1 },
                { variantId: variants.Pasta, quantity: 1 },
              ],
            }).expect(201)
          ).body;
          const r = change(extra);
          r.lines.splice(0, 1);
          await amend(extra, r);
          assert.equal((await current(extra)).items.length, 1);
          await sql.query(
            "UPDATE variant_channel_settings SET price=120 WHERE variant_id=$1 AND channel_code='COUNTER'",
            [variants.Noodles],
          );
        },
      );
      await t.test(
        'queued cancellation preserves token/history, removes effective food, creates refund and permits settled closure',
        async () => {
          const o = await create('Noodles', 1, '120');
          await amend(o, change(o, null, { kind: 'CANCEL', lines: [] }));
          const n = await current(o);
          assert.equal(n.status, 'CANCELLED');
          assert.equal(n.tokenNumber, o.tokenNumber);
          assert.deepEqual(n.items, []);
          assert.equal(n.grandTotal, '0.00');
          await call('post', `/bills/${o.billId}/close`).expect(409);
          await refund(o, '120').expect(201);
          await call('post', `/bills/${o.billId}/close`).expect(201);
          const another = await create();
          assert.ok(another.tokenNumber > o.tokenNumber);
        },
      );
      await t.test(
        'stale quotes, stale revisions, idempotency conflict and simultaneous amendments',
        async () => {
          const o = await create();
          const p = change(o, 'Pasta'),
            q = await quote(o, p);
          await call('post', `/bills/${o.billId}/payments`, {
            requestId: randomUUID(),
            method: 'CASH',
            amount: '10',
          }).expect(201);
          assert.equal(
            (await commit(o, p, q).expect(409)).body.code,
            'AMENDMENT_QUOTE_CHANGED',
          );
          const fresh = await quote(o, p);
          const responses = await Promise.all([
            commit(o, p, fresh),
            commit(o, p, fresh),
          ]);
          assert.ok(responses.every((r) => r.status === 201));
          await commit(o, { ...p, note: 'changed' }, fresh).expect(409);
          const stale = change(o);
          stale.lines[0].instruction = 'No onion';
          assert.equal(
            (
              await call(
                'post',
                `/orders/${o.id}/amendments/quote`,
                stale,
              ).expect(409)
            ).body.code,
            'ORDER_REVISION_CHANGED',
          );
          const x = await create();
          const a = change(x, 'Pasta'),
            b = change(x);
          b.lines[0].instruction = 'No onion';
          const qa = await quote(x, a),
            qb = await quote(x, b);
          const race = await Promise.all([commit(x, a, qa), commit(x, b, qb)]);
          assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
        },
      );
      await t.test(
        'Kitchen START wins stale edit; amendment-first START sees revised food; terminal states reject',
        async () => {
          const o = await create();
          const p = change(o, 'Pasta'),
            q = await quote(o, p);
          await finish(o);
          assert.equal(
            (await commit(o, p, q).expect(409)).body.code,
            'ORDER_NOT_AMENDABLE',
          );
          assert.equal((await bill(o)).billTotal, '120.00');
          const x = await create();
          await amend(x, change(x, 'Pasta'));
          const k = (await call('get', '/kitchen/orders', undefined, 'KITCHEN'))
            .body;
          for (const n of k.queued)
            await call(
              'post',
              `/kitchen/orders/${n.orderId}/start`,
              undefined,
              'KITCHEN',
            ).expect(200);
          assert.equal((await current(x)).items[0].itemName, 'Pasta');
          await call(
            'post',
            `/orders/${x.id}/amendments/quote`,
            change(await current(x), 'Noodles'),
          ).expect(409);
        },
      );
      await t.test(
        'refund race cannot over-refund and Takeaway blocks until fully settled; Dine In may serve with refund due',
        async () => {
          for (const service of ['TAKEAWAY', 'DINE_IN']) {
            const o = await create('Pasta', 1, '170', service);
            await amend(o, change(o, 'Noodles'));
            await finish(o);
            await call(
              'post',
              `/dispatch/orders/${o.id}/complete`,
              undefined,
              'DISPATCH',
            ).expect(service === 'TAKEAWAY' ? 409 : 200);
            const r = await Promise.all([
              refund(o, '50'),
              refund(o, '50', randomUUID(), 'MANAGER'),
            ]);
            assert.deepEqual(r.map((x) => x.status).sort(), [201, 409]);
            if (service === 'TAKEAWAY')
              await call(
                'post',
                `/dispatch/orders/${o.id}/complete`,
                undefined,
                'DISPATCH',
              ).expect(200);
          }
        },
      );
      await t.test(
        'reminder pauses for refund and resumes for additional due; active timers block amendments',
        async () => {
          const o = await create();
          await call('post', `/bills/${o.billId}/reminder`, {
            intervalMinutes: 5,
          }).expect(201);
          await call('post', `/bills/${o.billId}/payments`, {
            requestId: randomUUID(),
            method: 'CASH',
            amount: '120',
          }).expect(201);
          await amend(o, change(o, 'Pasta'));
          assert.ok(
            (
              await sql.query(
                'SELECT next_due_at FROM bill_reminders WHERE bill_id=$1',
                [o.billId],
              )
            ).rows[0].next_due_at,
          );
          await call('post', `/bills/${o.billId}/payments`, {
            requestId: randomUUID(),
            method: 'UPI',
            amount: '50',
          }).expect(201);
          await amend(await current(o), change(await current(o), 'Noodles'));
          assert.equal(
            (
              await sql.query(
                'SELECT next_due_at FROM bill_reminders WHERE bill_id=$1',
                [o.billId],
              )
            ).rows[0].next_due_at,
            null,
          );
          const x = await create();
          const timer = (
            await call(
              'post',
              '/kitchen/timers',
              {
                requestId: randomUUID(),
                label: 'Unexpected timer',
                durationSeconds: 60,
                orderId: x.id,
                orderItemId: x.items[0].id,
              },
              'KITCHEN',
            ).expect(201)
          ).body;
          assert.equal(
            (
              await call(
                'post',
                `/orders/${x.id}/amendments/quote`,
                change(x, 'Pasta'),
              ).expect(409)
            ).body.code,
            'ORDER_HAS_ACTIVE_TIMER',
          );
          await call(
            'post',
            `/kitchen/timers/${timer.id}/cancel`,
            undefined,
            'KITCHEN',
          ).expect(201);
          await amend(x, change(x, 'Pasta'));
        },
      );
      await t.test(
        'strict DTOs, unauthorized roles, cash-only database guard and no arbitrary refund',
        async () => {
          const o = await create();
          const p = change(o, 'Pasta');
          await request(app.getHttpServer())
            .post(`/api/orders/${o.id}/amendments/quote`)
            .set('X-DukanOS-Request', '1')
            .send(p)
            .expect(401);
          for (const role of ['KITCHEN', 'DISPATCH']) {
            await call(
              'post',
              `/orders/${o.id}/amendments/quote`,
              p,
              role,
            ).expect(403);
            await refund(o, '1', randomUUID(), role).expect(403);
          }
          for (const invalid of [
            { price: '1' },
            { expectedRevision: -1 },
            { reason: 'BOGUS' },
            { lines: [{ ...p.lines[0], quantity: 1.5 }] },
            { lines: [{ ...p.lines[0], quantity: 2 }] },
          ])
            await call('post', `/orders/${o.id}/amendments/quote`, {
              ...p,
              ...invalid,
            }).expect(400);
          await call('post', `/bills/${o.billId}/refunds`, {
            requestId: randomUUID(),
            amount: '1',
            method: 'UPI',
          }).expect(400);
          await refund(o, '1.001').expect(400);
          await refund(o, '0').expect(400);
          await refund(o, '1').expect(409);
          for (const role of ['OWNER', 'MANAGER', 'MULTI']) {
            const x = await create('Pasta', 1, '170');
            await amend(x, change(x, 'Noodles'), role);
            await refund(x, '50', randomUUID(), role).expect(201);
          }
          const x = await create('Pasta', 1, '170');
          await amend(x, change(x, 'Noodles'));
          await assert.rejects(
            sql.query(
              "INSERT INTO payments(id,bill_id,type,method,amount,performed_by,request_id,request_hash) VALUES($1,$2,'REFUND','UPI',10,$3,$4,$5)",
              [
                randomUUID(),
                x.billId,
                identities.CASHIER.id,
                randomUUID(),
                '0'.repeat(64),
              ],
            ),
            (e) => e.code === '23514',
          );
          await assert.rejects(
            sql.query('DELETE FROM order_amendments WHERE order_id=$1', [x.id]),
            /AMENDMENT_IMMUTABLE/,
          );
          await assert.rejects(
            sql.query(
              'UPDATE order_item_revisions SET quantity=1 WHERE order_id=$1',
              [x.id],
            ),
            /AMENDMENT_IMMUTABLE/,
          );
        },
      );

      await t.test(
        'replacement quote rechecks current availability/price and later menu changes cannot rewrite revision snapshots',
        async () => {
          const o = await create();
          const p = change(o, 'Pasta'),
            q = await quote(o, p);
          await sql.query(
            "UPDATE variant_channel_settings SET price=180 WHERE variant_id=$1 AND channel_code='COUNTER'",
            [variants.Pasta],
          );
          assert.equal(
            (await commit(o, p, q).expect(409)).body.code,
            'AMENDMENT_QUOTE_CHANGED',
          );
          const fresh = await quote(o, p);
          await sql.query(
            "UPDATE variant_channel_settings SET available=false WHERE variant_id=$1 AND channel_code='COUNTER'",
            [variants.Pasta],
          );
          assert.equal(
            (await commit(o, p, fresh).expect(409)).body.code,
            'ITEM_NOT_AVAILABLE',
          );
          await sql.query(
            "UPDATE variant_channel_settings SET available=true WHERE variant_id=$1 AND channel_code='COUNTER'",
            [variants.Pasta],
          );
          await amend(o, p);
          await sql.query(
            "UPDATE menu_items SET name='Pasta renamed' WHERE id=(SELECT menu_item_id FROM item_variants WHERE id=$1)",
            [variants.Pasta],
          );
          assert.equal((await current(o)).items[0].itemName, 'Pasta');
          assert.equal((await current(o)).grandTotal, '180.00');
          await sql.query(
            "UPDATE variant_channel_settings SET price=170 WHERE variant_id=$1 AND channel_code='COUNTER'",
            [variants.Pasta],
          );
          await sql.query(
            "UPDATE menu_items SET name='Pasta' WHERE id=(SELECT menu_item_id FROM item_variants WHERE id=$1)",
            [variants.Pasta],
          );
        },
      );
      await t.test(
        'simultaneous Kitchen START and commit serialize without partial changes',
        async () => {
          const k = (await call('get', '/kitchen/orders', undefined, 'KITCHEN'))
            .body;
          for (const n of k.queued)
            await call(
              'post',
              `/kitchen/orders/${n.orderId}/start`,
              undefined,
              'KITCHEN',
            ).expect(200);
          const o = await create(),
            p = change(o, 'Pasta'),
            q = await quote(o, p);
          const [edit, start] = await Promise.all([
            commit(o, p, q),
            call('post', `/kitchen/orders/${o.id}/start`, undefined, 'KITCHEN'),
          ]);
          assert.equal(start.status, 200);
          assert.ok([201, 409].includes(edit.status));
          const n = await current(o);
          assert.equal(n.status, 'PREPARING');
          assert.equal(
            n.items[0].itemName,
            edit.status === 201 ? 'Pasta' : 'Noodles',
          );
          assert.equal(
            (await bill(o)).billTotal,
            edit.status === 201 ? '170.00' : '120.00',
          );
        },
      );
      await t.test(
        'new round offsets existing refund credit without over-collecting',
        async () => {
          const o = await create('Pasta', 1, '170');
          await amend(o, change(o, 'Noodles'));
          const input = {
            requestId: randomUUID(),
            billId: o.billId,
            lines: [{ variantId: variants.Noodles, quantity: 1 }],
          };
          const q = (
            await call('post', '/orders/counter/quote', input).expect(201)
          ).body;
          assert.equal(q.existingRefund, '50.00');
          assert.equal(q.amountDue, '70.00');
          await call('post', '/orders/counter', {
            ...input,
            payment: { expectedDue: '70', cash: '70', upi: '0' },
          }).expect(201);
          assert.equal((await bill(o)).paymentStatus, 'PAID');
        },
      );
      await t.test(
        'original tax rate and half-up paise are retained through amendments after configuration changes',
        async () => {
          await app.close();
          process.env.ORDER_TAX_RATE = '2.50';
          const make = async () => {
            const m = await Test.createTestingModule({
              imports: [AppModule],
            }).compile();
            app = m.createNestApplication();
            configureApp(app);
            await app.init();
          };
          await make();
          const o = await create('Noodles', 3);
          assert.equal(o.grandTotal, '369.00');
          await app.close();
          process.env.ORDER_TAX_RATE = '10';
          await make();
          const p = change(o);
          p.lines[0].quantity = 2;
          await amend(o, p);
          const n = await current(o);
          assert.equal(n.grandTotal, '246.00');
          assert.equal(n.taxTotal, '6.00');
          assert.equal(n.tax.taxRate, '2.50');
          delete process.env.ORDER_TAX_RATE;
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
