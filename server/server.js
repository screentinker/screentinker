const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// Ensure upload directories exist
[config.contentDir, config.screenshotsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
app.set('trust proxy', 1);

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

const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 10 * 1024 * 1024 // 10MB for screenshot uploads
});

// Middleware
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts in widget renders
  crossOriginEmbedderPolicy: false, // Allow loading external widget content
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));
// CORS: open for public content (kiosk, widgets, player, uploads), restricted for API
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, server-to-server, kiosk iframes)
    if (!origin) return callback(null, true);
    // Allow all origins - auth is handled by JWT, not CORS
    // Devices, kiosks, and web players need cross-origin access
    callback(null, true);
  },
  credentials: true,
}));
// Stripe webhook needs raw body (before express.json parses it)
const stripeRouter = require('./routes/stripe');
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeRouter);

app.use(express.json());
const { sanitizeBody } = require('./middleware/sanitize');
app.use(sanitizeBody);

// Landing page BEFORE static middleware (so / doesn't serve index.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(config.frontendDir, 'landing.html'));
});

// Dashboard app
app.get('/app', (req, res) => {
  res.sendFile(path.join(config.frontendDir, 'index.html'));
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

// Serve web player at /player (same no-cache for JS/HTML)
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
    const key = req.ip + req.path;
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
app.use('/api/auth', require('./routes/auth'));
// Rate limit pairing to prevent brute force (5 attempts per minute per IP)
app.use('/api/provision/pair', rateLimit(60000, 5));
// Rate limit expensive operations
app.use('/api/status/export', rateLimit(60000, 5)); // 5 exports per minute
app.use('/api/status/import', rateLimit(60000, 3)); // 3 imports per minute
app.use('/api/content', rateLimit(60000, 30)); // 30 content operations per minute

// Subscription routes (mixed auth)
app.use('/api/subscription', require('./routes/subscription'));

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
  const screenshot = sdb.prepare('SELECT * FROM screenshots WHERE device_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.id);
  if (!screenshot) return res.status(404).json({ error: 'No screenshot available' });
  const safePath = path.resolve(config.screenshotsDir, path.basename(screenshot.filepath));
  if (!safePath.startsWith(path.resolve(config.screenshotsDir))) return res.status(403).json({ error: 'Invalid path' });
  res.sendFile(safePath);
});

// Public content file serving (must be BEFORE protected routes)
app.get('/api/content/:id/file', (req, res) => {
  const { db } = require('./db/database');
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  if (!content.filepath) return res.status(404).json({ error: 'No file (remote URL content)' });
  const assigned = db.prepare('SELECT id FROM playlist_items WHERE content_id = ? LIMIT 1').get(req.params.id);
  if (!assigned) return res.status(403).json({ error: 'Content not assigned to any playlist' });
  const safePath = path.resolve(config.contentDir, path.basename(content.filepath));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  res.sendFile(safePath);
});

// Public thumbnail serving (must be BEFORE protected routes)
app.get('/api/content/:id/thumbnail', (req, res) => {
  const { db } = require('./db/database');
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content || !content.thumbnail_path) return res.status(404).json({ error: 'Thumbnail not found' });
  const safePath = path.resolve(config.contentDir, path.basename(content.thumbnail_path));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  res.sendFile(safePath);
});

// Protected API Routes
const { requireAuth } = require('./middleware/auth');
app.use('/api/devices', requireAuth, require('./routes/devices'));
app.use('/api/content', requireAuth, require('./routes/content'));
app.use('/api/assignments', requireAuth, require('./routes/assignments'));
app.use('/api/provision', requireAuth, require('./routes/provisioning'));
app.use('/api/layouts', requireAuth, require('./routes/layouts'));
// Widget render is public (accessed by devices)
app.get('/api/widgets/:id/render', (req, res, next) => { req._skipAuth = true; next(); });
app.use('/api/widgets', (req, res, next) => { if (req._skipAuth) return next(); requireAuth(req, res, next); }, require('./routes/widgets'));
app.use('/api/schedules', requireAuth, require('./routes/schedules'));
app.use('/api/walls', requireAuth, require('./routes/video-walls'));
app.use('/api/teams', requireAuth, require('./routes/teams'));
app.use('/api/reports', requireAuth, require('./routes/reports'));
app.use('/api/groups', requireAuth, require('./routes/device-groups'));
app.use('/api/playlists', requireAuth, require('./routes/playlists'));
app.use('/api/activity', requireAuth, require('./routes/activity'));
app.use('/api/white-label', requireAuth, require('./routes/white-label'));
// Kiosk render is public (accessed by devices), CRUD is protected
app.get('/api/kiosk/:id/render', (req, res, next) => {
  // Let it through to the kiosk route without auth
  req._skipAuth = true;
  next();
});
app.use('/api/kiosk', (req, res, next) => {
  if (req._skipAuth) return next();
  requireAuth(req, res, next);
}, require('./routes/kiosk'));

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
    frontendHash = crypto.createHash('md5').update(Buffer.concat(files.map(f => Buffer.from(f)))).digest('hex').slice(0, 8);
  } catch { frontendHash = Date.now().toString(36); }
}
updateFrontendHash();
// Recheck every 30 seconds
setInterval(updateFrontendHash, 30000);
app.get('/api/version', (req, res) => {
  let version = '1.2.0';
  try { version = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim(); } catch {}
  res.json({ hash: frontendHash, version });
});

