/*
 * FIRST, before any dependency is required: make sure they are installed and loadable.
 *
 * A rollback restores an older package.json but not its packages, and a Node upgrade leaves the
 * native database module compiled against the wrong ABI. Both present as a server that will not
 * start, with an error naming a file rather than the action needed — and the rollback case happens
 * precisely when something else has already gone wrong. Repairing takes seconds; diagnosing at 2am
 * does not. ST_SKIP_DEP_PREFLIGHT=1 turns it off.
 */
require('./lib/preflight-deps').preflight();

const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const VERSION = require('./version');
const ghcrCheck = require('./lib/ghcr-check');

// #114: last-resort crash safety net. better-sqlite3 is SYNCHRONOUS, so a constraint
// violation (e.g. a FK write) inside a socket.io handler with no local try/catch
// propagates to uncaughtException; Node's default then prints a bare message and exits
// with NO stack — which is exactly why #114's "FOREIGN KEY constraint failed" couldn't
// be root-caused. This handler logs the FULL STACK (the file:line of the offending
// write) then exits(1) so systemd restarts a fresh process. It is NOT catch-and-
// continue: after an uncaught throw the process state is undefined, so we never keep
// serving. Registered before everything else so it's in place during startup too.
// (Verified: uncaughtException does catch a synchronous socket.io-handler throw.)
function logFatalAndExit(kind, err) {
  try {
    const e = err instanceof Error ? err : new Error('Non-error thrown: ' + require('util').inspect(err));
    process.stderr.write(`\n[FATAL ${kind}] ${new Date().toISOString()}\n${e.stack || e.message}\n`);
  } catch (_) { /* the death handler must never throw */ }
  try { require('./lib/status-log-writer').flush(); } catch (_) { /* #146 best-effort: drain buffered audit rows before close */ }
  try { require('./db/database').db.close(); } catch (_) { /* best-effort WAL flush */ }
  process.exit(1);
}
process.on('uncaughtException', (err) => logFatalAndExit('uncaughtException', err));
process.on('unhandledRejection', (reason) => logFatalAndExit('unhandledRejection', reason));

// Ensure upload directories exist
[config.contentDir, config.screenshotsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
const { trustedProxies } = require('./config/cloudflareIps');
const { getClientIp } = require('./services/activity');
// Trust loopback / link-local / unique-local (local dev, LAN reverse proxies)
// and Cloudflare's published edge ranges. With this list, req.ip resolves to
// the original client when fronted by Cloudflare; X-Forwarded-For from any
// non-trusted source is ignored, so the value can't be spoofed.
app.set('trust proxy', trustedProxies);

// Determine if SSL certs are available
const hasSsl = fs.existsSync(config.sslCert) && fs.existsSync(config.sslKey);
let server;

if (hasSsl) {
  const sslOptions = {
    cert: fs.readFileSync(config.sslCert),
    key: fs.readFileSync(config.sslKey),
  };
  server = https.createServer(sslOptions, app);
} else {
  server = http.createServer(app);
}

// #148 Item 4: TCP SO_KEEPALIVE on every accepted connection (lib/tcp-keepalive.js).
require('./lib/tcp-keepalive').applyTcpKeepAlive(server, config.tcpKeepAliveMs);

// Socket.IO CORS is checked via the same corsOriginCheck function defined below
// (after config is loaded). Hoisted into a closure so we can reference it before
// the function is defined — at first connection time, corsOriginCheck exists.
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => corsOriginCheck(origin, cb),
    credentials: true,
  },
  maxHttpBufferSize: 10 * 1024 * 1024, // 10MB for screenshot uploads
  pingInterval: config.pingInterval,
  pingTimeout: config.pingTimeout,
});

// Middleware
const helmet = require('helmet');

// CSP applies to the dashboard / app pages only. Widget and kiosk renders are
// publicly accessed by devices and intentionally use inline scripts/styles —
// they're served from /api/widgets/:id/render and /api/kiosk/:id/render and
// skip the CSP layer below via path-based opt-out.
//
// scriptSrc 'self' blocks <script> injection (the primary XSS vector) and external
// JS. scriptSrcAttr 'unsafe-inline' allows existing onclick/onchange handlers on
// dashboard buttons — TODO: refactor these to addEventListener and tighten further.
// styleSrcAttr 'unsafe-inline' is required because the views use inline style="..."
// attributes extensively for layout.
const dashboardCsp = helmet.contentSecurityPolicy({
  useDefaults: true,
  directives: {
    defaultSrc: ["'self'"],
    // Cloudflare Web Analytics: the beacon SCRIPT (static.cloudflareinsights.com) must be allowed to
    // load, AND the beacon must be allowed to POST its data back (connect-src -> cloudflareinsights.com).
    // Both are required — with only the script entry the beacon loads but silently can't report.
    scriptSrc: ["'self'", 'https://static.cloudflareinsights.com'],
    scriptSrcAttr: ["'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    styleSrcAttr: ["'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    mediaSrc: ["'self'", 'blob:', 'https:'],
    // 'wss:'/'ws:' keep the dashboard's socket.io connection working; the CF entry lets the beacon report.
    connectSrc: ["'self'", 'wss:', 'ws:', 'https:', 'https://cloudflareinsights.com'],
    fontSrc: ["'self'", 'data:'],
    frameSrc: ["'self'", 'https://www.youtube.com', 'https://youtube.com'],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    // Don't force HTTPS — self-hosted deployments may run on HTTP-only LANs.
    // Public production traffic is upgraded by Cloudflare / the reverse proxy and
    // protected by the HSTS header set above.
    upgradeInsecureRequests: null,
  },
});

app.use(helmet({
  contentSecurityPolicy: false,        // we apply our own below, scoped to non-render paths
  crossOriginEmbedderPolicy: false,    // allow loading external widget content
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// Apply CSP everywhere except routes that legitimately need inline scripts:
// - widget/kiosk renders (public, fetched by devices, intentionally inline)
// - /player (the web player has inline JS, served to display devices)
// - /         (landing page has inline JSON-LD + a pricing fetch script)
// The dashboard at /app uses ES modules only and gets the strict policy.
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/landing.html') return next();
  if (req.path.startsWith('/player')) return next();
  if (req.path === '/docs') return next(); // Redoc API reference needs a relaxed CSP
  if (req.path.startsWith('/api/widgets/') && req.path.endsWith('/render')) return next();
  if (req.path.startsWith('/api/widgets/') && req.path.endsWith('/data.json')) return next();
  if (req.path.startsWith('/api/widgets/preview-session/')) return next();
  if (req.path.startsWith('/api/kiosk/') && req.path.endsWith('/render')) return next();
  return dashboardCsp(req, res, next);
});
// CORS policy.
// - SELF_HOSTED=true: allow all origins (operator controls their own deployment).
// - production:       allowlist screentinker.com (+ subdomains) and localhost dev.
// - development:      open (default).
// Auth is JWT in Authorization header — credentials:true is kept for any cookie-based
// future flows but the JWT stays in localStorage and is sent via fetch() explicitly,
// so an attacker origin can't ride a session.
const isProd = process.env.NODE_ENV === 'production';
const allowedHostsProd = [
  'screentinker.com',
  'www.screentinker.com',
  'localhost',
  '127.0.0.1',
];

function corsOriginCheck(origin, callback) {
  // No origin = same-origin / mobile app / server-to-server / kiosk iframe.
  if (!origin) return callback(null, true);
  if (config.selfHosted) return callback(null, true);
  if (!isProd) return callback(null, true);
  let host;
  try { host = new URL(origin).hostname; } catch { return callback(null, false); }
  const allowed = allowedHostsProd.some(h => host === h || host.endsWith('.' + h));
  if (allowed) return callback(null, true);
  callback(null, false);
}

app.use(cors({
  origin: corsOriginCheck,
  credentials: true,
}));
// Stripe webhook needs raw body (before express.json parses it)
const stripeRouter = require('./routes/stripe');
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeRouter);

// 12mb so AI-designed signs with embedded generated images (base64 data URLs)
// can be published. #41 follow-up: upload generated images to the content store
// and reference by URL instead of embedding, to keep widget configs small.
/*
 * Collapse duplicate slashes in the PATH before anything routes on it.
 *
 * Express normalises the mount boundary for a router, so `/api/auth//login` still reaches the login
 * handler — but `app.use('/api/auth/login', rateLimit(...))` does NOT match it, so the limiter
 * never runs. One extra slash therefore removed EVERY per-endpoint limit under /api/auth: unlimited
 * password guesses (a review got a real session after 60 unthrottled attempts), unlimited TOTP
 * codes, unlimited password-reset mail to any address, and the SSO discovery cap that exists to
 * stop customer enumeration. It also made the per-account lockout a denial-of-service tool.
 *
 * Fixing it inside the limiter's key is not enough — the middleware is never invoked. The path has
 * to be one canonical thing before routing, which is what this does. Query and body are untouched.
 */
app.use((req, res, next) => {
  const q = req.url.indexOf('?');
  const path = q === -1 ? req.url : req.url.slice(0, q);
  if (path.includes('//')) {
    const collapsed = path.replace(/\/{2,}/g, '/');
    req.url = q === -1 ? collapsed : collapsed + req.url.slice(q);
  }
  next();
});

app.use(express.json({ limit: '12mb' }));
const { sanitizeBody } = require('./middleware/sanitize');
app.use(sanitizeBody);

// Landing page BEFORE static middleware (so / doesn't serve index.html).
// When DISABLE_HOMEPAGE is set, redirect to the app instead - for self-hosted
// internal deployments that don't want the public marketing page. 302 (not
// 301) so flipping the var back later isn't hard-cached by browsers.
app.get('/', (req, res) => {
  if (config.disableHomepage) return res.redirect(302, '/app');
  res.sendFile(path.join(config.frontendDir, 'landing.html'));
});

// Dashboard app. Inject the resolved instance / custom-domain branding into the
// shell as a <meta> (#76) so brand-prime can apply it before first paint when the
// per-workspace brand is not cached yet - no ScreenTinker flash on a never-visited
// org. CSP blocks inline <script>, so the brand rides in a <meta> that brand-prime
// reads. Falls back to a plain send of the shell if anything goes wrong.
app.get('/app', (req, res) => {
  const file = path.join(config.frontendDir, 'index.html');
  try {
    const { db } = require('./db/database');
    const { resolveBranding, publicBranding } = require('./lib/branding');
    const brand = publicBranding(resolveBranding(db, { domain: (req.hostname || '').toString() }));
    const attr = JSON.stringify(brand)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = fs.readFileSync(file, 'utf8')
      .replace('</head>', '  <meta name="ssr-brand" content="' + attr + '">\n</head>');
    res.type('html').send(html);
  } catch (e) {
    res.sendFile(file);
  }
});

// Sitemap and robots — served explicitly so the Content-Type is guaranteed
// and these endpoints are immune to any future static-middleware reshuffle.
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.setHeader('Cache-Control', 'public, max-age=3600'); // 1h, sitemap rarely changes
  res.sendFile(path.join(config.frontendDir, 'sitemap.xml'));
});
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(config.frontendDir, 'robots.txt'));
});

