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
  'PostgreSQL menu foundation and HTTP permissions',
  { timeout: 120000 },
  async (t) => {
    const original = process.env.DATABASE_URL;
    assert.ok(original);
    const admin = new Client({ connectionString: original });
    await admin.connect();
    const schema = 'menu_test_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(original);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    const sql = new Client({ connectionString: url.toString() });
    let app;
    try {
      for (let i = 0; i < 2; i++) {
        const run = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
          cwd: require('node:path').resolve(__dirname, '../../../..'),
          env: process.env,
          encoding: 'utf8',
        });
        assert.equal(run.status, 0, run.stdout + run.stderr);
      }
      await sql.connect();
      const module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = module.createNestApplication();
      configureApp(app);
      await app.init();
      const server = app.getHttpServer();
      const users = app.get(UsersService);
      const password = 'menu test password 123!';
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
        const login = await request(server)
          .post('/api/auth/login')
          .set('X-DukanOS-Request', '1')
          .send({ username: role.toLowerCase(), password })
          .expect(200);
        cookies[role] = login.headers['set-cookie'][0].split(';')[0];
      }
      const call = (method, path, body, role = 'OWNER') => {
        const agent = request(server);
        let req = agent[method]('/api/menu' + path)
          .set('Cookie', cookies[role])
          .set('X-DukanOS-Request', '1');
        if (body !== undefined) req = req.send(body);
        return req;
      };
      let category, item;
      const current = async () => {
        item = (await call('get', '/items/' + item.id).expect(200)).body;
        return item;
      };
      const price = async (code, amount) => {
        item = (
          await call(
            'put',
            `/variants/${item.variants[0].id}/channels/${code}/price`,
            { itemVersion: item.version, price: amount },
          ).expect(200)
        ).body;
      };
      const available = async (code, enabled) => {
        item = (
          await call(
            'patch',
            `/variants/${item.variants[0].id}/channels/${code}/availability`,
            { itemVersion: item.version, available: enabled },
          ).expect(200)
        ).body;
      };
      const menu = async (code = 'COUNTER', role = 'CASHIER') =>
        (await call('get', '?channel=' + code, undefined, role).expect(200))
          .body;
      await t.test(
        'owner and manager create/update categories; invalid DTOs and duplicate names rejected',
        async () => {
          await request(server).get('/api/menu?channel=COUNTER').expect(401);
          category = (
            await call(
              'post',
              '/categories',
              { name: 'Chinese', description: 'Wok dishes' },
              'MANAGER',
            ).expect(201)
          ).body;
          category = (
            await call('patch', '/categories/' + category.id, {
              version: category.version,
              name: 'Chinese food',
              sortOrder: 2,
            }).expect(200)
          ).body;
          assert.equal(category.sortOrder, 2);
          await call('post', '/categories', {}).expect(400);
          await call('post', '/categories', { name: '  ' }).expect(400);
          await call('post', '/categories', { name: 'CHINESE FOOD' }).expect(
            409,
          );
        },
      );
      await t.test(
        'items require variants; names scoped to item; updates retain identity',
        async () => {
          for (const variants of [
            [],
            [{}],
            [{ name: 'Half' }, { name: 'half' }],
          ])
            await call('post', '/items', {
              categoryId: category.id,
              name: 'Invalid',
              variants,
            }).expect(variants.length === 2 ? 409 : 400);
          await call('post', '/items', {
            categoryId: category.id,
            variants: [{ name: 'Regular' }],
          }).expect(400);
          item = (
            await call(
              'post',
              '/items',
              {
                categoryId: category.id,
                name: 'Veg Noodles',
                variants: [{ name: 'Full' }],
              },
              'MANAGER',
            ).expect(201)
          ).body;
          const id = item.id;
          item = (
            await call('patch', '/items/' + id, {
              version: item.version,
              name: 'Noodles',
              kitchenName: 'Veg noodles',
            }).expect(200)
          ).body;
          assert.equal(item.id, id);
          assert.equal(item.kitchenName, 'Veg noodles');
          await call('post', '/items/' + id + '/variants', {
            itemVersion: item.version,
            name: 'FULL',
          }).expect(409);
          await call('post', '/items', {
            categoryId: category.id,
            name: 'Biryani',
            variants: [{ name: 'Full' }],
          }).expect(201);
          item = (
            await call('post', '/items/' + id + '/variants', {
              itemVersion: item.version,
              name: '500 ml',
              sortOrder: 9,
            }).expect(201)
          ).body;
          const other = item.variants.find((v) => v.name === '500 ml');
          item = (
            await call('patch', '/variants/' + other.id, {
              itemVersion: item.version,
              name: 'Half',
              sortOrder: 10,
            }).expect(200)
          ).body;
        },
      );
      await t.test(
        'capabilities: cashier/kitchen read; operational users cannot administer',
        async () => {
          for (const role of ['CASHIER', 'KITCHEN']) {
            await menu('COUNTER', role);
            await call('get', '/admin', undefined, role).expect(403);
            await call(
              'put',
              `/variants/${item.variants[0].id}/channels/COUNTER/price`,
              { itemVersion: item.version, price: '1' },
              role,
            ).expect(403);
          }
          await call('get', '?channel=COUNTER', undefined, 'DISPATCH').expect(
            403,
          );
          await call('get', '/admin', undefined, 'MANAGER').expect(200);
        },
      );
      await t.test(
        'exact channel prices, invalid precision and separate availability',
        async () => {
          const base = `/variants/${item.variants[0].id}/channels/COUNTER`;
          await call('patch', base + '/availability', {
            itemVersion: item.version,
            available: true,
          }).expect(400);
          for (const amount of [
            '-1',
            '1.001',
            '1e2',
            'NaN',
            '1000000000000',
            '01.00',
            180,
          ])
            await call('put', base + '/price', {
              itemVersion: item.version,
              price: amount,
            }).expect(400);
          for (const [code, amount] of [
            ['COUNTER', '180'],
            ['ZOMATO', '210.50'],
            ['SWIGGY', '215'],
          ]) {
            await price(code, amount);
            assert.equal((await menu(code)).categories.length, 0);
            await available(code, true);
          }
          assert.equal(
            (await menu()).categories[0].items[0].variants[0].price,
            '180.00',
          );
          assert.equal(
            (await menu('ZOMATO')).categories[0].items[0].variants[0].price,
            '210.50',
          );
          await available('SWIGGY', false);
          assert.equal((await menu('SWIGGY')).categories.length, 0);
          assert.equal((await menu()).categories.length, 1);
          await price('COUNTER', '0.01');
          assert.equal(
            (await menu()).categories[0].items[0].variants[0].price,
            '0.01',
          );
          await price('COUNTER', '999999999999.99');
          assert.equal(
            (await menu()).categories[0].items[0].variants[0].price,
            '999999999999.99',
          );
        },
      );
      await t.test(
        'category/item/variant/channel activity filters operational catalog',
        async () => {
          for (const scope of ['variant', 'item', 'category']) {
            const toggle = async (active) => {
              if (scope === 'category')
                category = (
                  await call('patch', '/categories/' + category.id, {
                    version: category.version,
                    active,
                  }).expect(200)
                ).body;
              else if (scope === 'item')
                item = (
                  await call('patch', '/items/' + item.id, {
                    version: item.version,
                    active,
                  }).expect(200)
                ).body;
              else
                item = (
                  await call('patch', '/variants/' + item.variants[0].id, {
                    itemVersion: item.version,
                    active,
                  }).expect(200)
                ).body;
            };
            await toggle(false);
            assert.equal((await menu()).categories.length, 0);
            await call(
              'put',
              `/variants/${item.variants[0].id}/channels/COUNTER/price`,
              { itemVersion: item.version, price: '5' },
            ).expect(400);
            await toggle(true);
            assert.equal((await menu()).categories.length, 1);
          }
          await sql.query(
            "UPDATE sales_channels SET active=false WHERE code='COUNTER'",
          );
          await call('get', '?channel=COUNTER').expect(400);
          await sql.query(
            "UPDATE sales_channels SET active=true WHERE code='COUNTER'",
          );
          await call('get', '?channel=MISSING').expect(400);
          await sql.query(
            "INSERT INTO sales_channels(code,name) VALUES ('PHONE','Phone')",
          );
          await price('PHONE', '190');
          await available('PHONE', true);
          assert.equal((await menu('PHONE')).categories.length, 1);
        },
      );
      await t.test(
        'concurrent price updates reject stale version and audit successful edit',
        async () => {
          const results = await Promise.all(
            ['181', '182'].map((amount) =>
              call(
                'put',
                `/variants/${item.variants[0].id}/channels/COUNTER/price`,
                { itemVersion: item.version, price: amount },
              ),
            ),
          );
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
          assert.equal(
            results.find((r) => r.status === 409).body.code,
            'MENU_VERSION_CONFLICT',
          );
          await current();
          const audit = await sql.query(
            'SELECT * FROM menu_audit WHERE item_id=$1 ORDER BY created_at DESC',
            [item.id],
          );
          assert.equal(audit.rows[0].actor_id, owner.id);
          assert.ok(audit.rows[0].before_value);
          assert.equal(audit.rows[0].after_value.version, item.version);
          await assert.rejects(
            sql.query('DELETE FROM menu_audit WHERE item_id=$1', [item.id]),
            /AUDIT_IMMUTABLE/,
          );
        },
      );
      await t.test(
        'database constraints reject invalid prices, references, duplicate tuples and variant removal',
        async () => {
          const id = item.variants[0].id;
          for (const amount of [
            '-1',
            '1.001',
            'NaN',
            'Infinity',
            '1000000000000',
          ])
            await assert.rejects(
              sql.query(
                "UPDATE variant_channel_settings SET price=$2 WHERE variant_id=$1 AND channel_code='COUNTER'",
                [id, amount],
              ),
              (e) => e.code === '23514',
            );
          await assert.rejects(
            sql.query(
              "INSERT INTO variant_channel_settings VALUES ($1,'COUNTER',10,true)",
              [id],
            ),
            (e) => e.code === '23505',
          );
          await assert.rejects(
            sql.query(
              "INSERT INTO variant_channel_settings VALUES ($1,'MISSING',10,true)",
              [id],
            ),
            (e) => e.code === '23503',
          );
          await assert.rejects(
            sql.query(
              "INSERT INTO menu_items(category_id,name) VALUES ($1,'No variants')",
              [category.id],
            ),
            /ITEM_REQUIRES_VARIANT/,
          );
          const single = (
            await sql.query("SELECT id FROM menu_items WHERE name='Biryani'")
          ).rows[0].id;
          await assert.rejects(
            sql.query('DELETE FROM item_variants WHERE menu_item_id=$1', [
              single,
            ]),
            /ITEM_REQUIRES_VARIANT/,
          );
          await assert.rejects(
            sql.query(
              "INSERT INTO item_variants(menu_item_id,name) VALUES ($1,'full')",
              [item.id],
            ),
            (e) => e.code === '23505',
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
