'use strict';

/*
 * Player rollouts (lib/ota-rollout.js) for platform admins: Platform → Player rollouts.
 * JWT only, platform admin only — a rollout is the whole instance's fleet, not a workspace's.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { requirePlatformAdmin } = require('../middleware/auth');
const rollout = require('../lib/ota-rollout');

router.use(requirePlatformAdmin);

router.get('/', (req, res) => {
  res.json({ enabled: rollout.enabled(), waves: rollout.WAVES, rollouts: rollout.list(db) });
});

router.post('/:family/:version/:action', (req, res) => {
  const { family, version, action } = req.params;
  if (!Object.keys(rollout.FAMILIES).includes(family)) return res.status(400).json({ error: 'Unknown platform' });
  const r = rollout.act(db, family, version, action, { by: req.user.email || req.user.id });
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  try { require('../services/activity').logActivity(req.user.id, `ota.rollout_${action}`, `${family} ${version}`); } catch (_) { /* */ }
  res.json({ success: true, rollouts: rollout.list(db) });
});

module.exports = router;
