'use strict';

/*
 * POST /mcp — the Model Context Protocol endpoint.
 *
 * ⚠️ EVERY TOOL RUNS AS AN HTTP CALL TO OUR OWN PUBLIC API, over loopback, carrying the caller's own
 * token. That is the design, not an implementation shortcut. It means bearerAuth, resolveTenancy,
 * tokenScopeGate, the replica proxy and the rate limiters all apply to an agent exactly as they apply
 * to curl — and config/api-surface.js stays the single description of what a token can reach. The
 * alternative, calling the database or the route modules directly, would be a second front door with
 * its own copy of the permission model, which is how the copies drift and one of them gets it wrong.
 *
 * The cost is one loopback request per tool call. That is nothing next to the model round-trip that
 * asked for it.
 */

const express = require('express');
const router = express.Router();
const config = require('../config');
const { db } = require('../db/database');
const crypto = require('crypto');
const { wwwAuthenticate } = require('../middleware/auth');
const tools = require('../lib/mcp/tools');
const protocol = require('../lib/mcp/protocol');
const { getClientIp } = require('../services/activity');
const forwardedClientIp = require('../lib/forwarded-client-ip');

const TOKEN_PREFIX = 'st_';
const CALL_TIMEOUT_MS = 20_000;

/*
 * Resolve the bearer token to its scope, WITHOUT granting anything.
 *
 * This is a lookup, not an authentication: the actual authorisation happens when the tool's request
 * reaches the API through the normal front door. All this decides is which tools to show, and
 * refusing early gives a client a clean 401 at `initialize` rather than a catalogue it cannot use.
 */
function scopeOf(authorization) {
  const raw = String(authorization || '').startsWith('Bearer ')
    ? String(authorization).slice(7).trim() : '';
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  try {
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const row = db.prepare('SELECT scope, revoked_at FROM api_tokens WHERE token_hash = ?').get(hash);
    if (!row || row.revoked_at) return null;
    return row.scope || 'read';
  } catch (e) {
    return null;
  }
}

function selfOrigin() {
  // Loopback on purpose: never APP_URL. A tool call must reach THIS process, not whatever a proxy or
  // a CDN in front of the public hostname would answer with.
  const port = config.port || 3001;
  return `http://127.0.0.1:${port}`;
}

/* Run one tool: map it to an API request, make the request as the caller, summarise the answer.
 * `clientIp` is the address the MCP request came from, forwarded so the API attributes and rate
 * limits the call to it rather than to 127.0.0.1 (lib/forwarded-client-ip.js). */
async function callTool(name, args, authorization, scope, clientIp) {
  const tool = tools.byName(name);
  if (!tool) return { isError: true, text: `Unknown tool: ${name}` };

  /*
   * ⚠️ CHECKED HERE TOO, though the API is the real gate.
   *
   * A tool missing from the manifest is not a tool that cannot be CALLED — a client may have a stale
   * list, and a model may simply guess a plausible name. The API refuses it correctly (tokenScopeGate
   * returns 403, verified), so this is not what makes it safe; it makes the refusal cheap, keeps the
   * answer in the same vocabulary the catalogue uses, and means this endpoint is not the one place
   * where a downstream guard is the ONLY thing standing between a read token and a write.
   */
  const have = tools.SCOPE_RANK[scope] || 0;
  if ((tools.SCOPE_RANK[tool.scope] || 99) > have) {
    return {
      isError: true,
      text: `The tool "${name}" needs a token with '${tool.scope}' scope; this token has '${scope}'. `
        + 'Ask the account owner for a token with a wider scope — retrying will not help.',
    };
  }

  /*
   * The tool's own schema, enforced before anything is sent. A failure here is a malformed CALL, so
   * it is a JSON-RPC invalid-params error rather than a tool result (see protocol.js tools/call).
   */
  const invalid = tools.validate(tool, args === undefined ? {} : args);
  if (invalid) return { invalidParams: true, text: `Invalid arguments for ${name}: ${invalid}` };

  let req;
  try {
    req = tools.toRequest(tool, args || {});
  } catch (e) {
    return { isError: true, text: `Bad arguments: ${e.message}` };
  }

  const url = new URL(selfOrigin() + req.path);
  for (const [k, v] of Object.entries(req.query || {})) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        // So a handler (and an operator reading logs) can tell an agent from a script.
        'User-Agent': 'ScreenTinker-MCP/1.0',
        // Signed over (ip, now, path): only this process can mint it, and only for this call.
        ...(clientIp ? { [forwardedClientIp.HEADER]: forwardedClientIp.sign(clientIp, url.pathname) } : {}),
      },
      body: req.body ? JSON.stringify(req.body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let payload;
    try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = text; }

    if (!res.ok) {
      /*
       * ⚠️ A 401 HERE USUALLY MEANS "TOKENS CANNOT REACH THIS AT ALL", not "your token is wrong" —
       * the JWT-only routers refuse every `st_` token by design. Saying so stops an agent retrying a
       * wall, which is the single most expensive thing a confused agent does.
       */
      const detail = payload && payload.error ? payload.error : (typeof payload === 'string' ? payload.slice(0, 300) : res.statusText);
      /*
       * ⚠️ The scope hint only when the refusal IS about scope. A 403 for another workspace's
       * display, or a head office lock, is not fixed by a wider token, and saying it is sends the
       * user off to mint one. The scope gates' messages all name the scope (middleware/apiToken.js).
       */
      const hint = res.status === 401
        ? ' (this token cannot reach that endpoint — it is not a credential problem, do not retry)'
        : res.status === 403 && /\bscope\b/i.test(String(detail)) ? ' (the token’s scope does not permit this)' : '';
      return { isError: true, text: `${req.method} ${req.path} failed: ${res.status} ${detail}${hint}` };
    }

    /*
     * Shape, then redact — in that order, and never one without the other. The shape decides what is
     * WORTH sending a model; the redaction decides what may never be sent at all, and it runs on
     * every tool including the ones with no shape. See tools.redact.
     */
    const shaped = tool.shape ? tool.shape(payload, args || {}) : payload;
    return { isError: false, text: JSON.stringify(tools.redact(shaped), null, 2) };
  } catch (e) {
    const why = e.name === 'AbortError' ? `timed out after ${CALL_TIMEOUT_MS}ms` : e.message;
    return { isError: true, text: `${req.method} ${req.path} failed: ${why}` };
  } finally {
    clearTimeout(timer);
  }
}

