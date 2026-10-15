'use strict';

/*
 * Switch to ScreenTinker — the vendor adapters (lib/migrate/vendors/*) against FAKE vendors. The suite
 * never touches the network: lib/migrate/transport's wire is replaced, and so is its clock.
 *
 * Response shapes are copied from each vendor's official documentation (the page is cited beside
 * each fixture). Where a doc has only a field list, the shape is assembled from those field names.
 *
 * What has to hold, per vendor:
 *   - pagination is followed to the end (Xibo start/length + X-Total-Count, Yodeck limit/offset +
 *     count/next, Screenly limit/offset, ScreenCloud cursors)
 *   - 429 is retried after Retry-After; a media download that fails is reported and the rest go on
 *   - the mapping: layouts -> zones in percent, schedules -> wall clock + RRULE, screens ->
 *     placeholders with groups, playlists in order with durations
 *   - the credential (and any token it buys) never reaches the database after the job, a response,
 *     the report or a log line; it is sent only to the vendor's API origin, never to a CDN
 *   - a self-hosted address that is a metadata or loopback IP is refused before anything is fetched
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-migrate-v-'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
delete process.env.OUTBOUND_ALLOW_PRIVATE;
delete process.env.OUTBOUND_ALLOW_HOSTS;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const config = require('../config');
const { db } = require('../db/database');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const migrate = require('../lib/migrate');
const transport = require('../lib/migrate/transport');
const map = require('../lib/migrate/map');

/* ---------- bytes ---------- */
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(seed = 1) {
  const w = 8, h = 8;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [seed & 255, 9, 9]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12), Buffer.alloc(2048, 1)]);

/* ---------- the fake wire ---------- */
const W = { routes: [], calls: [], downloads: [], sleeps: [] };
const reply = (status, body, headers = {}) => ({ status, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])), text: body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body) });
const fakeWire = {
  async request(url, opts) {
    W.calls.push({ url, headers: opts.headers || {}, body: opts.body || null, method: opts.method });
    for (const r of W.routes) {
      const out = r(new URL(url), opts);
      if (out) return out;
    }
    return reply(404, { message: 'not found' });
  },
  async download(url, dest, { headers, maxBytes }) {
    W.downloads.push({ url, headers });
    for (const r of W.routes) {
      const out = r(new URL(url), { method: 'GET', headers, download: true });
      if (out && out.bytes) {
        if (out.bytes.length > maxBytes) throw Object.assign(new Error('too large'), { code: 'too_large' });
        fs.writeFileSync(dest, out.bytes, { flag: 'wx' });
        return { size: out.bytes.length };
      }
      if (out && out.status) { const e = new Error('x'); e.statusCode = out.status; throw e; }
    }
    const e = new Error('x'); e.statusCode = 404; throw e;
  },
};

