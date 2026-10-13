'use strict';
/*
 * THE live backstop limiter: one express-rate-limit instance, one in-memory store, for the whole
 * process. Keys, numbers and what is never counted are in lib/backstop-limit.js.
 *
 * ⚠️ WHY IT IS ALSO MOUNTED INSIDE THE ROUTERS. server.js mounts it app-wide, ahead of every route,
 * and that alone bounds every request at runtime. But most routers are mounted in a loop over
 * config/api-surface.js (`require(r.mod)`), and static analysis cannot see through a computed
 * require, so to it those routers look unguarded. Each such router therefore starts with
 * `router.use(backstop)` too. It is the SAME instance, and its skip() refuses a request it has
 * already counted, so the second sighting is free: no request is ever counted twice, and a router
 * mounted somewhere the app-wide one does not reach is still bounded.
 */
const expressRateLimit = require('express-rate-limit');
const config = require('../config');
const { backstopOptions } = require('./backstop-limit');
const { getClientIp } = require('../services/activity');

const isMcpPath = (p) => p === '/mcp' || p.startsWith('/mcp/');

module.exports = expressRateLimit(backstopOptions({
  identityMax: config.rateLimitBackstop,
  anonMax: config.rateLimitBackstopAnon,
  getClientIp,
  onReject: (req, res, retryAfter, info) => {
    // Same evidence trail as the hand-written limiter in server.js: a 429 otherwise leaves no
    // trace. The bucket key is already an HMAC, so it is safe to count as the identifier.
    try {
      const ip = getClientIp(req);
      const t = require('./limiter-telemetry').recordRejection({ endpoint: 'backstop', ip, identifier: info.key });
      require('./log-coalescer').record(
        `limit-reject:backstop:${ip}`,
        `[limit] 429 backstop ip=${ip} rejections=${t.rejections} distinct_identities=${t.distinctIdentifiers}` +
        (t.distinctIdentifiers >= 3 ? ' (several identities behind one IP)' : ''),
        { warn: true },
      );
    } catch (_) { /* telemetry must never break the limiter */ }
    res.set('Retry-After', String(retryAfter));
    // /mcp clients only understand JSON-RPC errors; everyone else gets the existing limiter's body.
    if (isMcpPath(String(req.originalUrl || req.url || '').split('?')[0])) {
      return require('../routes/mcp').rateLimited(req, res, retryAfter);
    }
    return res.status(429).json({ error: 'Too many requests, try again later' });
  },
}));
