require('reflect-metadata');
const {
  DatabaseService,
} = require('../apps/api/dist/database/database.service');
const {
  ExpenseMediaService,
} = require('../apps/api/dist/modules/expenses/expense-media.service');
(async () => {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--dry-run') || args.length > 1)
    throw new Error('Use only --dry-run.');
  const db = new DatabaseService();
  try {
    const report = await new ExpenseMediaService(db).cleanup(
      args.includes('--dry-run'),
    );
    console.log(JSON.stringify(report));
    if (report.deferred) process.exitCode = 1;
  } finally {
    await db.onApplicationShutdown();
  }
})().catch(() => {
  console.error(
    'Expense receipt cleanup failed. Check local database and data-directory access.',
  );
  process.exitCode = 1;
});
