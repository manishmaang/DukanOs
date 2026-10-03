require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const { Client } = require('pg');
const { Test } = require('@nestjs/testing');
const request = require('supertest');
const sharp = require('sharp');
const { AppModule } = require('../../dist/app.module');
const { configureApp } = require('../../dist/configure-app');
const { UsersService } = require('../../dist/modules/users/users.service');
const { RestaurantClock } = require('../../dist/database/restaurant-clock');
const {
  ExpenseMediaService,
} = require('../../dist/modules/expenses/expense-media.service');
test(
  'Restaurant expenses: exact money, independent ledger, receipts, roles, dates, audit and concurrency',
  { timeout: 180000 },
  async (t) => {
    const original = process.env.DATABASE_URL,
      oldDir = process.env.DUKANOS_DATA_DIR,
      oldZone = process.env.RESTAURANT_TIMEZONE;
    const dir = fs.mkdtempSync('/tmp/dukanos-expenses-integration-');
    process.env.DUKANOS_DATA_DIR = dir;
    process.env.RESTAURANT_TIMEZONE = 'Asia/Kolkata';
    const admin = new Client({ connectionString: original });
    await admin.connect();
    const schema = 'expenses_' + randomUUID().replaceAll('-', '');
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
        password = randomUUID() + '!',
        owner = await users.create({
          username: 'owner',
          name: 'Owner',
          password,
          roles: ['OWNER'],
        });
      const cookies = {},
        ids = { OWNER: owner.id };
      for (const role of [
        'OWNER',
        'MANAGER',
        'CASHIER',
        'KITCHEN',
        'DISPATCH',
      ]) {
        if (role !== 'OWNER')
          ids[role] = (
            await users.create(
              {
                username: role.toLowerCase(),
                name: role,
                password,
                roles: [role],
              },
              owner,
            )
          ).id;
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
        realRead = clock.read.bind(clock);
      let instant = '2026-09-30T12:00:00Z';
      clock.read = (c) =>
        realRead({
          query: (text, values) =>
            c.query(text.replace('clock_timestamp()', '$2::timestamptz'), [
              ...values,
              instant,
            ]),
        });
      const config = (await call('get', '/expense-categories').expect(200))
        .body;
      assert.equal(config.categories.length, 10);
      const category = config.categories.find(
          (c) => c.name === 'Vegetables / Raw Material',
        ),
        bread = config.categories.find((c) => c.name === 'Bread / Bakery');
      const input = (extra = {}) => ({
        requestId: randomUUID(),
        amount: '1250',
        categoryId: category.id,
        paymentMethod: 'CASH',
        ...extra,
      });
      const create = async (q = input(), role = 'OWNER') =>
        (await call('post', '/expenses', q, role).expect(201)).body;
      const report = async (query = '') =>
        (await call('get', '/reports/expenses' + query).expect(200)).body;
      let first;
      await t.test(
        'Cash and UPI entries retain exact amount, restaurant date and actor; customer financial data unchanged',
        async () => {
          const before = (await call('get', '/dashboard').expect(200)).body;
          first = await create(
            input({ vendor: 'Fresh Market', note: 'Morning purchase' }),
            'CASHIER',
          );
          assert.equal(first.amount, '1250.00');
          assert.equal(first.businessDate, '2026-09-30');
          assert.equal(first.recordedBy.id, ids.CASHIER);
          assert.equal(first.status, 'ACTIVE');
          await create(
            input({
              amount: '600',
              categoryId: bread.id,
              paymentMethod: 'UPI',
            }),
            'MANAGER',
          );
          const r = await report();
          assert.equal(r.total, '1850.00');
          assert.equal(r.cash, '1250.00');
          assert.equal(r.upi, '600.00');
          const after = (await call('get', '/dashboard').expect(200)).body;
          assert.equal(after.recordedExpenses, '1850.00');
          assert.deepEqual(after.sales, before.sales);
          assert.deepEqual(after.payments, before.payments);
          assert.equal(
            (await sql.query('SELECT count(*)::int AS n FROM payments')).rows[0]
              .n,
            0,
          );
        },
      );
      await t.test(
        'idempotent and simultaneous submission inserts once; changed intent conflicts',
        async () => {
          const body = input({ amount: '1.25' });
          const replies = await Promise.all(
            Array.from({ length: 5 }, () => create(body)),
          );
          assert.equal(new Set(replies.map((e) => e.id)).size, 1);
          await call('post', '/expenses', { ...body, amount: '2' }).expect(409);
          assert.equal(
            (await call('get', `/expenses/${replies[0].id}`).expect(200)).body
              .amount,
            '1.25',
          );
        },
      );
      await t.test(
        'authorization separates cashier data entry from analytics, category control and void',
        async () => {
          await request(app.getHttpServer())
            .post('/api/expenses')
            .set('X-DukanOS-Request', '1')
            .send(input())
            .expect(401);
          for (const role of ['KITCHEN', 'DISPATCH'])
            for (const [method, path, body] of [
              ['get', '/expenses'],
              ['get', '/expense-categories'],
              ['post', '/expenses', input()],
            ])
              await call(method, path, body, role).expect(403);
          for (const role of ['CASHIER', 'KITCHEN', 'DISPATCH'])
            await call('get', '/reports/expenses', undefined, role).expect(403);
          await call('get', '/expenses', undefined, 'CASHIER').expect(200);
          await call(
            'post',
            '/expense-categories',
            { name: 'Denied' },
            'CASHIER',
          ).expect(403);
          await call(
            'post',
            `/expenses/${first.id}/void`,
            { requestId: randomUUID(), reason: 'WRONG_AMOUNT' },
            'CASHIER',
          ).expect(403);
          for (const role of ['OWNER', 'MANAGER'])
            await call('get', '/reports/expenses', undefined, role).expect(200);
        },
      );
      await t.test(
        'strict input rejects precision, nonpositive amounts, malformed dates, unknown fields and unsupported methods',
        async () => {
          for (const extra of [
            { amount: '0' },
            { amount: '-1' },
            { amount: '1.001' },
            { amount: 12 },
            { amount: '1e3' },
            { amount: '1000000000000' },
            { amount: null },
            { paymentMethod: 'CARD' },
            { businessDate: '2026-02-30' },
            { businessDate: '2026-10-01' },
            { businessDate: '2026-08-30' },
            { businessDate: null },
            { vendor: 'x'.repeat(121) },
            { note: 'x'.repeat(501) },
            { price: '1' },
          ])
            await call('post', '/expenses', input(extra)).expect(400);
          for (const q of [
            '?unexpected=1',
            '?period=BAD',
            '?from=2026-02-30&to=2026-03-01',
            '?period=TODAY&from=2026-09-30',
            '?from=2024-01-01&to=2026-01-01',
            '?page=0',
            '?categoryId=bad',
            '?search=a&search=b',
          ])
            await call('get', '/expenses' + q).expect(400);
        },
      );
      await t.test(
        'category rename preserves original snapshot; deactivate rejects stale forms and preserves history',
        async () => {
          let c = (
            await call(
              'post',
              '/expense-categories',
              { name: 'Staff Tea' },
              'MANAGER',
            ).expect(201)
          ).body;
          const e = await create(input({ categoryId: c.id, amount: '100' }));
          c = (
            await call('patch', `/expense-categories/${c.id}`, {
              name: 'Staff Tea and Food',
              active: false,
              version: c.version,
            }).expect(200)
          ).body;
          assert.equal(
            (await call('get', `/expenses/${e.id}`).expect(200)).body
              .categoryName,
            'Staff Tea',
          );
          await call('post', '/expenses', input({ categoryId: c.id })).expect(
            409,
          );
          await call('patch', `/expense-categories/${c.id}`, {
            name: 'Stale',
            active: true,
            version: 1,
          }).expect(409);
          assert.equal(
            (
              await sql.query(
                'SELECT count(*)::int AS n FROM expense_category_audit WHERE category_id=$1',
                [c.id],
              )
            ).rows[0].n,
            2,
          );
          await call('post', '/expense-categories', {
            name: '  Vegetables / Raw Material  ',
          }).expect(409);
          await call('post', '/expense-categories', { name: '   ' }).expect(
            400,
          );
        },
      );
      await t.test(
        'void is audited, idempotent and immutable; positive expense is removed from effective totals only',
        async () => {
          const e = await create(input({ amount: '900' }));
          const before = await report();
          const q = {
            requestId: randomUUID(),
            reason: 'DUPLICATE_ENTRY',
            note: 'Recorded twice by mistake',
          };
          const results = await Promise.all([
            call('post', `/expenses/${e.id}/void`, q, 'MANAGER').expect(201),
            call('post', `/expenses/${e.id}/void`, q, 'MANAGER').expect(201),
          ]);
          assert.deepEqual(results[0].body, results[1].body);
          assert.equal(results[0].body.amount, '900.00');
          assert.equal(results[0].body.void.by.id, ids.MANAGER);
          assert.equal(
            BigInt(before.total.replace('.', '')) -
              BigInt((await report()).total.replace('.', '')),
            90000n,
          );
          await call('post', `/expenses/${e.id}/void`, {
            requestId: randomUUID(),
            reason: 'WRONG_AMOUNT',
          }).expect(409);
          await call('post', `/expenses/${first.id}/void`, {
            requestId: randomUUID(),
            reason: 'OTHER',
          }).expect(400);
          await assert.rejects(
            sql.query('DELETE FROM expenses WHERE id=$1', [e.id]),
            /EXPENSE_IMMUTABLE/,
          );
          await assert.rejects(
            sql.query('UPDATE expenses SET amount=1 WHERE id=$1', [first.id]),
            /EXPENSE_IMMUTABLE/,
          );
          await assert.rejects(
            sql.query("UPDATE expenses SET void_note='rewrite' WHERE id=$1", [
              e.id,
            ]),
            /EXPENSE_IMMUTABLE/,
          );
        },
      );
      await t.test(
        'PostgreSQL guards reject invalid financial values, dates, methods, inactive references and inconsistent voids',
        async () => {
          const base = (
            await sql.query('SELECT * FROM expenses WHERE id=$1', [first.id])
          ).rows[0];
          for (const patch of [
            { amount: '-1' },
            { amount: '0' },
            { amount: '1.001' },
            { payment_method: 'CARD' },
            { business_date: '2026-10-01' },
            { category_id: randomUUID() },
            { category_name_snapshot: 'Wrong' },
            { status: 'VOIDED' },
          ]) {
            const row = {
              ...base,
              ...patch,
              id: randomUUID(),
              request_id: randomUUID(),
            };
            const keys = Object.keys(row);
            await assert.rejects(
              sql.query(
                `INSERT INTO expenses(${keys.join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
                Object.values(row),
              ),
            );
          }
          await assert.rejects(
            sql.query('DELETE FROM expense_categories WHERE id=$1', [
              category.id,
            ]),
            /EXPENSE_CATEGORY_IMMUTABLE/,
          );
        },
      );
      await t.test(
        'deactivation wins while expense waits; revoked sessions are rechecked inside write lock',
        async () => {
          const c = (
            await call('post', '/expense-categories', {
              name: 'Race category',
            }).expect(201)
          ).body;
          await sql.query('BEGIN');
          await sql.query('SELECT pg_advisory_xact_lock(742019323)');
          await sql.query(
            'UPDATE expense_categories SET active=false,version=version+1 WHERE id=$1',
            [c.id],
          );
          const pending = call(
            'post',
            '/expenses',
            input({ categoryId: c.id }),
          ).then((r) => r);
          await new Promise((r) => setTimeout(r, 50));
          await sql.query('COMMIT');
          assert.equal((await pending).status, 409);
          await sql.query('BEGIN');
          await sql.query('SELECT pg_advisory_xact_lock(742019323)');
          const revoked = call('post', '/expenses', input(), 'CASHIER').then(
            (r) => r,
          );
          await new Promise((r) => setTimeout(r, 50));
          await sql.query('DELETE FROM auth_sessions WHERE user_id=$1', [
            ids.CASHIER,
          ]);
          await sql.query('COMMIT');
          assert.equal((await revoked).status, 401);
          const login = await request(app.getHttpServer())
            .post('/api/auth/login')
            .set('X-DukanOS-Request', '1')
            .send({ username: 'cashier', password })
            .expect(200);
          cookies.CASHIER = login.headers['set-cookie'][0].split(';')[0];
        },
      );
      await t.test(
        'recent historical entry, server midnight and all report periods/category totals/filtering are exact',
        async () => {
          instant = '2026-10-01T18:29:59.999Z';
          const boundary = await create(input({ amount: '10.50' }));
          assert.equal(boundary.businessDate, '2026-10-01');
          instant = '2026-10-01T18:30:00Z';
          const c = (
            await call('post', '/expense-categories', {
              name: 'Category report fixture',
            }).expect(201)
          ).body;
          await create(
            input({
              amount: '1000',
              categoryId: c.id,
              vendor: 'Exact vendor',
              note: 'Literal 100%',
            }),
          );
          await create(input({ amount: '500', categoryId: c.id }));
          await create(input({ amount: '400', categoryId: bread.id }));
          await create(input({ amount: '100' }));
          assert.equal((await report()).total, '2000.00');
          assert.equal(
            (await report()).categories.find((x) => x.categoryId === c.id)
              .amount,
            '1500.00',
          );
          assert.equal((await report('?period=YESTERDAY')).total, '10.50');
          assert.equal((await report('?period=THIS_MONTH')).total, '2010.50');
          assert.equal(
            (await report('?period=LAST_7_DAYS')).period.from,
            '2026-09-26',
          );
          assert.equal(
            (await report('?from=2026-10-02&to=2026-10-02')).total,
            '2000.00',
          );
          const filtered = (
            await call(
              'get',
              `/expenses?categoryId=${c.id}&search=100%25`,
            ).expect(200)
          ).body;
          assert.equal(filtered.expenses.length, 1);
          assert.equal(filtered.totals.total, '1000.00');
          await create(input({ amount: '0.01', businessDate: '2026-09-02' }));
          await call(
            'post',
            '/expenses',
            input({ businessDate: '2026-09-01' }),
          ).expect(400);
          assert.equal(
            (await report()).trend.reduce(
              (n, d) => n + BigInt(d.amount.replace('.', '')),
              0n,
            ),
            200000n,
          );
        },
      );
      await t.test(
        'JPEG PNG WebP receipt processing, ownership, authorization, invalid/oversize input and cleanup',
        async () => {
          const upload = (bytes, mime, role = 'OWNER') =>
            request(app.getHttpServer())
              .post('/api/expenses/receipts')
              .set('Cookie', cookies[role])
              .set('X-DukanOS-Request', '1')
              .attach('image', bytes, {
                filename: 'receipt',
                contentType: mime,
              });
          for (const format of ['jpeg', 'png', 'webp']) {
            const pipeline = sharp({
              create: {
                width: 2800,
                height: 1400,
                channels: 3,
                background: '#fafafa',
              },
            });
            const bytes = await pipeline[format]().toBuffer();
            const r = (await upload(bytes, 'image/' + format).expect(201)).body;
            assert.equal(r.width, 2400);
            assert.ok(!JSON.stringify(r).includes(dir));
            await call(
              'get',
              r.url.replace('/api', ''),
              undefined,
              'KITCHEN',
            ).expect(403);
            await call(
              'get',
              r.url.replace('/api', ''),
              undefined,
              'CASHIER',
            ).expect(404);
            await call(
              'post',
              '/expenses',
              input({ receiptKey: r.key }),
              'CASHIER',
            ).expect(409);
            const e = await create(input({ amount: '5', receiptKey: r.key }));
            assert.equal(e.receipt.key, r.key);
            const response = await call(
              'get',
              r.url.replace('/api', ''),
              undefined,
              'CASHIER',
            ).expect(200);
            assert.equal(response.headers['content-type'], 'image/webp');
            assert.equal(
              response.headers['cache-control'],
              'private, no-store',
            );
            await call(
              'post',
              '/expenses',
              input({ receiptKey: r.key }),
            ).expect(409);
            await call('post', `/expenses/${e.id}/void`, {
              requestId: randomUUID(),
              reason: 'WRONG_AMOUNT',
            }).expect(201);
            await call('get', r.url.replace('/api', '')).expect(200);
            assert.equal(
              await app.get(ExpenseMediaService).discardUnused(r.key),
              'referenced',
            );
          }
          await upload(Buffer.from('not an image'), 'image/jpeg').expect(400);
          await upload(Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png').expect(
            413,
          );
          const png = await sharp({
            create: { width: 10, height: 10, channels: 3, background: '#fff' },
          })
            .png()
            .toBuffer();
          await upload(png, 'image/jpeg').expect(400);
          const staged = (await upload(png, 'image/png').expect(201)).body;
          await sql.query(
            "UPDATE expense_receipts SET created_at=now()-interval '25 hours' WHERE key=$1",
            [staged.key],
          );
          const media = app.get(ExpenseMediaService);
          assert.ok((await media.cleanup(true)).candidates >= 1);
          assert.ok(await media.exists(staged.key));
          assert.ok((await media.cleanup()).removed >= 1);
          assert.equal(await media.exists(staged.key), false);
        },
      );
      await t.test(
        'report/list/receipt reads do not rewrite domain tables and entries retain void audit',
        async () => {
          const tables = (
            await sql.query(
              "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name",
            )
          ).rows.map((r) => r.table_name);
          const snap = async () => {
            const h = createHash('sha256');
            for (const name of tables)
              h.update(
                JSON.stringify(
                  (
                    await sql.query(
                      `SELECT to_jsonb(t)::text AS row FROM "${name}" t ORDER BY to_jsonb(t)::text`,
                    )
                  ).rows,
                ),
              );
            return h.digest('hex');
          };
          const before = await snap();
          await report();
          await call('get', '/expenses?status=VOIDED').expect(200);
          await call('get', '/expense-categories').expect(200);
          assert.equal(await snap(), before);
        },
      );
    } finally {
      if (app) await app.close();
      await sql.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      fs.rmSync(dir, { recursive: true, force: true });
      process.env.DATABASE_URL = original;
      if (oldDir === undefined) delete process.env.DUKANOS_DATA_DIR;
      else process.env.DUKANOS_DATA_DIR = oldDir;
      if (oldZone === undefined) delete process.env.RESTAURANT_TIMEZONE;
      else process.env.RESTAURANT_TIMEZONE = oldZone;
    }
  },
);