// Public status page
app.use('/api/status', require('./routes/status'));

// Activity logging middleware (after auth, before routes respond)
const { activityLogger } = require('./services/activity');
app.use(activityLogger);

// APK version check endpoint (public, used by devices to check for updates)
app.get('/api/update/check', (req, res) => {
  const currentVersion = req.query.version;
  const apkPath = path.join(__dirname, '..', 'ScreenTinker.apk');
  const apkExists = fs.existsSync(apkPath);
  const apkSize = apkExists ? fs.statSync(apkPath).size : 0;
  const apkModified = apkExists ? fs.statSync(apkPath).mtimeMs : 0;

  // Read version from a version file, or use the APK modification time as a version indicator
  const versionFile = path.join(__dirname, '..', 'VERSION');
  let latestVersion = '1.0.0';
  try {
    if (fs.existsSync(versionFile)) latestVersion = fs.readFileSync(versionFile, 'utf8').trim();
  } catch {}

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

// Start scheduler
const { startScheduler } = require('./services/scheduler');
startScheduler(io);

// Start alert service
const { startAlertService } = require('./services/alerts');
startAlertService(io);

// Handle provisioning via WebSocket notification
const { db } = require('./db/database');
const originalProvisionRoute = require('./routes/provisioning');

// Override provision to also notify device via WS
const { checkDeviceLimit } = require('./middleware/subscription');
app.post('/api/provision/pair', requireAuth, checkDeviceLimit, (req, res) => {
  const { pairing_code, name } = req.body;
  if (!pairing_code) return res.status(400).json({ error: 'pairing_code required' });

  const device = db.prepare('SELECT * FROM devices WHERE pairing_code = ?').get(pairing_code);
  if (!device) return res.status(404).json({ error: 'No device found with that pairing code' });

  const deviceName = name || 'Display ' + (db.prepare('SELECT COUNT(*) as count FROM devices WHERE user_id = ?').get(req.user.id).count + 1);
  db.prepare("UPDATE devices SET pairing_code = NULL, name = ?, user_id = ?, status = 'online', updated_at = strftime('%s','now') WHERE id = ?")
    .run(deviceName, req.user.id, device.id);

  // Link fingerprint to user
  db.prepare("UPDATE device_fingerprints SET user_id = ?, device_id = ? WHERE device_id = ?")
    .run(req.user.id, device.id, device.id);

  // Notify the device via WebSocket
  deviceNs.to(device.id).emit('device:paired', { device_id: device.id, name: deviceName });

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id);
  dashboardNs.emit('dashboard:device-added', updated);

  res.json(updated);
});

// Serve APK download
const apkPath = path.join(__dirname, '..', 'ScreenTinker.apk');
app.get('/download/apk', (req, res) => {
  if (fs.existsSync(apkPath)) {
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="ScreenTinker.apk"');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(apkPath);
  } else {
    res.status(404).send(`<!DOCTYPE html><html><head><title>APK Not Found</title><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}div{text-align:center;max-width:500px;padding:24px}h1{color:#f87171;font-size:24px}code{background:#1e293b;padding:2px 8px;border-radius:4px;font-size:14px}p{line-height:1.6;color:#94a3b8}</style></head><body><div><h1>APK Not Available</h1><p>The Android APK has not been compiled yet. To build it from source:</p><p><code>cd android</code><br><code>./gradlew assembleDebug</code><br><code>cp app/build/outputs/apk/debug/app-debug.apk ../ScreenTinker.apk</code></p><p>See the <a href="/" style="color:#3b82f6">README</a> for full build instructions.</p><p>Alternatively, use the <a href="/player" style="color:#3b82f6">web player</a> in any browser.</p></div></body></html>`);
  }
});

// SPA fallback for app routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(config.frontendDir, 'index.html'));
  }
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
