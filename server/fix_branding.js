const { db } = require('./db/database');
try {
  db.prepare('DELETE FROM white_labels').run();
  const d = require('./db/database').dbOptions;
  if (d && typeof db.sync === 'function') db.sync();
  console.log('Cleared old branding overrides, server will use the new HARDCODED_BRANDING.');
} catch (e) {
  console.error(e);
}
