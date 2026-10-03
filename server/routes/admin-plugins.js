'use strict';

/*
 * Platform-admin plugin inventory. Mounted at /api/admin/plugins.
 *
 * When PLUGINS_ENABLED is unset these handlers 404 (P1). Enable/disable persist
 * to plugin_state and tell the operator to restart — we do not require() new
 * code into a running process. Settings writes apply immediately: hook handlers
 * re-read getSettings() on each fire.
 *
 * Uploaded zips land in the inbox, never on a require() path. Approve copies
 * the inspected tree into DATA_DIR/plugins and pins the hash (P9).
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const config = require('../config');
const { db } = require('../db/database');
const registry = require('../lib/plugins/registry');
const { logActivity, getClientIp } = require('../services/activity');
const { redactSecrets, mergeSecrets, encryptSecrets, decryptSecrets } = require('../lib/plugins/secrets');
const submissions = require('../lib/plugins/submissions');
const allowlist = require('../lib/plugins/allowlist');
const { MAX_ARCHIVE_BYTES } = require('../lib/plugins/inbox');
const { rescan } = require('../lib/plugins/load');
const { isInside } = require('../lib/plugins/paths');
const { requirePlatformAdmin } = require('../middleware/auth');

// Defense in depth. This router is mounted behind requirePlatformAdmin in routes/admin.js, but every
// handler here is a code-install / enable primitive, so it re-asserts the check itself: if this
// sub-router is ever re-mounted elsewhere, or that one mount line is refactored, the install/enable
// routes do not silently become reachable by any authenticated user.
router.use(requirePlatformAdmin);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ARCHIVE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    const ok = name.endsWith('.zip')
      || mime === 'application/zip'
      || mime === 'application/x-zip-compressed'
      || mime === 'application/octet-stream';
    if (ok) cb(null, true);
    else cb(new Error('Plugin packages must be a .zip'));
  },
});

function pluginsOff(res) {
  return res.status(404).json({ error: 'Not found' });
}

function storedSettings(id) {
  try {
    const row = db.prepare('SELECT settings FROM plugin_state WHERE id = ?').get(id);
    if (!row || !row.settings) return {};
    const parsed = JSON.parse(row.settings);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sendErr(res, e) {
  const status = e && e.status ? e.status : 400;
  return res.status(status).json({ error: e.message || 'Request failed' });
}

router.get('/', (req, res) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  try { rescan(); } catch (e) {
    console.warn('[plugins] rescan failed:', e.message);
  }
  const pins = new Map(allowlist.list(db).map((r) => [r.plugin_id, r]));
  const plugins = registry.listPlugins().map((p) => {
    const fields = p.settingsFields || [];
    const pin = pins.get(p.id);
    return {
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description,
      origin: p.origin,
      capabilities: p.capabilities,
      enabled: !!p.enabled,
      loaded: !!p.loaded,
      error: p.error || null,
      settings_fields: fields,
      settings: redactSecrets(storedSettings(p.id), fields),
      allowlisted: !!pin,
      allowlist_sha256: pin ? pin.sha256 : null,
      allowlist_source: pin ? pin.source : null,
    };
  });
  res.json({ plugins, restart_required: false });
});

router.get('/submissions', (req, res) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  const status = req.query.status ? String(req.query.status) : undefined;
  res.json({ submissions: submissions.list(db, { status }) });
});

router.get('/submissions/:id', (req, res) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  const row = submissions.get(db, Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Submission not found' });
  res.json(row);
});

router.get('/submissions/:id/file', async (req, res) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  const rel = String(req.query.path || '');
  if (!rel || rel.includes('..')) return res.status(400).json({ error: 'path is required' });
  try {
    const buf = await submissions.readFile(db, {
      id: Number(req.params.id),
      rel,
      inboxDir: config.pluginInboxDir,
    });
    const text = buf.toString('utf8');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
      return res.json({ path: rel, binary: true, size: buf.length });
    }
    res.json({ path: rel, text, size: buf.length });
  } catch (e) {
    return sendErr(res, e);
  }
});

router.post('/submissions', (req, res, next) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  upload.single('package')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, async (req, res) => {
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'A .zip file is required' });
  try {
    const row = await submissions.create(db, {
      buffer: req.file.buffer,
      inboxDir: config.pluginInboxDir,
      submittedBy: req.user && req.user.id,
      workspaceId: req.workspaceId || null,
    });
    try { logActivity(req.user && req.user.id, 'plugin_submit', row.plugin_id, null, getClientIp(req), null); }
    catch (_) { /* */ }
    res.status(201).json(row);
  } catch (e) {
    return sendErr(res, e);
  }
});

router.post('/submissions/:id/approve', async (req, res) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  try {
    const row = await submissions.approve(db, {
      id: Number(req.params.id),
      approvedBy: req.user && req.user.id,
      inboxDir: config.pluginInboxDir,
      dataPluginsDir: config.dataPluginsDir,
      replace: !!(req.body && req.body.replace),
    });
    try { logActivity(req.user && req.user.id, 'plugin_approve', row.plugin_id, null, getClientIp(req), null); }
    catch (_) { /* */ }
    try { rescan(); } catch (e) { console.warn('[plugins] rescan after approve failed:', e.message); }
    res.json({ ok: true, submission: row, restart_required: false, next: 'enable' });
  } catch (e) {
    return sendErr(res, e);
  }
});