const INSTRUCTIONS = `ScreenTinker manages digital signage: screens ("displays"), the media library,
playlists and schedules.

Typical flow to change what a screen shows: find the display with list_displays, add or find media
with list_content / add_youtube_video, build a playlist with create_playlist and add_to_playlist,
then assign_playlist_to_display.

⚠️ Playlist edits are a DRAFT. Screens keep playing the last published version until publish_playlist
is called, so a change that is not published has changed nothing anybody can see.`;

/*
 * The body parser AND its errors, both here. server.js skips its global 12 MB parser for /mcp, so
 * this limit is the real one, and a body that does not parse is answered the way an MCP client
 * reads an answer: JSON-RPC -32700, not Express's HTML error page (which, in development, carried a
 * stack trace).
 */
const jsonParser = express.json({ limit: '1mb' });
function parseBody(req, res, next) {
  jsonParser(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
      return res.status(413).json(protocol.rpcError(null, protocol.ERR.INVALID_REQUEST, 'Request body is larger than 1 MB.'));
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json(protocol.rpcError(null, protocol.ERR.PARSE, 'Parse error: the request body is not valid JSON.'));
    }
    return res.status(err.status || 400).json(protocol.rpcError(null, protocol.ERR.INVALID_REQUEST, 'The request body could not be read.'));
  });
}

/*
 * The 429 from the /mcp rate limiter (server.js), in the shape an MCP client understands. The
 * limiter has already set Retry-After. The body has not been parsed yet — the limiter runs first,
 * which is the point of it — so there is no id to echo.
 */
function rateLimited(_req, res, retryAfter) {
  return res.status(429).json(protocol.rpcError(null, protocol.ERR.RATE_LIMITED,
    `Rate limit exceeded. Retry after ${retryAfter} seconds.`, { retryAfter }));
}

/*
 * The protocol version to put in the response header: the one `initialize` negotiated when this
 * request carries one, else the version the client says it is using (when we speak it), else ours.
 * Always answering LATEST told a client on an older version we had switched it.
 */
function responseVersion(req, messages) {
  const init = messages.find((m) => m && m.method === 'initialize');
  if (init) return protocol.negotiateVersion(init.params && init.params.protocolVersion);
  const asked = req.headers['mcp-protocol-version'];
  return protocol.PROTOCOL_VERSIONS.includes(asked) ? asked : protocol.LATEST;
}

router.post('/', parseBody, async (req, res) => {
  const scope = scopeOf(req.headers.authorization);
  if (!scope) {
    // WWW-Authenticate so a client knows what to present rather than guessing — and, per RFC 9728
    // §5.1, WHERE TO READ ABOUT IT. This is the surface an agent reaches first, so the pointer
    // matters more here than anywhere else: without it the only next move is blind probing.
    res.set('WWW-Authenticate', `${wwwAuthenticate(req)}, error="invalid_token"`);
    return res.status(401).json(protocol.rpcError(
      req.body && req.body.id, protocol.ERR.INVALID_REQUEST,
      'A ScreenTinker API token is required. Create one in the dashboard under Settings -> API tokens and send it as: Authorization: Bearer st_...'
    ));
  }

  const ctx = {
    version: config.version || require('../package.json').version,
    instructions: INSTRUCTIONS,
    manifest: () => tools.manifest(scope),
    callTool: (name, args) => callTool(name, args, req.headers.authorization, scope, getClientIp(req)),
  };

  // A batch is a JSON array; a single call is an object. Notifications produce no response, so a
  // batch of only notifications correctly answers 202 with no body.
  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const out = [];
  for (const m of messages) {
    const r = await protocol.handleMessage(m, ctx);
    if (r) out.push(r);
  }

  res.set('MCP-Protocol-Version', responseVersion(req, messages));
  if (!out.length) return res.status(202).end();
  return res.json(Array.isArray(req.body) ? out : out[0]);
});

/*
 * GET /mcp is the server-initiated stream in the Streamable HTTP transport. We never initiate
 * anything — no subscriptions, no sampling — so 405 is the honest answer and the one the spec names.
 * Holding a stream open forever to send nothing would look like a working feature.
 */
router.get('/', (_req, res) => {
  res.set('Allow', 'POST');
  res.status(405).type('text/plain').send('This MCP server does not stream. POST JSON-RPC to this URL.');
});

module.exports = router;
module.exports._scopeOf = scopeOf;
module.exports._callTool = callTool;
module.exports.rateLimited = rateLimited;
