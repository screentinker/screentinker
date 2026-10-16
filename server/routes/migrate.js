'use strict';

/*
 * Switch to ScreenTinker: import from another signage CMS (lib/migrate, docs/migrate.md).
 *
 *   GET    /vendors                 the sources this server can import from, and how to connect
 *   GET    /jobs                    this workspace's imports, newest first
 *   POST   /jobs                    connect with a key / server address and start the scan
 *   POST   /jobs/upload             upload an export file or a zip of media and start the scan
 *   GET    /jobs/:id                one import: scan summary, what cannot be mapped, progress, report
 *   POST   /jobs/:id/run            import what was chosen (also resumes a stopped or interrupted one)
 *   POST   /jobs/:id/cancel         stop it (between items) and delete the held credential
 *   GET    /placeholders            the source's screens, waiting to be paired
 *   POST   /placeholders/:id/link   record which real screen a placeholder became (after pairing)
 *   DELETE /placeholders/:id        drop a placeholder
 *
 * JWT only (config/api-surface.js), the active workspace (resolveTenancy). Everything except the
 * vendor list is refused to a view-only member: an import writes to the workspace, and even reading
 * a job would show which other vendor account the workspace is connected to.
 *
 * ⚠️ NO RESPONSE, LOG OR AUDIT LINE CARRIES THE CREDENTIAL. The request body that has it is read
 * once into lib/migrate.createJob / startRun and goes no further; job views are built by
 * lib/migrate.view, which has no field for it.
 */

const express = require('express');
const router = express.Router();
router.use(require('../lib/backstop-limiter'));
const fs = require('fs');
const { resolveWithin } = require('../lib/safe-path');
const multer = require('multer');
const { db } = require('../db/database');
const { denyReadOnly } = require('../lib/tenancy');
const { auditFromReq } = require('../lib/audit');
const migrate = require('../lib/migrate');
const vendors = require('../lib/migrate/vendors');

const UPLOAD_MAX = 2 * 1024 * 1024 * 1024;   // the same ceiling as a workspace import (routes/status.js)

function sendError(res, e) {
  if (e && e.name === 'MigrateError') return res.status(e.status || 400).json({ error: e.message, code: e.code });
  if (e && e.userMessage) return res.status(400).json({ error: e.userMessage });
  if (e && e.name === 'MigrateHttpError') return res.status(400).json({ error: e.message, code: e.code });
  console.error(`[migrate] unexpected failure (${(e && e.name) || 'error'})`);
  return res.status(500).json({ error: 'The import request failed' });
}
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => sendError(res, e));

function writeGate(req, res) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context. Switch to a workspace first.' }); return false; }
  if (denyReadOnly(req, res)) return false;
  return true;
}

router.get('/vendors', (req, res) => {
  res.json({ vendors: vendors.list(), can_import: !!req.workspaceId && !(req.workspaceRole === 'workspace_viewer' && !req.actingAs) });
});

router.get('/jobs', (req, res) => {
  if (!writeGate(req, res)) return;
  res.json({ jobs: migrate.list(req.workspaceId) });
});

router.post('/jobs', wrap(async (req, res) => {
  if (!writeGate(req, res)) return;
  const b = req.body || {};
  const adapter = vendors.get(String(b.vendor || ''));
  if (!adapter) return res.status(400).json({ error: 'Unknown source system.' });
  if (adapter.mode === 'file') return res.status(400).json({ error: 'This source is imported from a file. Upload it instead.' });
  const job = await migrate.createJob({ workspaceId: req.workspaceId, userId: req.user.id, vendor: adapter.id, cred: b.credentials || {} });
  auditFromReq(req, 'migration_started', { job_id: job.id, vendor: adapter.id });
  res.status(201).json(job);
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { const d = migrate.uploadDir(); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (req, file, cb) => cb(null, `${require('crypto').randomUUID()}.upload`),
  }),
  limits: { fileSize: UPLOAD_MAX, files: 1 },
});
function uploadOne(req, res, next) {
  // A viewer's or a workspace-less upload is refused BEFORE the bytes are written.
  if (!writeGate(req, res)) return;
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 2 GB.' : 'The upload failed.' });
    next();
  });
}