/* ---------- people ---------- */
function mkUser(tag) {
  const id = `u-migv-${tag}`;
  db.prepare("INSERT INTO users (id, email, password_hash, role, plan_id, email_verified) VALUES (?, ?, 'x', 'user', 'enterprise', 1)").run(id, `${tag}@migv.test`);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function mkWorkspace(tag, owner) {
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(`org-v${tag}`, `Org ${tag}`, owner.id);
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(`org-v${tag}`, owner.id);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(`ws-v${tag}`, `org-v${tag}`, `WS ${tag}`);
  return `ws-v${tag}`;
}

let server, base;
const logs = [];
const origConsole = {};
before(async () => {
  fs.mkdirSync(config.contentDir, { recursive: true });
  for (const k of ['log', 'warn', 'error', 'info']) {
    origConsole[k] = console[k];
    console[k] = (...a) => { logs.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  }
  transport._setTransport(fakeWire);
  transport._setSleep(async (ms) => { W.sleeps.push(ms); });
  const app = express();
  app.use(express.json());
  app.use('/api/migrate', requireAuth, resolveTenancy, require('../routes/migrate'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  transport._setTransport(null);
  transport._setSleep(null);
  Object.assign(console, origConsole);
  return new Promise((r) => server.close(r));
});
beforeEach(() => { W.routes = []; W.calls = []; W.downloads = []; W.sleeps = []; });

async function call(user, ws, method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${generateToken(user, ws)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, text };
}

/** Connect, wait for the scan, run everything, wait for the end. Returns { scan, job, texts }. */
async function importAll(user, ws, vendor, credentials, options = {}) {
  const c = await call(user, ws, 'POST', '/api/migrate/jobs', { vendor, credentials });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const s = await migrate._settle(c.body.id);
  assert.equal(s.status, 'scanned', s.error || '');
  const scanView = await call(user, ws, 'GET', `/api/migrate/jobs/${c.body.id}`);
  const r = await call(user, ws, 'POST', `/api/migrate/jobs/${c.body.id}/run`, { options });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const j = await migrate._settle(c.body.id);
  const fin = await call(user, ws, 'GET', `/api/migrate/jobs/${c.body.id}`);
  return { id: c.body.id, scan: scanView.body, job: j, view: fin.body, texts: [c.text, scanView.text, r.text, fin.text] };
}

/** Nothing about `secret` may be left anywhere a person or an attacker with the DB could read. */
function assertSecretGone(secret, jobId, texts) {
  const row = db.prepare('SELECT * FROM migration_jobs WHERE id = ?').get(jobId);
  assert.equal(row.cred_enc, null, 'the encrypted credential is deleted at the end');
  assert.equal(row.cred_expires_at, null);
  assert.ok(!JSON.stringify(row).includes(secret), 'not in the job row (scan, report, options, error)');
  const items = db.prepare('SELECT * FROM migration_items WHERE job_id = ?').all(jobId);
  assert.ok(!JSON.stringify(items).includes(secret), 'not in the id map');
  for (const t of texts) assert.ok(!String(t).includes(secret), 'not in a response');
  assert.ok(!logs.join('\n').includes(secret), 'not in a log line');
  assert.ok(!migrate._memCreds.has(jobId), 'not in memory either');
}

/* ===================================================================== pure mapping */

test('map.scheduleRows: once, weekly, overnight split, intervals, and what cannot be expressed', () => {
  const once = map.scheduleRows({ start: '2026-11-01T09:00', end: '2026-11-03T17:00', timezone: 'Europe/London', recurrence: null });
  assert.deepEqual(once.rows, [{ start_time: '2026-11-01T09:00', end_time: '2026-11-03T17:00', timezone: 'Europe/London', recurrence: null, recurrence_end: null }]);

  const wk = map.scheduleRows({ start: '2026-11-02T08:00', end: '2026-11-02T12:00', timezone: 'UTC', recurrence: { freq: 'WEEKLY', byDay: [1, 2, 3, 4, 5], until: '2026-12-31' } });
  assert.equal(wk.rows[0].recurrence, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(wk.rows[0].recurrence_end, '2026-12-31');

  const night = map.scheduleRows({ start: '2026-11-06T22:00', end: '2026-11-07T02:00', timezone: 'UTC', recurrence: { freq: 'WEEKLY', byDay: [5, 6] } });
  assert.equal(night.rows.length, 2, 'overnight is split');
  assert.equal(night.rows[0].end_time, '2026-11-06T23:59');
  assert.equal(night.rows[1].start_time, '2026-11-07T00:00');
  assert.equal(night.rows[1].recurrence, 'FREQ=WEEKLY;BYDAY=SU,SA', 'the morning part runs on the following days');
  assert.ok(night.notes.some((n) => /midnight/.test(n)));

  const every2 = map.scheduleRows({ start: '2026-11-02T08:00', end: '2026-11-02T09:00', timezone: 'UTC', recurrence: { freq: 'WEEKLY', interval: 2, byDay: [1] } });
  assert.ok(every2.notes.some((n) => /every 2 weeks/.test(n)));

  assert.match(map.scheduleRows({ start: '2026-11-02T08:00', end: '2026-11-02T09:00', recurrence: { freq: 'HOURLY' } }).skip, /every hour/);
  assert.match(map.scheduleRows({ start: '2026-11-02T08:00', end: '2026-11-02T09:00', recurrence: { freq: 'MONTHLY', byMonthDayOrdinal: true } }).skip, /nth weekday/);
  assert.ok(map.scheduleRows({ start: '2026-11-02T08:00', end: '2026-11-02T09:00', timezone: 'Mars/Olympus', recurrence: null }).notes.some((n) => /Unknown time zone/.test(n)));
  // An instant with an offset becomes wall clock in the zone.
  assert.equal(map.wallClock(Date.UTC(2026, 6, 1, 12, 0), 'Europe/Berlin'), '2026-07-01T14:00');
  assert.deepEqual(map.zonePercent({ left: 960, top: 0, width: 960, height: 1080 }, 1920, 1080), { x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100 });
});

test('transport: Retry-After is honoured (seconds or a date), the credential stays on its origin', async () => {
  assert.equal(transport.retryAfterMs({ 'retry-after': '3' }, 0), 3000);
  assert.equal(transport.retryAfterMs({ 'retry-after': '9999' }, 0), 60000, 'capped');
  let n = 0;
  W.routes.push((u) => (u.hostname === 'api.example.test' ? (++n < 3 ? reply(429, null, { 'Retry-After': '2' }) : reply(200, { ok: true })) : null));
  const c = transport.client('https://api.example.test/v1', { Authorization: 'Token SECRET-T' });
  const r = await c.api('/thing');
  assert.deepEqual(r.body, { ok: true });
  assert.deepEqual(W.sleeps, [2000, 2000]);
  await assert.rejects(() => c.api('https://evil.example.test/steal'), /outside its own API/);
  W.routes.unshift((u, o) => (o.download && (u.hostname === 'cdn.example.test' || u.hostname === 'api.example.test') ? { bytes: png(1) } : null));
  const d1 = path.join(process.env.DATA_DIR, 'd1'), d2 = path.join(process.env.DATA_DIR, 'd2');
  await c.download('https://cdn.example.test/file.png', d1, 1e6);
  await c.download('https://api.example.test/v1/file.png', d2, 1e6);
  assert.equal(W.downloads[0].headers.Authorization, undefined, 'a CDN never sees the key');
  assert.equal(W.downloads[1].headers.Authorization, 'Token SECRET-T');
  await assert.rejects(() => c.download('http://cdn.example.test/plain.png', d1 + 'x', 1e6), /not https/);
});

test('a self-hosted address that is a metadata, loopback or private IP is refused before any request', async () => {
  const u = mkUser('ssrf');
  const ws = mkWorkspace('ssrf', u);
  for (const [vendor, credentials] of [
    ['xibo', { url: 'http://169.254.169.254/latest/meta-data', client_id: 'a', client_secret: 'b' }],
    ['xibo', { url: 'http://[::ffff:169.254.169.254]/', client_id: 'a', client_secret: 'b' }],
    ['xibo', { url: 'http://127.0.0.1:8080', client_id: 'a', client_secret: 'b' }],
    ['anthias', { url: 'http://10.0.0.5' }],
    ['xibo', { url: 'http://user:pw@cms.example.org', client_id: 'a', client_secret: 'b' }],
    ['xibo', { url: 'file:///etc/passwd', client_id: 'a', client_secret: 'b' }],
  ]) {
    const r = await call(u, ws, 'POST', '/api/migrate/jobs', { vendor, credentials });
    assert.equal(r.status, 400, `${credentials.url} must be refused`);
  }
  assert.equal(W.calls.length, 0, 'nothing was fetched');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migration_jobs WHERE workspace_id = ?').get(ws).n, 0);
});

test('the real (guarded) wire refuses a metadata address even if a name resolves to it', async () => {
  transport._setTransport(null);
  try {
    const c = transport.client('http://169.254.169.254');
    await assert.rejects(() => c.api('/latest/meta-data'), (e) => e.code === 'blocked');
  } finally { transport._setTransport(fakeWire); }
});

/* ===================================================================== Xibo */

/*
 * Shapes: swagger.json v4.5 (https://raw.githubusercontent.com/xibosignage/xibo-cms/develop/web/swagger.json)
 * schemas Media, Layout, Region, Playlist, Widget, DisplayGroup, Display, Schedule, Campaign. Token:
 * https://docs.xibosignage.com/developer/integrate/authentication ({"token_type":"Bearer","expires_in":3600,
 * "access_token":"..."}). Paging: https://docs.xibosignage.com/developer/integrate/openapi.md (start, length,
 * X-Total-Count; bare JSON arrays).
 */
const XIBO_SECRET = 'xibo-CLIENT-SECRET-123456';
const XIBO_TOKEN = 'eyJ0eXAiOiJKV1Q-XIBO-ACCESS-TOKEN';
function xiboFake({ failMedia = null } = {}) {
  const library = [
    { mediaId: 12, name: 'lobby', mediaType: 'image', storedAs: '12.png', fileName: 'lobby.png', fileSize: 245, duration: 10, retired: 0 },
    { mediaId: 13, name: 'promo', mediaType: 'video', storedAs: '13.mp4', fileName: 'promo.mp4', fileSize: 2100, duration: 30, retired: 0 },
    { mediaId: 14, name: 'menu', mediaType: 'image', storedAs: '14.png', fileName: 'menu.png', fileSize: 245, duration: 10, retired: 0 },
  ];
  // Enough fonts to need a second page.
  for (let i = 0; i < 103; i++) library.push({ mediaId: 1000 + i, name: `font${i}`, mediaType: 'font', fileName: `f${i}.ttf`, fileSize: 10, retired: 0 });
  const widget = (id, type, mid, dur, order, useDuration = 1) => ({ widgetId: id, playlistId: 7, type, duration: dur, useDuration, calculatedDuration: dur, displayOrder: order, mediaIds: mid == null ? [] : [mid], widgetOptions: [] });
  const playlists = [
    { playlistId: 30, name: 'Welcome loop', regionId: null, isDynamic: 0, widgets: [widget(1, 'image', 14, 8, 2), widget(2, 'image', 12, 5, 1), widget(3, 'clock', null, 10, 3), widget(4, 'video', 13, 0, 4, 0)] },
    { playlistId: 31, name: 'region playlist', regionId: 9, widgets: [] },
  ];
  const layouts = [
    { layoutId: 5, layout: 'Main', width: 1920, height: 1080, campaignId: 50, parentId: null, regions: [
      { regionId: 9, name: 'Main', width: 1440, height: 1080, top: 0, left: 0, zIndex: 0, regionPlaylist: { playlistId: 31, widgets: [widget(21, 'image', 12, 10, 1)] } },
      { regionId: 10, name: 'Side', width: 480, height: 1080, top: 0, left: 1440, zIndex: 1, regionPlaylist: { playlistId: 32, widgets: [widget(22, 'video', 13, 0, 1, 0), widget(23, 'ticker', null, 10, 2)] } },
    ] },
    { layoutId: 6, layout: 'Main (draft)', width: 1920, height: 1080, campaignId: 51, parentId: 5, regions: [] },
  ];
  const groups = [
    { displayGroupId: 100, displayGroup: 'Lobby screens', isDisplaySpecific: 0 },
    { displayGroupId: 201, displayGroup: 'Reception TV', isDisplaySpecific: 1 },
  ];
  const displays = [{ displayId: 1, display: 'Reception TV', displayGroupId: 201, timeZone: 'Europe/Berlin', defaultLayoutId: 5, displayGroups: [{ displayGroupId: 100, displayGroup: 'Lobby screens' }] }];
  const campaigns = [{ campaignId: 50, campaign: 'Main', isLayoutSpecific: 1 }, { campaignId: 60, campaign: 'Rotation', isLayoutSpecific: 0, numberLayouts: 3 }];
  const events = [
    // Weekdays 08:00-12:00 Berlin from 2 Nov 2026, until 31 Dec; recurrenceRepeatsOn ISO 1..5.
    { eventId: 1, eventTypeId: 1, campaignId: 50, displayGroups: [{ displayGroupId: 201 }], fromDt: Date.UTC(2026, 10, 2, 7, 0) / 1000, toDt: Date.UTC(2026, 10, 2, 11, 0) / 1000,
      recurrenceType: 'Week', recurrenceDetail: 1, recurrenceRepeatsOn: '1,2,3,4,5', recurrenceRange: Date.UTC(2026, 11, 31, 22, 0) / 1000, isPriority: 0, displayOrder: 0, isAlways: 0 },
    { eventId: 2, eventTypeId: 3, campaignId: 50, displayGroups: [{ displayGroupId: 100 }], fromDt: 0, toDt: 0, name: 'Overlay' },
    { eventId: 3, eventTypeId: 5, campaignId: 60, displayGroups: [{ displayGroupId: 100 }], fromDt: 0, toDt: 0 },
    { eventId: 4, eventTypeId: 1, campaignId: 50, displayGroups: [{ displayGroupId: 100 }], isAlways: 1, fromDt: 0, toDt: 0, isPriority: 1 },
  ];
  let layoutCalls = 0;
  const paged = (rows, u) => {
    const start = Number(u.searchParams.get('start') || 0), length = Number(u.searchParams.get('length') || 10);
    return reply(200, rows.slice(start, start + length), { 'X-Total-Count': rows.length });
  };
  return (u, opts) => {
    if (u.hostname !== 'cms.example.org') return null;
    const p = u.pathname;
    if (opts.download) {
      const m = /^\/api\/library\/download\/(\d+)\/(\w+)$/.exec(p);
      if (!m || opts.headers.Authorization !== `Bearer ${XIBO_TOKEN}`) return { status: 401 };
      if (failMedia && Number(m[1]) === failMedia) return { status: 500 };
      return { bytes: m[2] === 'video' ? MP4 : png(Number(m[1])) };
    }
    if (p === '/api/authorize/access_token') {
      const f = new URLSearchParams(opts.body);
      if (f.get('grant_type') !== 'client_credentials' || f.get('client_secret') !== XIBO_SECRET) return reply(401, { error: 'invalid_client' });
      return reply(200, { token_type: 'Bearer', expires_in: 3600, access_token: XIBO_TOKEN });
    }
    if (opts.headers.Authorization !== `Bearer ${XIBO_TOKEN}`) return reply(401, { message: 'unauthorized' });
    if (p === '/api/library') return paged(library, u);
    if (p === '/api/playlist') return paged(playlists, u);
    if (p === '/api/layout') { if (++layoutCalls === 1) return reply(429, null, { 'Retry-After': '2' }); return paged(layouts, u); }
    if (p === '/api/displaygroup') return paged(groups, u);
    if (p === '/api/display') return paged(displays, u);
    if (p === '/api/campaign') return paged(campaigns, u);
    if (p === '/api/schedule') return paged(events, u);
    return null;
  };
}

test('Xibo: pages, retries, maps layouts/schedules/displays, survives a failed download, keeps no secret', async () => {
  const u = mkUser('xibo');
  const ws = mkWorkspace('xibo', u);
  W.routes.push(xiboFake({ failMedia: 14 }));
  const { id, scan, job, view, texts } = await importAll(u, ws, 'xibo', { url: 'https://cms.example.org/', client_id: 'cid', client_secret: XIBO_SECRET, timezone: 'Europe/London' });

  assert.equal(scan.summary.media, 3, 'images and video, across two library pages');
  assert.ok(W.calls.some((c) => c.url.includes('/api/library') && c.url.includes('start=100')), 'second page requested');
  assert.ok(W.sleeps.includes(2000), '429 on /layout waited Retry-After');
  assert.ok(scan.unmapped.some((x) => /font/.test(x.reason)));
  assert.ok(scan.unmapped.some((x) => /Overlay events/.test(x.reason)));
  assert.ok(scan.unmapped.some((x) => /campaign of several layouts/.test(x.reason)));
  assert.equal(scan.summary.layouts, 1, 'the draft layout is skipped');

  assert.equal(job.status, 'done', job.error || '');
  assert.equal(view.report.created.media, 2);
  assert.equal(view.report.failed.length, 1, 'the 500 is reported');
  assert.equal(view.report.failed[0].name, 'menu.png');

  const pl = db.prepare("SELECT id FROM playlists WHERE workspace_id = ? AND name = 'Welcome loop'").get(ws);
  const items = db.prepare('SELECT c.filename, pi.duration_sec FROM playlist_items pi JOIN content c ON c.id = pi.content_id WHERE pi.playlist_id = ? ORDER BY pi.sort_order').all(pl.id).map((r) => ({ ...r }));
  assert.deepEqual(items.map((i) => i.filename), ['lobby.png', 'promo.mp4'], 'displayOrder kept; the clock widget and the failed media dropped');
  assert.equal(items[0].duration_sec, 5);

  const lay = db.prepare("SELECT * FROM layouts WHERE workspace_id = ? AND name = 'Main'").get(ws);
  const zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(lay.id);
  assert.deepEqual(zones.map((z) => [z.x_percent, z.width_percent]), [[0, 75], [75, 25]]);

  const scheds = db.prepare('SELECT * FROM schedules WHERE workspace_id = ? ORDER BY start_time').all(ws);
  const weekly = scheds.find((s) => s.recurrence);
  assert.equal(weekly.start_time, '2026-11-02T08:00', 'UTC 07:00 is 08:00 in Berlin (the display zone wins)');
  assert.equal(weekly.end_time, '2026-11-02T12:00');
  assert.equal(weekly.timezone, 'Europe/Berlin');
  assert.equal(weekly.recurrence, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(weekly.recurrence_end, '2026-12-31');
  assert.equal(weekly.layout_id, lay.id);
  const always = scheds.find((s) => !s.recurrence);
  assert.equal(always.priority, 10);
  const lobby = db.prepare("SELECT id FROM device_groups WHERE workspace_id = ? AND name = 'Lobby screens'").get(ws);
  assert.equal(always.group_id, lobby.id);

  const ph = db.prepare('SELECT * FROM migration_screens WHERE workspace_id = ?').all(ws);
  assert.equal(ph.length, 1);
  assert.equal(ph[0].name, 'Reception TV');
  assert.equal(ph[0].layout_id, lay.id);
  const gids = JSON.parse(ph[0].group_ids);
  assert.ok(gids.includes(lobby.id) && gids.includes(weekly.group_id), 'its group, and the group its own schedules target');

  assert.ok(W.downloads.every((d) => d.url.startsWith('https://cms.example.org/api/library/download/')));
  assertSecretGone(XIBO_SECRET, id, texts);
  assertSecretGone(XIBO_TOKEN, id, texts);
  assert.ok(!JSON.parse(db.prepare('SELECT scan FROM migration_jobs WHERE id = ?').get(id).scan).catalog, 'the catalog is dropped at the end');
});

test('Xibo: a wrong secret fails the scan with a readable reason, and the credential is gone', async () => {
  const u = mkUser('xibobad');
  const ws = mkWorkspace('xibobad', u);
  W.routes.push(xiboFake());
  const c = await call(u, ws, 'POST', '/api/migrate/jobs', { vendor: 'xibo', credentials: { url: 'https://cms.example.org', client_id: 'cid', client_secret: 'WRONG-secret-value' } });
  const j = await migrate._settle(c.body.id);
  assert.equal(j.status, 'failed');
  assert.match(j.error, /refused the client id or secret/);
  assert.equal(j.cred_enc, null);
  assert.ok(!logs.join('\n').includes('WRONG-secret-value'));
});

test('Xibo: re-running the import duplicates nothing', async () => {
  const u = mkUser('xibo2');
  const ws = mkWorkspace('xibo2', u);
  W.routes.push(xiboFake());
  const creds = { url: 'https://cms.example.org', client_id: 'cid', client_secret: XIBO_SECRET };
  await importAll(u, ws, 'xibo', creds);
  const count = () => ['content', 'playlists', 'layouts', 'schedules', 'device_groups', 'migration_screens'].map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE workspace_id = ?`).get(ws).n);
  const before = count();
  const again = await importAll(u, ws, 'xibo', creds);
  assert.deepEqual(count(), before);
  assert.equal(again.view.report.created.media, 0);
  assert.equal(again.view.report.reused.media, 3);
  assert.ok(again.view.report.reused.schedules >= 2);
});

/* ===================================================================== Yodeck */

/*
 * Shapes: https://app.yodeck.com/api-docs/ (bundle.yaml, OpenAPI 3.1): list envelope {count, next,
 * previous, results}; Media (media_origin, arguments.download_from_url / play_from_url, file_extension),
 * Playlist (items[{id, priority, duration, name, type}]), Layout (resolution_width/height, regions[{left,
 * top, width, height, zindex, order, item{type,id}}]), Schedule (events[{start, duration (minutes),
 * recurrence o|d|w|m|y, days_of_week Monday-first, every, source{source_id, source_type}}]), Screen with
 * ?subset=basic (basic.tags, basic.time_zone; screen_content{source_type, source_id}). Rate limit: 429 with
 * Retry-After.
 */
const YODECK_KEY = 'migrate:YODECK-SECRET-TOKEN-abcdef';
function yodeckFake() {
  const media = [];
  for (let i = 1; i <= 120; i++) {
    media.push({ id: i, name: `doc${i}`, media_origin: { type: 'document', source: 'local' }, status: 'finished', workspace: { id: 42, name: 'Reception' } });
  }
  media.push({ id: 201, name: 'logo', media_origin: { type: 'image', source: 'url' }, file_extension: 'png', status: 'finished', default_duration: 10, arguments: { download_from_url: 'https://cdn.example.test/logo.png' }, workspace: { id: 42 } });
  media.push({ id: 202, name: 'promo', media_origin: { type: 'video', source: 'local' }, file_extension: 'mp4', status: 'finished', arguments: { duration: 30, play_from_url: 'https://media.yodeck.example/promo-1080.mp4' }, workspace: { id: 42 } });
  media.push({ id: 203, name: 'photo', media_origin: { type: 'image', source: 'local' }, file_extension: 'jpg', status: 'finished', thumbnail_url: 'https://cdn.example.test/thumb.jpg', arguments: {}, workspace: { id: 42 } });
  const playlists = [{ id: 7, name: 'Lobby', workspace: { id: 42 }, items: [{ id: 202, priority: 2, duration: 30, type: 'media' }, { id: 201, priority: 1, duration: 8, type: 'media' }, { id: 203, priority: 3, duration: 10, type: 'media' }], playback_options: { random_playback: false } }];
  const layouts = [{ id: 13, name: 'Daily Menu', resolution_width: 1920, resolution_height: 1080, regions: [{ id: 433, width: 960, height: 1080, top: 0, left: 960, zindex: 1, order: 1, item: { type: 'playlist', id: 7 } }] }];
  const schedules = [{ id: 42, name: 'Weekly Menu Show', events: [{ id: 1, start: '2026-11-02T09:00:00', end: '2027-01-01T00:00:00', duration: 90, priority: 3, recurrence: 'w', days_of_week: '1111100', every: 1, source: { source_id: 13, source_name: 'Daily Menu', source_type: 'layout' } }] }];
  const screens = [
    { id: 1, name: 'Front', workspace: { id: 42 }, screen_content: { source_id: 42, source_type: 'schedule' }, basic: { tags: ['Ground floor'], time_zone: 'Europe/Athens' } },
    { id: 2, name: 'Back', workspace: { id: 42 }, screen_content: { source_id: 7, source_type: 'playlist' }, basic: { tags: ['ground floor', 'Kitchen'] } },
  ];
  let mediaHits = 0;
  const env = (rows, u) => {
    const limit = Number(u.searchParams.get('limit')), offset = Number(u.searchParams.get('offset'));
    const next = offset + limit < rows.length ? `https://app.yodeck.com/api/v2${u.pathname.replace('/api/v2', '')}?limit=${limit}&offset=${offset + limit}` : null;
    return reply(200, { count: rows.length, next, previous: null, results: rows.slice(offset, offset + limit) });
  };
  return (u, opts) => {
    if (opts.download) {
      if (u.hostname === 'cdn.example.test' && u.pathname === '/logo.png') return opts.headers.Authorization ? { status: 403 } : { bytes: png(5) };
      if (u.hostname === 'media.yodeck.example') return opts.headers.Authorization ? { status: 403 } : { bytes: MP4 };
      return null;
    }
    if (u.hostname !== 'app.yodeck.com') return null;
    if (opts.headers.Authorization !== `Token ${YODECK_KEY}`) return reply(401, { detail: 'Invalid token.' });
    if (u.pathname === '/api/v2/media/') { if (++mediaHits === 2) return reply(429, null, { 'Retry-After': '5' }); return env(media, u); }
    if (u.pathname === '/api/v2/playlists/') return env(playlists, u);
    if (u.pathname === '/api/v2/layouts/') return env(layouts, u);
    if (u.pathname === '/api/v2/schedules/') return env(schedules, u);
    if (u.pathname === '/api/v2/screens/') { assert.equal(u.searchParams.get('subset'), 'basic'); return env(screens, u); }
    return null;
  };
}

test('Yodeck: limit/offset paging with a 429, originals only where the API has them, tags become groups', async () => {
  const u = mkUser('yodeck');
  const ws = mkWorkspace('yodeck', u);
  W.routes.push(yodeckFake());
  const { id, scan, job, view, texts } = await importAll(u, ws, 'yodeck', { api_key: YODECK_KEY, timezone: 'Europe/London' });
  assert.ok(W.sleeps.includes(5000));
  assert.equal(scan.summary.media, 2);
  assert.ok(scan.unmapped.some((x) => x.name === 'photo' && /original file/.test(x.reason)), 'a thumbnail is never passed off as the original');
  assert.equal(scan.unmapped.filter((x) => /document/.test(x.reason)).length, 120, 'all 120 documents seen across pages');
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(view.report.created.media, 2);
  const names = db.prepare('SELECT filename FROM content WHERE workspace_id = ? ORDER BY filename').all(ws).map((r) => r.filename);
  assert.deepEqual(names, ['logo.png', 'promo.mp4']);

  const pl = db.prepare("SELECT id FROM playlists WHERE workspace_id = ? AND name = 'Lobby'").get(ws);
  const items = db.prepare('SELECT c.filename, pi.duration_sec FROM playlist_items pi JOIN content c ON c.id = pi.content_id WHERE pi.playlist_id = ? ORDER BY pi.sort_order').all(pl.id).map((r) => ({ ...r }));
  assert.deepEqual(items, [{ filename: 'logo.png', duration_sec: 8 }, { filename: 'promo.mp4', duration_sec: 30 }], 'priority order');

  const s = db.prepare('SELECT * FROM schedules WHERE workspace_id = ?').get(ws);
  assert.equal(s.start_time, '2026-11-02T09:00');
  assert.equal(s.end_time, '2026-11-02T10:30', 'duration is minutes');
  assert.equal(s.recurrence, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(s.timezone, 'Europe/Athens', "the screen's zone");
  const groups = db.prepare('SELECT name FROM device_groups WHERE workspace_id = ? ORDER BY name').all(ws).map((g) => g.name);
  assert.ok(groups.includes('Ground floor') && groups.includes('Kitchen'));
  assert.ok(!groups.includes('ground floor'), 'tags are matched case-insensitively');
  const back = db.prepare("SELECT * FROM migration_screens WHERE workspace_id = ? AND name = 'Back'").get(ws);
  assert.equal(back.playlist_id, pl.id);
  assertSecretGone('YODECK-SECRET-TOKEN-abcdef', id, texts);
  assert.ok(W.downloads.every((d) => !d.headers.Authorization), 'CDN downloads carry no key');
});

test('Yodeck: a token without a label is refused before anything is called', async () => {
  const u = mkUser('yodeckbad');
  const ws = mkWorkspace('yodeckbad', u);
  const r = await call(u, ws, 'POST', '/api/migrate/jobs', { vendor: 'yodeck', credentials: { api_key: 'justatoken' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /label:token/);
  assert.equal(W.calls.length, 0);
});

/* ===================================================================== Screenly */

/*
 * Shapes: https://developer.screenly.io/api_v4_1/ examples for /assets, /playlists, /playlist-items, /labels,
 * /labels/screens, /labels/playlists, /screens. Predicates: https://www.screenly.io/docs/scheduling/advanced/predicates/
 * ($WEEKDAY 0 = Monday, $TIME ms since local midnight).
 */
const SCREENLY_TOKEN = 'screenly-SECRET-0123456789';
function screenlyFake() {
  const T = '01HC9RFEFP1ATEH5ZT5VQMF65P';
  const assets = [
    { id: 'A1', title: 'My Asset', type: 'image', mimetype: 'image/png', asset_url: 'https://us-assets.screenlyapp.com/a1', source_size: 300, status: 'finished', team_id: T },
    { id: 'A2', title: 'Web', type: 'web', mimetype: 'text/html', asset_url: null, status: 'finished', team_id: T },
  ];
  const playlists = [
    { id: 'P1', title: 'Office hours', is_enabled: true, priority: false, predicate: 'TRUE AND ($WEEKDAY IN {0, 1, 2, 3, 4}) AND ($TIME BETWEEN {28800000, 61200000})', team_id: T },
    { id: 'P2', title: 'Odd rule', is_enabled: true, priority: true, predicate: '($WEEKDAY IN {5}) OR ($WEEKDAY IN {6})', team_id: T },
  ];
  const items = [{ id: 'I1', playlist_id: 'P1', asset_id: 'A1', duration: 12, position: 0 }, { id: 'I2', playlist_id: 'P1', asset_id: 'A2', duration: 10, position: 1 }];
  const labels = [{ id: 'L1', name: 'Stockholm', human_name: 'Stockholm', type: 'manual' }, { id: 'L2', name: 'My Screen', type: 'auto' }];
  const screens = [{ id: 'S1', name: 'My Screen', timezone: 'Europe/Stockholm', team_id: T }];
  const ls = [{ label_id: 'L1', screen_id: 'S1' }, { label_id: 'L2', screen_id: 'S1' }];
  const lp = [{ label_id: 'L1', playlist_id: 'P1' }, { label_id: 'L2', playlist_id: 'P2' }];
  const page = (rows, u) => { const l = Number(u.searchParams.get('limit')), o = Number(u.searchParams.get('offset')); return reply(200, rows.slice(o, o + l)); };
  return (u, opts) => {
    if (opts.download) return u.hostname === 'us-assets.screenlyapp.com' && !opts.headers.Authorization ? { bytes: png(7) } : null;
    if (u.hostname !== 'api.screenlyapp.com') return null;
    if (opts.headers.Authorization !== `Token ${SCREENLY_TOKEN}`) return reply(401, { message: 'unauthorized' });
    const routes = { '/api/v4.1/assets': assets, '/api/v4.1/playlists': playlists, '/api/v4.1/playlist-items': items, '/api/v4.1/labels': labels, '/api/v4.1/labels/screens': ls, '/api/v4.1/labels/playlists': lp, '/api/v4.1/screens': screens };
    return routes[u.pathname] ? page(routes[u.pathname], u) : null;
  };
}

test('Screenly: predicates become schedules on label groups; OR rules are listed, not guessed', async () => {
  assert.deepEqual(require('../lib/migrate/vendors/screenly').parsePredicate('TRUE AND ($WEEKDAY IN {0, 6}) AND ($TIME BETWEEN {28800000, 61200000})'), { byDay: [1, 0], from: '08:00', to: '17:00' });
  assert.equal(require('../lib/migrate/vendors/screenly').parsePredicate('$WEEKDAY IN {1} OR TRUE'), null);
  const u = mkUser('screenly');
  const ws = mkWorkspace('screenly', u);
  W.routes.push(screenlyFake());
  const { id, scan, job, texts } = await importAll(u, ws, 'screenly', { token: SCREENLY_TOKEN });
  assert.equal(job.status, 'done', job.error || '');
  assert.ok(scan.unmapped.some((x) => x.name === 'Odd rule'));
  assert.ok(scan.unmapped.some((x) => x.name === 'Web'));
  const s = db.prepare('SELECT * FROM schedules WHERE workspace_id = ?').all(ws);
  assert.equal(s.length, 1);
  assert.equal(s[0].recurrence, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(s[0].start_time.slice(11), '08:00');
  assert.equal(s[0].end_time.slice(11), '17:00');
  assert.equal(s[0].timezone, 'Europe/Stockholm');
  const ph = db.prepare('SELECT * FROM migration_screens WHERE workspace_id = ?').get(ws);
  assert.equal(ph.name, 'My Screen');
  assert.equal(JSON.parse(ph.group_ids).length, 1, 'its own auto label is not made into a group');
  assertSecretGone(SCREENLY_TOKEN, id, texts);
});

/* ===================================================================== ScreenCloud */

/*
 * Shapes: https://screencloud.github.io/signage-next-graphql-docs/ — File (id, name, mimetype, size, source,
 * fileOutputsByFileId), connections (nodes, pageInfo{hasNextPage, endCursor}), playlist-content (list[].content
 * ._ref{type,id}, props.duration ms), channel-content (zones.<id>.list), custom-layout-config (zones + css),
 * `query { currentOrgId }` -> {"data":{"currentOrgId":"3fd0011c-..."}}.
 */
const SC_TOKEN = 'sc-SECRET-graphql-token-998877';
function screencloudFake() {
  const file = (id, name, mimetype) => ({ id, name, mimetype, size: 100, source: `https://media.eu.screencloud.example/${id}`, fileOutputsByFileId: { nodes: [] } });
  const files = [file('f1', 'hello.png', 'image/png'), file('f2', 'clip.mp4', 'video/mp4'), file('f3', 'deck.pdf', 'application/pdf')];
  const playlists = [{ id: 'p1', name: 'Morning', draftOf: null, content: { list: [{ content: { _ref: { id: 'f2', type: 'file' }, props: { duration: 14000 } } }, { content: { _ref: { id: 'f1', type: 'file' }, props: { duration: 0 } } }, { content: { _ref: { id: 'x', type: 'app' }, props: {} } }], props: { default_durations: { image: 10000 } } } }];
  const layouts = [{ id: 'l1', name: 'Split', width: 1920, height: 1080, config: { zones: [{ id: 'zone1', name: 'Main Zone' }, { id: 'zone2', name: 'Sidebar Zone' }], css: '<style>\n #zone1 { position: absolute; width: 70vw; height: 100vh; top: 0; left: 0; z-index: 10; }\n #zone2 { position: absolute; width: 30vw; height: 100vh; top: 0; left: 70vw; }</style>' } }];
  const channels = [{ id: 'c1', name: 'Lobby channel', layoutId: 'l1', draftOf: null, content: { zones: { zone1: { list: [{ rules: [], content: { _ref: { id: 'p1', type: 'playlist' } } }] }, zone2: { list: [{ rules: [{ time: [{ start: '08:00', end: '10:00' }] }], content: { _ref: { id: 'f1', type: 'file' }, props: {} } }] } } } }];
  const screens = [{ id: 's1', name: 'Lobby TV', screenGroupId: 'g1', tags: ['north'], timezone: 'Europe/London', content: { _ref: { type: 'channel', id: 'c1' } } }];
  const groups = [{ id: 'g1', name: 'Default group' }];
  return (u, opts) => {
    if (opts.download) return u.hostname === 'media.eu.screencloud.example' && !opts.headers.Authorization ? { bytes: u.pathname === '/f2' ? MP4 : png(3) } : null;
    if (u.hostname !== 'graphql.eu.screencloud.com') return null;
    if (opts.headers.Authorization !== `Bearer ${SC_TOKEN}`) return reply(200, { errors: [{ message: 'no', extensions: { code: 'UNAUTHENTICATED' } }] });
    const { query, variables } = JSON.parse(opts.body);
    if (/currentOrgId/.test(query)) return reply(200, { data: { currentOrgId: '3fd0011c-b6c2-4cc9-92ba-2e1474401fa4' }, meta: { graphqlQueryCost: 1 } });
    const conn = (key, rows) => {
      // Two per page, so the cursor is followed.
      const start = variables.after ? Number(variables.after) : 0;
      const nodes = rows.slice(start, start + 2);
      return reply(200, { data: { [key]: { nodes, pageInfo: { hasNextPage: start + 2 < rows.length, endCursor: String(start + 2) } } } });
    };
    if (/allFiles/.test(query)) return conn('allFiles', files);
    if (/allPlaylists/.test(query)) return conn('allPlaylists', playlists);
    if (/allLayouts/.test(query)) return conn('allLayouts', layouts);
    if (/allChannels/.test(query)) return conn('allChannels', channels);
    if (/allScreens\(/.test(query)) return conn('allScreens', screens);
    if (/allScreenGroups/.test(query)) return conn('allScreenGroups', groups);
    return null;
  };
}

test('ScreenCloud: GraphQL cursors, channel zones from the layout CSS, files from their source', async () => {
  const u = mkUser('sc');
  const ws = mkWorkspace('sc', u);
  W.routes.push(screencloudFake());
  const { id, scan, job, texts } = await importAll(u, ws, 'screencloud', { token: SC_TOKEN, region: 'eu' });
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(scan.summary.media, 2, 'the PDF is listed, not imported (both file pages read)');
  assert.ok(scan.unmapped.some((x) => /time rules/.test(x.reason)));
  const pl = db.prepare("SELECT id FROM playlists WHERE workspace_id = ? AND name = 'Morning'").get(ws);
  const items = db.prepare('SELECT c.filename, pi.duration_sec FROM playlist_items pi JOIN content c ON c.id = pi.content_id WHERE pi.playlist_id = ? ORDER BY pi.sort_order').all(pl.id).map((r) => ({ ...r }));
  assert.deepEqual(items, [{ filename: 'clip.mp4', duration_sec: 14 }, { filename: 'hello.png', duration_sec: 10 }], 'ms -> s, 0 -> the default');
  const lay = db.prepare("SELECT * FROM layouts WHERE workspace_id = ? AND name = 'Lobby channel'").get(ws);
  const zones = db.prepare('SELECT x_percent, width_percent FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(lay.id).map((r) => ({ ...r }));
  assert.deepEqual(zones, [{ x_percent: 0, width_percent: 70 }, { x_percent: 70, width_percent: 30 }]);
  const ph = db.prepare('SELECT * FROM migration_screens WHERE workspace_id = ?').get(ws);
  assert.equal(ph.layout_id, lay.id);
  assert.equal(JSON.parse(ph.group_ids).length, 2, 'screen group + tag');
  assertSecretGone(SC_TOKEN, id, texts);
});

/* ===================================================================== Anthias */

/*
 * Shapes: Anthias source, src/anthias_server/api/serializers/v2.py (AssetSerializerV2 fields) and
 * api/urls/v2.py (/api/v2/assets, /api/v2/assets/<id>/content, /api/v2/device_settings).
 */
test('Anthias: one device, one playlist in play order, basic auth only to the device', async () => {
  process.env.OUTBOUND_ALLOW_HOSTS = 'anthias.lan';
  const u = mkUser('anthias');
  const ws = mkWorkspace('anthias', u);
  const PASS = 'anthias-PASSWORD-xyz';
  const auth = `Basic ${Buffer.from(`pi:${PASS}`).toString('base64')}`;
  W.routes.push((url, opts) => {
    if (url.hostname !== 'anthias.lan') return null;
    if (opts.headers.Authorization !== auth) return opts.download ? { status: 401 } : reply(401, { detail: 'auth' });
    if (opts.download) return { bytes: url.pathname.includes('/v1/') ? MP4 : png(9) };
    if (url.pathname === '/api/v2/assets') {
      return reply(200, [
        { asset_id: 'v1', name: 'Clip', uri: '/data/anthias_assets/v1.mp4', mimetype: 'video', duration: 20, is_enabled: true, play_order: 1, play_days: [1, 2, 3, 4, 5, 6, 7] },
        { asset_id: 'i1', name: 'Poster', uri: '/data/anthias_assets/i1.png', mimetype: 'image', duration: 7, is_enabled: true, play_order: 0, play_days: [1, 2, 3, 4, 5], play_time_from: '08:00:00' },
        { asset_id: 'w1', name: 'News', uri: 'https://news.example', mimetype: 'webpage', duration: 30, is_enabled: true, play_order: 2 },
      ]);
    }
    if (url.pathname === '/api/v2/device_settings') return reply(200, { player_name: 'Hallway Pi', timezone: 'Europe/Dublin' });
    return null;
  });
  try {
    const { id, scan, job, texts } = await importAll(u, ws, 'anthias', { url: 'http://anthias.lan', username: 'pi', password: PASS });
    assert.equal(job.status, 'done', job.error || '');
    assert.ok(scan.unmapped.some((x) => x.name === 'News'));
    assert.ok(scan.unmapped.some((x) => x.name === 'Poster' && /window/.test(x.reason)));
    const pl = db.prepare("SELECT id FROM playlists WHERE workspace_id = ? AND name = 'Hallway Pi playlist'").get(ws);
    const items = db.prepare('SELECT c.filename FROM playlist_items pi JOIN content c ON c.id = pi.content_id WHERE pi.playlist_id = ? ORDER BY pi.sort_order').all(pl.id);
    assert.deepEqual(items.map((i) => i.filename), ['Poster.png', 'Clip.mp4']);
    assert.equal(db.prepare('SELECT name FROM migration_screens WHERE workspace_id = ?').get(ws).name, 'Hallway Pi');
    assertSecretGone(PASS, id, texts);
  } finally { delete process.env.OUTBOUND_ALLOW_HOSTS; }
});

/* ===================================================================== OptiSigns */

test('OptiSigns: listed with the reason it cannot be imported, never contacted', async () => {
  const u = mkUser('opti');
  const ws = mkWorkspace('opti', u);
  const v = await call(u, ws, 'GET', '/api/migrate/vendors');
  const o = v.body.vendors.find((x) => x.id === 'optisigns');
  assert.equal(o.mode, 'none');
  const r = await call(u, ws, 'POST', '/api/migrate/jobs', { vendor: 'optisigns', credentials: { token: 'x' } });
  assert.equal(r.status, 400);
  assert.equal(W.calls.length, 0);
});

/* ===================================================================== credential lifetime */

test('a held credential expires: the sweep deletes it and the job then asks for it again', async () => {
  const u = mkUser('expire');
  const ws = mkWorkspace('expire', u);
  W.routes.push(xiboFake());
  const c = await call(u, ws, 'POST', '/api/migrate/jobs', { vendor: 'xibo', credentials: { url: 'https://cms.example.org', client_id: 'cid', client_secret: XIBO_SECRET } });
  await migrate._settle(c.body.id);
  const row = db.prepare('SELECT cred_enc, cred_expires_at FROM migration_jobs WHERE id = ?').get(c.body.id);
  assert.ok(row.cred_enc && !row.cred_enc.includes(XIBO_SECRET), 'held encrypted while the person chooses');
  assert.ok(row.cred_expires_at - Math.floor(Date.now() / 1000) <= migrate.CRED_TTL_SEC);
  db.prepare('UPDATE migration_jobs SET cred_expires_at = 1 WHERE id = ?').run(c.body.id);
  migrate._memCreds.delete(c.body.id);   // as after a restart
  migrate.sweep();
  assert.equal(db.prepare('SELECT cred_enc FROM migration_jobs WHERE id = ?').get(c.body.id).cred_enc, null);
  const r = await call(u, ws, 'POST', `/api/migrate/jobs/${c.body.id}/run`, { options: {} });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'needs_credentials');
  // Giving it again resumes.
  const r2 = await call(u, ws, 'POST', `/api/migrate/jobs/${c.body.id}/run`, { credentials: { url: 'https://cms.example.org', client_id: 'cid', client_secret: XIBO_SECRET } });
  assert.equal(r2.status, 200);
  assert.equal((await migrate._settle(c.body.id)).status, 'done');
});