router.post('/submissions/:id/reject', (req, res) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  try {
    const row = submissions.reject(db, {
      id: Number(req.params.id),
      decidedBy: req.user && req.user.id,
      note: req.body && req.body.note,
      inboxDir: config.pluginInboxDir,
    });
    try { logActivity(req.user && req.user.id, 'plugin_reject', row.plugin_id, null, getClientIp(req), null); }
    catch (_) { /* */ }
    res.json({ ok: true, submission: row });
  } catch (e) {
    return sendErr(res, e);
  }
});

router.get('/allowlist', (req, res) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  res.json({ allowlist: allowlist.list(db) });
});

router.post('/:id/pin', (req, res) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  const id = String(req.params.id || '');
  const plugin = registry.getPlugin(id);
  if (!plugin || !plugin.dir) return res.status(404).json({ error: 'Plugin not found' });
  try {
    const sha256 = allowlist.hashTree(plugin.dir);
    const row = allowlist.pin(db, {
      pluginId: id,
      sha256,
      source: 'pin',
      approvedBy: req.user && req.user.id,
      note: req.body && req.body.note,
    });
    try { logActivity(req.user && req.user.id, 'plugin_pin', id, null, getClientIp(req), null); }
    catch (_) { /* */ }
    res.json({ ok: true, allowlist: row, restart_required: true });
  } catch (e) {
    return sendErr(res, e);
  }
});

router.post('/:id/unpin', (req, res) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  const id = String(req.params.id || '');
  const row = allowlist.unpin(db, id);
  if (!row) return res.status(404).json({ error: 'Not on the allowlist' });
  if (row.source === 'upload' && registry.getPlugin(id) && registry.getPlugin(id).dir) {
    const dir = registry.getPlugin(id).dir;
    const root = config.dataPluginsDir;
    try {
      const real = fs.realpathSync(dir);
      const rootReal = fs.realpathSync(root);
      if (real === path.join(rootReal, id) || isInside(rootReal, real)) {
        fs.rmSync(real, { recursive: true, force: true });
      }
    } catch { /* leftover files are still unloadable */ }
  }
  try { logActivity(req.user && req.user.id, 'plugin_unpin', id, null, getClientIp(req), null); }
  catch (_) { /* */ }
  try { rescan(); } catch (e) { console.warn('[plugins] rescan after unpin failed:', e.message); }
  res.json({ ok: true, restart_required: true });
});

router.post('/:id/enable', (req, res) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  try { rescan(); } catch (e) { console.warn('[plugins] rescan before enable failed:', e.message); }
  const id = String(req.params.id || '');
  const plugin = registry.getPlugin(id);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
  const allowErr = allowlist.assertLoadable(db, id, plugin.dir);
  if (allowErr) {
    return res.status(409).json({ error: 'Cannot enable: ' + allowErr });
  }
  try {
    db.prepare(`
      INSERT INTO plugin_state (id, enabled, error, updated_at)
      VALUES (?, 1, NULL, strftime('%s','now'))
      ON CONFLICT(id) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at
    `).run(id);
  } catch (e) {
    return res.status(500).json({ error: 'Could not persist plugin state' });
  }
  plugin.enabled = true;
  try { logActivity(req.user && req.user.id, 'plugin_enable', id, null, getClientIp(req), null); }
  catch (_) { /* audit is best-effort */ }
  res.json({ ok: true, restart_required: true });
});

router.post('/:id/disable', (req, res) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  const id = String(req.params.id || '');
  const plugin = registry.getPlugin(id);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
  try {
    db.prepare(`
      INSERT INTO plugin_state (id, enabled, error, updated_at)
      VALUES (?, 0, NULL, strftime('%s','now'))
      ON CONFLICT(id) DO UPDATE SET enabled = 0, updated_at = excluded.updated_at
    `).run(id);
  } catch (e) {
    return res.status(500).json({ error: 'Could not persist plugin state' });
  }
  plugin.enabled = false;
  try { logActivity(req.user && req.user.id, 'plugin_disable', id, null, getClientIp(req), null); }
  catch (_) { /* audit is best-effort */ }
  res.json({ ok: true, restart_required: true });
});

router.put('/:id/settings', (req, res) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  const id = String(req.params.id || '');
  const plugin = registry.getPlugin(id);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
  const incoming = req.body && req.body.settings;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'settings must be an object' });
  }
  const fields = plugin.settingsFields || [];
  // Merge against DECRYPTED stored secrets (blank incoming keeps the real value), then re-encrypt.
  const merged = mergeSecrets(incoming, decryptSecrets(storedSettings(id), fields), fields);
  const json = JSON.stringify(encryptSecrets(merged, fields));
  if (json.length > 32 * 1024) return res.status(400).json({ error: 'settings too large' });
  try {
    db.prepare(`
      INSERT INTO plugin_state (id, enabled, settings, updated_at)
      VALUES (?, ?, ?, strftime('%s','now'))
      ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at
    `).run(id, plugin.enabled ? 1 : 0, json);
  } catch (e) {
    return res.status(500).json({ error: 'Could not persist plugin settings' });
  }
  try { logActivity(req.user && req.user.id, 'plugin_settings', id, null, getClientIp(req), null); }
  catch (_) { /* audit is best-effort */ }
  res.json({ ok: true, restart_required: false, settings: redactSecrets(merged, fields) });
});

module.exports = router;
