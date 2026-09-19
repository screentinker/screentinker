'use strict';

/*
 * Scale-out: the ONE place a replica refuses to be a second writer (docs/scale-out-design.md §5.2).
 *
 * Every request whose resolved workspace is a COPY (`workspaces.origin_node_id` set) and whose
 * method can change state is intercepted in the tenancy resolver and either forwarded to the
 * operator-typed PRIMARY_URL or refused. Nothing is applied locally. GET/HEAD pass through and are
 * served from the copy by the unchanged route handlers — that is the whole point of a replica.
 *
 * ⚠️ A PIPE, NOT A PEER. The replica forwards the user's own request — bytes, method, path, and
 * the user's Authorization header — and the primary authenticates the USER's token and enforces
 * every rule it enforces today. The replica adds no authority and removes none. It is not a mesh
 * write (I2) because the replica asserts nothing; the primary would answer the same request from
 * the same browser identically.
 *
 * ⚠️ WHY PROXY AND NOT 307. A SPA sends Authorization: Bearer; browsers drop that header on a
 * cross-origin redirect, so a 307 to another origin turns every write into a 401. Proxying works
 * without a shared origin. 307 stays available (PRIMARY_REDIRECT) for the one-load-balancer case.
 *
 * ⚠️ NO LOOPS. If PRIMARY_URL points at another replica, that node would forward again. The hop
 * header is set here and refused on arrival, so a mis-typed URL answers a clear error rather than
 * bouncing between two boxes until something times out.
 *
 * Replica writes assume Bearer. No cookie session is rewritten or forwarded: the dashboard is
 * JWT-only, and a replica that minted or relayed cookies would be on its way to being an identity
 * provider, which it must not be (§5.3).
 */

const http = require('node:http');
const https = require('node:https');

const HOP_HEADER = 'x-st-replica-proxy';
const TIMEOUT_MS = 10_000;
/** Same ceiling as the global JSON body parser (server.js `express.json({ limit: '12mb' })`). */
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

/**
 * GETs that write. They are not workspace-scoped and are not reached through resolveTenancy, so
 * the interceptor never sees them; they are named here so the enumerate-mutating-routes test can
 * assert nothing on this list is ever mounted as a plain "read" on a replica-served path.
 */
const WRITING_GETS = Object.freeze([
  '/api/auth/verify-email',   // redeems a verification token
  '/api/update/check',        // stamps devices.ota_channel_served (players are on the primary in C1)
]);

/**
 * SQL fragment selecting rows that belong to THIS node: a row whose workspace is not a copy, or a
 * row filed under no workspace at all (the unpaired pool). `alias` is the table or alias that
 * carries `workspace_id`. Used by every background writer so a replica with copied workspaces runs
 * its sweeps for its OWN workspaces only (docs/scale-out-design.md §5.5).
 */
function LOCAL_ROWS_SQL(alias) {
  return `(${alias}.workspace_id IS NULL OR ${alias}.workspace_id NOT IN ` +
         `(SELECT id FROM workspaces WHERE origin_node_id IS NOT NULL))`;
}

/**
 * Same idea for user-driven sweeps (trial, activation nudge): a user who belongs to ANY copied
 * workspace is the primary's user. The primary keeps its own stamps; a replica that emailed them
 * would double every lifecycle mail. `alias` carries `id`.
 */
function LOCAL_USERS_SQL(alias) {
  return `NOT EXISTS (SELECT 1 FROM workspace_members lwm JOIN workspaces lw ON lw.id = lwm.workspace_id ` +
         `WHERE lwm.user_id = ${alias}.id AND lw.origin_node_id IS NOT NULL)`;
}

/**
 * Does this upload filename belong to a content row of a COPIED workspace? Used on the
 * /uploads/content miss path and by the content file/thumbnail routes: the bytes live on the
 * primary and are fetched through (no cache in C1). The name must match a copied row exactly, so
 * the public static route cannot be turned into an open proxy for arbitrary paths on the primary.
 */
function isCopiedUploadName(db, name) {
  if (!name || /[\/\\]/.test(name)) return false;
  try {
    const rows = db.prepare(`SELECT c.filepath, c.thumbnail_path FROM content c
                              JOIN workspaces w ON w.id = c.workspace_id
                             WHERE w.origin_node_id IS NOT NULL
                               AND (c.filepath LIKE '%' || ? OR c.thumbnail_path LIKE '%' || ?)`).all(name, name);
    const base = (p) => String(p || '').split(/[\/\\]/).pop();
    return rows.some((r) => base(r.filepath) === name || base(r.thumbnail_path) === name);
  } catch (e) { return false; }
}

