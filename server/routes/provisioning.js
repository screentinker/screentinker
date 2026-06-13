const express = require('express');
const router = express.Router();

// #90: the bare POST /api/provision was a vestigial SECOND pairing endpoint. It paired a
// device by pairing code but - unlike POST /api/provision/pair (server.js) - did NOT
// assign the device to a workspace, did NOT enforce checkDeviceLimit, and did NOT emit
// device:paired / dashboard:device-added. A silently-diverging duplicate of /pair that
// no client ever called (verified). Consolidated to /pair (the single, fully-protected
// pairing endpoint); this path now returns 410 Gone and points callers at the right one.
//
// The mount stays in the JWT-only partition (config/api-surface.js), so a Bearer st_
// token still gets 401 from requireAuth before ever reaching this handler.
router.post('/', (req, res) => {
  res.status(410).json({ error: 'This endpoint has been removed. Pair a device with POST /api/provision/pair.' });
});

module.exports = router;
