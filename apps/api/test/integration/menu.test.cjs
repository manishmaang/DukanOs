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
            }).expect(200)
          ).body;
          assert.equal(category.name, 'Chinese food');
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
            }).expect(201)
          ).body;
          const other = item.variants.find((v) => v.name === '500 ml');
          item = (
            await call('patch', '/variants/' + other.id, {
              itemVersion: item.version,
              name: 'Half',
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

      await t.test(
        'display ordering is rejected across public write contracts and absent in reads',
        async () => {
          for (const field of [
            'sortOrder',
            'displayOrder',
            'display_order',
            'sort_order',
          ]) {
            await call('post', '/categories', {
              name: 'Bad category',
              [field]: 1,
            }).expect(400);
            await call('patch', '/categories/' + category.id, {
              version: category.version,
              [field]: 1,
            }).expect(400);
            await call('post', '/items', {
              categoryId: category.id,
              name: 'Bad item',
              variants: [{ name: 'Standard' }],
              [field]: 1,
            }).expect(400);
            await call('post', '/items', {
              categoryId: category.id,
              name: 'Bad portion',
              variants: [{ name: 'Standard', [field]: 1 }],
            }).expect(400);
            await call('patch', '/items/' + item.id, {
              version: item.version,
              [field]: 1,
            }).expect(400);
            await call('patch', '/variants/' + item.variants[0].id, {
              itemVersion: item.version,
              [field]: 1,
            }).expect(400);
            await call('post', '/items/' + item.id + '/variants', {
              itemVersion: item.version,
              name: 'Bad',
              [field]: 1,
            }).expect(400);
          }
          const catalog = (await call('get', '/admin').expect(200)).body;
          assert.doesNotMatch(
            JSON.stringify(catalog),
            /sortOrder|displayOrder|sort_order|display_order/,
          );
        },
      );
      const payload = (i) => ({
        version: i.version,
        name: i.name,
        categoryId: i.categoryId,
        description: i.description,
        kitchenName: i.kitchenName,
        active: i.active,
        variants: i.variants.map((v) => ({
          id: v.id,
          name: v.name,
          displayLabel: v.displayLabel,
          active: v.active,
          channels: v.channels.map((c) => ({ ...c })),
        })),
      });
      let dish;
      await t.test(
        'one save creates portions and channel prices; owner/manager edit in one atomic request',
        async () => {
          const input = {
            name: 'Veg Noodles complete',
            categoryId: category.id,
            description: 'One save',
            variants: ['Regular', 'Half', 'Full'].map((name, index) => ({
              name,
              channels: [
                {
                  channelCode: 'COUNTER',
                  price: ['80', '120', '180'][index],
                  available: true,
                },
                {
                  channelCode: 'ZOMATO',
                  price: ['95', '140', '210'][index],
                  available: true,
                },
                {
                  channelCode: 'SWIGGY',
                  price: ['95', '145', '215'][index],
                  available: true,
                },
              ],
            })),
          };
          dish = (await call('post', '/items', input, 'MANAGER').expect(201))
            .body;
          assert.deepEqual(
            dish.variants.map((v) => v.name),
            ['Regular', 'Half', 'Full'],
          );
          assert.equal(
            dish.variants[0].channels.find((c) => c.channelCode === 'COUNTER')
              .price,
            '80.00',
          );
          const originalIds = dish.variants.map((v) => v.id);
          const update = payload(dish);
          update.name = 'Veg Noodles edited';
          update.description = 'All together';
          update.variants[0].displayLabel = 'R';
          update.variants[0].channels.find(
            (c) => c.channelCode === 'COUNTER',
          ).price = '85.50';
          for (const v of update.variants)
            v.channels.find((c) => c.channelCode === 'SWIGGY').available =
              false;
          dish = (await call('put', '/items/' + dish.id, update).expect(200))
            .body;
          assert.deepEqual(
            dish.variants.map((v) => v.id),
            originalIds,
          );
          assert.equal(dish.description, 'All together');
          assert.equal(dish.variants[0].displayLabel, 'R');
          assert.ok(
            !(await menu('SWIGGY')).categories
              .flatMap((c) => c.items)
              .some((i) => i.id === dish.id),
          );
          assert.ok(
            (await menu()).categories
              .flatMap((c) => c.items)
              .some((i) => i.id === dish.id),
          );
          for (const role of ['CASHIER', 'KITCHEN', 'DISPATCH']) {
            await call('put', '/items/' + dish.id, payload(dish), role).expect(
              403,
            );
            await call('post', '/items', input, role).expect(403);
          }
        },
      );
      await t.test(
        'full-dish renaming can swap portion names without replacing identities',
        async () => {
          const change = payload(dish);
          const originalIds = change.variants.map((v) => v.id);
          [change.variants[0].name, change.variants[1].name] = [
            change.variants[1].name,
            change.variants[0].name,
          ];
          const swapped = (
            await call('put', '/items/' + dish.id, change).expect(200)
          ).body;
          assert.deepEqual(
            swapped.variants.map((v) => v.id),
            originalIds,
          );
          assert.deepEqual(
            swapped.variants.map((v) => v.name),
            ['Half', 'Regular', 'Full'],
          );
          dish = (
            await call('put', '/items/' + dish.id, {
              ...payload(dish),
              version: swapped.version,
            }).expect(200)
          ).body;
        },
      );
      await t.test(
        'invalid nested writes preserve names, variants, prices, versions and audit; no partial creation',
        async () => {
          const before = (await call('get', '/items/' + dish.id).expect(200))
            .body;
          const audits = (
            await sql.query(
              'SELECT count(*) FROM menu_audit WHERE item_id=$1',
              [dish.id],
            )
          ).rows[0].count;
          for (const kind of [
            'negative',
            'precision',
            'duplicate',
            'missing',
            'foreign',
            'channel',
            'repeatedChannel',
            'clearPrice',
            'order',
          ]) {
            const change = payload(before);
            change.name = 'Should never persist';
            change.variants[0].channels[0].price = '81';
            if (kind === 'negative')
              change.variants[2].channels[0].price = '-1';
            if (kind === 'precision')
              change.variants[2].channels[0].price = '9.999';
            if (kind === 'duplicate') change.variants[2].name = 'regular';
            if (kind === 'missing') change.variants.pop();
            if (kind === 'foreign') change.variants[2].id = item.variants[0].id;
            if (kind === 'channel')
              change.variants[2].channels[0].channelCode = 'UNKNOWN';
            if (kind === 'repeatedChannel')
              change.variants[2].channels.push({
                ...change.variants[2].channels[0],
              });
            if (kind === 'clearPrice') change.variants[2].channels.pop();
            if (kind === 'order') change.variants[2].sortOrder = 1;
            await call('put', '/items/' + dish.id, change).expect(
              ['duplicate', 'repeatedChannel'].includes(kind) ? 409 : 400,
            );
            assert.deepEqual(
              (await call('get', '/items/' + dish.id)).body,
              before,
            );
          }
          assert.equal(
            (
              await sql.query(
                'SELECT count(*) FROM menu_audit WHERE item_id=$1',
                [dish.id],
              )
            ).rows[0].count,
            audits,
          );
          await call('post', '/items', {
            name: 'Should not exist',
            categoryId: category.id,
            variants: [
              {
                name: 'Good',
                channels: [
                  { channelCode: 'COUNTER', price: '80', available: true },
                ],
              },
              {
                name: 'Bad',
                channels: [
                  { channelCode: 'SWIGGY', price: '-10', available: true },
                ],
              },
            ],
          }).expect(400);
          assert.equal(
            (
              await sql.query(
                "SELECT count(*) FROM menu_items WHERE name='Should not exist'",
              )
            ).rows[0].count,
            '0',
          );
          // Force a late database rejection after metadata/first portion writes to prove rollback.
          await sql.query(
            "CREATE FUNCTION reject_test_price() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.price=987.65 THEN RAISE EXCEPTION 'TEST_REJECTION' USING ERRCODE='23514'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_test_price BEFORE INSERT OR UPDATE ON variant_channel_settings FOR EACH ROW EXECUTE FUNCTION reject_test_price()",
          );
          try {
            const change = payload(before);
            change.name = 'Must rollback';
            change.variants[0].name = 'Changed portion';
            change.variants[2].channels[0].price = '987.65';
            await call('put', '/items/' + dish.id, change).expect(500);
            assert.deepEqual(
              (await call('get', '/items/' + dish.id)).body,
              before,
            );
          } finally {
            await sql.query(
              'DROP TRIGGER reject_test_price ON variant_channel_settings; DROP FUNCTION reject_test_price()',
            );
          }
        },
      );
      await t.test(
        'aggregate updates preserve activation and stale-write protections',
        async () => {
          let change = payload(dish);
          change.active = false;
          dish = (await call('put', '/items/' + dish.id, change).expect(200))
            .body;
          assert.ok(
            !(await menu()).categories
              .flatMap((c) => c.items)
              .some((i) => i.id === dish.id),
          );
          assert.ok(
            dish.variants[0].channels.find((c) => c.channelCode === 'COUNTER')
              .available,
          );
          change = payload(dish);
          change.variants[0].channels[0].price = '10';
          await call('put', '/items/' + dish.id, change).expect(400);
          change = payload(dish);
          change.active = true;
          change.variants[0].active = false;
          dish = (await call('put', '/items/' + dish.id, change).expect(200))
            .body;
          assert.equal(
            (await menu()).categories
              .flatMap((c) => c.items)
              .find((i) => i.id === dish.id).variants.length,
            2,
          );
          const results = await Promise.all(
            ['Edit A', 'Edit B'].map((description) =>
              call('put', '/items/' + dish.id, {
                ...payload(dish),
                description,
              }),
            ),
          );
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
          dish = results.find((r) => r.status === 200).body;
        },
      );
      await t.test(
        'admin newest first; POS oldest first with deterministic timestamp ties and stable renames',
        async () => {
          const first = (
            await call('post', '/categories', {
              name: 'Ordering first',
            }).expect(201)
          ).body;
          const second = (
            await call('post', '/categories', {
              name: 'Ordering second',
            }).expect(201)
          ).body;
          let cats = (await call('get', '/categories')).body;
          assert.deepEqual(
            cats.slice(0, 2).map((c) => c.id),
            [second.id, first.id],
          );
          const create = async (name) =>
            (
              await call('post', '/items', {
                categoryId: first.id,
                name,
                variants: [
                  {
                    name: 'Standard',
                    channels: [
                      { channelCode: 'COUNTER', price: '10', available: true },
                    ],
                  },
                ],
              }).expect(201)
            ).body;
          let older = await create('Z oldest');
          const newer = await create('A newest');
          const adminIds = async () =>
            (await call('get', '/items')).body
              .filter((i) => i.categoryId === first.id)
              .map((i) => i.id);
          const posIds = async () =>
            (await menu()).categories
              .find((c) => c.id === first.id)
              .items.map((i) => i.id);
          assert.deepEqual(await adminIds(), [newer.id, older.id]);
          assert.deepEqual(await posIds(), [older.id, newer.id]);
          older = (
            await call('patch', '/items/' + older.id, {
              version: older.version,
              name: 'Renamed',
            }).expect(200)
          ).body;
          assert.deepEqual(await adminIds(), [newer.id, older.id]);
          assert.deepEqual(await posIds(), [older.id, newer.id]);
          const third = await create('Third');
          assert.deepEqual(await adminIds(), [third.id, newer.id, older.id]);
          assert.deepEqual(await posIds(), [older.id, newer.id, third.id]);
          await sql.query(
            "UPDATE menu_items SET created_at='2026-01-01T00:00:00Z' WHERE category_id=$1",
            [first.id],
          );
          const sorted = [older.id, newer.id, third.id].sort();
          assert.deepEqual(await adminIds(), [...sorted].reverse());
          assert.deepEqual(await posIds(), sorted);
          await sql.query(
            "UPDATE menu_categories SET created_at='2026-01-01T00:00:00Z' WHERE id=ANY($1::uuid[])",
            [[first.id, second.id]],
          );
          cats = (await call('get', '/categories')).body.filter((c) =>
            [first.id, second.id].includes(c.id),
          );
          assert.deepEqual(
            cats.map((c) => c.id),
            [first.id, second.id].sort().reverse(),
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
