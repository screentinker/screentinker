const express = require('express');
const router = express.Router();
const { getActivity, pruneActivityLog } = require('../services/activity');

// Get activity log
router.get('/', (req, res) => {
  const { device_id, limit, offset } = req.query;
  const isAdmin = req.user.role === 'superadmin';

  const activity = getActivity({
    userId: isAdmin ? null : req.user.id,
    deviceId: device_id || null,
    limit: Math.min(parseInt(limit) || 50, 200),
    offset: parseInt(offset) || 0,
  });

  res.json(activity);
});

// Prune old logs (admin only)
router.delete('/prune', (req, res) => {
  if (!['admin','superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
  pruneActivityLog();
  res.json({ success: true });
});

module.exports = router;
