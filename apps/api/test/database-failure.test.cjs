const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseService } = require('../dist/database/database.service');
for (const rollbackFails of [false, true])
  test(`transaction failure preserves original error and ${rollbackFails ? 'discards failed' : 'releases rolled-back'} connection`, async () => {
    const original = new Error('operation failed');
    const statements = [];
    let discarded;
    const client = {
      query: async (sql) => {
        statements.push(sql);
        if (sql === 'ROLLBACK' && rollbackFails)
          throw new Error('broken connection');
      },
      release: (flag) => {
        discarded = flag;
      },
    };
    await assert.rejects(
      DatabaseService.prototype.transaction.call(
        { pool: { connect: async () => client } },
        async () => {
          throw original;
        },
      ),
      (error) => error === original,
    );
    assert.deepEqual(statements, ['BEGIN', 'ROLLBACK']);
    assert.equal(discarded, rollbackFails);
  });