// Public API reference. /openapi.yaml is the machine-readable contract (served from
// docs/); /docs is the Redoc viewer (frontend/api-docs.html + the vendored standalone
// bundle under /vendor, no CDN so it works air-gapped). /docs is CSP-exempt above
// because Redoc needs a relaxed policy.
app.get('/openapi.yaml', (req, res) => {
  res.type('text/yaml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(__dirname, '..', 'docs', 'openapi.yaml'));
});
app.get('/docs', (req, res) => {
  res.sendFile(path.join(config.frontendDir, 'api-docs.html'));
});
// #73: the standalone agency portal (token-auth, NOT the JWT dashboard SPA). Served as its
// own page so the agency never touches the dashboard login.
app.get('/agency', (req, res) => {
  res.sendFile(path.join(config.frontendDir, 'agency.html'));
});

// The integrations hub is a directory index. express.static below runs with index:false,
// so a bare /integrations/ would otherwise fall through to the SPA catch-all (login page).
// Serve it explicitly (the spoke pages are real .html files and static already handles them).
app.get(['/integrations', '/integrations/'], (req, res) => {
  if (req.path === '/integrations') return res.redirect(301, '/integrations/');
  res.sendFile(path.join(config.frontendDir, 'integrations', 'index.html'));
});

// Serve frontend static files
// JS/CSS/HTML: no-cache (always revalidate, uses ETag/304)
// Images/fonts/icons: long cache for Cloudflare + browser
app.use(express.static(config.frontendDir, { index: false, etag: true, lastModified: true, setHeaders: (res, filePath) => {
  if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache');
  } else if (/\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|webp|mp4|webm)$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30 days
  }
}}));

// Player HTML: dynamic route. Injects a small inline window.__playerConfig
// script before the debug-overlay.js tag so the client knows whether to send
// telemetry to /api/player-debug. The PLAYER_DEBUG_REPORTING env var defaults
// to on - set to "off" to suppress all player-side telemetry POSTs (the
// server-side endpoint defends in depth, but the kill switch saves network
// traffic on the device too). Other player assets (JS, sw.js, etc) are still
// served by the static middleware below; only index.html is dynamic.
app.get(['/player', '/player/', '/player/index.html'], (req, res) => {
  const playerHtmlPath = path.join(__dirname, 'player', 'index.html');
  fs.readFile(playerHtmlPath, 'utf8', (err, html) => {
    if (err) return res.status(500).type('text/plain').send('player HTML unavailable');
    const reportingEnabled = String(process.env.PLAYER_DEBUG_REPORTING || 'on').toLowerCase() !== 'off';
    const inject =
      '  <script>window.__playerConfig = window.__playerConfig || {}; ' +
      'window.__playerConfig.debugReporting = ' + JSON.stringify(reportingEnabled) + ';</script>\n';
    // Inject right before the debug-overlay.js script tag. If for any reason
    // the tag isn't present (e.g. file edited out), fall back to injecting
    // before </head> so the flag still lands.
    let modified;
    if (html.indexOf('<script src="/player/debug-overlay.js"') >= 0) {
      modified = html.replace('<script src="/player/debug-overlay.js"', inject + '  <script src="/player/debug-overlay.js"');
    } else {
      modified = html.replace('</head>', inject + '</head>');
    }
    res.type('html').setHeader('Cache-Control', 'no-cache');
    res.send(modified);
  });
});

// #74/#75: serve the canonical schedule evaluator to the web player from the
// single source (server/lib/schedule-eval.js) so it can never drift from the
// server/Node-test copy. Registered before the static handler so it wins.
app.get('/player/schedule-eval.js', (req, res) => {
  res.type('application/javascript').setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'lib', 'schedule-eval.js'));
});

// Offline content-cache policy, imported by the service worker via importScripts and by the Node
// tests via require — one source, so the range arithmetic the player depends on cannot drift from
// the arithmetic that is actually tested. A service worker cannot require(), which is why this is
// a served file rather than a bundled one.
/*
 * The service worker, at the ROOT.
 *
 * A worker's scope defaults to its own directory, so /player/sw.js can only control /player/ and
 * below — not /player itself, which is the URL the dashboard shows. The fix for that was to ask for
 * a wider scope and permit it with a Service-Worker-Allowed header, and it works... until something
 * in front of the origin does not pass the header on. Cloudflare served a CACHED response for that
 * path across a deploy, headers and all, and the registration failed outright: worse than the
 * narrow scope it replaced, because a rejected registration means no worker at all.
 *
 * Served from / instead, the default scope IS the whole origin and no header is required. That
 * removes the dependency on a custom response header surviving every CDN, proxy and cache between
 * us and a display — including the ones self-hosters run and we will never see.
 *
 * /player/sw.js keeps working for players still asking for it.
 */
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');   // belt: harmless, and correct where it survives
  res.sendFile(path.join(__dirname, 'player', 'sw.js'));
});

app.get('/player/cache-policy.js', (req, res) => {
  res.type('application/javascript').setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'lib', 'player-cache-policy.js'));
});

// BrightSign player-package self-update. The manifest and the bytes are read from the SAME built
// buffer, so a checksum can never describe a file the server is not actually serving — that
// mismatch is the classic OTA-loop condition (download, fail verification, retry, forever).
//
// Unauthenticated on purpose, exactly like /download/apk: a player fetches this before it has any
// identity, and the payload is the same public host script that ships attached to every release.
const bsPackage = require('./lib/brightsign-package');
const bsUpdate = require('./lib/brightsign-update');

// The SERVER decides, exactly as /api/update/check does for Android, so the rule lives in one
// tested place instead of being re-implemented in BrightScript where it cannot be tested at all.
// The host does only what it is told.
app.get('/api/brightsign/package', async (req, res) => {
  const pkg = await bsPackage.getPackage();
  res.setHeader('Cache-Control', 'no-cache');

  // No package (a deployment without brightsign/, or an unreadable VERSION) is reported as a
  // decision of "skip", not an error. A player that cannot be told about an update must keep
  // running the one it has — an error here would otherwise be one more thing for the host to
  // misinterpret at boot.
  if (!pkg) return res.json({ action: 'skip', reason: 'package unavailable' });

  const decision = bsUpdate.decidePackageUpdate({
    currentVersion: req.query.version || null,
    manifestVersion: pkg.version,
    manifestSha256: pkg.sha256,
    stagedSha256: req.query.staged_sha256 || null,
    attempts: parseInt(req.query.attempts, 10) || 0,
    allowPrerelease: req.query.allow_prerelease === '1'
  });

  res.json({
    action: decision.action,
    reason: decision.reason,
    version: pkg.version,
    sha256: pkg.sha256,
    size: pkg.size,
    url: '/api/brightsign/package/download'
  });
});

app.get('/api/brightsign/package/download', async (req, res) => {
  const pkg = await bsPackage.getPackage();
  if (!pkg) return res.status(404).type('text/plain').send('package unavailable');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', String(pkg.size));
  res.setHeader('Content-Disposition', 'attachment; filename="autorun.zip"');
  // The checksum rides along so a client that already has the manifest can verify without a second
  // round trip, and so a proxy that mangles the body is detectable from the response alone.
  res.setHeader('X-Package-Sha256', pkg.sha256);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(pkg.buffer);
});

// ---------------------------------------------------------------------------------------------
// BrightSign framebuffer capture: the host COLLECTS the request, then POSTS the image back.
//
// Inverted on purpose. Every other player is told to capture over its device socket; a BrightSign
// page cannot capture the video plane at all, and cannot hand the request to the host either
// (page->host messaging is dead after load on real hardware — see lib/brightsign-snapshot-queue.js
// for the evidence). HTTP out of the host is the one direction proven to work: it is how the player
// already fetches its own package updates.
//
// Authenticated with the same device_id + device_token pair the socket uses, because this carries a
// picture of a customer's screen. Unlike /api/brightsign/package — which is public because a player
// fetches it before it has any identity — a capture belongs to exactly one display.
const bsSnapshotQueue = require('./lib/brightsign-snapshot-queue');
const bsDeviceSocket = require('./ws/deviceSocket');

function brightsignDeviceAuth(req, res) {
  const deviceId = req.query.device_id || req.get('X-Device-Id');
  const token = req.query.token || req.get('X-Device-Token');
  if (!bsDeviceSocket.validateDeviceToken(deviceId, token)) {
    res.status(401).json({ error: 'device authentication failed' });
    return null;
  }
  return deviceId;
}

// Polled by autorun.brs on the loop it already runs. Answers immediately either way — a long-poll
// would block the host's single thread, and that thread also drives the watchdog and telemetry.
app.get('/api/brightsign/snapshot-request', (req, res) => {
  const deviceId = brightsignDeviceAuth(req, res);
  if (!deviceId) return;
  res.setHeader('Cache-Control', 'no-cache');
  const pending = bsSnapshotQueue.take(deviceId);
  if (!pending) return res.json({ pending: false });
  res.json({ pending: true, width: pending.width, height: pending.height });
});

// The captured frame, straight from the host. Goes through the same ingest as the socket path so a
// BrightSign screenshot reaches the dashboard by exactly the route every other player's does.
app.post('/api/brightsign/snapshot', express.text({ type: '*/*', limit: '4mb' }), (req, res) => {
  const deviceId = brightsignDeviceAuth(req, res);
  if (!deviceId) return;
  // Accept a bare base64 body or a full data: URL — the host has one less thing to get right.
  let b64 = String(req.body || '').trim();
  const comma = b64.indexOf(',');
  if (b64.startsWith('data:') && comma > 0) b64 = b64.slice(comma + 1);
  if (b64.length < 100) return res.status(400).json({ error: 'no image' });
  if (b64.length > 2 * 1024 * 1024) return res.status(413).json({ error: 'image too large' });
  const ok = bsDeviceSocket.ingestScreenshot(deviceId, b64);
  if (!ok) return res.status(503).json({ error: 'sockets not ready' });
  res.json({ ok: true, bytes: b64.length });
});

