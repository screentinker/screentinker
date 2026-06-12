const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const VERSION = require('./version');

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
    scriptSrc: ["'self'"],
    scriptSrcAttr: ["'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    styleSrcAttr: ["'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    mediaSrc: ["'self'", 'blob:', 'https:'],
    connectSrc: ["'self'", 'wss:', 'ws:', 'https:'],
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
  if (req.path.startsWith('/api/widgets/') && req.path.endsWith('/render')) return next();
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

// Serve web player at /player (same no-cache for JS/HTML). The index.html
// route above intercepts the HTML requests; everything else still falls
// through to this static handler (debug-overlay.js, sw.js, manifest, etc).
app.use('/player', express.static(path.join(__dirname, 'player'), { etag: true, lastModified: true, setHeaders: (res, filePath) => {
  if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache');
  }
}}));

// Serve setup scripts
app.use('/scripts', express.static(path.join(__dirname, '..', 'scripts')));

// Serve socket.io client
app.use('/socket.io-client', express.static(
  path.join(__dirname, 'node_modules', 'socket.io', 'client-dist')
));

// Simple rate limiter for auth endpoints
const rateLimits = new Map();
function rateLimit(windowMs, maxRequests) {
  return (req, res, next) => {
    const key = getClientIp(req) + req.path;
    const now = Date.now();
    const windowStart = now - windowMs;
    let hits = rateLimits.get(key) || [];
    hits = hits.filter(t => t > windowStart);
    if (hits.length >= maxRequests) {
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
// Admin password-reset endpoint: even if an admin's session is compromised,
// cap the blast radius to 20 resets/min/IP. Express matches the longest
// path prefix first, so this fires before /api/auth catches the request.
app.use('/api/auth/users', rateLimit(60000, 20));
app.use('/api/auth', require('./routes/auth'));
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
const { verifyToken } = require('./middleware/auth');
app.get('/api/devices/:id/screenshot', (req, res) => {
  let user = null;
  const authHeader = req.headers.authorization;
  const tokenParam = req.query.token;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : tokenParam;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = verifyToken(token);
    const { db } = require('./db/database');
    user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
  } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  const { db: sdb } = require('./db/database');
  const device = sdb.prepare('SELECT user_id FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!['admin','superadmin'].includes(user.role) && device.user_id && device.user_id !== user.id) return res.status(403).json({ error: 'Access denied' });
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
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(m[1], config.jwtSecret, { algorithms: ['HS256'] });
    if (!decoded || !decoded.id) return false;
    if (decoded.role === 'platform_admin') return true;
    const { db } = require('./db/database');
    return !!db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(content.workspace_id, decoded.id);
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
  res.sendFile(safePath);
});

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
  const safePath = path.resolve(config.contentDir, path.basename(content.thumbnail_path));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  res.sendFile(safePath);
});

// Protected API Routes.
// Phase 2.1: resolveTenancy runs right after requireAuth on every resource
// route. It attaches req.workspaceId, req.workspaceRole, req.orgRole,
// req.isPlatformAdmin, req.actingAs. Route handlers in 2.1 don't read these
// yet (they still filter by user_id); 2.2 will migrate them one route at a time.
const { requireAuth } = require('./middleware/auth');
const { resolveTenancy } = require('./lib/tenancy');
// Public API token front door (Phase 1). Attached ONLY to the public routers below.
const { bearerAuth, tokenScopeGate } = require('./middleware/apiToken');

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
const { PUBLIC_ROUTERS, JWT_ONLY_ROUTERS } = require('./config/api-surface');

// Public device-render endpoints + the memory-heavy preview limiter must be registered
// BEFORE their parent router mount so the _skipAuth bypass / the limiter fire first.
app.get('/api/widgets/:id/render', (req, res, next) => { req._skipAuth = true; next(); });
app.use('/api/widgets/preview', rateLimit(60000, 30)); // base64 inline = memory-intensive
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
  res.json({ hash: frontendHash, version: VERSION });
});

// Public status page
app.use('/api/status', require('./routes/status'));

// Activity logging middleware now mounted earlier (just before the workspace
// route block) - leaving this comment here as a breadcrumb for the move.

// APK version check endpoint (public, used by devices to check for updates)
app.get('/api/update/check', (req, res) => {
  const currentVersion = req.query.version;
  const apkPath = resolveApkPath();
  const apkExists = apkPath !== null;
  const apkSize = apkExists ? fs.statSync(apkPath).size : 0;
  const apkModified = apkExists ? fs.statSync(apkPath).mtimeMs : 0;

  const latestVersion = VERSION;
  const updateAvailable = currentVersion && currentVersion !== latestVersion;

  res.json({
    latest_version: latestVersion,
    current_version: currentVersion || 'unknown',
    update_available: updateAvailable,
    download_url: '/download/apk',
    apk_size: apkSize,
    apk_modified: apkModified,
  });
});

// (Content file endpoint moved above protected routes)

// (Screenshot route moved above protected routes)

// Serve uploaded content files directly (with CORS for web player canvas capture)
// Long cache for media files — Cloudflare and browsers can cache these aggressively
app.use('/uploads/content', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable'); // 30 days
  next();
}, express.static(config.contentDir));

