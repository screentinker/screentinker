'use strict';

/*
 * Free stock photos and videos (lib/stock-media.js, docs/stock-media.md).
 *
 *   GET  /status            what the pickers need: is it on, may this person add, which providers
 *   GET  /search            proxied provider search (the key stays here)
 *   POST /import            add one result to the active workspace's library
 *   GET|PUT /settings       platform admins: the instance's provider keys (never returned)
 *   POST /settings/test     platform admins: check a key with one tiny search
 *
 * JWT only (config/api-surface.js): the keys and their quota are the operator's, and an API token
 * has no picker to drive. Searching is denied to view-only members as well as adding: they cannot
 * add the result, and every search can spend the instance's shared provider quota.
 */

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const config = require('../config');
const { db } = require('../db/database');
const stock = require('../lib/stock-media');
const { denyReadOnly } = require('../lib/tenancy');
const { requirePlatformAdmin, isPlatformRole } = require('../middleware/auth');
const { checkStorageLimit, storageRoomBytes } = require('../middleware/subscription');
const { auditFromReq } = require('../lib/audit');

function sendError(res, e) {
  if (e instanceof stock.StockError) {
    if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
    return res.status(e.status || 502).json({ error: e.message, code: e.code });
  }
  if (e && e.name === 'UnsupportedUploadError') return res.status(400).json({ error: e.message });
  if (e && e.name === 'StorageWriteError') { try { e.discard(); } catch { /* gone */ } return res.status(502).json({ error: e.message, code: 'STORAGE_WRITE_FAILED' }); }
  // Never the error itself: nothing upstream is allowed to decide what reaches a browser or a log.
  console.error(`[stock] unexpected failure (${(e && e.name) || 'error'})`);
  return res.status(500).json({ error: 'Stock request failed' });
}
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => sendError(res, e));

const isViewer = (req) => !req.actingAs && req.workspaceRole === 'workspace_viewer';

function writeGate(req, res) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context. Switch to a workspace first.' }); return false; }
  if (denyReadOnly(req, res)) return false;
  return true;
}

/* ============================== pickers ============================== */

router.get('/status', (req, res) => {
  const enabled = stock.enabledProviders();
  const admin = isPlatformRole(req.user && req.user.role);
  res.json({
    enabled: enabled.length > 0,
    can_add: !!req.workspaceId && !isViewer(req),
    providers: enabled.map((id) => ({
      id,
      name: stock.PROVIDERS[id].name,
      types: stock.PROVIDERS[id].types,
      home: stock.PROVIDERS[id].home,
      licence_url: stock.PROVIDERS[id].licenceUrl,
    })),
    // Only the person who can fix it is told where: everyone else simply never sees the tab.
    setup_hint: !enabled.length && admin ? 'platform_settings' : null,
  });
});

router.get('/search', wrap(async (req, res) => {
  if (!writeGate(req, res)) return;
  const type = req.query.type === 'video' ? 'video' : 'photo';
  const provider = String(req.query.provider || stock.enabledProviders()[0] || '');
  const out = await stock.search({
    provider, type, q: req.query.q, page: req.query.page, orientation: req.query.orientation,
    userId: req.user.id, workspaceId: req.workspaceId,
  });
  // Results are the same for everyone; the browser may keep them briefly too.
  res.set('Cache-Control', 'private, max-age=300');
  res.json(out);
}));

router.post('/import', checkStorageLimit, wrap(async (req, res) => {
  if (!writeGate(req, res)) return;
  const b = req.body || {};
  const provider = String(b.provider || '');
  const type = b.type === 'video' ? 'video' : b.type === 'photo' ? 'photo' : null;
  if (!type) return res.status(400).json({ error: 'type must be photo or video' });
  const folderId = b.folder_id || null;
  if (folderId) {
    const f = db.prepare('SELECT workspace_id FROM content_folders WHERE id = ?').get(String(folderId));
    if (!f || f.workspace_id !== req.workspaceId) return res.status(400).json({ error: 'Invalid folder_id for this workspace' });
  }
  // The same two ceilings an upload meets: the instance's per-file limit, and what is left of the
  // plan's storage. checkStorageLimit above only refuses someone already at the limit.
  const room = storageRoomBytes(req.user.id, req.workspaceId);
  const maxBytes = room === null ? config.maxFileSize : Math.min(config.maxFileSize, Math.max(0, room));
  if (room !== null && room <= 0) return res.status(403).json({ error: 'This item would exceed your storage allowance.', code: 'STORAGE_LIMIT' });

  const row = await stock.importItem({
    provider, type, id: String(b.id || ''), userId: req.user.id, workspaceId: req.workspaceId, folderId,
    maxBytes, roomLimited: room !== null && room < config.maxFileSize,
  });
  const label = (stock.PROVIDERS[provider] || {}).name || provider;
  try { require('../lib/revisions').recordCurrent(db, 'content', row.id, { actor: require('../lib/releases').actorOf(req), summary: `Added from ${label}` }); } catch { /* history is best effort */ }
  auditFromReq(req, 'stock_media_added', { provider, type, item_id: String(b.id), content_id: row.id });
  res.status(201).json(row);
}));

/* ============================== platform admin: keys ============================== */

function settingsView() {
  return {
    providers: stock.PROVIDER_ORDER.map((id) => {
      const p = stock.PROVIDERS[id];
      const source = stock.keySource(id);
      return { id, name: p.name, env: p.env, configured: !!source, source, env_locked: source === 'env' };
    }),
  };
}

router.get('/settings', requirePlatformAdmin, (req, res) => res.json(settingsView()));

router.put('/settings', requirePlatformAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const provider = String(b.provider || '');
  if (!stock.PROVIDERS[provider]) return res.status(400).json({ error: 'Unknown provider' });
  if (stock.keySource(provider) === 'env') {
    return res.status(409).json({ error: `${stock.PROVIDERS[provider].name} is set by ${stock.PROVIDERS[provider].env} in the environment; change it there.`, code: 'env_locked' });
  }
  stock.saveKey(provider, b.key);
  auditFromReq(req, b.key ? 'stock_media_key_saved' : 'stock_media_key_removed', { provider });
  res.json(settingsView());
}));

router.post('/settings/test', requirePlatformAdmin, wrap(async (req, res) => {
  const provider = String((req.body && req.body.provider) || '');
  try {
    await stock.testKey(provider);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof stock.StockError) return res.json({ ok: false, error: e.message, code: e.code });
    throw e;
  }
}));

module.exports = router;