// BrightSign bridge, served from its single source (brightsign/st-bridge.js) so the copy the
// player loads can never drift from the one sitting on the SD card next to autorun.brs — the two
// are halves of one messageport contract, and a skew between them is exactly what would leave a
// panel unable to restart itself.
//
// Served to every player rather than gated on a user agent: it costs one small request, every
// method degrades to a no-op off-platform, and a panel reporting an unexpected UA would otherwise
// silently lose restart-instead-of-reload — the one thing it most needs.
app.get('/player/st-bridge.js', (req, res) => {
  res.type('application/javascript').setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'brightsign', 'st-bridge.js'));
});

// BrightSign native synchronisation (SyncManager), same single-source rule as the bridge.
app.get('/player/st-sync.js', (req, res) => {
  res.type('application/javascript').setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'brightsign', 'st-sync.js'));
});

// The mute decision, from its single source (server/lib/media-mute.js). Served rather than
// duplicated because this rule disagreed with itself across players for exactly as long as it was
// written three times: a YouTube embed ignored the per-item mute on the web player and could never
// unmute at all on Tizen.
// Orientation geometry, from its single source. Rotating a box does not move it: the previous
// inline rule spun the container about its own top-left-pinned centre and put portrait content
// 420px off-screen on a 1920x1080 panel.
app.get('/player/orientation-style.js', (req, res) => {
  res.type('application/javascript').setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'lib', 'orientation-style.js'));
});

// #236: video-wall tile geometry, from its single source. Four players have to agree on this to
// the pixel — they render one frame across panels that share a seam, and a half-pixel of
// disagreement between two of them is a visible line down the middle of the wall.
app.get('/player/wall-geometry.js', (req, res) => {
  res.type('application/javascript').setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'lib', 'wall-geometry.js'));
});

app.get('/player/media-mute.js', (req, res) => {
  res.type('application/javascript').setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'lib', 'media-mute.js'));
});

// #146 web-player fix: serve the media-surface health decision from its single source
// (server/lib/player-media-health.js) so the player and the Node test can't drift.
app.get('/player/player-media-health.js', (req, res) => {
  res.type('application/javascript').setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'lib', 'player-media-health.js'));
});

// Transition runtime bundle (renderer.js + params.js + shader sources) built from shared/Transitions.
// If this ever fails to load, the player simply hard-cuts (never blank) — it's a progressive enhancement.
app.get('/player/transitions.js', (req, res) => {
  res.type('application/javascript').setHeader('Cache-Control', 'public, max-age=300');
  try { res.send(require('./lib/transition-bundle').bundle()); }
  catch (e) { res.status(500).send('/* transition bundle unavailable */'); }
});

// Serve web player at /player (same no-cache for JS/HTML). The index.html
// route above intercepts the HTML requests; everything else still falls
// through to this static handler (debug-overlay.js, sw.js, manifest, etc).
app.use('/player', express.static(path.join(__dirname, 'player'), { etag: true, lastModified: true, setHeaders: (res, filePath) => {
  if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache');
  }
  if (filePath.endsWith('sw.js')) {
    // A worker's default scope is its own directory, so sw.js at /player/sw.js can only control
    // /player/ AND BELOW — which does not include /player itself. The player is served at all three
    // of /player, /player/ and /player/index.html, and /player (no trailing slash) is the one
    // everybody actually uses: it is what the dashboard shows and what gets typed into a panel.
    // On that URL the worker registered, reported success, and then controlled nothing at all — no
    // shell cache, no content cache, no offline playback, silently. Widening the permitted scope is
    // what makes the registration below able to claim the page it was loaded from.
    res.setHeader('Service-Worker-Allowed', '/');
  }
}}));

// Serve setup scripts
app.use('/scripts', express.static(path.join(__dirname, '..', 'scripts')));

// Serve socket.io client
app.use('/socket.io-client', express.static(
  path.join(__dirname, 'node_modules', 'socket.io', 'client-dist')
));

// Simple rate limiter for auth endpoints
// Required here rather than relying on the log-coalescer const further down: that one is only
// safe because the callback runs at request time, which is a subtle thing to depend on.
const limiterTelemetry = require('./lib/limiter-telemetry');
const rateLimits = new Map();
/*
 * The bucket key is the SHAPE of the endpoint, never the spelling the caller chose.
 *
 * Two failures drove this. Express routes non-strictly, so `/api/auth/login/` was a different key
 * and bought a fresh ten password attempts. And `/api/organizations/<id>/...` carries three
 * caller-chosen segments, so every request minted its own bucket — 120 calls with unique ids gave
 * zero 429s against the limit that exists to bound outbound OIDC discovery and live DNS lookups.
 *
 * ⚠️ Fold by EXPLICIT shape, not with a clever catch-all. A single regex that collapsed "anything
 * else" put every unknown path in one bucket WITH the real endpoints, so flooding nonsense URLs
 * exhausted the limit for `/sso-only` — trading a bypass for a denial of service. Known shapes get
 * their own keys; everything else shares one, separate from all of them.
 */
const LIMIT_PATH_SHAPES = [
  [/^\/api\/auth\/oidc\/[^/]+\/(start|callback)$/, (m) => `/api/auth/oidc/:slug/${m[1]}`],
  [/^\/api\/organizations\/sso-only\/removal-requests\/[^/]+\/[^/]+$/, () => '/api/organizations/sso-only/removal-requests/:id/:decision'],
  [/^\/api\/organizations\/sso-only\/removal-requests$/, () => '/api/organizations/sso-only/removal-requests'],
  [/^\/api\/organizations\/[^/]+\/sso-only\/removal-request\/[^/]+$/, () => '/api/organizations/:id/sso-only/removal-request/:id'],
  [/^\/api\/organizations\/[^/]+\/sso-only\/removal-request$/, () => '/api/organizations/:id/sso-only/removal-request'],
  [/^\/api\/organizations\/[^/]+\/sso-only$/, () => '/api/organizations/:id/sso-only'],
  // The reset/target routes mint a bucket per TARGET without this, which is the same
  // caller-chosen-segment defect, at the mount next door.
  [/^\/api\/auth\/users\/[^/]+\/(.+)$/, (m) => `/api/auth/users/:id/${m[1]}`],
  [/^\/api\/content\/[^/]+$/, () => '/api/content/:id'],
  [/^\/api\/organizations\/[^/]+\/sso\/[^/]+\/domains\/[^/]+\/verify$/, () => '/api/organizations/:id/sso/:id/domains/:domain/verify'],
  [/^\/api\/organizations\/[^/]+\/sso\/[^/]+\/test$/, () => '/api/organizations/:id/sso/:id/test'],
  [/^\/api\/organizations\/[^/]+\/sso\/[^/]+$/, () => '/api/organizations/:id/sso/:id'],
  [/^\/api\/organizations\/[^/]+\/sso$/, () => '/api/organizations/:id/sso'],
];

function canonicalLimitPath(rawPath) {
  const p = rawPath
    .replace(/\/{2,}/g, '/')      // collapse doubled separators
    .replace(/\/+$/, '')          // a trailing slash is the same endpoint
    .toLowerCase()
    || '/';
  for (const [re, to] of LIMIT_PATH_SHAPES) {
    const m = p.match(re);
    if (m) return to(m);
  }
  // Unrecognised, but still under a mount whose ids are caller-chosen: one shared bucket, kept
  // apart from every real endpoint so flooding it cannot starve them.
  if (p.startsWith('/api/organizations/')) return '/api/organizations/:unmatched';
  return p;
}

function rateLimit(windowMs, maxRequests) {
  return (req, res, next) => {
    // #100: key on the FULL path, not req.path. These limiters are mounted via
    // app.use('/api/auth/login', ...) etc., and Express strips the mount path, so
    // req.path was '/' for ALL of them - i.e. /login, /register, /totp/verify shared
    // ONE per-IP counter (coupled limits; the /totp/verify brute-force limit wasn't
    // actually independent). originalUrl keeps each endpoint's limit separate.
    /*
     * ⚠️ NORMALISE THE PATH, or the key is caller-controlled and the limit is decorative.
     *
     * Express routes non-strictly, so `/api/auth/login/` reaches the same handler as
     * `/api/auth/login` — with a different originalUrl, hence a different bucket, hence a fresh ten
     * attempts. A review walked straight past the login limiter that way. Any path segment the
     * caller chooses does the same thing, and `/api/auth/oidc/:slug/...` has one by design, so the
     * slug is folded out too: one bucket per IP per ENDPOINT, not per spelling of it.
     */
    const rawPath = (req.originalUrl || req.url || req.path).split('?')[0];
    const normalisedPath = canonicalLimitPath(rawPath);
    const key = getClientIp(req) + normalisedPath;
    const now = Date.now();
    const windowStart = now - windowMs;
    let hits = rateLimits.get(key) || [];
    hits = hits.filter(t => t > windowStart);
    if (hits.length >= maxRequests) {
      // QA-SNAT: a 429 returns before any handler runs, so nothing else in the system ever
      // records that it happened — the limit hides its own evidence. Count it here. The
      // number that matters is distinct identifiers per IP: one means the limiter is doing
      // its job, several means a shared egress IP is denying real users. Identifiers are
      // salted-hashed inside the telemetry module and only ever counted. Response unchanged.
      try {
        const endpoint = (req.originalUrl || req.url || req.path).split('?')[0];
        const ip = getClientIp(req);
        const ident = req.body && (req.body.email || req.body.username);
        const t = limiterTelemetry.recordRejection({ endpoint, ip, identifier: ident });
        logCoalescer.record(
          `limit-reject:${endpoint}:${ip}`,
          `[limit] 429 ${endpoint} ip=${ip} rejections=${t.rejections} distinct_accounts=${t.distinctIdentifiers}` +
          (t.distinctIdentifiers >= 3 ? ' (looks like a SHARED egress, not one attacker)' : ''),
          { warn: t.distinctIdentifiers >= 3 },
        );
      } catch (_) { /* telemetry must never break the limiter */ }
      return res.status(429).json({ error: 'Too many requests, try again later' });
    }
    hits.push(now);
    rateLimits.set(key, hits);
    // Cleanup old entries periodically
    if (rateLimits.size > 10000) {
      for (const [k, v] of rateLimits) { if (v.every(t => t < windowStart)) rateLimits.delete(k); }
    }
    next();
  };
}

