'use strict';

/*
 * Per-route rate limits for the embedded diagnostics and firmware routes (#2, #3).
 *
 * ⚠️ express-rate-limit, NOT server.js's own rateLimit(): CodeQL's js/missing-rate-limiting only
 * recognises known limiter packages, and server.js's helper is not importable from a router anyway.
 * These are additive to anything mounted app-wide.
 *
 * Keyed per client IP (the default key generator, which respects app 'trust proxy' and buckets IPv6
 * by /56). Ceilings are sized for a whole site of panels behind ONE NAT address, not one panel:
 *
 *  - firmware: unauthenticated, and every hit reads (and, for /version, hashes) the whole binary.
 *    An OTA wave is one /version + one download per panel, so 120 per 15 min still lets ~60 panels
 *    behind one address update in a single window, and stops a loop from streaming the file forever.
 *  - device logs: device-token authenticated; a panel uploads when asked (upload_logs) or on a fault,
 *    a handful of times per hour. 60/min per address is far above any real site.
 *  - dashboard reads: GET /api/devices/:id/diagnostic-logs only (up to 20 stored uploads of 256 kB
 *    each). 300/min per address leaves room for an office of dashboards. ⚠️ NOT on GET
 *    /api/devices/:id itself: that is the core device read, bounded by the global backstop
 *    (lib/backstop-limiter.js) like every other dashboard read.
 *
 * Every 429 is JSON ({ error }) so panels and the dashboard can parse it like any other error.
 */

const { rateLimit } = require('express-rate-limit');

function limiter(windowMs, limit, what) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: `Too many ${what} requests, slow down and retry later.` },
  });
}

const firmwareLimiter = limiter(15 * 60 * 1000, 120, 'firmware');
const deviceLogsLimiter = limiter(60 * 1000, 60, 'diagnostic log');
const dashboardDeviceReadLimiter = limiter(60 * 1000, 300, 'device');

module.exports = { firmwareLimiter, deviceLogsLimiter, dashboardDeviceReadLimiter };
