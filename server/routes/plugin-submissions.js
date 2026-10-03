'use strict';

/*
 * Workspace-editor plugin submissions. Same inspect-and-wait path as the admin
 * upload, without the ability to approve. 404 when plugins are off (P1).
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const config = require('../config');
const { db } = require('../db/database');
const { canWrite } = require('../lib/permissions');
const { logActivity, getClientIp } = require('../services/activity');
const submissions = require('../lib/plugins/submissions');
const { MAX_ARCHIVE_BYTES } = require('../lib/plugins/inbox');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ARCHIVE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    if (name.endsWith('.zip')) cb(null, true);
    else cb(new Error('Plugin packages must be a .zip'));
  },
});

function pluginsOff(res) {
  return res.status(404).json({ error: 'Not found' });
}

router.get('/', (req, res) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  if (!canWrite(req)) return res.status(403).json({ error: 'Workspace editor or admin required' });
  const mine = submissions.list(db, { submittedBy: req.user && req.user.id });
  res.json({ submissions: mine });
});

router.post('/', (req, res, next) => {
  if (!config.pluginsEnabled) return pluginsOff(res);
  if (!canWrite(req)) return res.status(403).json({ error: 'Workspace editor or admin required' });
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
    res.status(e.status || 400).json({ error: e.message || 'Upload failed' });
  }
});

module.exports = router;