// Auth routes (public, rate limited)
app.use('/api/auth/login', rateLimit(60000, 10)); // 10 attempts per minute
app.use('/api/auth/register', rateLimit(60000, 5)); // 5 registrations per minute
// #100 (tightening #2): the TOTP verify endpoint is the brute-force surface for a
// 6-digit code. Cap attempts/min here; the per-user lockout (lib/totp-lockout) sits
// on top in the handler.
app.use('/api/auth/totp/verify', rateLimit(60000, 10));
// Email-verification resend: cap so it can't be used to spray mail at an address.
app.use('/api/auth/resend-verification', rateLimit(60000, 5));
// Domain lookup is unauthenticated by necessity (it runs before login). Rate limited so it
// cannot be walked to enumerate which customers use SSO.
app.use('/api/auth/sso/discover', rateLimit(60000, 10));
// 10/min was wrong for this one: org SSO is used by companies behind a SINGLE corporate egress IP,
// and this is their only entry point, so the 11th employee of the morning met a raw JSON 429 with no
// login page. It is a redirect, not a credential check.
app.use('/api/auth/sso/start', rateLimit(60000, 120));
// The OIDC endpoints had no limit at all, which left the callback's parsing as a free amplifier.
app.use('/api/auth/oidc', rateLimit(60000, 120));
// Self-service password reset. The request endpoint is the spray surface (it sends mail to
// an address the caller supplies), so it gets the tighter cap; the redeem endpoint is a
// 32-byte-token guess, capped mostly to keep the bcrypt work bounded.
app.use('/api/auth/forgot-password', rateLimit(60000, 5));
app.use('/api/auth/reset-password', rateLimit(60000, 10));
// Admin password-reset endpoint: even if an admin's session is compromised,
// cap the blast radius to 20 resets/min/IP. Express matches the longest
// path prefix first, so this fires before /api/auth catches the request.
app.use('/api/auth/users', rateLimit(60000, 20));
app.use('/api/auth', require('./routes/auth'));
// Per-organization SSO configuration. Mounted under /api/organizations so the org id is the
// route's own subject, which is what the org_owner/org_admin check keys on.
/*
 * Rate-limited because these routes do outbound work on caller-supplied input: OIDC discovery on a
 * customer-chosen issuer, and a live DNS lookup per domain verification. Everything under
 * /api/auth/* already had a limit; this router was mounted without one.
 */
app.use('/api/organizations', rateLimit(60000, 60), require('./routes/org-sso'));
// Rate limit pairing to prevent brute force (5 attempts per minute per IP).
// #88: bind this to the whole /api/provision surface, not just /pair - the bare
// POST /api/provision (routes/provisioning.js) is a second pairing endpoint that
// was unthrottled, letting an authed user brute-force pairing codes. /api/provision
// matches both /api/provision and /api/provision/pair.
app.use('/api/provision', rateLimit(60000, 5));
// Rate limit expensive operations
app.use('/api/status/export', rateLimit(60000, 5)); // 5 exports per minute
app.use('/api/status/import', rateLimit(60000, 3)); // 3 imports per minute
app.use('/api/content', rateLimit(60000, 30)); // 30 content operations per minute

// Subscription routes (mixed auth)
app.use('/api/subscription', require('./routes/subscription'));

// Public contact form (enterprise inquiries from landing page). Rate limited
// to 5 submissions per minute per IP; honeypot enforced inside the route.
app.use('/api/contact', rateLimit(60000, 5));
app.use('/api/contact', require('./routes/contact'));

// Public player debug-log sink. Smart TVs and other embedded browsers
// without devtools POST captured errors here. Rate limited to 10 req/min
// per IP+path. Body is JSON (express.json() is global at line 140).
app.use('/api/player-debug', rateLimit(60000, 10));
app.use('/api/player-debug', require('./routes/player-debug'));

// Public branding resolver (#15). Pre-login / pre-workspace contexts (the login
// page especially) need branding without a token. Resolves custom-domain match
// -> platform default -> hardcoded ScreenTinker. Domain comes from ?domain= or
// the request hostname (trust-proxy resolves the forwarded Host behind CF/Nginx).
app.get('/api/branding', (req, res) => {
  const { db } = require('./db/database');
  const { resolveBranding, publicBranding } = require('./lib/branding');
  const domain = (req.query.domain || req.hostname || '').toString();
  // publicBranding strips internal columns (id/user_id/workspace_id/custom_domain
  // /timestamps) so this unauthenticated endpoint only exposes presentational fields.
  res.json(publicBranding(resolveBranding(db, { domain })));
});

// Stripe billing routes (checkout, portal)
app.use('/api/stripe', stripeRouter);


