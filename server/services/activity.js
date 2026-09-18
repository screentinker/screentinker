const { db } = require('../db/database');
const proxyaddr = require('proxy-addr');
const { cloudflareIps } = require('../config/cloudflareIps');

// Peer gate for CF-Connecting-IP: ONLY Cloudflare's published edge ranges, deliberately
// NOT the loopback/linklocal/uniquelocal entries that `trust proxy` also carries.
//
// Those entries are right for X-Forwarded-For, because a local reverse proxy APPENDS to
// XFF and Express then walks the chain right-to-left, so a client-supplied value cannot
// end up as the resolved address. CF-Connecting-IP has no chain: nginx passes through
// whatever single value the client sent. Treating a loopback peer as evidence that the
// request came through Cloudflare therefore means trusting the client.
//
// This is also the portable behaviour. Most self-hosted installs do NOT sit behind
// Cloudflare; for them this header is now simply ignored and attribution comes from
// req.ip via whatever `trust proxy` the operator configured. An install that DOES front
// with Cloudflare is unaffected: its peer really is a CF edge.
const isCloudflarePeer = proxyaddr.compile(cloudflareIps);

// Resolve the real client IP. This value keys every per-IP control (the auth/pairing rate
// limiters, lib/pair-lockout) and the ip_address column in activity_log, so a caller must
// never be able to choose it.
function getClientIp(req) {
  if (!req) return null;
  const cf = req.headers && req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim().length > 0) {
    const peer = req.socket && req.socket.remoteAddress;
    // Believe it only when the request demonstrably arrived through Cloudflare.
    if (peer && isCloudflarePeer(peer, 0)) return cf.trim();
  }
  return req.ip || null;
}

// Phase 2.2 writer-leak fix: activity_log rows now stamp workspace_id so
// tenant-scoped queries don't miss new events. Callers pass the workspace
// when known; the middleware below sources it from resolveTenancy. When
// workspaceId is null but a device_id is provided, fall back to the device's
// workspace - matches the backfill rule for consistency.
function logActivity(userId, action, details = null, deviceId = null, ipAddress = null, workspaceId = null, statusCode = null) {
  try {
    // A break-glass identity ('recovery-<jti>') is synthetic and has no users row, so
    // activity_log.user_id's foreign key rejects it and the row is lost — which is exactly
    // why a recovery session used to leave no trail whatsoever. Record it with a NULL
    // user_id and the identity in `details`, so the action IS audited.
    if (typeof userId === 'string' && userId.startsWith('recovery-')) {
      details = `[break-glass ${userId}] ${details || ''}`.trim();
      userId = null;
    }
    // Same for a support session ('support:<jti>', lib/support-access): everything a support
    // engineer does on a customer's instance must land in the customer's audit log.
    if (typeof userId === 'string' && userId.startsWith('support:')) {
      details = `[support ${userId}] ${details || ''}`.trim();
      userId = null;
    }
    let ws = workspaceId || null;
    if (!ws && deviceId) {
      const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
      ws = d?.workspace_id || null;
    }
    db.prepare(
      'INSERT INTO activity_log (user_id, device_id, action, details, ip_address, workspace_id, status_code) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(userId || null, deviceId || null, action, details || null, ipAddress || null, ws,
          Number.isInteger(statusCode) ? statusCode : null);
  } catch (e) {
    // LOUD on purpose. A silently-dropped audit row is how a break-glass session went
    // unrecorded for months: the insert failed a foreign key, this catch swallowed it, and
    // nothing anywhere reported that the audit trail had a hole in it. If this fires, the
    // audit log is INCOMPLETE and that is worth someone's attention.
    console.error(`[AUDIT-DROP] activity_log insert FAILED — the audit trail is incomplete. action=${action} user=${userId || 'null'} device=${deviceId || 'null'}: ${e.message}`);
    auditDrops++;
  }
}

// Count of audit rows we failed to persist, so the gap is observable rather than only
// greppable in stdout.
let auditDrops = 0;
function auditDropCount() { return auditDrops; }

