require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { Client } = require('pg');
const { Test } = require('@nestjs/testing');
const request = require('supertest');
const { AppModule } = require('../../dist/app.module');
const { configureApp } = require('../../dist/configure-app');
const { UsersService } = require('../../dist/modules/users/users.service');
const {
  PasswordManagementService,
} = require('../../dist/modules/users/password-management.service');
const { tokenHash } = require('../../dist/modules/auth/auth.service');
const { verifyPassword } = require('../../dist/modules/auth/password');
const root = resolve(__dirname, '../../../..');
const initial = 'test original password 123!';
const replacement = 'test replacement password 456!';
const header = ['X-DukanOS-Request', '1'];

test(
  'password changes, delegated resets and local owner recovery',
  { timeout: 120000 },
  async (t) => {
    assert.ok(process.env.DATABASE_URL, 'Use npm run test:integration');
    const originalUrl = process.env.DATABASE_URL;
    const admin = new Client({ connectionString: originalUrl });
    await admin.connect();
    const schema = 'password_test_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(originalUrl);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    const sql = new Client({ connectionString: url.toString() });
    let app;
    try {
      for (let i = 0; i < 2; i++) {
        const run = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
          cwd: root,
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
      const users = app.get(UsersService);
      const passwords = app.get(PasswordManagementService);
      const server = app.getHttpServer();
      const owner = await users.create({
        username: 'owner',
        name: 'Owner',
        password: initial,
        roles: ['OWNER'],
      });
      const create = (username, roles) =>
        users.create(
          { username, name: username, password: initial, roles },
          owner,
        );
      const manager = await create('manager', ['MANAGER']);
      const peer = await create('manager_peer', ['MANAGER']);
      const worker = await create('worker', ['CASHIER', 'KITCHEN', 'DISPATCH']);
      const own = await create('self_staff', ['CASHIER']);
      const login = async (username, password = initial) => {
        const r = await request(server)
          .post('/api/auth/login')
          .set(...header)
          .send({ username, password })
          .expect(200);
        assert.equal(r.body.password_hash, undefined);
        assert.equal(r.body.password, undefined);
        assert.equal(JSON.stringify(r.body).includes(password), false);
        return r.headers['set-cookie'][0].split(';')[0];
      };
      const ownerCookie = await login('owner');
      const managerCookie = await login('manager');
      const workerCookie = await login('worker');
      const reset = (
        cookie,
        target,
        newPassword = replacement,
        version = target.version,
        reason = 'Staff requested password assistance',
      ) =>
        request(server)
          .post(`/api/users/${target.id}/password-reset`)
          .set(...header)
          .set('Cookie', cookie)
          .send({ newPassword, version, reason });
      const change = (cookie, currentPassword, newPassword = replacement) =>
        request(server)
          .post('/api/auth/change-password')
          .set(...header)
          .set('Cookie', cookie)
          .send({ currentPassword, newPassword });
      const sessionCount = async (id) =>
        Number(
          (
            await sql.query(
              'SELECT count(*) FROM auth_sessions WHERE user_id=$1',
              [id],
            )
          ).rows[0].count,
        );

      await t.test(
        'authenticated password change validates current password, strength and CSRF without changing state on failure',
        async () => {
          const cookie = await login('self_staff');
          await request(server)
            .post('/api/auth/change-password')
            .set(...header)
            .send({ currentPassword: initial, newPassword: replacement })
            .expect(401);
          await request(server)
            .post('/api/auth/change-password')
            .set('Cookie', cookie)
            .send({ currentPassword: initial, newPassword: replacement })
            .expect(403);
          const wrong = await change(cookie, 'incorrect').expect(400);
          assert.equal(wrong.body.code, 'CURRENT_PASSWORD_INCORRECT');
          await change(cookie, initial, 'short').expect(400);
          await change(cookie, initial, 'x'.repeat(129)).expect(400);
          assert.equal(await sessionCount(own.id), 1);
          assert.equal((await users.context(own.id)).version, own.version);
          assert.equal(
            Number(
              (
                await sql.query(
                  "SELECT count(*) FROM user_audit WHERE target_id=$1 AND action='PASSWORD_CHANGED'",
                  [own.id],
                )
              ).rows[0].count,
            ),
            0,
          );
        },
      );
      await t.test(
        'successful self change invalidates the old password and every existing session, with an empty API response',
        async () => {
          const a = await login('self_staff');
          const b = await login('self_staff');
          const r = await change(a, initial).expect(204);
          assert.equal(r.text, '');
          assert.match(r.headers['set-cookie'][0], /Expires=Thu, 01 Jan 1970/);
          assert.equal(await sessionCount(own.id), 0);
          for (const cookie of [a, b])
            await request(server)
              .get('/api/auth/me')
              .set('Cookie', cookie)
              .expect(401);
          await request(server)
            .post('/api/auth/login')
            .set(...header)
            .send({ username: 'self_staff', password: initial })
            .expect(401);
          await login('self_staff', replacement);
          const audit = (
            await sql.query(
              "SELECT * FROM user_audit WHERE target_id=$1 AND action='PASSWORD_CHANGED'",
              [own.id],
            )
          ).rows[0];
          assert.equal(audit.actor_id, own.id);
          assert.ok(audit.created_at);
          assert.deepEqual(audit.new_value, {
            passwordChanged: true,
            sessionsRevoked: true,
          });
        },
      );
      await t.test(
        'OWNER can reset operational staff and MANAGER, revoking target sessions and preserving roles/status',
        async () => {
          const peerCookie = await login('manager_peer');
          for (const target of [worker, peer]) {
            const r = await reset(ownerCookie, target).expect(204);
            assert.equal(r.text, '');
            assert.equal(await sessionCount(target.id), 0);
            const current = await users.context(target.id);
            assert.deepEqual(current.roles, target.roles);
            assert.equal(current.active, true);
            await login(target.username, replacement);
            await request(server)
              .post('/api/auth/login')
              .set(...header)
              .send({ username: target.username, password: initial })
              .expect(401);
          }
          for (const cookie of [workerCookie, peerCookie])
            await request(server)
              .get('/api/auth/me')
              .set('Cookie', cookie)
              .expect(401);
          await request(server)
            .get('/api/auth/me')
            .set('Cookie', ownerCookie)
            .expect(200);
        },
      );
      await t.test(
        'MANAGER can reset operational combinations but not OWNER, peer MANAGER, or self',
        async () => {
          const target = await create('manager_target', [
            'KITCHEN',
            'DISPATCH',
          ]);
          const targetCookie = await login(target.username);
          await reset(managerCookie, target).expect(204);
          assert.equal(await sessionCount(target.id), 0);
          await request(server)
            .get('/api/auth/me')
            .set('Cookie', targetCookie)
            .expect(401);
          await login(target.username, replacement);
          for (const target of [owner, peer, manager]) {
            const r = await reset(managerCookie, target).expect(403);
            assert.equal(r.body.code, 'PASSWORD_RESET_FORBIDDEN');
          }
          await reset(ownerCookie, owner).expect(403);
          const anotherOwner = await create('another_owner', ['OWNER']);
          await reset(ownerCookie, anotherOwner).expect(403);
        },
      );
      await t.test(
        'operational staff cannot reset others even when a reset capability is accidentally granted',
        async () => {
          const cookie = await login('worker', replacement);
          await reset(cookie, peer).expect(403);
          await request(server)
            .get('/api/users/password-reset-targets')
            .set('Cookie', cookie)
            .expect(403);
          await sql.query(
            "INSERT INTO role_permissions VALUES ('CASHIER','users.password.reset')",
          );
          try {
            const r = await reset(cookie, peer).expect(403);
            assert.equal(r.body.code, 'PASSWORD_RESET_FORBIDDEN');
          } finally {
            await sql.query(
              "DELETE FROM role_permissions WHERE role_code='CASHIER' AND permission_code='users.password.reset'",
            );
          }
        },
      );
      await t.test(
        'reset lists respect target roles and do not broaden manager staff-management access',
        async () => {
          const r = await request(server)
            .get('/api/users/password-reset-targets')
            .set('Cookie', managerCookie)
            .expect(200);
          assert.ok(r.body.length);
          assert.ok(
            r.body.every(
              (u) =>
                !u.roles.some((role) => ['OWNER', 'MANAGER'].includes(role)),
            ),
          );
          for (const row of r.body)
            assert.deepEqual(Object.keys(row).sort(), [
              'active',
              'id',
              'name',
              'roles',
              'username',
              'version',
            ]);
          const ownerList = await request(server)
            .get('/api/users/password-reset-targets')
            .set('Cookie', ownerCookie)
            .expect(200);
          assert.ok(ownerList.body.some((u) => u.id === manager.id));
          assert.ok(ownerList.body.every((u) => !u.roles.includes('OWNER')));
          await request(server)
            .get('/api/users')
            .set('Cookie', managerCookie)
            .expect(403);
          await request(server)
            .post('/api/users')
            .set(...header)
            .set('Cookie', managerCookie)
            .send({
              username: 'forbidden',
              name: 'No',
              password: initial,
              roles: ['CASHIER'],
            })
            .expect(403);
        },
      );
      await t.test(
        'resets validate reasons/strength, reject stale versions and serialize conflicting updates',
        async () => {
          const target = await create('concurrent', ['DISPATCH']);
          const noReason = await reset(
            ownerCookie,
            target,
            replacement,
            target.version,
            '   ',
          ).expect(400);
          assert.equal(noReason.body.code, 'REASON_REQUIRED');
          await reset(ownerCookie, target, 'short').expect(400);
          const results = await Promise.all([
            reset(ownerCookie, target),
            reset(managerCookie, target, 'another valid password 789!'),
          ]);
          assert.deepEqual(results.map((r) => r.status).sort(), [204, 409]);
          const audit = await sql.query(
            "SELECT * FROM user_audit WHERE target_id=$1 AND action='PASSWORD_RESET'",
            [target.id],
          );
          assert.equal(audit.rowCount, 1);
          assert.ok([owner.id, manager.id].includes(audit.rows[0].actor_id));
          assert.ok(audit.rows[0].reason);
          assert.ok(audit.rows[0].created_at);
        },
      );
      await t.test(
        'concurrent own changes cannot both succeed with an obsolete session/current password',
        async () => {
          const target = await create('own_concurrent', ['KITCHEN']);
          const cookie = await login(target.username);
          const results = await Promise.all([
            change(cookie, initial),
            change(cookie, initial, 'another personal password 789!'),
          ]);
          assert.equal(results.filter((r) => r.status === 204).length, 1);
          assert.equal(
            results.filter((r) => [401, 409].includes(r.status)).length,
            1,
          );
          assert.equal(await sessionCount(target.id), 0);
        },
      );
      await t.test(
        'transactional reset rechecks actor session and target role after waiting on concurrent changes',
        async () => {
          const target = await create('promoted_target', ['CASHIER']);
          await sql.query('BEGIN');
          await sql.query('SELECT pg_advisory_xact_lock(742019322)');
          const pending = passwords.resetStaff(
            manager.id,
            tokenHash(managerCookie.split('=')[1]),
            target.id,
            {
              newPassword: replacement,
              version: target.version,
              reason: 'Concurrent promotion test',
            },
          );
          await sql.query('DELETE FROM user_roles WHERE user_id=$1', [
            target.id,
          ]);
          await sql.query("INSERT INTO user_roles VALUES ($1,'OWNER')", [
            target.id,
          ]);
          await sql.query('COMMIT');
          await assert.rejects(
            pending,
            (e) => e.getResponse().code === 'PASSWORD_RESET_FORBIDDEN',
          );
          const resetter = await create('revoked_actor', ['MANAGER']);
          const cookie = await login(resetter.username);
          const victim = await create('revocation_target', ['KITCHEN']);
          await sql.query('DELETE FROM auth_sessions WHERE user_id=$1', [
            resetter.id,
          ]);
          await assert.rejects(
            passwords.resetStaff(
              resetter.id,
              tokenHash(cookie.split('=')[1]),
              victim.id,
              {
                newPassword: replacement,
                version: victim.version,
                reason: 'Session revoked',
              },
            ),
            (e) => e.getResponse().code === 'AUTHENTICATION_REQUIRED',
          );
        },
      );
      await t.test(
        'inactive staff remain inactive after password reset',
        async () => {
          let target = await create('inactive_staff', ['CASHIER']);
          target = await users.updateAccess(
            target.id,
            {
              roles: target.roles,
              active: false,
              version: target.version,
              reason: 'Inactive staff',
            },
            owner,
          );
          await reset(managerCookie, target).expect(204);
          assert.equal((await users.context(target.id)).active, false);
          await request(server)
            .post('/api/auth/login')
            .set(...header)
            .send({ username: target.username, password: replacement })
            .expect(401);
        },
      );
      await t.test('self-password verification is rate limited', async () => {
        const target = await create('limited', ['KITCHEN']);
        const cookie = await login(target.username);
        await sql.query(
          'INSERT INTO login_attempts(key,attempts) VALUES ($1,10)',
          [tokenHash('password-change:' + target.id)],
        );
        const r = await change(cookie, initial).expect(429);
        assert.equal(r.body.code, 'PASSWORD_CHANGE_RATE_LIMITED');
      });
      await t.test(
        'local owner recovery CLI changes exactly the selected owner, revokes sessions and is repeat-safe',
        async () => {
          const recovered = 'recovered owner password 789!';
          const input = JSON.stringify({
            username: 'OWNER',
            newPassword: recovered,
            confirmPassword: recovered,
            reason: 'Local owner recovery test',
          });
          const before = Number(
            (await sql.query('SELECT count(*) FROM users')).rows[0].count,
          );
          for (let attempt = 0; attempt < 2; attempt++) {
            const run = spawnSync(
              process.execPath,
              ['scripts/reset-owner.cjs'],
              { cwd: root, env: process.env, input, encoding: 'utf8' },
            );
            assert.equal(run.status, 0, run.stdout + run.stderr);
            assert.equal((run.stdout + run.stderr).includes(recovered), false);
            assert.equal(await sessionCount(owner.id), 0);
          }
          assert.equal(
            Number(
              (await sql.query('SELECT count(*) FROM users')).rows[0].count,
            ),
            before,
          );
          const current = await users.context(owner.id);
          assert.deepEqual(current.roles, ['OWNER']);
          assert.equal(current.active, true);
          await request(server)
            .get('/api/auth/me')
            .set('Cookie', ownerCookie)
            .expect(401);
          await request(server)
            .post('/api/auth/login')
            .set(...header)
            .send({ username: 'owner', password: initial })
            .expect(401);
          await login('owner', recovered);
          const audit = (
            await sql.query(
              "SELECT * FROM user_audit WHERE target_id=$1 AND action='OWNER_RECOVERED'",
              [owner.id],
            )
          ).rows;
          assert.equal(audit.length, 2);
          assert.ok(audit.every((a) => a.actor_id === null));
          const hash = (
            await sql.query('SELECT password_hash FROM users WHERE id=$1', [
              owner.id,
            ])
          ).rows[0].password_hash;
          assert.equal(await verifyPassword(recovered, hash), true);
        },
      );
      await t.test(
        'recovery rejects non-owners, inactive owners, malformed/mismatched input and remote database targets without leaking input',
        async () => {
          const inactive = await create('inactive_owner', ['OWNER']);
          await sql.query('UPDATE users SET active=false WHERE id=$1', [
            inactive.id,
          ]);
          const base = {
            username: 'owner',
            newPassword: replacement,
            confirmPassword: replacement,
            reason: 'Recovery validation test',
          };
          for (const [input, code] of [
            [{ ...base, username: 'worker' }, 'OWNER_NOT_FOUND'],
            [{ ...base, username: 'absent_owner' }, 'OWNER_NOT_FOUND'],
            [{ ...base, username: 'inactive_owner' }, 'OWNER_INACTIVE'],
            [{ ...base, confirmPassword: 'mismatch' }, 'confirmation'],
            [
              { ...base, newPassword: 'short', confirmPassword: 'short' },
              'INVALID_PASSWORD',
            ],
          ]) {
            const run = spawnSync(
              process.execPath,
              ['scripts/reset-owner.cjs'],
              {
                cwd: root,
                env: process.env,
                input: JSON.stringify(input),
                encoding: 'utf8',
              },
            );
            assert.equal(run.status, 1);
            assert.match(run.stderr, new RegExp(code));
            assert.equal(
              (run.stdout + run.stderr).includes(replacement),
              false,
            );
          }
          const remote = spawnSync(
            process.execPath,
            ['scripts/reset-owner.cjs'],
            {
              cwd: root,
              env: {
                ...process.env,
                DATABASE_URL: 'postgresql://example.invalid/dukanos',
              },
              input: JSON.stringify(base),
              encoding: 'utf8',
            },
          );
          assert.equal(remote.status, 1);
          assert.match(remote.stderr, /loopback/);
          const malformed = spawnSync(
            process.execPath,
            ['scripts/reset-owner.cjs'],
            {
              cwd: root,
              env: process.env,
              input: 'not JSON ' + replacement,
              encoding: 'utf8',
            },
          );
          assert.equal(malformed.status, 1);
          assert.equal(malformed.stderr.includes(replacement), false);
        },
      );
      await t.test(
        'password audit payloads contain no credentials and database rejects secret-bearing payloads',
        async () => {
          const rows = (
            await sql.query(
              "SELECT * FROM user_audit WHERE action IN ('PASSWORD_CHANGED','PASSWORD_RESET','OWNER_RECOVERED')",
            )
          ).rows;
          assert.ok(rows.length > 0);
          for (const row of rows) {
            assert.equal(row.old_value, null);
            assert.deepEqual(row.new_value, {
              passwordChanged: true,
              sessionsRevoked: true,
            });
          }
          const text = JSON.stringify(rows);
          for (const secret of [initial, replacement, 'scrypt-32768-8-3'])
            assert.equal(text.includes(secret), false);
          await assert.rejects(
            sql.query(
              "INSERT INTO user_audit(actor_id,target_id,action,reason,new_value) VALUES ($1,$2,'PASSWORD_RESET','Test',$3)",
              [owner.id, worker.id, JSON.stringify({ password: replacement })],
            ),
            (e) => e.code === '23514',
          );
        },
      );
    } finally {
      if (app) await app.close();
      await sql.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      process.env.DATABASE_URL = originalUrl;
    }
  },
);
