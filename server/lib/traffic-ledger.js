'use strict';

/*
 * Bandwidth this server SERVES, for the platform admin's Traffic page. Two layers:
 *
 *   1. ATTRIBUTED: every HTTP response's bytes (and every device socket's), by category
 *      (content, embedded frames, OTA/APK, player assets, API, sockets, web) and by workspace and
 *      device when known. Answers "who and what is using the bandwidth".
 *   2. HOST: the network interface's own counters (/proc/net/dev). Everything that leaves the box,
 *      including what never touches Express (WebRTC live video, backups, SSH, OS updates). This is
 *      what a hosting bill is measured on. The gap between the two is non-web traffic.
 *
 * Counting is in memory (one Map update per response) and flushed once a minute, so the request
 * path does no database work. Bytes are the SOCKET's delta across the request, so file streams,
 * sendFile, express.static and the headers themselves are all included without wrapping res.write.
 *
 * Sister of lib/outbound-ledger.js, which counts the other direction (calls this server makes).
 * Nothing here leaves the server: no third-party analytics (a deliberate privacy choice).
 *
 * Tables (db/database.js):
 *   traffic_hourly        (hour, node, category, workspace_id)  35 days, the 24h/7d charts
 *   traffic_daily         (day, node, category, workspace_id)   400 days, the 30/90-day view
 *   traffic_device_daily  (day, node, device_id)                 90 days, the top-screens list
 *   host_traffic_hourly   (hour, node, iface)                    400 days, small (a row per NIC per hour)
 */

const fs = require('fs');
const os = require('os');

const NODE = (process.env.TRAFFIC_NODE_ID || os.hostname() || 'node').slice(0, 64);
const RETENTION = { hourly: 35, daily: 400, device: 90, host: 400 };
const FLUSH_MS = 60 * 1000;

const HOUR = 3600;
const hourOf = (sec) => Math.floor(sec / HOUR) * HOUR;
const dayOf = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const nowSec = () => Math.floor(Date.now() / 1000);

let dbRef = null;
// key -> { hour, category, workspace_id, device_id, requests, bytes_in, bytes_out }
let pending = new Map();

/*
 * What a request is, from its path. Order matters: the content/embedded/raster/OTA routes all live
 * under /api, so they are matched before the generic /api bucket.
 */
const CATEGORIES = ['content', 'embedded', 'raster', 'ota', 'player', 'api', 'socket', 'web'];
function categorize(path) {
  const p = String(path || '').split('?')[0];
  if (p.startsWith('/uploads/') || /^\/api\/content\/[^/]+\/(file|bundle|variant|thumbnail)/.test(p)) return 'content';
  if (p.startsWith('/api/embedded/firmware') || p.startsWith('/download/') || p.startsWith('/api/update')) return 'ota';
  if (p.startsWith('/api/embedded')) return 'embedded';
  if (p.startsWith('/api/player/raster')) return 'raster';
  if (/^\/(player|tizen|webos|sssp3|brightsign|roku|vega)(\/|$)/.test(p)) return 'player';
  if (p.startsWith('/api/')) return 'api';
  return 'web';
}

function add(category, workspaceId, deviceId, bytesIn, bytesOut, requests = 1, at = nowSec()) {
  if (!(bytesIn > 0 || bytesOut > 0)) return;
  const hour = hourOf(at);
  const ws = workspaceId ? String(workspaceId).slice(0, 64) : '';
  const dev = deviceId ? String(deviceId).slice(0, 64) : '';
  const key = `${hour}|${category}|${ws}|${dev}`;
  const row = pending.get(key) || { hour, category, workspace_id: ws, device_id: dev, requests: 0, bytes_in: 0, bytes_out: 0 };
  row.requests += requests;
  row.bytes_in += bytesIn;
  row.bytes_out += bytesOut;
  pending.set(key, row);
}

/* Small bounded lookups, so attributing /uploads/<file> or a content id costs one indexed read per file. */
const lookupCache = new Map();
const LOOKUP_MAX = 5000;
function cached(key, fn) {
  if (lookupCache.has(key)) return lookupCache.get(key);
  let v = null;
  try { v = fn(); } catch (_) { v = null; }
  if (lookupCache.size >= LOOKUP_MAX) lookupCache.clear();
  lookupCache.set(key, v);
  return v;
}

