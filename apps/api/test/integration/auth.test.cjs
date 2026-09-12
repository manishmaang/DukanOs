require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { Test } = require('@nestjs/testing');
const { Controller, Get } = require('@nestjs/common');
const request = require('supertest');
const { AppModule } = require('../../dist/app.module');
const { configureApp } = require('../../dist/configure-app');
const { UsersService } = require('../../dist/modules/users/users.service');
const { RequirePermissions } = require('../../dist/modules/auth/access');
const { tokenHash } = require('../../dist/modules/auth/auth.service');
const { DUMMY_HASH } = require('../../dist/modules/auth/password');

class CapabilityProbe {
  pos() {
    return { ok: true };
  }
  kitchen() {
    return { ok: true };
  }
  dispatch() {
    return { ok: true };
  }
  refund() {
    return { ok: true };
  }
}
Controller('test-capabilities')(CapabilityProbe);
for (const [method, permission] of [
  ['pos', 'orders.create'],
  ['kitchen', 'kitchen.read'],
  ['dispatch', 'dispatch.read'],
  ['refund', 'payments.refund'],
]) {
  const descriptor = Object.getOwnPropertyDescriptor(
    CapabilityProbe.prototype,
    method,
  );
  Get(method)(CapabilityProbe.prototype, method, descriptor);
  RequirePermissions(permission)(CapabilityProbe.prototype, method, descriptor);
}
const password = 'test-only long password 123!';
const header = ['X-DukanOS-Request', '1'];

