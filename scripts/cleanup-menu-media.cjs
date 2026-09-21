require('reflect-metadata');
const {
  DatabaseService,
} = require('../apps/api/dist/database/database.service');
const {
  MenuMediaService,
} = require('../apps/api/dist/modules/menu/menu-media.service');
(async () => {
  const db = new DatabaseService();
  try {
    await new MenuMediaService(db).cleanup();
    console.log('Unreferenced menu media older than 24 hours cleaned.');
  } finally {
    await db.onApplicationShutdown();
  }
})().catch(() => {
  console.error(
    'Media cleanup failed. Check local database and data-directory access.',
  );
  process.exitCode = 1;
});