router.post('/jobs/upload', uploadOne, wrap(async (req, res) => {
  // multer named the file (a random UUID in uploadDir); resolved within that folder all the same.
  const discard = () => {
    const p = req.file && req.file.path ? resolveWithin(migrate.uploadDir(), req.file.path) : null;
    if (p) { try { fs.rmSync(p, { force: true }); } catch { /* gone */ } }
  };
  const adapter = vendors.get(String((req.body && req.body.vendor) || ''));
  if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
  if (!adapter || adapter.mode !== 'file') { discard(); return res.status(400).json({ error: 'This source does not import from a file.' }); }
  try {
    const name = String(req.file.originalname || '').normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, '').slice(0, 200);
    const job = await migrate.createJob({
      workspaceId: req.workspaceId, userId: req.user.id, vendor: adapter.id,
      cred: { upload_path: require('path').basename(req.file.path), label: name }, uploadName: name,
    });
    auditFromReq(req, 'migration_started', { job_id: job.id, vendor: adapter.id, file: true });
    res.status(201).json(job);
  } catch (e) { discard(); throw e; }
}));

router.get('/jobs/:id', (req, res) => {
  if (!writeGate(req, res)) return;
  const job = migrate.getIn(req.workspaceId, req.params.id);
  if (!job) return res.status(404).json({ error: 'Import not found.' });
  res.json(migrate.view(job));
});

router.post('/jobs/:id/run', wrap(async (req, res) => {
  if (!writeGate(req, res)) return;
  const b = req.body || {};
  const job = migrate.startRun({ workspaceId: req.workspaceId, id: req.params.id, options: b.options || null, userId: req.user.id, cred: b.credentials || null });
  res.json(job);
}));

router.post('/jobs/:id/cancel', wrap(async (req, res) => {
  if (!writeGate(req, res)) return;
  const job = migrate.cancel(req.workspaceId, req.params.id);
  auditFromReq(req, 'migration_cancelled', { job_id: req.params.id });
  res.json(job);
}));

/* ------------------------------------------------------------------ placeholders */

function placeholderView(p) {
  let groupIds = [];
  try { groupIds = JSON.parse(p.group_ids || '[]'); } catch { groupIds = []; }
  const groups = groupIds.length
    ? db.prepare(`SELECT id, name FROM device_groups WHERE workspace_id = ? AND id IN (${groupIds.map(() => '?').join(',')})`).all(p.workspace_id, ...groupIds)
    : [];
  const pl = p.playlist_id ? db.prepare('SELECT id, name FROM playlists WHERE id = ? AND workspace_id = ?').get(p.playlist_id, p.workspace_id) : null;
  const dev = p.device_id ? db.prepare('SELECT id, name FROM devices WHERE id = ? AND workspace_id = ?').get(p.device_id, p.workspace_id) : null;
  return {
    id: p.id, name: p.name, vendor: p.vendor, vendor_name: (vendors.get(p.vendor) || {}).name || p.vendor,
    groups, playlist: pl || null, note: p.note || null,
    device: dev || null, linked_at: p.linked_at || null, created_at: p.created_at,
  };
}

router.get('/placeholders', (req, res) => {
  if (!writeGate(req, res)) return;
  const rows = db.prepare('SELECT * FROM migration_screens WHERE workspace_id = ? ORDER BY (device_id IS NOT NULL), name COLLATE NOCASE LIMIT 2000').all(req.workspaceId);
  res.json({ placeholders: rows.map(placeholderView) });
});

router.post('/placeholders/:id/link', (req, res) => {
  if (!writeGate(req, res)) return;
  const p = db.prepare('SELECT * FROM migration_screens WHERE id = ? AND workspace_id = ?').get(String(req.params.id), req.workspaceId);
  if (!p) return res.status(404).json({ error: 'Placeholder not found.' });
  const deviceId = String((req.body && req.body.device_id) || '');
  // Only a screen already paired INTO THIS WORKSPACE can be linked: linking never claims anything.
  const dev = db.prepare('SELECT id FROM devices WHERE id = ? AND workspace_id = ?').get(deviceId, req.workspaceId);
  if (!dev) return res.status(404).json({ error: 'Screen not found in this workspace.' });
  db.prepare("UPDATE migration_screens SET device_id = ?, linked_at = strftime('%s','now') WHERE id = ?").run(dev.id, p.id);
  auditFromReq(req, 'migration_screen_linked', { placeholder_id: p.id, device_id: dev.id });
  res.json(placeholderView(db.prepare('SELECT * FROM migration_screens WHERE id = ?').get(p.id)));
});

router.delete('/placeholders/:id', (req, res) => {
  if (!writeGate(req, res)) return;
  const r = db.prepare('DELETE FROM migration_screens WHERE id = ? AND workspace_id = ?').run(String(req.params.id), req.workspaceId);
  if (!r.changes) return res.status(404).json({ error: 'Placeholder not found.' });
  res.json({ success: true });
});

module.exports = router;
