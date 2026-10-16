const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));

// Teams API temporarily disabled while the feature is redesigned as a
// user-grouping primitive within the new Workspaces architecture. The
// original Teams data model had no workspace-awareness and was effectively
// non-functional after Phase 2.2 (every resource route migrated away from
// team_id), but the UI remained reachable and let users accumulate orphan
// data while believing they were configuring access control.
//
// All inbound methods now return 503 Service Unavailable with a message
// pointing at the in-progress redesign. The teams / team_members /
// team_invites tables are preserved indefinitely for forward migration
// to the future Teams design - do NOT drop them.
//
// When the new design lands, this router file is the replacement point:
// drop in the new handlers and remove the catch-all below.
router.all('/{*splat}', (req, res) => {
  res.status(503).json({
    error: 'Teams temporarily unavailable',
    message: 'The Teams feature is being redesigned to work within the new Workspaces system. It will return in a future release. Existing team data is preserved and will be migrated forward.',
    reason: 'feature_redesign_in_progress',
  });
});

module.exports = router;