// Screenshot route (before protected routes - needs custom auth for img tags)
const { resolveSessionUser } = require('./middleware/auth');
app.get('/api/devices/:id/screenshot', (req, res) => {
  let user = null;
  const authHeader = req.headers.authorization;
  const tokenParam = req.query.token;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : tokenParam;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  // resolveSessionUser is the same resolver requireAuth uses, so this route inherits the
  // pre-TOTP refusal, the live-user check and the forced-password-change gate.
  try {
    const session = resolveSessionUser(token);
    // Break-glass has no users row; the lookup this replaced returned nothing for it.
    if (session.viaRecovery) return res.status(401).json({ error: 'User not found' });
    user = session.user;
  } catch (err) {
    if (err.code === 'mfa_required') return res.status(401).json({ error: 'mfa_required' });
    if (err.code === 'password_change_required') return res.status(403).json({ error: 'password_change_required' });
    if (err.code === 'user_not_found') return res.status(401).json({ error: 'User not found' });
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const { db: sdb } = require('./db/database');
  const device = sdb.prepare('SELECT user_id, workspace_id FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  // Authorize on the DEVICE'S WORKSPACE, the same way routes/devices.js does. The previous
  // test was pre-tenancy (`device.user_id !== user.id`) with a role bypass listing
  // 'admin'/'superadmin', which had three problems: it short-circuited on `device.user_id &&`
  // so a device with NO owner was readable by any authenticated account (an unpaired panel
  // displays its pairing code, so that image is also a claim vector); it omitted
  // 'platform_admin', the name #14 migrated 'superadmin' to, so real platform admins were
  // denied; and it denied workspace members who administer the device everywhere else.
  // accessContext covers direct membership, org-level access and platform staff in one call.
  if (!device.workspace_id) return res.status(403).json({ error: 'Access denied' });
  const ws = sdb.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  if (!ws || !accessContext(user.id, user.role, ws)) return res.status(403).json({ error: 'Access denied' });
  // Serve from memory if available (device online), otherwise from disk (offline snapshot)
  const deviceSocket = require('./ws/deviceSocket');
  const memScreenshot = deviceSocket.lastScreenshots?.[req.params.id];
  if (memScreenshot) {
    const buffer = Buffer.from(memScreenshot, 'base64');
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-cache');
    return res.send(buffer);
  }
  const screenshot = sdb.prepare('SELECT * FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1').get(req.params.id);
  if (!screenshot) return res.status(404).json({ error: 'No screenshot available' });
  const safePath = path.resolve(config.screenshotsDir, path.basename(screenshot.filepath));
  if (!safePath.startsWith(path.resolve(config.screenshotsDir))) return res.status(403).json({ error: 'Invalid path' });
  res.sendFile(safePath);
});

// A logged-in user who can access the content's workspace may view its file /
// thumbnail even when it isn't referenced by a playlist/widget yet (e.g. the
// content library showing a just-uploaded, not-yet-assigned item). <img> can't
// send an Authorization header, so the dashboard fetches these with the Bearer
// token; this verifies it and checks workspace membership. Anonymous players
// (no token) still fall back to the playlist/widget reference gate. (#39)
function requesterCanAccessContent(req, content) {
  try {
    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (!m) return false;
    // Same resolver as requireAuth: a pre-TOTP token, a deleted user or an outstanding
    // forced password change all throw here and fall through to false.
    const session = resolveSessionUser(m[1]);
    if (session.viaRecovery) return false; // no workspace membership; unchanged behaviour
    const user = session.user;
    if (!user || !user.id) return false;
    // Role from the LIVE users row, not the token claim, so a demotion takes effect at once.
    if (user.role === 'platform_admin') return true;
    const { db } = require('./db/database');
    return !!db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(content.workspace_id, user.id);
  } catch { return false; }
}

// Public content file serving (must be BEFORE protected routes)
app.get('/api/content/:id/file', (req, res) => {
  const { db } = require('./db/database');
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  if (!content.filepath) return res.status(404).json({ error: 'No file (remote URL content)' });
  const inPlaylist = db.prepare('SELECT id FROM playlist_items WHERE content_id = ? LIMIT 1').get(req.params.id);
  // Scope widget lookup to widgets in the content's workspace — prevents a user
  // in another workspace from unlocking this content by creating a widget that
  // references the UUID. Phase 2.2d: keyed off content.workspace_id (was user_id).
  // Perf note: LIKE scan on widgets.config is O(n) per request. Fine at current scale
  // (<100 widgets); revisit with a content_widget_refs join table if this grows.
  const inWidget = inPlaylist ? null : db.prepare('SELECT id FROM widgets WHERE workspace_id = ? AND config LIKE ? LIMIT 1').get(content.workspace_id, `%/api/content/${req.params.id}/%`);
  if (!inPlaylist && !inWidget && !requesterCanAccessContent(req, content)) return res.status(403).json({ error: 'Content not assigned to any playlist or widget' });
  const safePath = path.resolve(config.contentDir, path.basename(content.filepath));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  // Widget boards (logo / background images) render inside the player's sandboxed
  // (opaque-origin) widget iframe, so these image loads are cross-origin. The helmet
  // default CORP: same-origin blocks them (NS_ERROR_DOM_CORP_FAILED, 0 bytes). Allow
  // cross-origin — matches the /uploads/content static route; this content is already
  // served here without auth (playlist/widget-gated above).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  hardenUploadResponse(res, content.filepath);
  res.sendFile(safePath);
});

// Proxy a remote thumbnail (e.g. YouTube's img.youtube.com/.../hqdefault.jpg, which
// content.js stores as thumbnail_path) server-side, SAME-ORIGIN, so the dashboard CSP
// img-src is unaffected. Never throws into the process: any upstream/network failure
// becomes a clean 404/502. Restricted to image/* responses (modest SSRF hardening; the
// URL is server-set at ingest, not caller-supplied). Thumbnails are small, so buffering
// is fine and avoids partial-stream error handling.
async function proxyRemoteThumbnail(url, res) {
  try {
    const upstream = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (upstream.status === 404) return res.status(404).json({ error: 'Thumbnail not found' });
    if (!upstream.ok) return res.status(502).json({ error: 'Thumbnail upstream error' });
    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(ct)) return res.status(502).json({ error: 'Thumbnail upstream is not an image' });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin'); // load in sandboxed widget iframes
    return res.send(buf);
  } catch (e) {
    return res.status(502).json({ error: 'Thumbnail fetch failed' });
  }
}

// Public thumbnail serving (must be BEFORE protected routes)
app.get('/api/content/:id/thumbnail', (req, res) => {
  const { db } = require('./db/database');
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content || !content.thumbnail_path) return res.status(404).json({ error: 'Thumbnail not found' });
  // Security: gate the same way as /file - only serve when the content is
  // referenced by a playlist or by a widget IN THE CONTENT'S WORKSPACE. Without
  // this, any anonymous caller holding a content UUID could pull any tenant's
  // thumbnail (the /file route already had this check; the thumbnail route did not).
  const inPlaylist = db.prepare('SELECT id FROM playlist_items WHERE content_id = ? LIMIT 1').get(req.params.id);
  const inWidget = inPlaylist ? null : db.prepare('SELECT id FROM widgets WHERE workspace_id = ? AND config LIKE ? LIMIT 1').get(content.workspace_id, `%/api/content/${req.params.id}/%`);
  if (!inPlaylist && !inWidget && !requesterCanAccessContent(req, content)) return res.status(403).json({ error: 'Content not assigned to any playlist or widget' });
  // YouTube (and any future remote-sourced) content stores thumbnail_path as a remote
  // http(s) URL, not a local file. Proxy it instead of resolving it to a local path that
  // doesn't exist (contentDir/hqdefault.jpg -> ENOENT spam). Local thumbnails are
  // unchanged. Access gating above already ran identically for both branches.
  if (/^https?:\/\//i.test(content.thumbnail_path)) return proxyRemoteThumbnail(content.thumbnail_path, res);
  const safePath = path.resolve(config.contentDir, path.basename(content.thumbnail_path));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  // See /file — cross-origin so sandboxed widget iframes can load it.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  hardenUploadResponse(res, content.thumbnail_path);
  res.sendFile(safePath);
});

// Protected API Routes.
// Phase 2.1: resolveTenancy runs right after requireAuth on every resource
// route. It attaches req.workspaceId, req.workspaceRole, req.orgRole,
// req.isPlatformAdmin, req.actingAs. Route handlers in 2.1 don't read these
// yet (they still filter by user_id); 2.2 will migrate them one route at a time.
const { requireAuth } = require('./middleware/auth');
const { sixDigitCode } = require('./lib/numeric-code');
const { resolveTenancy, accessContext } = require('./lib/tenancy');
// Public API token front door (Phase 1). Attached ONLY to the public routers below.
const { bearerAuth, tokenScopeGate, agencyGate } = require('./middleware/apiToken');

// activityLogger wraps res.json on every subsequent route to auto-log
// successful POST/PUT/DELETE mutations. Mount it BEFORE the workspace routes
// (this fix corrects a pre-existing bug where it was mounted after them and
// silently never fired). Auth / subscription / stripe routes are already
// mounted above and stay opt-out from the auto-logger (login has its own
// inline writers; payment webhooks don't belong in activity_log).
const { activityLogger } = require('./services/activity');
app.use(activityLogger);

// #public-api Phase 1: the router partition is data-driven from config/api-surface.js
// so server.js and the partition firewall test (test/api.test.js) read the SAME list
// and cannot drift. PUBLIC routers get the token front door (bearerAuth + resolveTenancy
// + tokenScopeGate); JWT-ONLY routers keep requireAuth, so a Bearer st_... token fails
// their jwt.verify and is unreachable (secure by exclusion). Tokens act as a workspace
// member with platform powers stripped, so in-handler ELEVATED/PLATFORM checks (e.g.
// GET /api/devices/unassigned) still deny.
const { PUBLIC_ROUTERS, JWT_ONLY_ROUTERS, AGENCY_ROUTERS } = require('./config/api-surface');

// Public device-render endpoints + the memory-heavy preview limiter must be registered
// BEFORE their parent router mount so the _skipAuth bypass / the limiter fire first.
app.get('/api/widgets/:id/render', (req, res, next) => { req._skipAuth = true; next(); });
app.get('/api/widgets/:id/data.json', (req, res, next) => { req._skipAuth = true; next(); });
app.post('/api/widgets/:id/telemetry', (req, res, next) => { req._skipAuth = true; next(); }); // diag widget reports frame stats (null-origin iframe)
app.get('/api/widgets/:id/telemetry', (req, res, next) => { req._skipAuth = true; next(); });
app.get('/api/widgets/preview-session/:id', (req, res, next) => { req._skipAuth = true; next(); });
app.use('/api/widgets/preview', rateLimit(60000, 30)); // base64 inline = memory-intensive
app.use('/api/widgets/preview-session', rateLimit(60000, 30)); // preview session creation retains rendered HTML in memory for 5min
app.get('/api/kiosk/:id/render', (req, res, next) => { req._skipAuth = true; next(); });

for (const r of PUBLIC_ROUTERS) {
  // renderBypass routers let the public /:id/render through (req._skipAuth) before bearerAuth.
  const front = r.renderBypass
    ? (req, res, next) => { if (req._skipAuth) return next(); bearerAuth(req, res, next); }
    : bearerAuth;
  app.use(r.path, front, resolveTenancy, tokenScopeGate, require(r.mod));
}
for (const r of JWT_ONLY_ROUTERS) {
  // tenancy routers act on the caller's active workspace; the rest (workspaces, admin)
  // target a workspace by URL/body param and are gated per-handler (canAdminWorkspace).
  if (r.tenancy) app.use(r.path, requireAuth, resolveTenancy, require(r.mod));
  else app.use(r.path, requireAuth, require(r.mod));
}
for (const r of AGENCY_ROUTERS) {
  // #73: capability-restricted token surface. bearerAuth + resolveTenancy + agencyGate
  // (NOT tokenScopeGate). 'agency' is off the read/write/full ladder, so these tokens
  // reach ONLY here; agencyGate enforces the playlist allowlist + bound workspace.
  app.use(r.path, bearerAuth, resolveTenancy, agencyGate, require(r.mod));
}

// Frontend version hash (changes when files are modified, triggers soft reload)
const crypto = require('crypto');
let frontendHash = '';
function updateFrontendHash() {
  try {
    const files = ['index.html', 'js/app.js', 'js/api.js', 'js/socket.js', 'css/main.css',
      'js/views/dashboard.js', 'js/views/device-detail.js', 'js/views/content-library.js',
      'js/views/settings.js', 'js/views/login.js', 'js/views/billing.js',
      'js/views/layout-editor.js', 'js/views/schedule.js', 'js/views/widgets.js',
      'js/views/video-wall.js', 'js/views/reports.js', 'js/views/designer.js',
      'js/views/activity.js', 'js/views/kiosk.js'].map(f => {
      try { return fs.readFileSync(path.join(config.frontendDir, f)); } catch { return ''; }
    });
    // Include player files in hash so web players detect code updates
    try { files.push(fs.readFileSync(path.join(__dirname, 'player', 'index.html'))); } catch {}
    try { files.push(fs.readFileSync(path.join(__dirname, 'player', 'sw.js'))); } catch {}
    try { files.push(fs.readFileSync(path.join(__dirname, 'player', 'debug-overlay.js'))); } catch {}
    frontendHash = crypto.createHash('md5').update(Buffer.concat(files.map(f => Buffer.from(f)))).digest('hex').slice(0, 8);
  } catch { frontendHash = Date.now().toString(36); }
}
updateFrontendHash();
// Recheck every 30 seconds
setInterval(updateFrontendHash, 30000);
app.get('/api/version', (req, res) => {
  const latest = ghcrCheck.getLatestVersion();
  const updateAvailable = latest ? ghcrCheck.compareVersions(latest, VERSION) > 0 : false;
  res.json({ hash: frontendHash, version: VERSION, latest_version: latest, update_available: updateAvailable });
});

// Public status page
app.use('/api/status', require('./routes/status'));

/*
 * Opt-in install statistics — the COLLECTOR side, plus the public aggregate the marketing
 * page reads. Both live in routes/telemetry-collector.js; both are mounted only when
 * TELEMETRY_COLLECTOR=1, so a normal self-hosted install exposes neither.
 */
if (process.env.TELEMETRY_COLLECTOR === '1') {
  /* `require('./db/database').db`, not the module-scope `db` — that binding is declared far
     below this line, so naming it here throws "Cannot access 'db' before initialization" at
     load and the process never starts. The inline handler this replaced only touched `db`
     inside a request callback, which runs long after the binding exists; passing it to a
     factory made the reference eager. Every neighbouring call site in this region resolves
     the same lazy way. */
  app.use('/api', require('./routes/telemetry-collector')(require('./db/database').db));
  console.log('[telemetry] collector enabled at POST /api/telemetry/report (+ GET /api/public/stats)');
}

// #146 BILLING: Usage Report on its OWN route (NOT part of /api/status — billing is revenue
// data and a heavier aggregate than the hot status path). bearerAuth is the dual front door:
// a 'billing:read' API token (Bearer st_...) OR a JWT session both reach it; the route's
// requireBillingRead then authorizes a billing:read token OR a platform-admin session.
// No tenancy — billing is platform-global.
app.use('/api/billing', bearerAuth, require('./routes/billing'));

// Activity logging middleware now mounted earlier (just before the workspace
// route block) - leaving this comment here as a breadcrumb for the move.

// APK version check endpoint (public, used by devices to check for updates)
const otaBreaker = require('./lib/ota-breaker');
otaBreaker.startSweep();   // #144: periodically evict idle breaker buckets so keyed state stays bounded
require('./lib/reconnect-throttle').startSweep();   // #146: same, for the reconnect throttle's per-device buckets
require('./lib/flap-limiter').startSweep();          // #146 Item B: evict idle flap-limiter buckets
require('./lib/session-settle').startSweep();        // #148 patch2: evict idle session-settle entries
require('./lib/content-ack-limiter').startSweep();   // #146 Item E: evict idle content-ack buckets
const apkCache = require('./lib/apk-cache');
apkCache.start();                                    // #146 Item C: resolve APK path/size/mtime once + refresh on interval (no per-request fs)
const wgtCache = require('./lib/wgt-cache');
wgtCache.start();                                    // Tizen SSSP URL-Launcher: resolve .wgt path/size/mtime once + refresh on interval
const { getBand } = require('./services/loop-lag');  // #146 Item C: critical-band download shed
app.get('/api/update/check', (req, res) => {
  const currentVersion = req.query.version;
  const deviceId = req.query.device_id || null;   // #144: optional; beta4+ clients send it for per-device keying
  let latestVersion = VERSION;   // replaced by the beta build's declared version for opted-in displays
  let betaChannel = false;   // per-display pre-release opt-in, set from the device row below
  let wasOnBeta = false;     // whether we have actually served this display the beta channel

  // #155/#161: self-update kill switch, enforced SERVER-SIDE so it covers EVERY client
  // version (not just ones with the client-side stand-down). If OTA is off globally
  // (config.otaEnabled) or for this device (devices.ota_enabled=0), never offer an update
  // — an MDM/operator owns updates instead. Checked before the breaker so a disabled device
  // does zero further work.
  {
    const otaGloballyOff = !config.otaEnabled;
    let otaDeviceOff = false;
    if (deviceId) {
      try {
        const row = require('./db/database').db.prepare('SELECT ota_enabled, ota_beta, ota_channel_served FROM devices WHERE id = ?').get(deviceId);
        otaDeviceOff = !!row && row.ota_enabled === 0;
        // #234 follow-up: per-display pre-release opt-in, read from the same row rather than a
        // second query. Without it, handing someone a test build is a trap — a prerelease sorts
        // BELOW its own release, so the next check "upgrades" the display straight back off it.
        betaChannel = !!row && row.ota_beta === 1;
        wasOnBeta = !!row && row.ota_channel_served === 'beta';
      } catch (_) { /* device unknown / pre-migration — treat as enabled */ }
    }
    if (otaGloballyOff || otaDeviceOff) {
      const reason = otaGloballyOff ? 'ota_disabled_global' : 'ota_disabled_device';
      logOtaCheck(deviceId, currentVersion, latestVersion, false, reason);
      return res.json({
        latest_version: latestVersion, current_version: currentVersion || 'unknown',
        update_available: false, reason, download_url: '/download/apk', apk_size: 0, apk_modified: 0,
      });
    }
  }

  // #144: circuit-breaker + phantom-version guard. Keys per device_id when present, else
  // per reported version (NOT IP — SNAT). Rate-trips a looping client in seconds.
  // Channel selection. An opted-in display is compared against — and offered — the BETA build's
  // declared version, not the server's. Falls back to stable whenever no usable beta is published,
  // so ticking the box on a server with no beta build is a no-op, not a broken display.
  const onBeta = betaChannel && apkCache.betaAvailable();
  if (onBeta) latestVersion = apkCache.getBeta().version;

  // The hold-my-prerelease guard only applies when we are NOT actively serving a beta: on the beta
  // channel the beta build is the target, so normal comparison does the right thing.
  const verdict = otaBreaker.decide(currentVersion, latestVersion, deviceId, Date.now(), betaChannel && !onBeta, wasOnBeta);

  // Record that this display is being served beta, so switching it back later is distinguishable
  // from a display that has always run its own build. Written only on a change, not per check.
  if (onBeta && !wasOnBeta && deviceId) {
    try {
      require('./db/database').db.prepare("UPDATE devices SET ota_channel_served = 'beta' WHERE id = ?").run(deviceId);
    } catch (_) { /* best-effort bookkeeping; never break a check over it */ }
  }

  // #146 Item C: EARLY-RETURN before any filesystem work when we won't serve
  // (rate-backoff, up-to-date, phantom, client-newer, …). A looping client that gets
  // rate-backoff does ZERO fs calls — the flood can't turn into a statSync flood.
  if (!verdict.update_available) {
    if (verdict.log) console.log(verdict.log);
    logOtaCheck(deviceId, currentVersion, latestVersion, false, verdict.reason);
    return res.json({
      latest_version: latestVersion, current_version: currentVersion || 'unknown',
      update_available: false, reason: verdict.reason, download_url: '/download/apk',
      apk_size: 0, apk_modified: 0,
      ...(verdict.retry_after_seconds ? { retry_after_seconds: verdict.retry_after_seconds } : {}),
    });
  }

  // Offering — read the CACHED apk metadata (no per-request statSync; refreshed on an
  // interval by apkCache). Never offer if the APK isn't actually present.
  const apk = onBeta ? apkCache.getBeta() : apkCache.get();
  const updateAvailable = apk.exists;
  if (verdict.log) console.log(verdict.log);
  logOtaCheck(deviceId, currentVersion, latestVersion, updateAvailable, updateAvailable ? verdict.reason : 'apk-missing');
  res.json({
    latest_version: latestVersion, current_version: currentVersion || 'unknown',
    update_available: updateAvailable, reason: updateAvailable ? verdict.reason : 'apk-missing',
    // The client fetches whatever URL we hand back, so channel routing needs no APK change —
    // a display already in the field can be moved between channels from the dashboard.
    download_url: onBeta ? '/download/apk?channel=beta' : '/download/apk',
    channel: onBeta ? 'beta' : 'stable',
    apk_size: updateAvailable ? apk.size : 0,
    apk_modified: updateAvailable ? apk.mtime : 0,
    // #166 escape hatch (OTA_ALLOW_MANAGED_DEVICES). Tells a player it may self-update even when
    // a foreign DPC owns the device. Always present, so a player can distinguish "the operator
    // said no" from "this server is too old to have an opinion" — both mean stand down, but only
    // the first is a decision.
    allow_managed: !!config.otaAllowManagedDevices,
  });
});

// Exit-signal contract v1 — beacon transport (reliable-on-unload). Clients that can't reliably
// socket.emit at death (browser/Tizen pagehide, APK crash where async emit won't flush) POST their
// manner-of-death here via navigator.sendBeacon / blocking HTTP. Token-authed (there's no JWT/socket
// session at unload time); PUBLIC (mounted before requireAuth). Sets offline_reason exactly like the
// device:exit socket handler — the later Offline transition resolves + surfaces it. NEVER triggers
// offline itself (additive only). Always 204 (never error a dying client; never leak an id/token oracle).
app.post('/api/device/exit', (req, res) => {
  const { db } = require('./db/database');
  const liveness = require('./lib/liveness');
  const { device_id, device_token, reason, detail } = req.body || {};
  if (!device_id || typeof device_token !== 'string') return res.status(204).end();
  const row = db.prepare('SELECT device_token FROM devices WHERE id = ?').get(device_id);
  let ok = false;
  try {
    ok = !!(row && row.device_token && device_token.length === row.device_token.length &&
      crypto.timingSafeEqual(Buffer.from(row.device_token), Buffer.from(device_token)));
  } catch (_) { ok = false; }
  if (!ok) return res.status(204).end();
  const e = liveness.sanitizeExitReason(reason, detail);   // unknown/invalid -> null -> device falls to 'silent'
  if (e) db.prepare("UPDATE devices SET offline_reason = ?, offline_reason_at = strftime('%s','now'), offline_detail = ? WHERE id = ?").run(e.reason, e.detail, device_id);
  res.status(204).end();
});

// (Content file endpoint moved above protected routes)

// (Screenshot route moved above protected routes)

// Serve uploaded content files directly (with CORS for web player canvas capture)
// Long cache for media files — Cloudflare and browsers can cache these aggressively
// Uploads share the dashboard's origin, so the browser's interpretation of them is a
// security boundary. lib/upload-sniff derives every stored extension from the file's
// bytes, but this layer is the BACKSTOP that holds regardless of how a file reached
// disk (a future sniffer gap, a restored backup, a pre-fix row):
//   - `Content-Security-Policy: sandbox` -> if the response is ever treated as a
//     document, it lands in an opaque origin with scripts disabled, so it cannot read
//     the dashboard's localStorage. Images/video loaded as subresources are unaffected
//     (CSP on a response only governs it as a document), so <img>/<video> still work.
//   - anything outside the inline-safe extension set is forced to download as opaque
//     bytes instead of being rendered.
const { INLINE_SAFE_EXTS } = require('./lib/upload-sniff');
function hardenUploadResponse(res, filename) {
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (!INLINE_SAFE_EXTS.has(ext)) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    return false; // caller must not let express override the type
  }
  return true;
}

