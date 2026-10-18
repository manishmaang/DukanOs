// Starts its OWN PostgreSQL 16 cluster on a private Unix socket with TCP disabled.
// Never reads .env, DATABASE_URL, production backups or existing server sockets.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  rm,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const bin = '/usr/lib/postgresql/16/bin/';
const scriptPath = 'scripts/cleanup-test-orders-2026-10-17.sql';

test(
  'isolated PostgreSQL 16 test-order cleanup safety',
  { timeout: 180000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'dukanos-cleanup-review-'));
    const data = join(dir, 'pgdata');
    const env = {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      PGHOST: dir,
      PGPORT: '55439',
      PGUSER: 'postgres',
      PGDATABASE: 'dukanos_prod',
    };
    const run = (name, args) =>
      execFile(bin + name, args, { env, maxBuffer: 8 * 1024 * 1024 });
    let started = false;
    const sql = await readFile(scriptPath, 'utf8');
    const schemaQuery = sql.split('$schema$')[1];
    const ids = sql
      .match(/targets constant uuid\[\] := '\{([^}]+)\}'/)[1]
      .split(',');
    async function query(text) {
      const path = join(dir, 'query.sql');
      await writeFile(path, text);
      return (
        await run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-At', '-f', path])
      ).stdout.trim();
    }
    async function cleanup(flags = {}, content = sql) {
      const path = join(dir, 'cleanup.sql');
      await writeFile(path, content);
      try {
        const r = await run('psql', [
          '-X',
          ...Object.entries(flags).flatMap(([k, v]) => ['-v', `${k}=${v}`]),
          '-f',
          path,
        ]);
        return { ok: true, output: r.stdout + r.stderr };
      } catch (e) {
        return { ok: false, output: e.stdout + e.stderr };
      }
    }
    const snapshotSql = `SET search_path=dukanos,pg_catalog; SET timezone='UTC';
DO $$ DECLARE r record; rows jsonb; all_rows jsonb:='{}'; BEGIN
FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='dukanos' ORDER BY tablename LOOP
EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM dukanos.%I t',r.tablename) INTO rows;
all_rows:=all_rows||jsonb_build_object(r.tablename,rows); END LOOP;
PERFORM set_config('test.fingerprint',encode(sha256(convert_to(all_rows::text,'UTF8')),'hex'),false); END $$;
SELECT current_setting('test.fingerprint');
${schemaQuery};
SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='dukanos'::regnamespace AND t.tgenabled<>'O';`;
    let migrationSQL =
      'CREATE SCHEMA dukanos; SET search_path=dukanos,pg_catalog; BEGIN; CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());\n';
    for (const name of (await readdir('database/migrations'))
      .filter((n) => /^\d.*\.sql$/.test(n))
      .sort()) {
      const contents = await readFile('database/migrations/' + name, 'utf8');
      migrationSQL +=
        contents +
        `\nINSERT INTO schema_migrations(name,checksum) VALUES('${name}','${createHash('sha256').update(contents).digest('hex')}');\n`;
    }
    migrationSQL += 'COMMIT;';
    const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    // Reuse the reviewed public Menu aggregate shape, without running the import.
    const menuSnapshotSql = (
      await readFile('scripts/enable-platform-menu.sql', 'utf8')
    ).split('$snapshot$')[1];
    let fixture = `SET search_path=dukanos,pg_catalog; BEGIN;
INSERT INTO users(id,username,name,password_hash) VALUES('${owner}','fixtureowner','Synthetic owner','not-a-real-password-hash');
INSERT INTO user_roles VALUES('${owner}','OWNER');
INSERT INTO menu_categories(id,name) SELECT md5('category'||n)::uuid,'Synthetic category '||n FROM generate_series(1,15) n;
INSERT INTO menu_items(id,category_id,name) SELECT md5('item'||n)::uuid,md5('category'||(1+(n-1)%15))::uuid,'Synthetic dish '||n FROM generate_series(1,118) n;
INSERT INTO item_variants(id,menu_item_id,name) SELECT md5('variant'||n)::uuid,md5('item'||(1+(n-1)%118))::uuid,'Portion '||n FROM generate_series(1,156) n;
INSERT INTO variant_channel_settings(variant_id,channel_code,price,available) SELECT id,code,100,true FROM item_variants CROSS JOIN sales_channels;
INSERT INTO menu_audit(actor_id,item_id,action,after_value) SELECT '${owner}',md5('item'||(1+(n-1)%118))::uuid,CASE WHEN n<=133 THEN 'CREATED' ELSE 'UPDATED' END,'{"fixture":true}' FROM generate_series(1,251)n;
-- Additional legitimate-format audit records only in the synthetic cluster.
DO $fixture$ DECLARE n integer; item_id uuid; before_snapshot jsonb; after_snapshot jsonb;
 snapshot_query text := $snapshot$${menuSnapshotSql}$snapshot$;
BEGIN
 FOR n IN 1..42 LOOP
  item_id:=md5('item'||n)::uuid;
  EXECUTE snapshot_query INTO before_snapshot USING item_id;
  UPDATE menu_items SET description='Synthetic audited edit '||n WHERE id=item_id;
  EXECUTE snapshot_query INTO after_snapshot USING item_id;
  INSERT INTO menu_audit(actor_id,item_id,action,before_value,after_value,created_at)
  VALUES('${owner}',item_id,'UPDATED',before_snapshot,after_snapshot,
    CASE WHEN n<=11 THEN '2026-10-14T10:00:00Z'::timestamptz ELSE '2026-10-15T10:00:00Z'::timestamptz END);
 END LOOP;
END $fixture$;
INSERT INTO order_daily_tokens VALUES('2026-10-17',7); INSERT INTO bill_daily_numbers VALUES('2026-10-17',5);
INSERT INTO bills(id,business_date,bill_number,service_type,opened_by,opened_at) SELECT md5('bill'||n)::uuid,'2026-10-17',n,'DINE_IN','${owner}','2026-10-17T10:00:00Z' FROM generate_series(1,5)n;
INSERT INTO daily_reports(id,business_date,version,source,snapshot) SELECT gen_random_uuid(),d::date,1,'AUTOMATIC',jsonb_build_object('schemaVersion',1,'businessDate',d::date,'timezone','Asia/Kolkata','foodSold','0.00','cashReturned','0.00','recordedExpenses','0.00','expenseCategories','[]'::jsonb,'expenseEntries','[]'::jsonb,'bestSeller',null) FROM generate_series('2026-10-10'::timestamp,'2026-10-16'::timestamp,interval '1 day')d;
COMMIT;\n`;
    for (let n = 1; n <= 7; n++) {
      const counter = n <= 5;
      const amount = [280, 300, 300, 220, 100][n - 1];
      const time = `2026-10-17T10:00:0${n}Z`;
      fixture += `BEGIN;
INSERT INTO orders(id,source,status,business_date,token_number,confirmed_by,request_id,request_hash,queued_at,subtotal,discount_total,tax_total,rounding_adjustment,grand_total,tax_rate,tax_label,timezone,tax_mode,tax_rounding,bill_id,external_reference,preparation_mode)
VALUES('${ids[n - 1]}','${counter ? 'COUNTER' : 'ZOMATO'}','QUEUED','2026-10-17',${n},'${owner}',gen_random_uuid(),repeat('a',64),'${time}',${counter ? `${amount},0,0,0,${amount},0,'No tax'` : 'NULL,NULL,NULL,NULL,NULL,NULL,NULL'},'Asia/Kolkata',${counter ? "'EXCLUSIVE','HALF_UP_PAISE',md5('bill" + n + "')::uuid,NULL,NULL" : "NULL,NULL,NULL,'SYNTHETIC-" + n + "','NORMAL'"});
INSERT INTO order_items(id,order_id,position,menu_item_id,variant_id,item_name_snapshot,kitchen_name_snapshot,variant_name_snapshot,quantity,unit_price_snapshot,line_subtotal)
SELECT gen_random_uuid(),'${ids[n - 1]}',p,md5('item1')::uuid,md5('variant1')::uuid,'Synthetic dish','Synthetic dish','Portion 1',1,${counter ? amount / (n <= 2 ? 2 : 1) : 'NULL'},${counter ? amount / (n <= 2 ? 2 : 1) : 'NULL'} FROM generate_series(1,${n <= 2 ? 2 : 1})p;
INSERT INTO order_status_history VALUES(gen_random_uuid(),'${ids[n - 1]}','DRAFT','QUEUED','${owner}','${time}','Confirmed'); COMMIT;\n`;
    }
    for (let n = 1; n <= 4; n++)
      fixture += `INSERT INTO payments(id,bill_id,type,method,amount,performed_by,request_id,request_hash,confirmation_order_id,created_at) VALUES(gen_random_uuid(),md5('bill${n}')::uuid,'COLLECTION','${n === 1 ? 'CASH' : 'UPI'}',${[280, 300, 300, 220][n - 1]},'${owner}',gen_random_uuid(),repeat('b',64),'${ids[n - 1]}','2026-10-17T10:05:00Z');\n`;
    for (let n = 1; n <= 2; n++)
      for (const [i, [from, to]] of [
        ['QUEUED', 'PREPARING'],
        ['PREPARING', 'READY'],
        ['READY', 'COMPLETED'],
      ].entries())
        fixture += `INSERT INTO order_status_history VALUES(gen_random_uuid(),'${ids[n - 1]}','${from}','${to}','${owner}','2026-10-17T10:${10 + n}:${10 + i}Z','Synthetic transition');\n`;
    fixture += `INSERT INTO kitchen_timers(id,order_id,label,duration_seconds,started_at,due_at,status,created_by,request_id,request_hash,resolved_by,resolved_at) VALUES('273e996f-81c6-45bd-8bd8-95f836bc3722','${ids[1]}','Synthetic timer',60,'2026-10-17T10:01:00Z','2026-10-17T10:02:00Z','ACKNOWLEDGED','${owner}',gen_random_uuid(),repeat('c',64),'${owner}','2026-10-17T10:03:00Z');`;
    async function reset() {
      await query(
        'DROP SCHEMA IF EXISTS dukanos CASCADE;' + migrationSQL + fixture,
      );
    }
    const apply = {
      apply: 'true',
      confirm: 'DELETE_20261017_7_ORDERS_5_BILLS_4_PAYMENTS',
    };
    async function expectAbort(pattern, flags = {}, altered = sql) {
      const before = await query(snapshotSql);
      const r = await cleanup(flags, altered);
      assert.equal(r.ok, false, r.output);
      assert.match(r.output, pattern);
      assert.equal(await query(snapshotSql), before);
      console.log('EXPECTED SAFE ABORT: ' + r.output.match(/ERROR: .*/)?.[0]);
    }
    try {
      await run('initdb', [
        '-D',
        data,
        '-U',
        'postgres',
        '-A',
        'trust',
        '--no-locale',
        '--encoding=UTF8',
      ]);
      await run('pg_ctl', [
        '-D',
        data,
        '-l',
        join(dir, 'server.log'),
        '-o',
        `-k ${dir} -h '' -p 55439 -c unix_socket_permissions=0700`,
        '-w',
        'start',
      ]);
      started = true;
      await run('createdb', ['dukanos_prod']);
      await reset();
      if (process.argv.includes('--print-schema-fingerprint')) {
        console.log(
          await query('SET search_path=dukanos,pg_catalog;' + schemaQuery),
        );
        return;
      }
      await t.test(
        '293 audits include 42 attributed complete before/after aggregates',
        async () => {
          assert.equal(
            await query('SELECT count(*) FROM dukanos.menu_audit'),
            '293',
          );
          assert.equal(
            await query(
              `SELECT count(*) FROM dukanos.menu_audit WHERE before_value IS NOT NULL AND actor_id='${owner}' AND action='UPDATED' AND before_value->>'id'=item_id::text AND after_value->>'id'=item_id::text AND jsonb_typeof(after_value->'variants')='array' AND after_value ?& ARRAY['categoryId','name','description','kitchenName','active','version','image','createdAt','updatedAt','variants','counterVisibility'] AND (after_value->>'version')::int=(before_value->>'version')::int+1 AND after_value->>'description' LIKE 'Synthetic audited edit %'`,
            ),
            '42',
          );
          assert.equal(
            await query(
              "SELECT count(*) FILTER(WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date='2026-10-14')||','||count(*) FILTER(WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date='2026-10-15') FROM dukanos.menu_audit WHERE before_value IS NOT NULL",
            ),
            '11,31',
          );
        },
      );
      for (const count of [292, 294])
        await t.test('audit count ' + count + ' safely aborts', async () => {
          if (count === 292)
            await query(
              'SET search_path=dukanos,pg_catalog; ALTER TABLE menu_audit DISABLE TRIGGER protect_menu_audit; DELETE FROM menu_audit WHERE id=(SELECT id FROM menu_audit WHERE before_value IS NOT NULL LIMIT 1); ALTER TABLE menu_audit ENABLE TRIGGER protect_menu_audit;',
            );
          else
            await query(
              'INSERT INTO dukanos.menu_audit(actor_id,item_id,action,before_value,after_value) SELECT actor_id,item_id,action,before_value,after_value FROM dukanos.menu_audit WHERE before_value IS NOT NULL LIMIT 1',
            );
          await expectAbort(/CLEANUP_MENU_BASELINE_CHANGED/);
          await reset();
        });
      await t.test(
        'same audit count but changed content after review aborts',
        async () => {
          const r = await cleanup();
          assert.equal(r.ok, true, r.output);
          const fingerprint = r.output.match(
            /CLEANUP_REVIEW_FINGERPRINT=([a-f0-9]{64})/,
          )[1];
          // Simulate illicit historical mutation only in this disposable fixture;
          // restore its immutable trigger before invoking the unchanged cleanup.
          await query(
            `SET search_path=dukanos,pg_catalog; ALTER TABLE menu_audit DISABLE TRIGGER protect_menu_audit; UPDATE menu_audit SET after_value=jsonb_set(after_value,'{description}','"Changed after review"') WHERE id=(SELECT id FROM menu_audit WHERE before_value IS NOT NULL LIMIT 1); ALTER TABLE menu_audit ENABLE TRIGGER protect_menu_audit;`,
          );
          assert.equal(
            await query('SELECT count(*) FROM dukanos.menu_audit'),
            '293',
          );
          await expectAbort(/CLEANUP_REVIEW_FINGERPRINT_CHANGED/, {
            ...apply,
            expected_fingerprint: fingerprint,
          });
          await reset();
        },
      );
      await t.test(
        'new October 17 daily report after midnight stops cleanup and is preserved',
        async () => {
          await query(
            `INSERT INTO dukanos.daily_reports(id,business_date,version,source,snapshot) SELECT gen_random_uuid(),'2026-10-17',1,'AUTOMATIC',jsonb_set(snapshot,'{businessDate}','"2026-10-17"') FROM dukanos.daily_reports LIMIT 1;`,
          );
          await expectAbort(/CLEANUP_UNRELATED_OR_NUMBERING_BASELINE_CHANGED/);
          await reset();
        },
      );
      for (const [table, column] of [
        ['order_daily_tokens', 'last_token'],
        ['bill_daily_numbers', 'last_number'],
      ])
        await t.test('new October 18 ' + table + ' stops cleanup', async () => {
          await query(
            `INSERT INTO dukanos.${table}(business_date,${column}) VALUES('2026-10-18',1)`,
          );
          await expectAbort(/CLEANUP_UNRELATED_OR_NUMBERING_BASELINE_CHANGED/);
          await reset();
        });
      await t.test(
        'default dry run deletes exact inventory then rolls back every row/trigger',
        async () => {
          const before = await query(snapshotSql);
          const r = await cleanup();
          assert.equal(r.ok, true, r.output);
          assert.match(r.output, /CLEANUP_DRY_RUN_ROLLED_BACK/);
          assert.match(r.output, /"orders": 7/);
          assert.match(r.output, /"payments": 4/);
          assert.equal(await query(snapshotSql), before);
          console.log(r.output);
        },
      );
      await t.test(
        'explicit apply requires confirmation and reviewed fingerprint',
        async () => {
          await expectAbort(/CLEANUP_EXPLICIT_CONFIRMATION_REQUIRED/, {
            apply: 'true',
          });
        },
      );
      await t.test('changed reviewed fingerprint aborts', async () => {
        await expectAbort(/CLEANUP_REVIEW_FINGERPRINT_CHANGED/, {
          ...apply,
          expected_fingerprint: '0'.repeat(64),
        });
      });
      await t.test('mismatched target UUID aborts', async () => {
        await expectAbort(
          /CLEANUP_ORDER_BASELINE_CHANGED/,
          {},
          sql.replaceAll(ids[0], 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
        );
      });
      await t.test('unexpected extra bill aborts', async () => {
        await query(
          `SET search_path=dukanos,pg_catalog; INSERT INTO bills(id,business_date,bill_number,service_type,opened_by,opened_at) VALUES(gen_random_uuid(),'2026-10-17',6,'DINE_IN','${owner}',now());`,
        );
        await expectAbort(/CLEANUP_BILL_OR_ORDER_CHILD_BASELINE_CHANGED/);
        await reset();
      });
      await t.test('another database client blocks maintenance', async () => {
        const { Client } = require('pg');
        const other = new Client({
          host: dir,
          port: 55439,
          user: 'postgres',
          database: 'dukanos_prod',
        });
        await other.connect();
        try {
          await expectAbort(/CLEANUP_OTHER_DATABASE_CLIENTS/);
        } finally {
          await other.end();
        }
      });
      await t.test('an eighth order is never swept up', async () => {
        const extra = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        await query(`SET search_path=dukanos,pg_catalog; BEGIN;
INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,to_jsonb(o)||jsonb_build_object('id','${extra}','token_number',8,'request_id',gen_random_uuid(),'external_reference','EXTRA-8'))).* FROM orders o WHERE id='${ids[6]}';
INSERT INTO order_items SELECT (jsonb_populate_record(NULL::order_items,to_jsonb(i)||jsonb_build_object('id',gen_random_uuid(),'order_id','${extra}'))).* FROM order_items i WHERE order_id='${ids[6]}';
INSERT INTO order_status_history SELECT gen_random_uuid(),id,'DRAFT','QUEUED',confirmed_by,queued_at,'Extra test' FROM orders WHERE id='${extra}'; COMMIT;`);
        await expectAbort(/CLEANUP_ORDER_BASELINE_CHANGED/);
        await reset();
      });
      await t.test('an additional collection aborts', async () => {
        await query(
          `SET search_path=dukanos,pg_catalog; INSERT INTO payments(id,bill_id,type,method,amount,performed_by,request_id,request_hash) VALUES(gen_random_uuid(),md5('bill5')::uuid,'COLLECTION','CASH',1,'${owner}',gen_random_uuid(),repeat('d',64));`,
        );
        await expectAbort(/CLEANUP_PAYMENT_BASELINE_CHANGED/);
        await reset();
      });
      await t.test(
        'menu edit after reviewed dry-run invalidates apply fingerprint',
        async () => {
          const r = await cleanup();
          assert.equal(r.ok, true, r.output);
          const fingerprint = r.output.match(
            /CLEANUP_REVIEW_FINGERPRINT=([a-f0-9]{64})/,
          )[1];
          await query(
            "SET search_path=dukanos,pg_catalog; UPDATE variant_channel_settings SET price=101 WHERE channel_code='COUNTER'",
          );
          await expectAbort(/CLEANUP_REVIEW_FINGERPRINT_CHANGED/, {
            ...apply,
            expected_fingerprint: fingerprint,
          });
          await reset();
        },
      );
      await t.test('ledger checksum mismatch aborts', async () => {
        await query(
          "UPDATE dukanos.schema_migrations SET checksum='bad' WHERE name LIKE '021_%'",
        );
        await expectAbort(/CLEANUP_MIGRATION_LEDGER_CHANGED/);
        await reset();
      });
      await t.test('foreign-key constraint removal aborts', async () => {
        await query(
          'ALTER TABLE dukanos.payments DROP CONSTRAINT payments_bill_id_fkey',
        );
        await expectAbort(/CLEANUP_SCHEMA_CHANGED/);
        await reset();
      });
      await t.test(
        'cross-schema reference aborts even when empty',
        async () => {
          await query(
            'CREATE TABLE public.unexpected_reference(order_id uuid REFERENCES dukanos.orders(id))',
          );
          await expectAbort(
            /CLEANUP_UNEXPECTED_TRIGGER_OR_EXTERNAL_DEPENDENCY/,
          );
          await query('DROP TABLE public.unexpected_reference');
          await reset();
        },
      );
      await t.test(
        'cross-date payment aborts to protect historical report semantics',
        async () => {
          await query(
            "SET search_path=dukanos,pg_catalog; ALTER TABLE payments DISABLE TRIGGER protect_payments; UPDATE payments SET created_at='2026-10-16T10:00:00Z' WHERE method='CASH'; ALTER TABLE payments ENABLE TRIGGER protect_payments;",
          );
          await expectAbort(/CLEANUP_EVENT_DATE_CHANGED/);
          await reset();
        },
      );
      await t.test(
        'missing trigger restoration aborts and rolls everything back',
        async () => {
          await expectAbort(
            /CLEANUP_SCHEMA_OR_TRIGGER_RESTORE_FAILED/,
            {},
            sql.replace(
              'ALTER TABLE payments ENABLE TRIGGER protect_payments;',
              '-- injected omitted restoration',
            ),
          );
        },
      );
      await t.test('unknown schema column aborts', async () => {
        await query('ALTER TABLE dukanos.orders ADD COLUMN unexpected text');
        await expectAbort(/CLEANUP_SCHEMA_CHANGED/);
        await reset();
      });
      await t.test(
        'disabled protection trigger aborts without changing its preexisting state',
        async () => {
          await query(
            'ALTER TABLE dukanos.order_amendments DISABLE TRIGGER protect_amendments',
          );
          await expectAbort(/CLEANUP_SCHEMA_CHANGED/);
          await reset();
        },
      );
      await t.test(
        'FKs still reject parent deletion while six application guards are disabled',
        async () => {
          await expectAbort(
            /violates foreign key constraint/,
            {},
            sql.replace(
              'DELETE FROM kitchen_timers WHERE',
              `DELETE FROM orders WHERE id='${ids[1]}';\n DELETE FROM kitchen_timers WHERE`,
            ),
          );
        },
      );
      for (const table of [
        'kitchen_timers',
        'payments',
        'order_status_history',
        'order_items',
        'orders',
        'bills',
      ])
        await t.test(
          'injected failure after deleting ' +
            table +
            ' restores all rows and trigger states',
          async () => {
            const regex = new RegExp(`(DELETE FROM ${table} WHERE[^;]+;)`);
            await expectAbort(
              /INJECTED_FAILURE/,
              {},
              sql.replace(regex, "$1\n RAISE EXCEPTION 'INJECTED_FAILURE';"),
            );
          },
        );
      await t.test(
        'preservation check catches unrelated update and rolls it back',
        async () => {
          await expectAbort(
            /CLEANUP_PRESERVED_DATA_CHANGED/,
            {},
            sql.replace(
              'ALTER TABLE kitchen_timers ENABLE',
              "UPDATE app_metadata SET value='unexpected';\n ALTER TABLE kitchen_timers ENABLE",
            ),
          );
        },
      );
      await t.test('report referring to target in JSON aborts', async () => {
        await query(
          `SET search_path=dukanos,pg_catalog; ALTER TABLE daily_reports DISABLE TRIGGER daily_reports_immutable; UPDATE daily_reports SET snapshot=snapshot||jsonb_build_object('unexpectedOrderId','${ids[0]}') WHERE business_date='2026-10-10'; ALTER TABLE daily_reports ENABLE TRIGGER daily_reports_immutable;`,
        );
        await expectAbort(/CLEANUP_REPORT_OR_NUMBER_IDENTITY_CHANGED/);
        await reset();
      });
      await t.test(
        'commit deletes only six tables; counters, menu, staff and reports unchanged; repeat safely refuses',
        async () => {
          const rehearsal = await cleanup();
          assert.equal(rehearsal.ok, true, rehearsal.output);
          const fingerprint = rehearsal.output.match(
            /CLEANUP_REVIEW_FINGERPRINT=([a-f0-9]{64})/,
          )[1];
          const preservedQuery = snapshotSql.replace(
            "WHERE schemaname='dukanos' ORDER BY",
            "WHERE schemaname='dukanos' AND tablename NOT IN ('orders','bills','payments','order_items','order_status_history','kitchen_timers') ORDER BY",
          );
          const preservedBefore = await query(preservedQuery);
          const r = await cleanup({
            ...apply,
            expected_fingerprint: fingerprint,
          });
          assert.equal(await query(preservedQuery), preservedBefore);
          assert.equal(r.ok, true, r.output);
          assert.match(r.output, /CLEANUP_COMMITTED/);
          console.log(r.output);
          assert.equal(
            await query(
              `SELECT (SELECT count(*) FROM dukanos.orders)||','||(SELECT last_token FROM dukanos.order_daily_tokens)||','||(SELECT last_number FROM dukanos.bill_daily_numbers)||','||(SELECT count(*) FROM dukanos.daily_reports)||','||(SELECT count(*) FROM dukanos.menu_audit);`,
            ),
            '0,7,5,7,293',
          );
          const state = await query(snapshotSql);
          const verification = await readFile(
            'scripts/verify-test-order-cleanup-2026-10-17.sql',
            'utf8',
          );
          const output = await query(verification);
          assert.match(output, /PRESERVATION_HASH/);
          assert.equal(await query(snapshotSql), state);
          await expectAbort(/CLEANUP_ORDER_BASELINE_CHANGED/, {
            ...apply,
            expected_fingerprint: fingerprint,
          });
        },
      );
    } finally {
      if (started)
        await run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
