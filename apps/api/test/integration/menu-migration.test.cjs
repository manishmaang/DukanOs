const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { randomUUID, createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
test('menu ordering and image migrations preserve an existing populated catalog and immutable history', async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const schema = 'menu_upgrade_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  const sql = new Client({ connectionString: url.toString() });
  await sql.connect();
  const root = path.resolve(__dirname, '../../../..');
  try {
    await sql.query(
      'CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of readdirSync(root + '/database/migrations')
      .filter((n) => n < '005')
      .sort()) {
      const source = readFileSync(
        root + '/database/migrations/' + name,
        'utf8',
      );
      await sql.query('BEGIN');
      await sql.query(source);
      await sql.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)',
        [name, createHash('sha256').update(source).digest('hex')],
      );
      await sql.query('COMMIT');
    }
    await sql.query('BEGIN');
    const user = (
      await sql.query(
        "INSERT INTO users(username,name,password_hash) VALUES ('fixture','Fixture','fixture-only') RETURNING id",
      )
    ).rows[0].id;
    await sql.query("INSERT INTO user_roles VALUES ($1,'OWNER')", [user]);
    const category = (
      await sql.query(
        "INSERT INTO menu_categories(name,sort_order,active) VALUES ('Existing category',20,false) RETURNING id",
      )
    ).rows[0].id;
    const item = (
      await sql.query(
        "INSERT INTO menu_items(category_id,name,sort_order,description) VALUES ($1,'Existing dish',10,'Keep description') RETURNING id",
        [category],
      )
    ).rows[0].id;
    const variant = (
      await sql.query(
        "INSERT INTO item_variants(menu_item_id,name,sort_order,active) VALUES ($1,'Half',3,false) RETURNING id",
        [item],
      )
    ).rows[0].id;
    await sql.query(
      "INSERT INTO variant_channel_settings(variant_id,channel_code,price,available) VALUES ($1,'COUNTER',120.50,true),($1,'SWIGGY',150,false)",
      [variant],
    );
    await sql.query(
      'INSERT INTO menu_audit(actor_id,item_id,action,after_value) VALUES ($1,$2,\'CREATED\',\'{"sortOrder":10,"name":"Existing dish"}\')',
      [user, item],
    );
    await sql.query('COMMIT');
    const tables = [
      'menu_categories',
      'menu_items',
      'item_variants',
      'sales_channels',
      'variant_channel_settings',
      'menu_audit',
    ];
    const snapshot = async () => {
      const values = {};
      for (const table of tables)
        values[table] = (
          await sql.query(
            `SELECT to_jsonb(t)-'sort_order'-'image_key' AS value FROM ${table} t ORDER BY to_jsonb(t)::text`,
          )
        ).rows
          .map((r) => r.value)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return values;
    };
    const before = await snapshot();
    for (let run = 0; run < 2; run++) {
      const result = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: url.toString() },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      (await sql.query('SELECT image_key FROM menu_items')).rows[0].image_key,
      null,
    );
    assert.equal(
      (await sql.query('SELECT count(*) FROM menu_images')).rows[0].count,
      '0',
    );
    assert.equal(
      (
        await sql.query(
          "SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND column_name IN ('sort_order','display_order')",
          [schema],
        )
      ).rows[0].count,
      '0',
    );
    assert.equal(
      (
        await sql.query(
          "SELECT count(*) FROM schema_migrations WHERE name='005_menu_automatic_ordering.sql'",
        )
      ).rows[0].count,
      '1',
    );
  } finally {
    await sql.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