app.use('/uploads/content', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable'); // 30 days
  hardenUploadResponse(res, req.path);
  next();
}, express.static(config.contentDir, {
  setHeaders: (res, filePath) => {
    // express.static sets Content-Type from the extension AFTER our middleware, so
    // re-assert the override here for anything not inline-safe.
    hardenUploadResponse(res, filePath);
  },
}), (req, res) => {
  /*
   * A miss ENDS here. express.static calls next() when the file isn't there, and the only thing
   * left downstream is the SPA catch-all — so GET /uploads/content/<gone>.mp4 answered 200
   * text/html with 15KB of dashboard, under the `immutable, max-age=30d` header this middleware
   * had already set on the way in.
   *
   * That is the worst possible answer for a player. Every downloader treats 200 as success, so the
   * panel stores the HTML page AS the video, caches it for a month, and plays a black frame with
   * nothing in any log to say why. Android's cache validates the BYTE COUNT, not the type, so a
   * correctly-sized page passes the integrity check and is promoted as a valid asset.
   *
   * It is reachable the moment an asset is replaced (a replace writes a new random filename and
   * unlinks the old one) or a file goes missing from the volume — exactly when a screen most needs
   * to fail loudly.
   *
   * The Cache-Control goes too: 'immutable' is a promise about a file that exists.
   */
  res.removeHeader('Cache-Control');
  res.removeHeader('Content-Disposition');
  res.type('application/json').status(404).json({ error: 'Not found' });
});

// Media proxy for remote (URL-referenced) playlist items — public by construction (players are
// unauthenticated browsers). Takes an itemId, never a caller URL: it fetches the item's stored
// remote_url through the SSRF guard so a WebGL transition can read the bytes same-origin. Must sit
// before the SPA catch-all (app.get('*')) or that would swallow /media/proxy/*.
app.use('/media', require('./routes/media'));

// Setup WebSockets
const setupWebSockets = require('./ws');
const { deviceNs, dashboardNs } = setupWebSockets(io);
app.set('io', io);

// Start heartbeat checker
const { startHeartbeatChecker } = require('./services/heartbeat');
startHeartbeatChecker(io);

// #142: start event-loop lag sampling (feeds /api/status + the reconnect throttle)
const { startLoopLagMonitor } = require('./services/loop-lag');
startLoopLagMonitor();

