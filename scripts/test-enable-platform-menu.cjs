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
  'platform menu SQL without TEMPORARY privilege',
  { timeout: 120000 },
  async (t) => {
    const original = process.env.DATABASE_URL;
    const url = new URL(original);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    assert.notEqual(url.pathname, '/dukanos_prod');
    assert.notEqual(process.env.NODE_ENV, 'production');
    const id = randomUUID().replaceAll('-', '');
    const database = 'dukanos_platform_test_' + id;
    const role = 'platform_maint_' + id;
    const admin = new Client({ connectionString: original });
    const directory = await mkdtemp(join(tmpdir(), 'dukanos-platform-sql-'));
    let sql, db;
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      await admin.query(`CREATE DATABASE "${database}"`);
      url.pathname = '/' + database;
      url.search = '';
      const setup = new Client({ connectionString: url.toString() });
      await setup.connect();
      try {
        await setup.query(`CREATE SCHEMA dukanos AUTHORIZATION "${role}"`);
      } finally {
        await setup.end();
      }
      url.searchParams.set('options', `-csearch_path=dukanos -crole=${role}`);
      process.env.DATABASE_URL = url.toString();
      await execFile(process.execPath, ['scripts/migrate.mjs'], {
        env: process.env,
      });
      await admin.query(
        `REVOKE TEMPORARY ON DATABASE "${database}" FROM PUBLIC,"${role}"`,
      );
      sql = new Client({ connectionString: url.toString() });
      await sql.connect();
      assert.equal(
        (
          await sql.query(
            "SELECT has_database_privilege(current_user,current_database(),'TEMP') AS temp",
          )
        ).rows[0].temp,
        false,
      );
      db = new DatabaseService();
      const users = new UsersService(db);
      const owner = await users.create({
        username: 'platformowner',
        name: 'Owner',
        password: 'fixture password 123!',
        roles: ['OWNER'],
      });
      await users.create(
        {
          username: 'cashier',
          name: 'Cashier',
          password: 'fixture password 123!',
          roles: ['CASHIER'],
        },
        owner,
      );
      const login = await new AuthService(db, users).login(
        'platformowner',
        'fixture password 123!',
        '127.0.0.1',
      );
      const actor = { user: login.user, sessionHash: tokenHash(login.token) };
      const menu = new MenuService(db, new MenuMediaService(db));
      // Build through existing application service from the review table; never run the seed SQL.
      const table = (
        await readFile('data/menu-import/rudragiri-menu-review.md', 'utf8')
      )
        .split('## Complete extracted menu')[1]
        .split('## Import behavior')[0];
      let category;
      for (const line of table.split('\n')) {
        if (line.startsWith('### '))
          category = await menu.createCategory({ name: line.slice(4) }, actor);
        if (!line.startsWith('|') || /^\|\s*(Dish|:?-)/.test(line)) continue;
        const [name, ...prices] = line
          .slice(1, -1)
          .split('|')
          .map((s) => s.trim());
        await menu.createItem(
          {
            categoryId: category.id,
            name,
            kitchenName: 'Kitchen ' + name,
            description: 'Preserve this description',
            variants: prices.flatMap((price, i) =>
              price === '—'
                ? []
                : [
                    {
                      name: ['REGULAR', 'HALF', 'FULL', 'REFILL'][i],
                      displayLabel: 'Label ' + i,
                      channels: [
                        {
                          channelCode: 'COUNTER',
                          price: price + '.00',
                          available: true,
                        },
                      ],
                    },
                  ],
            ),
          },
          actor,
        );
      }
      const catalog = await menu.catalog();
      // A valid attached photo metadata snapshot (no file reads occur in this SQL test).
      const imageKey = randomUUID();
      await sql.query(
        'INSERT INTO menu_images(key,uploaded_by,width,height,byte_size) VALUES($1,$2,100,100,100)',
        [imageKey, owner.id],
      );
      await sql.query('UPDATE menu_items SET image_key=$1 WHERE id=$2', [
        imageKey,
        catalog.items[0].id,
      ]);
      const variant = catalog.items[0].variants[0];
      // Exercise paise precision rather than relying solely on the menu's whole-rupee prices.
      await sql.query(
        "UPDATE variant_channel_settings SET price='12.35' WHERE variant_id=$1 AND channel_code='COUNTER'",
        [variant.id],
      );
      const clock = new RestaurantClock();
      await new OrdersService(
        db,
        menu,
        new BillsService(db, clock),
        clock,
      ).confirm(
        {
          requestId: randomUUID(),
          serviceType: 'TAKEAWAY',
          lines: [{ variantId: variant.id, quantity: 1 }],
          payment: { expectedDue: '12.35', cash: '12.35', upi: '0.00' },
        },
        actor,
      );
      const source = await readFile('scripts/enable-platform-menu.sql', 'utf8');
      const pgEnv = {
        ...process.env,
        PGHOST: url.hostname,
        PGPORT: url.port || '5432',
        PGDATABASE: database,
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        PGOPTIONS: `-crole=${role}`,
        PGPASSFILE: '/dev/null',
      };
      delete pgEnv.PGSERVICE;
      const run = async (
        text = source,
        apply = false,
        username = 'platformowner',
        confirm = 'ENABLE_PLATFORMS_156_312',
      ) => {
        const path = join(directory, randomUUID() + '.sql');
        await writeFile(path, text);
        try {
          const r = await execFile(
            'psql',
            [
              '-X',
              '-q',
              '-v',
              `expected_database=${database}`,
              '-v',
              `owner_username=${username}`,
              '-v',
              `apply=${apply}`,
              '-v',
              `confirm=${confirm}`,
              '-f',
              path,
            ],
            { env: pgEnv, maxBuffer: 2 * 1024 * 1024 },
          );
          return { ok: true, text: r.stdout + r.stderr };
        } catch (e) {
          return { ok: false, text: e.stderr };
        }
      };
      const snapshot = async () => {
        const rows = {};
        for (const { tablename } of (
          await sql.query(
            "SELECT tablename FROM pg_tables WHERE schemaname='dukanos' ORDER BY tablename",
          )
        ).rows)
          rows[tablename] = (
            await sql.query(
              `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS data FROM "${tablename}" t`,
            )
          ).rows[0].data;
        return rows;
      };
      const before = await snapshot();
      const beforeCatalog = await menu.catalog();
      assert.equal(before.menu_audit.length, 133);
      await t.test(
        'default complete dry-run leaves all tables unchanged without TEMP',
        async () => {
          const r = await run();
          assert.ok(r.ok, r.text);
          assert.match(r.text, /inserted: 312.*audits: 118/);
          assert.deepEqual(await snapshot(), before);
        },
      );
      await t.test(
        'owner and explicit apply confirmation are mandatory',
        async () => {
          for (const args of [
            [source, true, 'cashier'],
            [source, true, 'missing'],
            [source, true, 'platformowner', 'wrong'],
          ])
            assert.equal((await run(...args)).ok, false);
          assert.deepEqual(await snapshot(), before);
        },
      );
      await t.test(
        'late failure rolls back inserts, item versions and earlier audits',
        async () => {
          const fault = source.replace(
            'INSERT INTO menu_audit(actor_id,item_id,action,before_value,after_value)',
            "IF updated_items=1 THEN RAISE EXCEPTION 'INJECTED_FAILURE'; END IF;\n INSERT INTO menu_audit(actor_id,item_id,action,before_value,after_value)",
          );
          const r = await run(fault, true);
          assert.equal(r.ok, false);
          assert.match(r.text, /INJECTED_FAILURE/);
          assert.deepEqual(await snapshot(), before);
        },
      );
      await t.test(
        'simultaneous first apply inserts 312 records and exactly 118 audits',
        async () => {
          const result = await Promise.all([
            run(source, true),
            run(source, true),
          ]);
          for (const r of result) assert.ok(r.ok, r.text);
          const after = await snapshot();
          assert.equal(after.variant_channel_settings.length, 468);
          assert.equal(after.menu_audit.length, 251);
          for (const table of Object.keys(before))
            if (
              ![
                'menu_items',
                'variant_channel_settings',
                'menu_audit',
              ].includes(table)
            )
              assert.deepEqual(after[table], before[table], table);
          assert.deepEqual(
            after.variant_channel_settings.filter(
              (s) => s.channel_code === 'COUNTER',
            ),
            before.variant_channel_settings,
          );
          for (const row of before.menu_items) {
            const next = after.menu_items.find((i) => i.id === row.id);
            const portions = before.item_variants.filter(
              (v) => v.menu_item_id === row.id,
            ).length;
            assert.equal(next.version, row.version + 2 * portions);
            assert.deepEqual(
              { ...next, version: row.version, updated_at: row.updated_at },
              row,
            );
          }
          for (const a of before.menu_audit)
            assert.deepEqual(
              after.menu_audit.find((n) => n.id === a.id),
              a,
            );
          for (const p of after.variant_channel_settings.filter(
            (s) => s.channel_code !== 'COUNTER',
          )) {
            const c = before.variant_channel_settings.find(
              (s) => s.variant_id === p.variant_id,
            );
            assert.equal(p.price, c.price);
            assert.equal(p.available, true);
            assert.equal(p.normal_amount, null);
            assert.equal(p.reduced_amount, null);
            assert.equal(p.serving_unit, null);
          }
        },
      );
      await t.test(
        'before/after UPDATED snapshots equal full application model including images and labels',
        async () => {
          const afterCatalog = await menu.catalog();
          const audits = (
            await sql.query("SELECT * FROM menu_audit WHERE action='UPDATED'")
          ).rows;
          assert.equal(audits.length, 118);
          for (const a of audits) {
            assert.equal(a.actor_id, owner.id);
            assert.deepEqual(
              a.before_value,
              beforeCatalog.items.find((i) => i.id === a.item_id),
            );
            assert.deepEqual(
              a.after_value,
              afterCatalog.items.find((i) => i.id === a.item_id),
            );
          }
        },
      );
      await t.test(
        'repeat apply and read-only verification make no changes',
        async () => {
          const saved = await snapshot();
          const r = await run(source, true);
          assert.ok(r.ok, r.text);
          assert.match(r.text, /inserted: 0.*audits: 0/);
          assert.deepEqual(await snapshot(), saved);
          const verify = await run(
            await readFile('scripts/verify-platform-menu.sql', 'utf8'),
          );
          assert.ok(verify.ok, verify.text);
          assert.deepEqual(await snapshot(), saved);
        },
      );
      const target = variant.id;
      for (const [name, assignment] of [
        ['price', 'price=999'],
        ['null price', 'price=NULL'],
        ['availability', 'available=false'],
        [
          'measurements',
          "normal_amount=200,reduced_amount=150,serving_unit='g'",
        ],
      ]) {
        await t.test(
          'conflicting ' + name + ' is rejected without overwriting any record',
          async () => {
            await sql.query(
              `UPDATE variant_channel_settings SET ${assignment} WHERE variant_id=$1 AND channel_code='SWIGGY'`,
              [target],
            );
            const saved = await snapshot();
            const r = await run(source, true);
            assert.equal(r.ok, false);
            assert.match(r.text, /PLATFORM_MENU_CONFLICT/);
            assert.deepEqual(await snapshot(), saved);
            await sql.query(
              "UPDATE variant_channel_settings SET price=(SELECT price FROM variant_channel_settings WHERE variant_id=$1 AND channel_code='COUNTER'),available=true,normal_amount=NULL,reduced_amount=NULL,serving_unit=NULL WHERE variant_id=$1 AND channel_code='SWIGGY'",
              [target],
            );
          },
        );
      }
      await t.test(
        'partial matching settings add only missing record and one item audit',
        async () => {
          await sql.query(
            "DELETE FROM variant_channel_settings WHERE variant_id=$1 AND channel_code='ZOMATO'",
            [target],
          );
          const saved = await snapshot();
          const r = await run(source, true);
          assert.ok(r.ok, r.text);
          assert.match(r.text, /inserted: 1.*audits: 1/);
          const after = await snapshot();
          assert.equal(after.menu_audit.length, saved.menu_audit.length + 1);
          for (const s of saved.variant_channel_settings)
            assert.deepEqual(
              after.variant_channel_settings.find(
                (n) =>
                  n.variant_id === s.variant_id &&
                  n.channel_code === s.channel_code,
              ),
              s,
            );
        },
      );
      await t.test(
        'missing Counter price and inactive references abort before any writes',
        async () => {
          await sql.query(
            "DELETE FROM variant_channel_settings WHERE variant_id=$1 AND channel_code='COUNTER'",
            [target],
          );
          const saved = await snapshot();
          const r = await run(source, true);
          assert.equal(r.ok, false);
          assert.match(r.text, /PLATFORM_MENU_BASELINE_INVALID/);
          assert.deepEqual(await snapshot(), saved);
          await sql.query(
            "INSERT INTO variant_channel_settings(variant_id,channel_code,price,available) VALUES($1,'COUNTER',12.35,true)",
            [target],
          );
          await sql.query(
            "UPDATE sales_channels SET active=false WHERE code='SWIGGY'",
          );
          const inactive = await snapshot();
          const s = await run(source, true);
          assert.equal(s.ok, false);
          assert.match(s.text, /PLATFORM_MENU_BASELINE_INVALID/);
          assert.deepEqual(await snapshot(), inactive);
        },
      );
    } finally {
      if (db) await db.onApplicationShutdown();
      if (sql) await sql.end();
      process.env.DATABASE_URL = original;
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
