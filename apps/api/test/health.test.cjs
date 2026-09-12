require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Test } = require('@nestjs/testing');
const request = require('supertest');
const { AppModule } = require('../dist/app.module');
const { DatabaseService } = require('../dist/database/database.service');
const { configureApp } = require('../dist/configure-app');
const { readConfig } = require('../dist/config');
test('configuration rejects missing database URL and invalid ports', () => {
  assert.throws(() => readConfig({}), /DATABASE_URL/);
  assert.throws(() => readConfig({ PORT: '0' }), /PORT/);
  assert.throws(
    () => readConfig({ DATABASE_URL: 'https://example.com' }),
    /PostgreSQL/,
  );
  assert.equal(
    readConfig({ DATABASE_URL: 'postgresql://localhost/dukanos' }).port,
    3000,
  );
});
test('HTTP health separates liveness from database readiness and sanitizes failures', async () => {
  let fails = false;
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseService)
    .useValue({
      check: async () => {
        if (fails) throw new Error('secret database credentials');
      },
    })
    .compile();
  const app = module.createNestApplication();
  configureApp(app);
  await app.init();
  try {
    const live = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    assert.deepEqual(live.body, { status: 'ok', service: 'dukanos-api' });
    await request(app.getHttpServer()).get('/api/health/ready').expect(200);
    fails = true;
    const ready = await request(app.getHttpServer())
      .get('/api/health/ready')
      .expect(503);
    assert.deepEqual(ready.body, {
      code: 'DATABASE_UNAVAILABLE',
      message: 'Service is unavailable',
    });
    await request(app.getHttpServer()).get('/api/health').expect(200);
    const missing = await request(app.getHttpServer())
      .get('/api/missing')
      .expect(404);
    assert.equal(missing.body.code, 'HTTP_404');
  } finally {
    await app.close();
  }
});
