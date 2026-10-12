require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { Client } = require('pg');
const {
  DatabaseService,
} = require('../apps/api/dist/database/database.service');
const {
  RestaurantClock,
} = require('../apps/api/dist/database/restaurant-clock');
const {
  UsersService,
} = require('../apps/api/dist/modules/users/users.service');
const {
  AuthService,
  tokenHash,
} = require('../apps/api/dist/modules/auth/auth.service');
const { MenuService } = require('../apps/api/dist/modules/menu/menu.service');
const {
  MenuMediaService,
} = require('../apps/api/dist/modules/menu/menu-media.service');
const {
  BillsService,
} = require('../apps/api/dist/modules/bills/bills.service');
const {
  OrdersService,
} = require('../apps/api/dist/modules/orders/orders.service');

test(
  'standalone Rudragiri SQL on a disposable PostgreSQL database',
  { timeout: 120000 },
  async (t) => {
    const original = process.env.DATABASE_URL;
    const url = new URL(original);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    assert.notEqual(url.pathname, '/dukanos_prod');
    assert.notEqual(process.env.NODE_ENV, 'production');
    const dbName = 'dukanos_import_test_' + randomUUID().replaceAll('-', '');
    const admin = new Client({ connectionString: original });
    const directory = await mkdtemp(join(tmpdir(), 'dukanos-import-test-'));
    let sql, db;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      url.pathname = '/' + dbName;
      url.search = '';
      url.searchParams.set('options', '-csearch_path=dukanos');
      process.env.DATABASE_URL = url.toString();
      sql = new Client({ connectionString: url.toString() });
      await sql.connect();
      await sql.query('CREATE SCHEMA dukanos');
      await execFile(process.execPath, ['scripts/migrate.mjs'], {
        env: process.env,
      });
      db = new DatabaseService();
      const users = new UsersService(db);
      const owner = await users.create({
        username: 'importowner',
        name: 'Import Owner',
        password: 'fixture password 123!',
        roles: ['OWNER'],
      });
      await users.create(
        {
          username: 'importcashier',
          name: 'Cashier',
          password: 'fixture password 123!',
          roles: ['CASHIER'],
        },
        owner,
      );
      const auth = new AuthService(db, users);
      const login = await auth.login(
        'importowner',
        'fixture password 123!',
        '127.0.0.1',
      );
      const actor = { user: login.user, sessionHash: tokenHash(login.token) };
      const menu = new MenuService(db, new MenuMediaService(db));
      const category = await menu.createCategory(
        { name: 'Existing restaurant category' },
        actor,
      );
      const dish = await menu.createItem(
        {
          categoryId: category.id,
          name: 'Existing dish',
          kitchenName: 'Old kitchen name',
          variants: [
            {
              name: 'Standard',
              channels: [
                { channelCode: 'COUNTER', price: '12.50', available: true },
                { channelCode: 'SWIGGY', price: null, available: true },
              ],
            },
          ],
        },
        actor,
      );
      const clock = new RestaurantClock();
      const orders = new OrdersService(
        db,
        menu,
        new BillsService(db, clock),
        clock,
      );
      await orders.confirm(
        {
          requestId: randomUUID(),
          serviceType: 'TAKEAWAY',
          lines: [{ variantId: dish.variants[0].id, quantity: 1 }],
          payment: { expectedDue: '12.50', cash: '12.50', upi: '0.00' },
        },
        actor,
      );
      const source = await readFile('scripts/seed-rudragiri-menu.sql', 'utf8');
      const pgEnv = {
        ...process.env,
        PGHOST: url.hostname,
        PGPORT: url.port || '5432',
        PGDATABASE: dbName,
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        PGOPTIONS: '',
        PGSERVICEFILE: '/dev/null',
        PGPASSFILE: '/dev/null',
      };
      delete pgEnv.PGSERVICE;
      const run = async (
        text = source,
        apply = false,
        ownerName = 'importowner',
        confirm = 'RUDRAGIRI_118_156',
      ) => {
        const path = join(directory, randomUUID() + '.sql');
        await writeFile(path, text);
        try {
          const result = await execFile(
            'psql',
            [
              '-X',
              '-q',
              '-v',
              'ON_ERROR_STOP=1',
              '-v',
              `expected_database=${dbName}`,
              '-v',
              'target_schema=dukanos',
              '-v',
              `owner_username=${ownerName}`,
              '-v',
              `apply=${apply}`,
              '-v',
              `confirm=${confirm}`,
              '-f',
              path,
            ],
            { env: pgEnv, maxBuffer: 2 * 1024 * 1024 },
          );
          return { ok: true, text: result.stdout };
        } catch (e) {
          return { ok: false, text: e.stderr };
        }
      };
      const snapshot = async () => {
        const result = {};
        for (const { tablename } of (
          await sql.query(
            "SELECT tablename FROM pg_tables WHERE schemaname='dukanos' ORDER BY tablename",
          )
        ).rows)
          result[tablename] = (
            await sql.query(
              `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS data FROM "${tablename}" t`,
            )
          ).rows[0].data;
        return result;
      };
      const before = await snapshot();
      await t.test(
        'default dry run validates and rolls back menu plus audit',
        async () => {
          const result = await run();
          assert.ok(result.ok, result.text);
          assert.match(result.text, /DRY RUN/);
          assert.deepEqual(await snapshot(), before);
        },
      );
      for (const [label, modified] of [
        ['negative price', source.replace("'70.00'", "'-70.00'")],
        ['overprecision', source.replace("'70.00'", "'70.001'")],
        [
          'unsupported variant',
          source.replace("'FULL','70.00'", "'SMALL','70.00'"),
        ],
        [
          'missing category',
          source.replace(
            "'SANDWICH/BURGER','VEG SANDWICH'",
            "'','VEG SANDWICH'",
          ),
        ],
        [
          'duplicate scoped dish',
          source.replace("'VEG CHEESE SANDWICH'", "'VEG SANDWICH'"),
        ],
        [
          'empty dataset',
          source.replace(
            /INSERT INTO import_rows VALUES[\s\S]*?;\n-- END REVIEWED MENU DATA/,
            '-- END REVIEWED MENU DATA',
          ),
        ],
      ])
        await t.test(label + ' fails without changing data', async () => {
          assert.notEqual(modified, source);
          const result = await run(modified, true);
          assert.equal(result.ok, false);
          assert.match(result.text, /ERROR:.*(constraint|IMPORT_)/);
          assert.deepEqual(await snapshot(), before);
        });
      await t.test(
        'requires explicit confirmation and authorized existing owner',
        async () => {
          assert.equal(
            (await run(source, true, 'importowner', 'wrong')).ok,
            false,
          );
          assert.equal((await run(source, true, 'importcashier')).ok, false);
          assert.equal((await run(source, true, 'unknown')).ok, false);
          assert.deepEqual(await snapshot(), before);
        },
      );
      await t.test(
        'late audit failure rolls back all categories/items/portions/prices',
        async () => {
          const fault = source.replace(
            '-- Equivalent public aggregate snapshots',
            () =>
              "CREATE FUNCTION pg_temp.fail_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_FAILURE'; END $$;\nCREATE TRIGGER test_import_failure BEFORE INSERT ON menu_audit FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_import();\n-- Equivalent public aggregate snapshots",
          );
          const result = await run(fault, true);
          assert.equal(result.ok, false);
          assert.match(result.text, /INJECTED_FAILURE/);
          assert.deepEqual(await snapshot(), before);
        },
      );
      await t.test(
        'first concurrent imports create one set, preserve users/financial history and unrelated menu',
        async () => {
          const results = await Promise.all([
            run(source, true),
            run(source, true),
          ]);
          for (const result of results) assert.ok(result.ok, result.text);
          const after = await snapshot();
          const changed = new Set([
            'menu_categories',
            'menu_items',
            'item_variants',
            'variant_channel_settings',
            'menu_audit',
          ]);
          for (const table of Object.keys(before)) {
            if (!changed.has(table))
              assert.equal(after[table], before[table], table);
            else
              for (const row of JSON.parse(before[table]))
                assert.ok(
                  JSON.parse(after[table]).some(
                    (r) => JSON.stringify(r) === JSON.stringify(row),
                  ),
                  table,
                );
          }
          assert.equal(JSON.parse(after.menu_items).length, 119);
          assert.equal(JSON.parse(after.item_variants).length, 157);
          assert.equal(JSON.parse(after.menu_categories).length, 16);
          assert.equal(
            JSON.parse(after.menu_audit).length -
              JSON.parse(before.menu_audit).length,
            133,
          );
        },
      );
      await t.test(
        'repeat apply is an exact database no-op including timestamps, versions and audits',
        async () => {
          const saved = await snapshot();
          const result = await run(source, true);
          assert.ok(result.ok, result.text);
          assert.deepEqual(await snapshot(), saved);
        },
      );
      await t.test(
        'all audit snapshots match application read model and Counter menu is sellable',
        async () => {
          const catalog = await menu.catalog();
          for (const a of (await sql.query('SELECT * FROM menu_audit')).rows) {
            if (a.item_id === dish.id || a.category_id === category.id)
              continue;
            assert.deepEqual(
              a.after_value,
              a.item_id
                ? catalog.items.find((i) => i.id === a.item_id)
                : catalog.categories.find((c) => c.id === a.category_id),
            );
            assert.equal(a.actor_id, owner.id);
          }
          assert.ok(catalog.items.every((i) => i.counterVisibility.visible));
          const indian = catalog.categories.find((c) => c.name === 'INDIAN').id;
          for (const [name, amounts] of [
            ['CHOLE', ['90.00', '110.00', '160.00']],
            ['BUTTER PANEER MASALA', ['120.00', '170.00', '210.00']],
          ]) {
            const item = catalog.items.find(
              (i) => i.categoryId === indian && i.name === name,
            );
            assert.deepEqual(
              item.variants.map((v) => v.name),
              ['REGULAR', 'HALF', 'FULL'],
            );
            assert.deepEqual(
              item.variants.map((v) => v.channels[0].price),
              amounts,
            );
          }
          assert.equal(
            catalog.items.find((i) => i.name === 'SEV TAMATAR').variants[0]
              .channels[0].price,
            '130.00',
          );
          assert.deepEqual(
            catalog.items
              .find((i) => i.name === 'EXTRA PAV')
              .variants.map((v) => v.name),
            ['REFILL'],
          );
          assert.deepEqual(
            catalog.items
              .find((i) => i.name === 'VEG SANDWICH')
              .variants.map((v) => v.name),
            ['FULL'],
          );
          assert.deepEqual(
            catalog.items
              .find((i) => i.name === 'MACRONI')
              .variants.map((v) => v.name),
            ['HALF', 'FULL'],
          );
        },
      );
      await t.test(
        'read-only reconciliation leaves every record unchanged',
        async () => {
          const saved = await snapshot();
          const result = await run(
            await readFile('scripts/verify-rudragiri-menu.sql', 'utf8'),
          );
          assert.ok(result.ok, result.text);
          assert.deepEqual(await snapshot(), saved);
        },
      );
      await t.test(
        'matching imported items preserve separate kitchen names and platform settings',
        async () => {
          const id = (
            await sql.query(
              "SELECT id FROM menu_items WHERE name='EXTRA CHOLE'",
            )
          ).rows[0].id;
          await sql.query(
            "UPDATE menu_items SET kitchen_name='Custom Kitchen Label' WHERE id=$1",
            [id],
          );
          await sql.query(
            "INSERT INTO variant_channel_settings(variant_id,channel_code,price,available,normal_amount,reduced_amount,serving_unit) SELECT id,'SWIGGY',NULL,true,200,150,'g' FROM item_variants WHERE menu_item_id=$1",
            [id],
          );
          const saved = await snapshot();
          const result = await run(source, true);
          assert.ok(result.ok, result.text);
          assert.deepEqual(await snapshot(), saved);
        },
      );
      await t.test(
        'existing conflict is never overwritten or partially repaired',
        async () => {
          await sql.query(
            "UPDATE variant_channel_settings SET available=false WHERE variant_id=(SELECT v.id FROM item_variants v JOIN menu_items i ON i.id=v.menu_item_id WHERE i.name='EXTRA PAV') AND channel_code='COUNTER'",
          );
          const saved = await snapshot();
          const result = await run(source, true);
          assert.equal(result.ok, false);
          assert.match(result.text, /IMPORT_CONFLICT/);
          assert.deepEqual(await snapshot(), saved);
        },
      );
      await t.test(
        'partial existing item is rejected without adding missing channel rows',
        async () => {
          await sql.query(
            "DELETE FROM variant_channel_settings WHERE variant_id=(SELECT v.id FROM item_variants v JOIN menu_items i ON i.id=v.menu_item_id WHERE i.name='EXTRA PAV') AND channel_code='COUNTER'",
          );
          const saved = await snapshot();
          const result = await run(source, true);
          assert.equal(result.ok, false);
          assert.match(result.text, /IMPORT_CONFLICT/);
          assert.deepEqual(await snapshot(), saved);
        },
      );
    } finally {
      if (db) await db.onApplicationShutdown();
      if (sql) await sql.end();
      process.env.DATABASE_URL = original;
      // Only the uniquely named database created by this test is eligible for removal.
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('review table and executable SQL contain exactly the same 156 portion prices', async () => {
  const source = await readFile('scripts/seed-rudragiri-menu.sql', 'utf8');
  const data = source
    .split('-- BEGIN REVIEWED MENU DATA')[1]
    .split('-- END REVIEWED MENU DATA')[0];
  const actual = [];
  const row =
    /\(\d+,\d+,\d+,'((?:[^']|'')*)','((?:[^']|'')*)','((?:[^']|'')*)','(\d+\.\d{2})'\)/g;
  for (const m of data.matchAll(row))
    actual.push(m.slice(1).map((v) => v.replaceAll("''", "'")));
  const table = (
    await readFile('data/menu-import/rudragiri-menu-review.md', 'utf8')
  )
    .split('## Complete extracted menu')[1]
    .split('## Import behavior')[0];
  const expected = [];
  let category;
  for (const line of table.split('\n')) {
    if (line.startsWith('### ')) category = line.slice(4);
    if (!line.startsWith('|') || /^\|\s*(Dish|:?-)/.test(line)) continue;
    const [dish, ...prices] = line
      .slice(1, -1)
      .split('|')
      .map((s) => s.trim());
    for (let i = 0; i < prices.length; i++)
      if (prices[i] !== '—')
        expected.push([
          category,
          dish,
          ['REGULAR', 'HALF', 'FULL', 'REFILL'][i],
          prices[i] + '.00',
        ]);
  }
  assert.equal(actual.length, 156);
  assert.deepEqual(actual, expected);
});
