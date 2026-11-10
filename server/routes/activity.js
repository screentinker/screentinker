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

  /*
   * Who reads what. The instance operator: everything. Whoever ADMINISTERS the workspace this
   * request is in (its workspace_admin, or an organization admin / staff acting in it): every row
   * of that workspace, whoever made it, which is what "who changed that?" needs, and nothing from
   * any other workspace. Everyone else: their own rows. The role is the live one resolved for this
   * request, so a demotion narrows the view at once.
   */
  const runsWorkspace = !isAdmin && !!req.workspaceId
    && (req.workspaceRole === 'workspace_admin' || req.actingAs === true);

  const activity = getActivity({
    userId: (isAdmin || runsWorkspace) ? null : req.user.id,
    workspaceId: runsWorkspace ? req.workspaceId : null,
    alsoUserId: runsWorkspace ? req.user.id : null,   // never fewer rows than before for the admin themself
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