/* The workspace a request was for, from whatever the request already knows. */
function attribute(req, res) {
  const locals = (res && res.locals) || {};
  let ws = locals.trafficWorkspaceId || req.workspaceId || (req.device && req.device.workspace_id) || null;
  const dev = locals.trafficDeviceId || (req.device && req.device.id) || null;
  if (!ws && dbRef) {
    const p = String(req.originalUrl || req.url || '').split('?')[0];
    let m = /^\/uploads\/content\/([^/]+)$/.exec(p);
    if (m) {
      const file = decodeURIComponent(m[1]);
      ws = cached(`f:${file}`, () => dbRef.prepare('SELECT workspace_id FROM content WHERE filepath = ? LIMIT 1').get(file)?.workspace_id || null);
    } else if ((m = /^\/api\/content\/([^/]+)\//.exec(p))) {
      const id = m[1];
      ws = cached(`c:${id}`, () => dbRef.prepare('SELECT workspace_id FROM content WHERE id = ?').get(id)?.workspace_id || null);
    }
  }
  return { ws, dev };
}

/**
 * Express middleware: count each response's bytes from the socket's own counters. Mounted first,
 * so it sees every request Express handles. A keep-alive socket serves requests one after another,
 * so the delta across one request is that request's bytes.
 */
// Each connection's counters as of the end of its last request. The request line and headers are
// read off the socket BEFORE any middleware runs, so a snapshot taken here would miss them.
const sockMark = new WeakMap();
function middleware() {
  return (req, res, next) => {
    const sock = req.socket;
    if (!sock) return next();
    const mark = sockMark.get(sock) || { out: 0, in: 0 };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        const nowOut = sock.bytesWritten || 0, nowIn = sock.bytesRead || 0;
        const out = Math.max(0, nowOut - mark.out);
        const inn = Math.max(0, nowIn - mark.in);
        sockMark.set(sock, { out: nowOut, in: nowIn });
        const { ws, dev } = attribute(req, res);
        add(categorize(req.originalUrl || req.url), ws, dev, inn, out);
      } catch (_) { /* never let accounting break a response */ }
    };
    res.on('finish', finish);
    res.on('close', finish);
    next();
  };
}

/*
 * Socket.IO: websocket frames never pass through Express. Each device socket's underlying TCP
 * socket is sampled at flush time and its delta booked to that device. Dashboard sockets are booked
 * without a workspace. Polling transport rides Express and is already counted there.
 */
const sockSeen = new WeakMap();
const deviceWs = new Map();   // device id -> workspace id (refreshed every 10 min)
let deviceWsAt = 0;
function workspaceOfDevice(id) {
  if (!dbRef || !id) return null;
  if (Date.now() - deviceWsAt > 10 * 60 * 1000) { deviceWs.clear(); deviceWsAt = Date.now(); }
  if (!deviceWs.has(id)) {
    let w = null;
    try { w = dbRef.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(id)?.workspace_id || null; } catch (_) {}
    deviceWs.set(id, w);
  }
  return deviceWs.get(id);
}
function sampleSockets(io, at = nowSec()) {
  if (!io || typeof io.of !== 'function') return;
  for (const [name, ns] of io._nsps || []) {
    for (const [, socket] of ns.sockets) {
      const raw = socket.conn && socket.conn.transport && socket.conn.transport.name === 'websocket'
        ? (socket.request && socket.request.socket) : null;
      if (!raw) continue;
      const prev = sockSeen.get(raw) || { out: 0, in: 0 };
      const out = raw.bytesWritten || 0, inn = raw.bytesRead || 0;
      sockSeen.set(raw, { out, in: inn });
      const dOut = Math.max(0, out - prev.out), dIn = Math.max(0, inn - prev.in);
      const devId = name === '/device' ? (socket.data && socket.data.trafficDeviceId) : null;
      add('socket', devId ? workspaceOfDevice(devId) : null, devId, dIn, dOut, 0, at);
    }
  }
}

/* ── Host interface counters ─────────────────────────────────────────────────────────────────── */

/* The interfaces that carry the default route (the box's real uplink); else every non-virtual one. */
function uplinkInterfaces(routeText) {
  const ifaces = new Set();
  for (const line of String(routeText || '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length > 2 && f[1] === '00000000') ifaces.add(f[0]);
  }
  return ifaces;
}
const VIRTUAL = /^(lo|docker|veth|br-|virbr|cni|flannel|tailscale|wg|tun|tap)/;
function parseNetDev(text, only) {
  const out = {};
  for (const line of String(text || '').split('\n').slice(2)) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const iface = m[1].trim();
    if (only && only.size ? !only.has(iface) : VIRTUAL.test(iface)) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length >= 9) out[iface] = { rx: f[0], tx: f[8] };
  }
  return out;
}
let hostPrev = null;
const hostPending = new Map();   // `${hour}|${iface}` -> { rx, tx }
function sampleHost(at = nowSec(), readFile = (p) => fs.readFileSync(p, 'utf8')) {
  let now;
  try {
    let route = '';
    try { route = readFile('/proc/net/route'); } catch (_) {}
    now = parseNetDev(readFile('/proc/net/dev'), uplinkInterfaces(route));
  } catch (_) { return; }   // not Linux, or no /proc: the host layer simply stays empty
  if (hostPrev) {
    for (const [iface, c] of Object.entries(now)) {
      const p = hostPrev[iface];
      if (!p) continue;
      // A counter that went backwards was reset (reboot, driver reload): count from zero.
      const rx = c.rx >= p.rx ? c.rx - p.rx : c.rx;
      const tx = c.tx >= p.tx ? c.tx - p.tx : c.tx;
      const key = `${hourOf(at)}|${iface}`;
      const row = hostPending.get(key) || { hour: hourOf(at), iface, rx: 0, tx: 0 };
      row.rx += rx; row.tx += tx;
      hostPending.set(key, row);
    }
  }
  hostPrev = now;
}

