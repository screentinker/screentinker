'use strict';

/**
 * Data Sources & Integrations REST API Routes for ScreenTinker.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../db/database');
const { syncDataSource, withFetchSlot, bumpDependentWidgets } = require('../lib/data-sources/service');
const { resolveIcalData } = require('../lib/data-sources/ical-resolver');
const { resolveWeatherData, validateWeatherConfig } = require('../lib/data-sources/weather-resolver');
const { requireWorkspaceWrite, canWrite } = require('../lib/permissions');
const { parseSafeUrl } = require('../lib/ssrf-guard');
const { makePluginFetch } = require('../lib/plugins/egress');
const { isRealTimezone } = require('../lib/device-timezone');
const pluginRegistry = require('../lib/plugins/registry');
const { redactSecrets, mergeSecrets, encryptSecrets, decryptSecrets, fieldsForDataSource } = require('../lib/plugins/secrets');

function isSupportedDataSourceType(type) {
  return type === 'ical' || type === 'weather' || pluginRegistry.hasDataSource(type);
}

// Two configs share a secret destination when their `url` fields resolve to the same origin.
// A missing or unparseable URL on either side counts as "different" so we fail closed and never
// forward a stored secret to a URL it was not saved for.
function sameSecretDestination(a, b) {
  const originOf = (cfg) => {
    const u = cfg && typeof cfg.url === 'string' ? cfg.url : '';
    try { return new URL(u).origin.toLowerCase(); } catch (_) { return null; }
  };
  const oa = originOf(a);
  return oa !== null && oa === originOf(b);
}

// Helper to generate a clean URL-friendly slug
function toSlug(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '_')
    .replace(/^_|_$/g, '') || 'source';
}

function sanitizeConfigForRole(cfg, req, type) {
  if (!cfg || typeof cfg !== 'object') return {};
  const fields = fieldsForDataSource(type);
  let safe = redactSecrets(cfg, fields);
  if (canWrite(req)) return safe;
  if (safe.url) {
    try {
      const u = new URL(safe.url);
      if (u.search) u.search = '?***';
      if (u.username) u.username = '***';
      if (u.password) u.password = '***';
      safe.url = u.toString();
    } catch (_) {
      safe.url = '***';
    }
  }
  if (safe.ics_data) safe.ics_data = '[redacted]';
  if (safe.raw_data) safe.raw_data = '[redacted]';
  if (safe.raw_ics) safe.raw_ics = '[redacted]';
  return safe;
}

function validateDataSourceConfig(type, config) {
  if (!config || typeof config !== 'object') return null;

  // Weather has its own schema (location or coordinates, units, locale, 'auto' timezone) and makes
  // no request to a user-supplied URL, so the iCal URL / IANA checks below do not apply to it.
  if (type === 'weather') return validateWeatherConfig(config);

  if (config.timezone) {
    const tzStr = String(config.timezone).trim();
    if (!isRealTimezone(tzStr)) {
      return `Invalid IANA timezone: "${config.timezone}"`;
    }
  }

  const hasInline = Boolean(config.ics_data || config.raw_data || config.raw_ics);
  if (config.url && !hasInline) {
    try {
      parseSafeUrl(config.url);
    } catch (err) {
      if (err.reason === 'userinfo') {
        return 'URLs with basic-auth credentials (username/password) are not allowed';
      }
      if (err.reason === 'bad-scheme') {
        return 'URL must use HTTP, HTTPS, or webcal protocol';
      }
      if (err.reason && err.reason.startsWith('blocked-ip')) {
        return 'The address is not allowed';
      }
      return 'Invalid URL format';
    }
  }

  return null;
}

// ─── GET /api/data-sources (List all in current workspace) ─────────────────────
router.get('/', (req, res) => {
  const wsId = req.workspaceId;
  const rows = db.prepare(`
    SELECT id, workspace_id, slug, name, type, config, cached_data, last_fetched_at, last_status, last_error, created_at, updated_at
    FROM data_sources
    WHERE workspace_id = ?
    ORDER BY name ASC
  `).all(wsId);

  const parsed = rows.map(r => {
    let cfg = {};
    try { cfg = JSON.parse(r.config); } catch (_) {}
    let data = null;
    try { data = JSON.parse(r.cached_data || 'null'); } catch (_) {}
    return {
      ...r,
      config: sanitizeConfigForRole(cfg, req, r.type),
      data,
    };
  });

  res.json(parsed);
});

router.get('/plugin-types', (req, res) => {
  res.json({ types: pluginRegistry.listDataSourceTypes() });
});

// ─── GET /api/data-sources/:id (Get single data source with live preview) ──────
router.get('/:id', (req, res) => {
  const wsId = req.workspaceId;
  const row = db.prepare('SELECT * FROM data_sources WHERE id = ? AND workspace_id = ?').get(req.params.id, wsId);
  if (!row) {
    return res.status(404).json({ error: 'Data source not found' });
  }

  let config = {};
  try { config = JSON.parse(row.config); } catch (_) {}

  let data = null;
  try { data = JSON.parse(row.cached_data || 'null'); } catch (_) {}

  res.json({
    ...row,
    config: sanitizeConfigForRole(config, req, row.type),
    data,
  });
});

// ─── POST /api/data-sources/test (Test connection & preview live data) ─────────
router.post('/test', requireWorkspaceWrite, async (req, res, next) => {
  const { type, config } = req.body || {};
  if (!type || !config) {
    return res.status(400).json({ error: 'Type and config are required' });
  }

  if (!isSupportedDataSourceType(type)) {
    return res.status(400).json({ error: `Unsupported data source type: ${type}` });
  }

  let parsedConfig = config;
  if (typeof config === 'string') {
    try { parsedConfig = JSON.parse(config); }
    catch (_) { return res.status(400).json({ error: 'Config must be valid JSON' }); }
  }
  if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
    return res.status(400).json({ error: 'Config must be an object' });
  }

  const valErr = validateDataSourceConfig(type, parsedConfig);
  if (valErr) {
    return res.status(400).json({ error: valErr });
  }

  if (req.body.id) {
    const existing = db.prepare('SELECT config, type FROM data_sources WHERE id = ? AND workspace_id = ?')
      .get(req.body.id, req.workspaceId);
    if (existing) {
      let prev = {};
      try { prev = decryptSecrets(JSON.parse(existing.config), fieldsForDataSource(existing.type || type)); } catch (_) {}
      // Only back-fill a stored secret when this test targets the SAME destination the secret was
      // saved for. GET redacts secrets from everyone (see sanitizeConfigForRole), so without this a
      // workspace writer could point an existing source at their own URL, have the stored token
      // merged in, and receive it -- a redaction bypass / credential-exfil path. Fail closed: if
      // either URL is missing or unparseable, do not merge, and the test runs without the secret.
      if (sameSecretDestination(parsedConfig, prev)) {
        parsedConfig = mergeSecrets(parsedConfig, prev, fieldsForDataSource(existing.type || type));
      }
    }
  }

  try {
    let previewData = null;
    if (type === 'ical') {
      previewData = await withFetchSlot(() => resolveIcalData(parsedConfig));
    } else if (type === 'weather') {
      previewData = await withFetchSlot(() => resolveWeatherData(parsedConfig, { now: new Date() }));
    } else {
      const plugin = pluginRegistry.getDataSource(type);
      if (!plugin) return res.status(400).json({ error: `Unsupported data source type: ${type}` });
      previewData = await withFetchSlot(() => plugin.resolve(parsedConfig, {
        workspaceId: req.workspaceId,
        now: new Date(),
        log: (...args) => console.warn(`[plugin:${plugin.pluginId}]`, ...args),
        fetch: makePluginFetch(plugin.network && plugin.network.allow, { timeoutMs: 10000, maxBytes: 512 * 1024, responseType: 'text' }),
      }));
    }

    res.json({
      status: 'ok',
      preview: previewData,
    });
  } catch (err) {
    // Do NOT leak the raw upstream error to the caller: it can betray internal topology or
    // distinguish "connection refused" from "DNS failed", which aids SSRF reconnaissance.
    // Log the detail server-side and surface only a generic message.
    console.warn(`[data-sources] Test failed for type "${type}": ${err.message}`);
    res.status(422).json({
      status: 'error',
      error: type === 'weather'
        ? 'Could not fetch the weather. Check the location and try again.'
        : 'Could not fetch or parse the data source. Check the URL and try again.',
    });
  }
});

// ─── POST /api/data-sources (Create new data source) ───────────────────────────
router.post('/', requireWorkspaceWrite, (req, res) => {
  const wsId = req.workspaceId;
  if (!wsId) {
    return res.status(400).json({ error: 'Workspace ID is required' });
  }
  const { name, type, config, slug: customSlug } = req.body || {};

  if (!name || !type || !config) {
    return res.status(400).json({ error: 'Name, type, and config are required' });
  }

  if (!isSupportedDataSourceType(type)) {
    return res.status(400).json({ error: `Unsupported data source type: ${type}` });
  }

  let parsedConfig = config;
  if (typeof config === 'string') {
    try { parsedConfig = JSON.parse(config); }
    catch (_) { return res.status(400).json({ error: 'Config must be valid JSON' }); }
  }
  if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
    return res.status(400).json({ error: 'Config must be an object' });
  }

  const valErr = validateDataSourceConfig(type, parsedConfig);
  if (valErr) {
    return res.status(400).json({ error: valErr });
  }

  const cleanName = String(name).trim();
  let cleanSlug = customSlug ? toSlug(customSlug) : toSlug(cleanName);

  // Ensure slug uniqueness in workspace
  let uniqueSlug = cleanSlug;
  let counter = 1;
  while (db.prepare('SELECT 1 FROM data_sources WHERE workspace_id = ? AND slug = ?').get(wsId, uniqueSlug)) {
    uniqueSlug = `${cleanSlug}_${counter++}`;
  }

  const id = `ds_${crypto.randomUUID()}`;
  // Secret fields are encrypted at rest; the plaintext parsedConfig is kept only for the response
  // (where sanitizeConfigForRole redacts it anyway).
  const configJson = JSON.stringify(encryptSecrets(parsedConfig, fieldsForDataSource(type)));
  const nowSec = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO data_sources (id, workspace_id, slug, name, type, config, last_fetched_at, last_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)
  `).run(id, wsId, uniqueSlug, cleanName, type, configJson, nowSec, nowSec);

  // Trigger initial sync in background
  const newRow = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(id);
  syncDataSource(newRow, true).catch(err => {
    console.warn(`[data-sources] background initial sync failed for ${id}:`, err.message);
  });

  res.status(201).json({
    status: 'ok',
    id,
    slug: uniqueSlug,
    name: cleanName,
    type,
    config: sanitizeConfigForRole(parsedConfig, req, type),
    data: null,
  });
});

// ─── PUT /api/data-sources/:id (Update data source) ────────────────────────────
router.put('/:id', requireWorkspaceWrite, (req, res) => {
  const wsId = req.workspaceId;
  const { name, config, slug: customSlug } = req.body || {};

  const existing = db.prepare('SELECT * FROM data_sources WHERE id = ? AND workspace_id = ?').get(req.params.id, wsId);
  if (!existing) {
    return res.status(404).json({ error: 'Data source not found' });
  }

  const cleanName = name ? String(name).trim() : existing.name;
  let cleanSlug = customSlug ? toSlug(customSlug) : existing.slug;

  if (cleanSlug !== existing.slug) {
    const collision = db.prepare('SELECT 1 FROM data_sources WHERE workspace_id = ? AND slug = ? AND id != ?').get(wsId, cleanSlug, req.params.id);
    if (collision) {
      return res.status(409).json({ error: `Slug "${cleanSlug}" is already taken in this workspace` });
    }
  }

  let configJson = existing.config;
  let parsedConfig = null;
  let plaintextChanged = false;
  if (config !== undefined) {
    parsedConfig = config;
    if (typeof config === 'string') {
      try { parsedConfig = JSON.parse(config); }
      catch (_) { return res.status(400).json({ error: 'Config must be valid JSON' }); }
    }
    if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
      return res.status(400).json({ error: 'Config must be an object' });
    }
    const valErr = validateDataSourceConfig(existing.type, parsedConfig);
    if (valErr) {
      return res.status(400).json({ error: valErr });
    }
    const fields = fieldsForDataSource(existing.type);
    let prev = {};
    try { prev = decryptSecrets(JSON.parse(existing.config), fields); } catch (_) {}
    // Merge against DECRYPTED stored secrets so a blank incoming secret keeps the real value.
    parsedConfig = mergeSecrets(parsedConfig, prev, fields);
    plaintextChanged = JSON.stringify(parsedConfig) !== JSON.stringify(prev);
    configJson = JSON.stringify(encryptSecrets(parsedConfig, fields)); // re-encrypt for storage
  } else {
    try { parsedConfig = decryptSecrets(JSON.parse(configJson), fieldsForDataSource(existing.type)); } catch (_) {}
  }

  const nowSec = Math.floor(Date.now() / 1000);

  db.prepare(`
    UPDATE data_sources
    SET name = ?, slug = ?, config = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ?
  `).run(cleanName, cleanSlug, configJson, nowSec, req.params.id, wsId);

  // Trigger refresh only if the config's plaintext actually changed (encryption is non-deterministic,
  // so a ciphertext comparison would always look "changed").
  const configChanged = plaintextChanged;
  if (configChanged) {
    const updatedRow = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(req.params.id);
    syncDataSource(updatedRow, true).catch(err => {
      console.warn(`[data-sources] background update sync failed for ${req.params.id}:`, err.message);
    });
  }

  let existingData = null;
  try { existingData = JSON.parse(existing.cached_data || 'null'); } catch (_) {}

  res.json({
    status: 'ok',
    id: req.params.id,
    slug: cleanSlug,
    name: cleanName,
    type: existing.type,
    config: sanitizeConfigForRole(parsedConfig, req, existing.type),
    data: existingData,
  });
});

// ─── POST /api/data-sources/:id/refresh (Force refresh) ─────────────────────────
router.post('/:id/refresh', requireWorkspaceWrite, async (req, res, next) => {
  try {
    const wsId = req.workspaceId;
    const row = db.prepare('SELECT * FROM data_sources WHERE id = ? AND workspace_id = ?').get(req.params.id, wsId);
    if (!row) {
      return res.status(404).json({ error: 'Data source not found' });
    }

    const synced = await syncDataSource(row, true);
    res.json({
      status: 'ok',
      last_status: synced.last_status,
      last_error: synced.last_error,
      last_fetched_at: synced.last_fetched_at,
      data: synced.data,
    });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/data-sources/:id (Delete data source) ─────────────────────────
router.delete('/:id', requireWorkspaceWrite, (req, res) => {
  const wsId = req.workspaceId;
  const row = db.prepare('SELECT id, workspace_id, slug FROM data_sources WHERE id = ? AND workspace_id = ?').get(req.params.id, wsId);
  if (!row) {
    return res.status(404).json({ error: 'Data source not found' });
  }
  db.prepare('DELETE FROM data_sources WHERE id = ?').run(row.id);
  // The bound widgets now resolve to '' and their rev must move, or every player keeps the
  // deleted source's last values in the year-long immutable render cache.
  bumpDependentWidgets(row, Math.floor(Date.now() / 1000));

  res.json({ success: true, message: 'Data source deleted' });
});

module.exports = router;
