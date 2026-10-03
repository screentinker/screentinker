// Hard backward-compat guarantee: with DATA_DIR (and the per-path overrides)
// UNSET, config must resolve to exactly the legacy in-repo locations, so existing
// installs - including production - see zero behavior change. Also verifies the
// overrides actually relocate state (the Docker /data case).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PATH_ENV = ['DATA_DIR', 'DB_PATH', 'UPLOADS_DIR', 'CERTS_DIR', 'PLUGINS_ENABLED', 'PLUGINS_DIR', 'BUNDLED_PLUGINS_DIR', 'PLUGIN_INBOX_DIR'];
const serverDir = path.join(__dirname, '..'); // config.js lives in server/

function loadConfig(overrides) {
  PATH_ENV.forEach((k) => delete process.env[k]);
  process.env.JWT_SECRET = 'test-secret'; // short-circuits the secret-file-writing IIFE (no FS side effects)
  Object.assign(process.env, overrides || {});
  delete require.cache[require.resolve('../config')];
  return require('../config');
}

test('UNSET -> exactly the legacy in-repo paths (zero change for existing installs)', () => {
  const c = loadConfig();
  assert.strictEqual(c.dataDir, serverDir);
  assert.strictEqual(c.dbPath, path.join(serverDir, 'db', 'remote_display.db'));
  assert.strictEqual(c.uploadsDir, path.join(serverDir, 'uploads'));
  assert.strictEqual(c.contentDir, path.join(serverDir, 'uploads', 'content'));
  assert.strictEqual(c.screenshotsDir, path.join(serverDir, 'uploads', 'screenshots'));
  assert.strictEqual(c.certsDir, path.join(serverDir, 'certs'));
  assert.strictEqual(c.pluginsEnabled, false, 'plugins stay off when PLUGINS_ENABLED is unset');
  assert.strictEqual(c.pluginInboxDir, path.join(serverDir, 'plugin-inbox'));
});

test('DATA_DIR relocates db / uploads / certs onto the volume', () => {
  const c = loadConfig({ DATA_DIR: '/data' });
  assert.strictEqual(c.dbPath, path.join('/data', 'db', 'remote_display.db'));
  assert.strictEqual(c.uploadsDir, path.join('/data', 'uploads'));
  assert.strictEqual(c.contentDir, path.join('/data', 'uploads', 'content'));
  assert.strictEqual(c.screenshotsDir, path.join('/data', 'uploads', 'screenshots'));
  assert.strictEqual(c.certsDir, path.join('/data', 'certs'));
  assert.strictEqual(c.dataPluginsDir, path.join('/data', 'plugins'));
  assert.strictEqual(c.pluginInboxDir, path.join('/data', 'plugin-inbox'));
});

test('individual overrides win over DATA_DIR', () => {
  const c = loadConfig({ DATA_DIR: '/data', DB_PATH: '/custom/app.db', UPLOADS_DIR: '/media' });
  assert.strictEqual(c.dbPath, '/custom/app.db');
  assert.strictEqual(c.uploadsDir, '/media');
  assert.strictEqual(c.contentDir, path.join('/media', 'content'));
});