test(
  'PostgreSQL-backed authentication, RBAC and concurrency',
  { timeout: 120000 },
  async (t) => {
    assert.ok(
      process.env.DATABASE_URL,
      'DATABASE_URL is required; run npm run test:integration',
    );
    const originalUrl = process.env.DATABASE_URL;
    const admin = new Client({ connectionString: originalUrl });
    await admin.connect();
    const schema = 'rbac_test_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(originalUrl);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    let app;
    const sql = new Client({ connectionString: url.toString() });
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
        controllers: [CapabilityProbe],
      }).compile();
      app = module.createNestApplication();
      configureApp(app);
      await app.init();
      const users = app.get(UsersService);
      const server = app.getHttpServer();
      const owner = await users.create({
        username: 'owner',
        name: 'Owner',
        password,
        roles: ['OWNER'],
      });
      let ownerCookie;
      let employee;
      let staffCookie;
      const login = async (username) => {
        const response = await request(server)
          .post('/api/auth/login')
          .set(...header)
          .send({ username, password })
          .expect(200);
        return {
          response,
          cookie: response.headers['set-cookie'][0].split(';')[0],
        };
      };
      await t.test(
        'one-time owner bootstrap, protected routes, CSRF, generic login failures and safe cookies',
        async () => {
          await assert.rejects(
            users.create({
              username: 'owner2',
              name: 'Owner',
              password,
              roles: ['OWNER'],
            }),
            (e) => e.getResponse().code === 'BOOTSTRAP_DISABLED',
          );
          await request(server).get('/api/auth/me').expect(401);
          await request(server).get('/api/users').expect(401);
          await request(server)
            .post('/api/auth/login')
            .send({ username: 'owner', password })
            .expect(403);
          const wrong = await request(server)
            .post('/api/auth/login')
            .set(...header)
            .send({ username: 'owner', password: 'wrong' })
            .expect(401);
          const unknown = await request(server)
            .post('/api/auth/login')
            .set(...header)
            .send({ username: 'missing', password: 'wrong' })
            .expect(401);
          assert.deepEqual(wrong.body, unknown.body);
          const { response, cookie } = await login('OWNER');
          ownerCookie = cookie;
          assert.match(response.headers['set-cookie'][0], /HttpOnly/);
          assert.match(response.headers['set-cookie'][0], /SameSite=Strict/);
          assert.deepEqual(response.body.roles, ['OWNER']);
          assert.ok(response.body.permissions.includes('users.manage'));
          assert.equal(response.body.password_hash, undefined);
          assert.equal(response.body.role, undefined);
          const sessions = await sql.query(
            'SELECT token_hash FROM auth_sessions',
          );
          assert.equal(
            sessions.rows[0].token_hash,
            tokenHash(cookie.split('=')[1]),
          );
        },
      );
      await t.test(
        'staff creation, permission union, cross-screen access, and server-side denied capabilities',
        async () => {
          const response = await request(server)
            .post('/api/users')
            .set(...header)
            .set('Cookie', ownerCookie)
            .send({
              username: 'worker',
              name: 'Worker',
              password,
              roles: ['CASHIER', 'KITCHEN'],
            })
            .expect(201);
          employee = response.body;
          assert.deepEqual(employee.permissions, [
            'kitchen.read',
            'kitchen.update',
            'menu.read',
            'orders.create',
            'orders.read',
            'payments.collect',
          ]);
          ({ cookie: staffCookie } = await login('worker'));
          for (const path of ['pos', 'kitchen'])
            await request(server)
              .get('/api/test-capabilities/' + path)
              .set('Cookie', staffCookie)
              .expect(200);
          for (const path of ['dispatch', 'refund'])
            await request(server)
              .get('/api/test-capabilities/' + path)
              .set('Cookie', staffCookie)
              .expect(403);
          await request(server)
            .get('/api/users')
            .set('Cookie', staffCookie)
            .expect(403);
          await request(server)
            .patch('/api/users/' + employee.id + '/access')
            .set(...header)
            .set('Cookie', staffCookie)
            .send({
              roles: ['OWNER'],
              active: true,
              version: employee.version,
              reason: 'Escalate',
            })
            .expect(403);
          await request(server)
            .post('/api/users')
            .set(...header)
            .set('Cookie', ownerCookie)
            .send({
              username: 'WORKER',
              name: 'Duplicate',
              password,
              roles: ['CASHIER'],
            })
            .expect(409);
        },
      );
      await t.test(
        'invalid role sets have a meaningful API error and do not alter staff',
        async () => {
          for (const roles of [
            [],
            ['OWNER', 'MANAGER'],
            ['OWNER', 'KITCHEN'],
            ['MANAGER', 'CASHIER'],
            ['CASHIER', 'CASHIER'],
            ['INVALID'],
          ]) {
            const response = await request(server)
              .patch('/api/users/' + employee.id + '/access')
              .set(...header)
              .set('Cookie', ownerCookie)
              .send({
                roles,
                active: true,
                version: employee.version,
                reason: 'Invalid assignment test',
              })
              .expect(400);
            assert.equal(response.body.code, 'INVALID_ROLE_COMBINATION');
          }
          const current = await users.context(employee.id);
          assert.equal(current.version, employee.version);
        },
      );
      await t.test(
        'concurrent access updates use versions, revoke old sessions, and append audit entries',
        async () => {
          const results = await Promise.all(
            [['CASHIER', 'KITCHEN', 'DISPATCH'], ['DISPATCH']].map((roles) =>
              request(server)
                .patch('/api/users/' + employee.id + '/access')
                .set(...header)
                .set('Cookie', ownerCookie)
                .send({
                  roles,
                  active: true,
                  version: employee.version,
                  reason: 'Change shift responsibilities',
                }),
            ),
          );
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
          await request(server)
            .get('/api/auth/me')
            .set('Cookie', staffCookie)
            .expect(401);
          employee = await users.context(employee.id);
          employee = await users.updateAccess(
            employee.id,
            {
              roles: ['CASHIER', 'KITCHEN', 'DISPATCH'],
              active: true,
              version: employee.version,
              reason: 'All operational duties',
            },
            owner,
          );
          ({ cookie: staffCookie } = await login('worker'));
          for (const path of ['pos', 'kitchen', 'dispatch'])
            await request(server)
              .get('/api/test-capabilities/' + path)
              .set('Cookie', staffCookie)
              .expect(200);
          const audit = await sql.query(
            "SELECT * FROM user_audit WHERE target_id=$1 AND action='ACCESS_CHANGED'",
            [employee.id],
          );
          assert.equal(audit.rowCount, 2);
          assert.equal(audit.rows[0].actor_id, owner.id);
          await assert.rejects(
            sql.query('DELETE FROM user_audit WHERE target_id=$1', [
              employee.id,
            ]),
            /AUDIT_IMMUTABLE/,
          );
        },
      );
      await t.test(
        'permissions refresh from DB and deactivation revokes access immediately',
        async () => {
          await sql.query(
            "DELETE FROM role_permissions WHERE role_code='CASHIER' AND permission_code='payments.collect'",
          );
          const context = await request(server)
            .get('/api/auth/me')
            .set('Cookie', staffCookie)
            .expect(200);
          assert.equal(
            context.body.permissions.includes('payments.collect'),
            false,
          );
          await sql.query(
            "INSERT INTO role_permissions VALUES ('CASHIER','payments.collect')",
          );
          employee = await users.updateAccess(
            employee.id,
            {
              roles: employee.roles,
              active: false,
              version: employee.version,
              reason: 'Staff inactive',
            },
            owner,
          );
          await request(server)
            .get('/api/auth/me')
            .set('Cookie', staffCookie)
            .expect(401);
          await request(server)
            .post('/api/auth/login')
            .set(...header)
            .send({ username: 'worker', password })
            .expect(401);
          employee = await users.updateAccess(
            employee.id,
            {
              roles: employee.roles,
              active: true,
              version: employee.version,
              reason: 'Staff reactivated',
            },
            owner,
          );
        },
      );
      await t.test('expiry, logout and login rate limiting', async () => {
        let result = await login('worker');
        await sql.query(
          "UPDATE auth_sessions SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE token_hash=$1",
          [tokenHash(result.cookie.split('=')[1])],
        );
        await request(server)
          .get('/api/auth/me')
          .set('Cookie', result.cookie)
          .expect(401);
        result = await login('worker');
        await request(server)
          .post('/api/auth/logout')
          .set(...header)
          .set('Cookie', result.cookie)
          .expect(204);
        await request(server)
          .get('/api/auth/me')
          .set('Cookie', result.cookie)
          .expect(401);
        await sql.query(
          'INSERT INTO login_attempts(key,attempts) VALUES ($1,10)',
          [tokenHash('user:blocked')],
        );
        const limited = await request(server)
          .post('/api/auth/login')
          .set(...header)
          .send({ username: 'blocked', password })
          .expect(429);
        assert.equal(limited.body.code, 'LOGIN_RATE_LIMITED');
      });
      await t.test(
        'manager is exclusive but receives operational capabilities; last active owner remains',
        async () => {
          const manager = await users.create(
            {
              username: 'manager',
              name: 'Manager',
              password,
              roles: ['MANAGER'],
            },
            owner,
          );
          assert.ok(manager.permissions.includes('dispatch.complete'));
          assert.equal(manager.permissions.includes('users.manage'), false);
          const response = await request(server)
            .patch('/api/users/' + owner.id + '/access')
            .set(...header)
            .set('Cookie', ownerCookie)
            .send({
              roles: ['CASHIER'],
              active: true,
              version: owner.version,
              reason: 'Remove owner',
            })
            .expect(409);
          assert.equal(response.body.code, 'LAST_OWNER_REQUIRED');
        },
      );
      await t.test(
        'database constraints reject all invalid subsets, including empty and mixed roles',
        async () => {
          const codes = ['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN', 'DISPATCH'];
          for (let mask = 0; mask < 32; mask++) {
            const roles = codes.filter((_, i) => mask & (1 << i));
            const valid =
              roles.length > 0 &&
              (!roles.some((r) => ['OWNER', 'MANAGER'].includes(r)) ||
                roles.length === 1);
            await sql.query('BEGIN');
            try {
              const id = (
                await sql.query(
                  'INSERT INTO users(username,name,password_hash) VALUES ($1,$2,$3) RETURNING id',
                  ['subset' + mask, 'Subset', DUMMY_HASH],
                )
              ).rows[0].id;
              for (const role of roles)
                await sql.query('INSERT INTO user_roles VALUES ($1,$2)', [
                  id,
                  role,
                ]);
              if (valid) await sql.query('COMMIT');
              else
                await assert.rejects(
                  sql.query('COMMIT'),
                  (e) =>
                    e.code === '23514' &&
                    e.message === 'INVALID_ROLE_COMBINATION',
                );
            } finally {
              await sql.query('ROLLBACK');
            }
          }
          await assert.rejects(
            sql.query('DELETE FROM user_roles WHERE user_id=$1', [owner.id]),
            /INVALID_ROLE_COMBINATION/,
          );
        },
      );
      await t.test(
        'concurrent direct SQL assignments cannot produce a mixed role set',
        async () => {
          const first = new Client({ connectionString: url.toString() });
          const second = new Client({ connectionString: url.toString() });
          await first.connect();
          await second.connect();
          try {
            const id = (
              await sql.query(
                "SELECT user_id FROM user_roles WHERE role_code='CASHIER' GROUP BY user_id HAVING count(*)=1 LIMIT 1",
              )
            ).rows[0].user_id;
            await first.query('BEGIN');
            await second.query('BEGIN');
            await first.query(
              "INSERT INTO user_roles VALUES ($1,'KITCHEN') ON CONFLICT DO NOTHING",
              [id],
            );
            const pending = second.query(
              "INSERT INTO user_roles VALUES ($1,'OWNER')",
              [id],
            );
            await first.query('COMMIT');
            await pending;
            await assert.rejects(
              second.query('COMMIT'),
              /INVALID_ROLE_COMBINATION/,
            );
            const result = await sql.query(
              'SELECT role_code FROM user_roles WHERE user_id=$1',
              [id],
            );
            assert.equal(
              result.rows.some((r) => r.role_code === 'OWNER'),
              false,
            );
          } finally {
            await first.end();
            await second.end();
          }
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