/* ── Flush & retention ───────────────────────────────────────────────────────────────────────── */

function flush() {
  if (!dbRef) return;
  const rows = [...pending.values()];
  pending = new Map();
  const hosts = [...hostPending.values()];
  hostPending.clear();
  if (!rows.length && !hosts.length) return;
  const upHourly = dbRef.prepare(`INSERT INTO traffic_hourly (hour, node, category, workspace_id, requests, bytes_in, bytes_out)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(hour, node, category, workspace_id) DO UPDATE SET
    requests = requests + excluded.requests, bytes_in = bytes_in + excluded.bytes_in, bytes_out = bytes_out + excluded.bytes_out`);
  const upDaily = dbRef.prepare(`INSERT INTO traffic_daily (day, node, category, workspace_id, requests, bytes_in, bytes_out)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(day, node, category, workspace_id) DO UPDATE SET
    requests = requests + excluded.requests, bytes_in = bytes_in + excluded.bytes_in, bytes_out = bytes_out + excluded.bytes_out`);
  const upDevice = dbRef.prepare(`INSERT INTO traffic_device_daily (day, node, device_id, workspace_id, requests, bytes_in, bytes_out)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(day, node, device_id) DO UPDATE SET
    requests = requests + excluded.requests, bytes_in = bytes_in + excluded.bytes_in, bytes_out = bytes_out + excluded.bytes_out,
    workspace_id = excluded.workspace_id`);
  const upHost = dbRef.prepare(`INSERT INTO host_traffic_hourly (hour, node, iface, rx_bytes, tx_bytes) VALUES (?,?,?,?,?)
    ON CONFLICT(hour, node, iface) DO UPDATE SET rx_bytes = rx_bytes + excluded.rx_bytes, tx_bytes = tx_bytes + excluded.tx_bytes`);
  const tx = dbRef.transaction(() => {
    for (const r of rows) {
      upHourly.run(r.hour, NODE, r.category, r.workspace_id, r.requests, r.bytes_in, r.bytes_out);
      upDaily.run(dayOf(r.hour), NODE, r.category, r.workspace_id, r.requests, r.bytes_in, r.bytes_out);
      if (r.device_id) upDevice.run(dayOf(r.hour), NODE, r.device_id, r.workspace_id, r.requests, r.bytes_in, r.bytes_out);
    }
    for (const h of hosts) upHost.run(h.hour, NODE, h.iface, h.rx, h.tx);
  });
  try { tx(); } catch (e) { console.warn('[traffic] flush failed:', e.message); }
}

function prune(now = nowSec()) {
  if (!dbRef) return 0;
  let n = 0;
  const day = (d) => dayOf(now - d * 86400);
  try {
    n += dbRef.prepare('DELETE FROM traffic_hourly WHERE hour < ?').run(now - RETENTION.hourly * 86400).changes;
    n += dbRef.prepare('DELETE FROM traffic_daily WHERE day < ?').run(day(RETENTION.daily)).changes;
    n += dbRef.prepare('DELETE FROM traffic_device_daily WHERE day < ?').run(day(RETENTION.device)).changes;
    n += dbRef.prepare('DELETE FROM host_traffic_hourly WHERE hour < ?').run(now - RETENTION.host * 86400).changes;
  } catch (e) { console.warn('[traffic] prune failed:', e.message); }
  return n;
}

let timer = null;
/** Start the once-a-minute sampler/flush. `io` is the Socket.IO server (optional). */
function start(db, { io } = {}) {
  dbRef = db;
  if (timer) return;
  sampleHost();   // a baseline, so the first minute has a delta
  let ticks = 0;
  timer = setInterval(() => {
    try { sampleSockets(io); sampleHost(); flush(); } catch (e) { console.warn('[traffic] tick failed:', e.message); }
    if (++ticks % 60 === 0) prune();   // hourly
  }, FLUSH_MS);
  if (timer.unref) timer.unref();
}

/* ── Reading, for routes/admin.js ────────────────────────────────────────────────────────────── */

/**
 * The Traffic page's data for the last `days` days. Hourly series up to 7 days, daily beyond.
 * Includes what is still in memory, so the page is current to the second.
 */
