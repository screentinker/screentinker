'use strict';

/*
 * One-time (idempotent) migration: encrypt legacy PLAINTEXT secret fields already stored in
 * data_sources.config and plugin_state.settings. New writes encrypt on save (see routes), so this
 * only touches rows written before encryption-at-rest existed. Runs at boot after plugins load, so
 * a plugin data-source's secret fields are known; iCal's `authorization` is covered regardless.
 *
 * Idempotent: a value already carrying the enc: marker is skipped, so re-running is a no-op. Row by
 * row over two small tables (never play_logs), so it is cheap even on a large DB.
 */

const secrets = require('./secrets');
const registry = require('./registry');

function migrateSecretsAtRest(db) {
  let migrated = 0;
  try {
    const rows = db.prepare('SELECT id, type, config FROM data_sources').all();
    for (const row of rows) {
      let cfg;
      try { cfg = JSON.parse(row.config || '{}'); } catch (_) { continue; }
      const fields = secrets.fieldsForDataSource(row.type);
      if (!secrets.hasPlaintextSecret(cfg, fields)) continue;
      const enc = JSON.stringify(secrets.encryptSecrets(cfg, fields));
      db.prepare('UPDATE data_sources SET config = ? WHERE id = ?').run(enc, row.id);
      migrated += 1;
    }
  } catch (e) {
    console.warn('[plugins] secret migration (data_sources) skipped:', e.message);
  }

  try {
    const rows = db.prepare('SELECT id, settings FROM plugin_state WHERE settings IS NOT NULL').all();
    for (const row of rows) {
      let s;
      try { s = JSON.parse(row.settings || '{}'); } catch (_) { continue; }
      const plugin = registry.getPlugin(row.id);
      const fields = (plugin && plugin.settingsFields) || [];
      if (!secrets.hasPlaintextSecret(s, fields)) continue;
      const enc = JSON.stringify(secrets.encryptSecrets(s, fields));
      db.prepare('UPDATE plugin_state SET settings = ? WHERE id = ?').run(enc, row.id);
      migrated += 1;
    }
  } catch (e) {
    console.warn('[plugins] secret migration (plugin_state) skipped:', e.message);
  }

  if (migrated > 0) console.log(`[plugins] encrypted ${migrated} legacy plaintext secret row(s) at rest`);
  return migrated;
}

module.exports = { migrateSecretsAtRest };