// Start command-queue sweep (prunes expired entries for offline devices)
const commandQueue = require('./lib/command-queue');
commandQueue.startSweep();

// Start scheduler
const { startScheduler } = require('./services/scheduler');
startScheduler(io);

// #157: auto-deactivate expired content + republish affected playlists
const { startContentExpiry } = require('./services/content-expiry');
startContentExpiry(io);

// Start alert service
const { startAlertService } = require('./services/alerts');
startAlertService(io);


// Start activation-nudge sweep (T+3 onboarding nudge; gated on HOSTED_INSTANCE)
const { startActivationNudge } = require('./services/activationNudge');
startActivationNudge();

// #73: agency-upload digest flush (batched draft/published notifications to admins + owner)
const { startAgencyDigest } = require('./services/agency-digest');
startAgencyDigest();

// Off-main-thread WAL checkpointer: disables inline auto-checkpoint on the main connection
// (the ~60s p99 spike = a synchronous fsync-heavy checkpoint on the loop) and runs PASSIVE
// (escalating to TRUNCATE if starved) from a worker thread. Started AFTER the DB is open+migrated.
const { startWalCheckpointer, stopWalCheckpointer } = require('./db/wal-checkpointer');
startWalCheckpointer(require('./db/database').db, config.dbPath);

// Version update indicator: poll GHCR for latest image tag, cache in memory.
// First poll fires after 30s to let the server stabilize.
ghcrCheck.startPolling(config.ghcrCheckIntervalHours, VERSION);

// Graceful shutdown: stop the checkpointer worker (closes its own DB handle) + flush + close.
let _shuttingDown = false;
function gracefulShutdown(sig) {
  if (_shuttingDown) return; _shuttingDown = true;
  console.log(`[shutdown] ${sig} — stopping WAL checkpointer + closing DB`);
  Promise.resolve(stopWalCheckpointer()).catch(() => {}).finally(() => {
    try { require('./lib/status-log-writer').flush(); } catch (_) {}
    try { require('./db/database').db.close(); } catch (_) {}
    process.exit(0);
  });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle provisioning via WebSocket notification
const { db } = require('./db/database');

// Opt-in install statistics — REPORTER side. Sends nothing until an operator says yes; the timer
// is unref'd so it can never hold the process open, and every failure path is silent and local.
// Must sit AFTER the `db` binding above: `const` is hoisted but uninitialised, so calling this
// earlier in the file throws "Cannot access 'db' before initialization" at load.
require('./lib/telemetry').start(db);

const originalProvisionRoute = require('./routes/provisioning');

// #161: device-owner QR provisioning. Returns the AOSP provisioning payload (DPC component + APK
// download URL + signing-cert checksum), a rendered QR data-URL, and the ADB one-liner — so an
// operator can enroll a fresh/factory-reset panel by scanning (tap the setup-wizard welcome 6x) or
// by cable. Checksum = URL-safe base64 SHA-256 of the SIGNING CERT (constant per key; env-overridable
// if you re-sign). Auth-gated (operator only); the DPC component + public APK URL aren't secrets.
const QRCode = require('qrcode');
const { apkSignatureChecksumCached } = require('./lib/apk-signature');
const DEVICE_ADMIN_COMPONENT = 'com.remotedisplay.player/.admin.STDeviceAdminReceiver';
// Fallback only. The checksum is normally COMPUTED from the actual served APK at request time
// (see below) so the QR is always correct for whatever build is on disk; this constant is used
// only when the APK is absent/unparseable. Env override wins over the baked-in default.
const DEVICE_ADMIN_SIGNATURE_CHECKSUM =
  process.env.DEVICE_ADMIN_SIGNATURE_CHECKSUM || 's9ZOWAvn3qFYJxaaR0j41ZttQK1r6_XgaTMcB7rIqqI';
app.get('/api/provision/device-owner-qr', requireAuth, async (req, res) => {
  try {
    const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const apkUrl = `${base}/download/apk`;
    // Derive the signature checksum from the APK the device will actually download, so it can
    // never drift from the served build. Fall back to the configured constant if the APK isn't
    // present/parseable (in which case the QR would also be pointing at a missing download).
    const apk = apkCache.get();
    let checksum = DEVICE_ADMIN_SIGNATURE_CHECKSUM;
    let checksumSource = 'fallback';
    if (apk.exists && apk.path) {
      const computed = await apkSignatureChecksumCached(apk.path, apk.mtime);
      if (computed) { checksum = computed; checksumSource = 'apk'; }
    }
    const payload = {
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': DEVICE_ADMIN_COMPONENT,
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': apkUrl,
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM': checksum,
      'android.app.extra.PROVISIONING_SKIP_ENCRYPTION': true,
      // Delivered to the player after enrollment so it self-configures the server URL (operator just
      // reads the pairing code — no typing). Purely optional on the client: a build that ignores it,
      // or a plain install, is unaffected.
      'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': { server_url: base },
    };
    const qr = await QRCode.toDataURL(JSON.stringify(payload), { errorCorrectionLevel: 'M', margin: 2, width: 360 });
    res.json({
      component: DEVICE_ADMIN_COMPONENT,
      apk_url: apkUrl,
      signature_checksum: checksum,
      checksum_source: checksumSource,   // 'apk' = computed from the served build; 'fallback' = constant
      apk_present: !!apk.exists,
      payload,
      qr_data_url: qr,
      adb_command: `adb shell dpm set-device-owner ${DEVICE_ADMIN_COMPONENT}`,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to generate provisioning QR', detail: e.message });
  }
});

// Override provision to also notify device via WS
const { checkDeviceLimit } = require('./middleware/subscription');
const pairLockout = require('./lib/pair-lockout');
app.post('/api/provision/pair', requireAuth, resolveTenancy, checkDeviceLimit, (req, res) => {
  // #87: lock out an IP after repeated failed pairing-code guesses (brute-force defense
  // beyond the 5/min rate-limit on /api/provision).
  const ip = getClientIp(req);
  if (pairLockout.isLocked(ip)) {
    return res.status(429).json({ error: 'Too many failed pairing attempts. Try again in a few minutes.' });
  }
  const { pairing_code, name } = req.body;
  if (!pairing_code) return res.status(400).json({ error: 'pairing_code required' });
  // Phase 2.2a: pair into the caller's current workspace. Refusing on no
  // context prevents the regression window where a newly-paired device
  // would have workspace_id NULL and be invisible to workspace-filtered lists.
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before pairing.' });

  const device = db.prepare('SELECT * FROM devices WHERE pairing_code = ?').get(pairing_code);
  // #87: an UNKNOWN code is a brute-force guess - count it toward the per-IP lockout.
  if (!device) {
    pairLockout.recordFailure(ip);
    return res.status(404).json({ error: 'No device found with that pairing code' });
  }
  // An EXPIRED code is a legitimate-but-stale code (a slow rollout, not an attack), so it
  // does NOT count toward the lockout - it just asks the display to regenerate. This keeps
  // a bulk rollout from one office/NAT IP from locking itself out on expired codes.
  // Expiry is keyed on LIVENESS, not on when the row was first created.
  //
  // devices.created_at is written once, at the device's first registration, and the row is
  // never recreated: a player persists its device_id and its pairing code and re-registers
  // with them forever. Keying expiry on created_at therefore made a screen permanently
  // unclaimable 15 minutes after first boot, while it kept heartbeating and kept showing
  // the code — and "restart the display to get a new code" could not help, because a
  // restart reuses the stored identity and produces the same code. Seen in production on a
  // web player whose row was 4 days old, still online, unpairable for all but its first 15
  // minutes.
  //
  // last_heartbeat answers the question the operator actually cares about: is this screen
  // still there showing me this code? A device that has gone away for longer than the TTL
  // still expires, which is what the expiry is for. Fall back to created_at for a row that
  // has never checked in.
  //
  // Trade-off, deliberately taken: a code stays claimable while its screen is connected,
  // rather than for a fixed 15 minutes. That is the behaviour the product implies (the code
  // is displayed on the screen the whole time), and guessing is bounded by lib/pair-lockout
  // (5 failures per IP per 15 min) plus the 5/min route limit, not by this TTL.
  const lastSeen = device.last_heartbeat || device.created_at;
  if (pairLockout.isCodeExpired(lastSeen)) {
    return res.status(410).json({ error: 'Pairing code expired - restart the display to get a new code' });
  }
  pairLockout.reset(ip); // a valid claim forgives prior failed attempts from this IP

  const deviceName = name || 'Display ' + (db.prepare('SELECT COUNT(*) as count FROM devices WHERE user_id = ?').get(req.user.id).count + 1);
  // Generate a random 6-digit PIN for the hidden settings menu — each device gets a
  // unique PIN provisioned by the server (never a hardcoded default). CSPRNG-backed
  // (lib/numeric-code): this PIN gates the on-device settings menu and is observable in
  // device API responses, so Math.random's recoverable state would let one tenant predict
  // another's.
  const settingsPin = sixDigitCode();
  db.prepare("UPDATE devices SET pairing_code = NULL, name = ?, user_id = ?, workspace_id = ?, status = 'online', settings_pin = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(deviceName, req.user.id, req.workspaceId, settingsPin, device.id);

  // Link fingerprint to user
  db.prepare("UPDATE device_fingerprints SET user_id = ?, device_id = ? WHERE device_id = ?")
    .run(req.user.id, device.id, device.id);

  // Notify the device via WebSocket
  deviceNs.to(device.id).emit('device:paired', { device_id: device.id, name: deviceName, settings_pin: settingsPin });

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id);
  require('./lib/device-sanitize').stripDeviceSecrets(updated); // never leak device_token to clients
  // Phase 2.3: scope to the workspace the device was just claimed into.
  const { workspaceRoom, emitToWorkspace } = require('./lib/socket-rooms');
  emitToWorkspace(dashboardNs, workspaceRoom(updated.workspace_id), 'dashboard:device-added', updated);

  res.json(updated);
});

// #146 Item C/E: OTA update-check log — COALESCED (one summarized line per reason per
// window) so a poll flood can't turn synchronous stdout writes into a loop hog. Never
// keys on IP for any decision (SNAT).
const logCoalescer = require('./lib/log-coalescer');
function logOtaCheck(deviceId, client, latest, available, reason) {
  logCoalescer.record(`ota-check:${reason}:${available}`, `[ota] update check: latest=${latest} update_available=${available} reason=${reason}`);
}

// #146 Item C: GLOBAL download admission (lib/ota-download-guard) — concurrency + rate
// caps + critical-band shed, NEVER per-IP (SNAT). Single bounded rolling state.
const otaDownloadGuard = require('./lib/ota-download-guard');
const otaDownloadState = otaDownloadGuard.prodState();   // #146 P3.8: shared singleton so /api/status can read stats

app.get('/download/apk', (req, res) => {
  // Serve the slot the check advertised. If these disagree the client is handed bytes whose
  // size does not match apk_size, which is how an OTA loop starts — so both sides resolve
  // the channel the same way, and both fall back to stable identically.
  const apk = apkCache.forChannel(req.query.channel === 'beta' ? 'beta' : 'stable');
  if (!apk.exists) {
    return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>APK Not Available — ScreenTinker</title><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}div{text-align:center;max-width:480px;padding:32px 24px}h1{color:#f87171;font-size:22px;margin:0 0 8px}p{line-height:1.6;color:#94a3b8;font-size:14px;margin:0 0 20px}code{background:#1e293b;padding:2px 6px;border-radius:4px;font-size:13px}a{color:#3b82f6;text-decoration:none}a:hover{text-decoration:underline}.btn{display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:500;text-decoration:none;margin-bottom:24px}.btn:hover{background:#1d4ed8;text-decoration:none}.muted{font-size:12px;color:#64748b}</style></head><body><div><h1>APK Not Available</h1><p>The Android APK has not been compiled yet.</p><a class="btn" href="https://github.com/screentinker/screentinker/releases/latest" target="_blank" rel="noopener">&#128230; Download from GitHub Releases</a><p class="muted">Self-hosting? Mount a built APK at <code>/data/ScreenTinker.apk</code> to serve it from this instance. Or use the <a href="/player">web player</a> instead.</p></div></body></html>`);
  }

  const verdict = otaDownloadGuard.admit(otaDownloadState, getBand());
  if (verdict.summary) {
    console.log(`[ota] downloads last ${Math.round(config.otaDownloadWindowMs / 1000)}s: ${verdict.summary.served} served, ${verdict.summary.shed} shed (in-flight ${verdict.summary.inFlight})`);
  }
  if (!verdict.allow) {
    res.setHeader('Retry-After', String(verdict.retryAfter));
    return res.status(verdict.status).json({ error: 'download capacity reached, retry shortly', retry_after: verdict.retryAfter });
  }

  let released = false;
  const release = () => { if (released) return; released = true; otaDownloadGuard.release(otaDownloadState); };
  res.on('finish', release); res.on('close', release);
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="ScreenTinker.apk"');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(apk.path, (err) => { if (err) release(); });
});

// ==================== Tizen SSSP URL-Launcher install ====================
// One-URL native install for Samsung signage panels (SSSP), the same flow Fusion/OptiSigns
// use: on the panel, enter this server's /tizen URL under URL Launcher / Custom App. The panel
// fetches /tizen/sssp_config.xml, reads the version + size, downloads /tizen/ScreenTinker.wgt,
// and installs it as a native app (auto-updating when <ver> bumps on the next release).
//
// The served .wgt must be signed with a Samsung PARTNER distributor certificate to install on
// retail/commercial panels — mount the signed build at /data/ScreenTinker.wgt. A dev-mode panel
// accepts a self-signed build. See tizen/README.md.
function tizenNotAvailable(res) {
  return res.status(404).send('<!DOCTYPE html><html><head><title>Tizen Player Not Available</title>'
    + '<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}div{text-align:center;max-width:520px;padding:24px}h1{color:#f87171;font-size:24px}code{background:#1e293b;padding:2px 8px;border-radius:4px;font-size:14px}p{line-height:1.6;color:#94a3b8}</style></head>'
    + '<body><div><h1>Tizen App Not Available</h1><p>No signed <code>ScreenTinker.wgt</code> is hosted on this instance. Mount one at <code>/data/ScreenTinker.wgt</code>, or point the panel’s URL Launcher at the web player: <a href="/player" style="color:#3b82f6">/player</a>.</p></div></body></html>');
}

// The manifest the panel fetches. Dynamic so <size> always matches the exact bytes we serve.
app.get('/tizen/sssp_config.xml', (req, res) => {
  const wgt = wgtCache.get();
  if (!wgt.exists) return tizenNotAvailable(res);
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(wgtCache.ssspConfigXml(wgt));
});

// The widget package. Named <widgetname>.wgt from the manifest so the panel resolves it here.
app.get('/tizen/ScreenTinker.wgt', (req, res) => {
  const wgt = wgtCache.get();
  if (!wgt.exists) return tizenNotAvailable(res);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="ScreenTinker.wgt"');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(wgt.path);
});

// Human-facing landing (a panel appends /sssp_config.xml itself, so it never lands here).
app.get(['/tizen', '/tizen/'], (req, res) => {
  const wgt = wgtCache.get();
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const ready = wgt.exists;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>ScreenTinker on Samsung (Tizen)</title>'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:40px 20px;line-height:1.6}'
    + '.w{max-width:640px;margin:0 auto}h1{color:#34d399}code{background:#1e293b;padding:2px 8px;border-radius:4px;font-size:14px}'
    + 'ol{padding-left:20px}li{margin:8px 0}.mut{color:#94a3b8;font-size:14px}.pill{display:inline-block;background:#1e293b;border-radius:20px;padding:4px 12px;font-size:13px;color:#94a3b8}</style></head>'
    + '<body><div class="w"><h1>ScreenTinker — Samsung Signage (Tizen)</h1>'
    + (ready ? `<p class="pill">Ready · v${wgt.version} · ${(wgt.size/1024/1024).toFixed(2)} MB</p>` : '<p class="pill">No signed .wgt hosted yet</p>')
    + '<p>On the Samsung signage panel, go to <b>URL Launcher / Custom App</b> and enter:</p>'
    + `<p><code>${base}/tizen</code></p>`
    + '<p>The panel installs the ScreenTinker player as a native app, then shows a 6-digit pairing code to claim in your dashboard.</p>'
    + '<p class="mut">Requires a Samsung Partner-signed build on retail panels. No signed build? Point URL Launcher at '
    + `<code>${base}/player</code> to run the web player instead.</p>`
    + '</div></body></html>');
});

// SPA fallback for app routes. Unmatched /api/ paths return 404 so misrouted
// clients fail fast instead of hanging until Cloudflare's 15s upstream timeout.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(config.frontendDir, 'index.html'));
});