function report(db, { days = 7, now = nowSec(), quotaBytes = 0 } = {}) {
  flush();
  const d = Math.min(400, Math.max(1, Math.floor(Number(days) || 7)));
  const since = now - d * 86400;
  const hourly = d <= 7;
  const series = hourly
    ? db.prepare(`SELECT hour AS t, SUM(bytes_out) AS out, SUM(bytes_in) AS inn, SUM(requests) AS req
        FROM traffic_hourly WHERE hour >= ? GROUP BY hour ORDER BY hour`).all(hourOf(since))
    : db.prepare(`SELECT day AS t, SUM(bytes_out) AS out, SUM(bytes_in) AS inn, SUM(requests) AS req
        FROM traffic_daily WHERE day >= ? GROUP BY day ORDER BY day`).all(dayOf(since));
  const hostSeries = hourly
    ? db.prepare(`SELECT hour AS t, SUM(tx_bytes) AS tx, SUM(rx_bytes) AS rx FROM host_traffic_hourly WHERE hour >= ? GROUP BY hour ORDER BY hour`).all(hourOf(since))
    : db.prepare(`SELECT date(hour, 'unixepoch') AS t, SUM(tx_bytes) AS tx, SUM(rx_bytes) AS rx FROM host_traffic_hourly WHERE hour >= ? GROUP BY t ORDER BY t`).all(hourOf(since));
  const range = hourly ? ['traffic_hourly', 'hour', hourOf(since)] : ['traffic_daily', 'day', dayOf(since)];
  const byCategory = db.prepare(`SELECT category, SUM(bytes_out) AS out, SUM(bytes_in) AS inn, SUM(requests) AS req
    FROM ${range[0]} WHERE ${range[1]} >= ? GROUP BY category ORDER BY out DESC`).all(range[2]);
  const topWorkspaces = db.prepare(`SELECT t.workspace_id AS id, w.name AS name, o.name AS org, SUM(t.bytes_out) AS out, SUM(t.requests) AS req
    FROM ${range[0]} t LEFT JOIN workspaces w ON w.id = t.workspace_id LEFT JOIN organizations o ON o.id = w.organization_id
    WHERE t.${range[1]} >= ? AND t.workspace_id != '' GROUP BY t.workspace_id ORDER BY out DESC LIMIT 10`).all(range[2]);
  const topDevices = db.prepare(`SELECT t.device_id AS id, dv.name AS name, w.name AS workspace, SUM(t.bytes_out) AS out, SUM(t.requests) AS req
    FROM traffic_device_daily t LEFT JOIN devices dv ON dv.id = t.device_id LEFT JOIN workspaces w ON w.id = t.workspace_id
    WHERE t.day >= ? GROUP BY t.device_id ORDER BY out DESC LIMIT 10`).all(dayOf(since));
  const sum = (rows, k) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
  // Calendar month to date (UTC), for the quota.
  const monthStart = Math.floor(Date.UTC(new Date(now * 1000).getUTCFullYear(), new Date(now * 1000).getUTCMonth(), 1) / 1000);
  const month = db.prepare('SELECT SUM(tx_bytes) AS tx, SUM(rx_bytes) AS rx FROM host_traffic_hourly WHERE hour >= ?').get(monthStart) || {};
  const monthApp = db.prepare('SELECT SUM(bytes_out) AS out FROM traffic_daily WHERE day >= ?').get(dayOf(monthStart)) || {};
  const nodes = db.prepare('SELECT DISTINCT node FROM host_traffic_hourly UNION SELECT DISTINCT node FROM traffic_daily').all().map((r) => r.node);
  return {
    days: d,
    granularity: hourly ? 'hour' : 'day',
    nodes,
    totals: {
      attributed_out: sum(series, 'out'), attributed_in: sum(series, 'inn'), requests: sum(series, 'req'),
      host_tx: sum(hostSeries, 'tx'), host_rx: sum(hostSeries, 'rx'),
    },
    series, host_series: hostSeries,
    by_category: byCategory,
    top_workspaces: topWorkspaces,
    top_devices: topDevices,
    month: {
      start: monthStart, host_tx: month.tx || 0, host_rx: month.rx || 0, attributed_out: monthApp.out || 0,
      quota_bytes: quotaBytes || 0,
      quota_pct: quotaBytes > 0 ? Math.round(((month.tx || 0) / quotaBytes) * 1000) / 10 : null,
    },
    host_available: hostSeries.length > 0 || process.platform === 'linux',
  };
}

module.exports = {
  CATEGORIES, RETENTION, NODE,
  middleware, start, flush, prune, report,
  // exported for tests
  categorize, add, sampleHost, sampleSockets, parseNetDev, uplinkInterfaces,
  _reset: () => { pending = new Map(); hostPending.clear(); hostPrev = null; lookupCache.clear(); deviceWs.clear(); },
  _setDb: (db) => { dbRef = db; },
};