function getActivity(options = {}) {
  const { userId, deviceId, workspaceId, action, limit = 50, offset = 0 } = options;
  let sql = `SELECT al.*, u.name as user_name, u.email as user_email
    FROM activity_log al LEFT JOIN users u ON al.user_id = u.id WHERE 1=1`;
  const params = [];

  if (userId) { sql += ' AND al.user_id = ?'; params.push(userId); }
  if (deviceId) { sql += ' AND al.device_id = ?'; params.push(deviceId); }
  /*
   * ⚠️ WORKSPACE FILTERING, which this could not do — rows have carried workspace_id since the
   * Phase 2.2 writer-leak fix and nothing could query on it. On a multi-tenant install that made
   * the audit trail readable only in full or not at all: an operator who administers one workspace
   * could not ask what happened in it, and any caller wanting to show them a scoped view had to
   * fetch everything and filter in the process, which is the shape that leaks the moment somebody
   * adds a count or a total.
   */
  if (workspaceId) { sql += ' AND al.workspace_id = ?'; params.push(workspaceId); }
  if (action) { sql += ' AND al.action = ?'; params.push(action); }

  sql += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

/*
 * Prune old activity logs.
 *
 * ⚠️ This existed and was NEVER CALLED — not by a route, not by a scheduler, not by anything. So
 * activity_log grew for the life of the install while a comment described a 90-day retention that
 * was never applied. It is scheduled now (services/scheduler.js); see the note there about why it
 * does not run at boot.
 *
 * The horizon is a parameter rather than a literal so a caller can be explicit, but the default is
 * unchanged — silently shortening anyone's retention on upgrade would be its own kind of bug.
 */
function pruneActivityLog(days = 90) {
  const keep = Number.isFinite(days) && days > 0 ? Math.floor(days) : 90;
  return db.prepare(
    "DELETE FROM activity_log WHERE created_at < strftime('%s','now') - (? * 86400)",
  ).run(keep).changes;
}

const AUDITED_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/*
 * Should this finished request become an audit row?
 *
 * Successes: yes, unchanged — that is the audit trail.
 *
 * The rule is ownership, and it applies to successes and failures alike: a row is written when the
 * request belongs to an authenticated user or a known device, or when it is a 5xx.
 *
 * ⚠️ ANONYMOUS REQUESTS ARE NOT AUDITED, AND THAT IS LOAD-BEARING. The public surface is scanned
 * constantly (≈1,000 probes/day for /wp-login.php, /.env and friends) and carries genuinely
 * anonymous high-frequency endpoints — widget telemetry reports once per widget per device,
 * forever. Auditing those buries the operator's own history in noise and hands a stranger unlimited
 * writes to this table. test/widget-telemetry-bounded.test.js pins exactly this.
 *
 * ⚠️ THIS USED TO BE ENFORCED BY ACCIDENT. The old middleware wrapped res.json, so an endpoint
 * could opt out of auditing by replying with res.end() instead — and routes/widgets.js telemetry
 * did precisely that, with a comment explaining the trick. Hooking 'finish' removed that escape
 * hatch, so the property now has to be stated rather than inherited from how a handler replies.
 *
 * ⚠️ BEHAVIOUR CHANGE: `POST /api/telemetry/report` (657 rows on prod) is anonymous and therefore
 * no longer audited. That is the same principle applied consistently, not an oversight.
 */
function shouldAudit(req, res) {
  if (!AUDITED_METHODS.includes(req.method)) return false;
  // A 5xx is OUR fault. Keep it whoever triggered it — that is the row worth having.
  if (res.statusCode >= 500) return true;
  // Everything else must belong to someone. An anonymous caller cannot write here.
  return !!(req.user?.id || req.params?.deviceId || req.body?.device_id);
}

/*
 * Express middleware to auto-log API mutations.
 *
 * ⚠️ HOOKS res.on('finish'), NOT res.json.
 *
 * Wrapping res.json only saw responses that happened to be sent AS JSON. A route ending in
 * res.send(), res.sendStatus(), res.end() or an unhandled throw produced no row at all, so the
 * audit trail silently depended on how each handler chose to reply. 'finish' fires once per
 * response however it was sent, and by then res.statusCode is final — which is the whole point,
 * since the old wrapper read the status BEFORE the body was written.
 *
 * Everything it reads (req.user, req.params, req.body, req.route) is still populated at finish;
 * the response object is done, the request object is not.
 */
function activityLogger(req, res, next) {
  res.on('finish', () => {
    try {
      if (!shouldAudit(req, res)) return;
      const action = `${req.method} ${req.baseUrl || ''}${req.route?.path || req.path}`;
      const userId = req.user?.id;
      const deviceId = req.params?.id || req.params?.deviceId || req.body?.device_id;
      const details = summarizeAction(req);
      logActivity(userId, action, details, deviceId, getClientIp(req), req.workspaceId || null, res.statusCode);
    } catch (e) {
      // A finish handler runs outside the request's error path: throwing here would be an
      // unhandled 'error' on the response, so contain it. logActivity already shouts on its own.
      console.error(`[AUDIT-DROP] activityLogger finish handler failed: ${e.message}`);
    }
  });
  next();
}

function summarizeAction(req) {
  const parts = [];
  if (req.body?.name) parts.push(`name: ${req.body.name}`);
  if (req.body?.filename) parts.push(`file: ${req.body.filename}`);
  if (req.body?.pairing_code) parts.push('device paired');
  if (req.body?.plan_id) parts.push(`plan: ${req.body.plan_id}`);
  if (req.file?.originalname) parts.push(`uploaded: ${req.file.originalname}`);
  return parts.join(', ') || null;
}

module.exports = { logActivity, getActivity, pruneActivityLog, activityLogger, getClientIp, auditDropCount };
