// Run via the root npm command; secrets arrive only on stdin, never arguments.
require('reflect-metadata');
const { readFileSync } = require('node:fs');
const {
  DatabaseService,
} = require('../apps/api/dist/database/database.service');
const {
  UsersService,
} = require('../apps/api/dist/modules/users/users.service');
async function run() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    throw new Error(
      'Provide JSON on stdin containing username, name, and password.',
    );
  }
  const db = new DatabaseService();
  try {
    await new UsersService(db).create({ ...input, roles: ['OWNER'] });
    console.log('Initial owner created. Sign in through the application.');
  } finally {
    await db.onApplicationShutdown();
  }
}
run().catch(() => {
  console.error(
    'Owner setup failed. Check input, migrations, connectivity, and that no staff accounts exist.',
  );
  process.exitCode = 1;
});