function isCopiedWorkspace(workspace) {
  return !!(workspace && workspace.origin_node_id);
}

function isMutating(req) {
  const m = String(req.method || 'GET').toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

/** True when this request must not be applied locally. */
function shouldIntercept(req, workspace) {
  return isCopiedWorkspace(workspace) && isMutating(req);
}

function refuse(res, status, code, message, extra) {
  res.status(status).json({ error: message, code, ...(extra || {}) });
}

/**
 * Forward `req` to the primary and relay the answer verbatim (status, body, safe headers).
 * Resolves when the response has been sent. Never throws into the caller.
 */
function proxyToPrimary(req, res, config, { timeoutMs = TIMEOUT_MS, transport } = {}) {
  const base = config.primaryUrl;
  if (!base) {
    return refuse(res, 409, 'read_only_replica',
      'This workspace is a read-only copy; the primary server is not configured on this node (PRIMARY_URL).');
  }
  if (req.headers[HOP_HEADER]) {
    // The request already crossed a replica: PRIMARY_URL on THAT node pointed here. Say so.
    return refuse(res, 508, 'proxy_loop',
      'PRIMARY_URL points at another replica, not at the primary. Fix the address on the forwarding node.');
  }
  if (config.primaryRedirect) {
    res.set('Location', base + req.originalUrl);
    return res.status(307).json({ code: 'primary_redirect', primary_url: base });
  }

  let target;
  try { target = new URL(base + req.originalUrl); } catch (e) {
    return refuse(res, 409, 'read_only_replica', 'PRIMARY_URL is not a valid URL.');
  }

  // Outbound headers: the user's, minus hop-by-hop, with Host recomputed for the primary.
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === 'cookie') continue; // Bearer only; see the header comment
    headers[k] = v;
  }
  headers[HOP_HEADER] = '1';
  headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.ip].filter(Boolean).join(', ');

  // The body: express.json has usually consumed and parsed it. Re-serialise what it parsed;
  // stream anything it did not touch (multipart uploads reach multer per-route, so at this point
  // the stream is intact).
  let body = null;
  const ctype = String(req.headers['content-type'] || '');
  const parsed = req.body && typeof req.body === 'object' && /application\/json/i.test(ctype);
  if (parsed) {
    body = Buffer.from(JSON.stringify(req.body));
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(body.length);
  }
  const declared = Number(req.headers['content-length'] || 0);
  if ((body && body.length > MAX_BODY_BYTES) || declared > MAX_BODY_BYTES) {
    return refuse(res, 413, 'payload_too_large', 'Request body exceeds the replica proxy limit.');
  }

  const lib = transport || (target.protocol === 'https:' ? https : http);
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { settled = true; resolve(); };
    const up = lib.request(target, { method: req.method, headers, timeout: timeoutMs }, (upRes) => {
      // ⚠️ Upstream 401/403/4xx pass through untouched. Turning the primary's refusal into a 503
      // would tell the operator the primary is down when it said "no".
      res.status(upRes.statusCode || 502);
      for (const [k, v] of Object.entries(upRes.headers)) {
        const key = k.toLowerCase();
        if (HOP_BY_HOP.has(key) || key === 'set-cookie') continue;
        res.set(k, v);
      }
      res.set('x-st-served-by', 'primary');
      upRes.on('end', done);
      upRes.on('error', done);
      upRes.pipe(res);
    });
    up.on('timeout', () => { up.destroy(new Error('timeout')); });
    up.on('error', (err) => {
      if (settled || res.headersSent) return done();
      refuse(res, 503, 'primary_unreachable',
        'The primary server did not answer, so this change could not be made. Reads still work from the copy on this server.',
        { retry_after: 30, detail: err && err.message });
      done();
    });
    if (body) up.end(body);
    else if (parsed === false && isMutating(req) && !req.readableEnded) req.pipe(up);
    else up.end();
  });
}

module.exports = {
  HOP_HEADER, TIMEOUT_MS, MAX_BODY_BYTES, WRITING_GETS, LOCAL_ROWS_SQL, LOCAL_USERS_SQL,
  isCopiedWorkspace, isCopiedUploadName, isMutating, shouldIntercept, proxyToPrimary,
};
