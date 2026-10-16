const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { getActivity, pruneActivityLog } = require('../services/activity');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');

// Get activity log
router.get('/', (req, res) => {
  const { device_id, limit, offset } = req.query;
  const isAdmin = PLATFORM_ROLES.includes(req.user.role);

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
  if (!ELEVATED_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
  pruneActivityLog();
  res.json({ success: true });
});

module.exports = router;