// Setup WebSockets
const setupWebSockets = require('./ws');
const { deviceNs, dashboardNs } = setupWebSockets(io);
app.set('io', io);

// Start heartbeat checker
const { startHeartbeatChecker } = require('./services/heartbeat');
startHeartbeatChecker(io);

// Start command-queue sweep (prunes expired entries for offline devices)
const commandQueue = require('./lib/command-queue');
commandQueue.startSweep();

// Start scheduler
const { startScheduler } = require('./services/scheduler');
startScheduler(io);

// Start alert service
const { startAlertService } = require('./services/alerts');
startAlertService(io);

// Start activation-nudge sweep (T+3 onboarding nudge; gated on HOSTED_INSTANCE)
const { startActivationNudge } = require('./services/activationNudge');
startActivationNudge();

// Handle provisioning via WebSocket notification
const { db } = require('./db/database');
const originalProvisionRoute = require('./routes/provisioning');

// Override provision to also notify device via WS
const { checkDeviceLimit } = require('./middleware/subscription');
app.post('/api/provision/pair', requireAuth, resolveTenancy, checkDeviceLimit, (req, res) => {
  const { pairing_code, name } = req.body;
  if (!pairing_code) return res.status(400).json({ error: 'pairing_code required' });
  // Phase 2.2a: pair into the caller's current workspace. Refusing on no
  // context prevents the regression window where a newly-paired device
  // would have workspace_id NULL and be invisible to workspace-filtered lists.
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before pairing.' });

  const device = db.prepare('SELECT * FROM devices WHERE pairing_code = ?').get(pairing_code);
  if (!device) return res.status(404).json({ error: 'No device found with that pairing code' });

  const deviceName = name || 'Display ' + (db.prepare('SELECT COUNT(*) as count FROM devices WHERE user_id = ?').get(req.user.id).count + 1);
  db.prepare("UPDATE devices SET pairing_code = NULL, name = ?, user_id = ?, workspace_id = ?, status = 'online', updated_at = strftime('%s','now') WHERE id = ?")
    .run(deviceName, req.user.id, req.workspaceId, device.id);

  // Link fingerprint to user
  db.prepare("UPDATE device_fingerprints SET user_id = ?, device_id = ? WHERE device_id = ?")
    .run(req.user.id, device.id, device.id);

  // Notify the device via WebSocket
  deviceNs.to(device.id).emit('device:paired', { device_id: device.id, name: deviceName });

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id);
  require('./lib/device-sanitize').stripDeviceSecrets(updated); // never leak device_token to clients
  // Phase 2.3: scope to the workspace the device was just claimed into.
  const { workspaceRoom, emitToWorkspace } = require('./lib/socket-rooms');
  emitToWorkspace(dashboardNs, workspaceRoom(updated.workspace_id), 'dashboard:device-added', updated);

  res.json(updated);
});

// Resolve the OTA APK. A copy under the data dir (DATA_DIR) wins, so a container
// operator can mount one at /data/ScreenTinker.apk; otherwise the legacy in-repo
// root path (unchanged when DATA_DIR is unset). Returns null if neither exists.
function resolveApkPath() {
  for (const p of [path.join(config.dataDir, 'ScreenTinker.apk'), path.join(__dirname, '..', 'ScreenTinker.apk')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Serve APK download
app.get('/download/apk', (req, res) => {
  const apkPath = resolveApkPath();
  if (apkPath) {
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="ScreenTinker.apk"');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(apkPath);
  } else {
    res.status(404).send(`<!DOCTYPE html><html><head><title>APK Not Found</title><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}div{text-align:center;max-width:500px;padding:24px}h1{color:#f87171;font-size:24px}code{background:#1e293b;padding:2px 8px;border-radius:4px;font-size:14px}p{line-height:1.6;color:#94a3b8}</style></head><body><div><h1>APK Not Available</h1><p>The Android APK has not been compiled yet. To build it from source:</p><p><code>cd android</code><br><code>./gradlew assembleDebug</code><br><code>cp app/build/outputs/apk/debug/app-debug.apk ../ScreenTinker.apk</code></p><p>See the <a href="/" style="color:#3b82f6">README</a> for full build instructions.</p><p>In Docker, mount a built APK at <code>/data/ScreenTinker.apk</code> (the data dir).</p><p>Alternatively, use the <a href="/player" style="color:#3b82f6">web player</a> in any browser.</p></div></body></html>`);
  }
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
║       ScreenTinker Server v1.2.0                ║
║──────────────────────────────────────────────────║
║  Dashboard: ${protocol}://localhost:${String(listenPort).padEnd(5)}              ║
║  API:       ${protocol}://localhost:${String(listenPort).padEnd(5)}/api          ║
║  SSL:       ${hasSsl ? 'ENABLED ✓' : 'DISABLED (no certs found)'}${hasSsl ? '                       ' : '         '}║
║──────────────────────────────────────────────────║
║  Listening on all interfaces (0.0.0.0)           ║
╚══════════════════════════════════════════════════╝
  `);
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
