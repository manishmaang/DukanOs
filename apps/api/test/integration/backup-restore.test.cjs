require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { Client } = require('pg');
const { Test } = require('@nestjs/testing');
const request = require('supertest');
const sharp = require('sharp');
const { AppModule } = require('../../dist/app.module');
const { configureApp } = require('../../dist/configure-app');
const { UsersService } = require('../../dist/modules/users/users.service');
const {
  DailyWorkerService,
} = require('../../dist/modules/daily-reports/daily-worker.service');

test(
  'encrypted full backup restores financial records, RBAC, reports, media and release in isolation',
  { timeout: 240000 },
  async () => {
    const { makeBackup, restoreFixture, command, digest, validateBundle } =
      await import('../../../../scripts/backup.mjs');
    const saved = { ...process.env },
      suffix = randomUUID().replaceAll('-', '');
    const original = 'dukanos_fixture_' + suffix,
      restored = 'dukanos_restore_' + suffix;
    const maint = 'backup_owner_' + suffix,
      runtime = 'backup_runtime_' + suffix,
      rolePassword = randomUUID();
    const admin = new Client({ connectionString: saved.DATABASE_URL });
    await admin.connect();
    const root = await fs.mkdtemp('/tmp/dukanos-backup-test-');
    let app;
    const url = new URL(saved.DATABASE_URL);
    url.pathname = '/' + original;
    url.searchParams.delete('options');
    const restore = new URL(url);
    restore.pathname = '/' + restored;
    try {
      await admin.query(`CREATE DATABASE ${original}`);
      await admin.query(`CREATE DATABASE ${restored}`);
      process.env.DATABASE_URL = url.toString();
      process.env.NODE_ENV = 'development';
      process.env.DUKANOS_DATA_DIR = root + '/data';
      process.env.SMTP_HOST = '';
      process.env.ORDER_TAX_RATE = '0';
      process.env.DUKANOS_DB_SCHEMA = 'dukanos';
      process.env.DUKANOS_MIGRATION_ROLE = maint;
      process.env.DUKANOS_RUNTIME_ROLE = runtime;
      command(process.execPath, ['scripts/provision-database.mjs', 'setup']);
      command(process.execPath, ['scripts/provision-database.mjs', 'setup']);
      await admin.query(`ALTER ROLE ${maint} PASSWORD '${rolePassword}'`);
      await admin.query(`ALTER ROLE ${runtime} PASSWORD '${rolePassword}'`);
      url.username = maint;
      url.password = rolePassword;
      process.env.DATABASE_URL = url.toString();
      command(process.execPath, ['scripts/migrate.mjs']);
      command(process.execPath, ['scripts/provision-database.mjs', 'grant']);
      command(process.execPath, ['scripts/provision-database.mjs', 'grant']);
      const runtimeUrl = new URL(url);
      runtimeUrl.username = runtime;
      process.env.DATABASE_URL = runtimeUrl.toString();
      const module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = module.createNestApplication();
      configureApp(app);
      await app.init();
      const password = randomUUID() + '!';
      await app.get(UsersService).create({
        username: 'owner',
        name: 'Restore Owner',
        password,
        roles: ['OWNER'],
      });
      const cookie = (
        await request(app.getHttpServer())
          .post('/api/auth/login')
          .set('X-DukanOS-Request', '1')
          .send({ username: 'owner', password })
          .expect(200)
      ).headers['set-cookie'][0].split(';')[0];
      const call = (m, p, b) => {
        const a = request(app.getHttpServer());
        const r = a[m]('/api' + p)
          .set('Cookie', cookie)
          .set('X-DukanOS-Request', '1');
        return b ? r.send(b) : r;
      };
      const photo = await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#229944' },
      })
        .png()
        .toBuffer();
      const image = (
        await call('post', '/menu/images')
          .attach('image', photo, {
            filename: 'meal.png',
            contentType: 'image/png',
          })
          .expect(201)
      ).body;
      const cat = (
        await call('post', '/menu/categories', { name: 'Restore Menu' }).expect(
          201,
        )
      ).body;
      const item = (
        await call('post', '/menu/items', {
          categoryId: cat.id,
          name: 'Meal',
          imageKey: image.key,
          variants: [
            {
              name: 'Full',
              channels: [
                { channelCode: 'COUNTER', price: '100', available: true },
              ],
            },
          ],
        }).expect(201)
      ).body;
      const order = (
        await call('post', '/orders/counter', {
          requestId: randomUUID(),
          serviceType: 'DINE_IN',
          lines: [{ variantId: item.variants[0].id, quantity: 1 }],
        }).expect(201)
      ).body;
      await call('post', `/bills/${order.billId}/payments`, {
        requestId: randomUUID(),
        method: 'CASH',
        amount: '40',
      }).expect(201);
      const receipt = (
        await call('post', '/expenses/receipts')
          .attach('image', photo, {
            filename: 'receipt.png',
            contentType: 'image/png',
          })
          .expect(201)
      ).body;
      const categories = (await call('get', '/expense-categories').expect(200))
        .body;
      await call('post', '/expenses', {
        requestId: randomUUID(),
        categoryId: categories.categories[0].id,
        amount: '12.50',
        paymentMethod: 'CASH',
        receiptKey: receipt.key,
        note: 'Synthetic recovery fixture',
      }).expect(201);
      await app.get(DailyWorkerService).run();
      await app.close();
      app = undefined;
      process.env.GNUPGHOME = root + '/keyring';
      await fs.mkdir(process.env.GNUPGHOME, { mode: 0o700 });
      command('gpg', [
        '--batch',
        '--pinentry-mode',
        'loopback',
        '--passphrase',
        '',
        '--quick-generate-key',
        'Disposable DukanOS recovery test',
        'default',
        'default',
        '1d',
      ]);
      const fingerprint = command('gpg', [
        '--batch',
        '--with-colons',
        '--list-keys',
      ])
        .split('\n')
        .find((l) => l.startsWith('fpr:'))
        .split(':')[9];
      await fs.mkdir(root + '/config', { mode: 0o700 });
      await fs.writeFile(
        root + '/config/runtime.env',
        'SMTP_HOST=\nSYNTHETIC_RECOVERY_MATERIAL=fixture-only\n',
        { mode: 0o600 },
      );
      const bundle = await makeBackup({
        url: url.toString(),
        schema: 'dukanos',
        data: root + '/data',
        config: root + '/config',
        release: process.cwd(),
        destination: root + '/backups',
        recipient: fingerprint,
        fixture: true,
      });
      assert.ok((await fs.stat(bundle)).size > 0);
      const manifest = await restoreFixture({
        bundle,
        url: restore.toString(),
        output: root + '/restored',
      });
      assert.equal(manifest.inventory.counts.orders, '1');
      assert.equal(manifest.inventory.counts.payments, '1');
      assert.equal(manifest.inventory.counts.expenses, '1');
      assert.equal(manifest.inventory.counts.daily_reports, '1');
      assert.equal(manifest.inventory.financial.collections, '40.00');
      assert.deepEqual(manifest.inventory.roles, [
        { username: 'owner', roles: ['OWNER'] },
      ]);
      assert.equal(Object.keys(manifest.media).length, 2);
      for (const path of Object.keys(manifest.media))
        assert.equal(
          await digest(root + '/data/' + path),
          await digest(root + '/restored/media/' + path),
        );
      assert.equal(
        await fs.readFile(
          root + '/restored/protected-config/runtime.env',
          'utf8',
        ),
        'SMTP_HOST=\nSYNTHETIC_RECOVERY_MATERIAL=fixture-only\n',
      );
      await fs.access(root + '/restored/release/apps/api/dist/main.js');
      await fs.access(root + '/restored/release/apps/web/dist/index.html');
      await fs.appendFile(root + '/restored/grants.json', 'corrupt');
      await assert.rejects(validateBundle(root + '/restored'), /CHECKSUM/);
      await assert.rejects(
        restoreFixture({
          bundle,
          url: url.toString(),
          output: root + '/unsafe',
        }),
        /ISOLATED/,
      );
      await assert.rejects(
        restoreFixture({
          bundle,
          url: restore.toString(),
          output: root + '/duplicate',
        }),
        /NOT_EMPTY/,
      );
    } finally {
      if (app) await app.close();
      await admin.query(`DROP DATABASE IF EXISTS ${original}`);
      await admin.query(`DROP DATABASE IF EXISTS ${restored}`);
      await admin.query(`DROP ROLE IF EXISTS ${maint}`);
      await admin.query(`DROP ROLE IF EXISTS ${runtime}`);
      await admin.end();
      if (process.env.GNUPGHOME?.startsWith(root)) {
        try {
          command('gpgconf', ['--kill', 'gpg-agent']);
        } catch {
          /* disposable agent may already exit */
        }
      }
      await fs.rm(root, { recursive: true, force: true });
      for (const key of Object.keys(process.env))
        if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  },
);