const listenPort = hasSsl ? config.httpsPort : config.port;
const protocol = hasSsl ? 'https' : 'http';

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║       ScreenTinker Server v${VERSION.padEnd(22).slice(0, 22)}║
║──────────────────────────────────────────────────║
║  Dashboard: ${protocol}://localhost:${String(listenPort).padEnd(5)}              ║
║  API:       ${protocol}://localhost:${String(listenPort).padEnd(5)}/api          ║
║  SSL:       ${hasSsl ? 'ENABLED ✓' : 'DISABLED (no certs found)'}${hasSsl ? '                       ' : '         '}║
║──────────────────────────────────────────────────║
║  Listening on all interfaces (0.0.0.0)           ║
╚══════════════════════════════════════════════════╝
  `);

  // Email transport diagnostics — a partially-configured transport is a real
  // misconfiguration (some fields set, others missing) and gets a loud line;
  // a fully-unset transport just falls back to the stdout logger silently.
  try {
    const es = require('./services/email').emailConfigStatus();
    if (es.invalidTransport) {
      console.error(`[EMAIL] EMAIL_TRANSPORT="${es.rawTransport}" is invalid — expected "graph" or "smtp". Falling back to graph.`);
    }
    if (es.partiallyConfigured) {
      console.error(`[EMAIL] ${es.transport.toUpperCase()} transport selected but MISCONFIGURED — missing: ${es.missing.join(', ')}. Email delivery is DISABLED until these are set.`);
    } else if (es.configured) {
      console.log(`[EMAIL] transport: ${es.transport} (configured)`);
    } else {
      console.log(`[EMAIL] transport: ${es.transport} (not configured — emails log to stdout only)`);
    }
  } catch (e) {
    console.error(`[EMAIL] config check failed: ${e.message}`);
  }

  // Media tooling diagnostics — ffmpeg/ffprobe are SYSTEM dependencies that video
  // thumbnail + duration extraction needs. Ingest is best-effort, so without them
  // every video uploads fine and silently gets no thumbnail: exactly the kind of
  // misconfiguration that deserves a loud line, like the email block above.
  // (The probe is async so a hung binary can't block serving on the bound port.)
  require('./lib/media-tools').mediaToolStatus()
    .then((mt) => {
      if (!mt.ffmpeg || !mt.ffprobe) {
        const missing = [!mt.ffmpeg && 'ffmpeg', !mt.ffprobe && 'ffprobe'].filter(Boolean).join(', ');
        console.error(`[MEDIA] ${missing} not found on PATH — video thumbnails and durations are DISABLED until installed (e.g. apt-get install ffmpeg). Image thumbnails are unaffected.`);
      } else {
        console.log('[MEDIA] ffmpeg/ffprobe found — video thumbnails enabled');
      }
    })
    .catch((e) => console.error(`[MEDIA] tooling check failed: ${e.message}`));

  // Heal rows that missed ingest-time thumbnail generation (uploads from before the
  // feature, or videos uploaded while ffmpeg was missing). Delayed past boot so it
  // never competes with startup work; paced internally so it never competes with
  // serving. Timer unref'd: it must not hold the process open on shutdown.
  setTimeout(() => {
    require('./lib/thumbnail-backfill').backfillMissingThumbnails()
      .then((s) => {
        if (s.scanned > 0) console.log(`[MEDIA] thumbnail backfill: ${s.generated} generated, ${s.skipped} skipped, ${s.failed} failed (of ${s.scanned} without thumbnails)`);
      })
      .catch((e) => console.error(`[MEDIA] thumbnail backfill failed: ${e.message}`));
  }, 15000).unref();
});

// If SSL is enabled, also start an HTTP server that redirects to HTTPS
if (hasSsl) {
  const redirectApp = express();
  redirectApp.use((req, res) => {
    const host = req.headers.host?.replace(`:${config.port}`, `:${config.httpsPort}`) || `localhost:${config.httpsPort}`;
    res.redirect(301, `https://${host}${req.url}`);
  });
  http.createServer(redirectApp).listen(config.port, '0.0.0.0', () => {
    console.log(`  HTTP redirect: http://localhost:${config.port} → https://localhost:${config.httpsPort}\n`);
  });
}
