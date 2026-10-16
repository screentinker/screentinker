'use strict';

/*
 * Content requests (lib/content-requests.js): the whole abuse surface of the public form, tenancy of
 * the workspace side, and the approval -> publish -> expiry path through the existing release gate.
 *
 * A fresh data dir, so the migrations run here too.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-requests-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-requests';
process.env.NODE_ENV = 'test';
delete process.env.APP_URL;

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const cr = require('../lib/content-requests');
const releases = require('../lib/releases');
const emailSvc = require('../services/email');

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────

const O = 'org-req', O2 = 'org-req-2', WS = 'ws-req', WS2 = 'ws-req-other', WS3 = 'ws-req-appr';
const U = { admin: 'u-req-admin', ed: 'u-req-ed', viewer: 'u-req-viewer', other: 'u-req-other', a3: 'u-req-a3', rev: 'u-req-rev', ed3: 'u-req-ed3' };
for (const [k, id] of Object.entries(U)) db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name) VALUES (?,?,'x','user',?)").run(id, `${k}@req.local`, k);
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', U.admin);
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O2, 'Other org', U.other);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'Campus');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS2, O2, 'Elsewhere');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS3, O, 'Reviewed');
const mem = db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
mem.run(WS, U.admin, 'workspace_admin'); mem.run(WS, U.ed, 'workspace_editor'); mem.run(WS, U.viewer, 'workspace_viewer');
mem.run(WS2, U.other, 'workspace_admin');
mem.run(WS3, U.a3, 'workspace_admin'); mem.run(WS3, U.rev, 'workspace_editor'); mem.run(WS3, U.ed3, 'workspace_editor');

const PL = 'pl-req-lobby', PL_CAF = 'pl-req-caf', PL_DRAFT = 'pl-req-draft', PL_ZONED = 'pl-req-zoned', PL_OTHER = 'pl-req-other', PL3 = 'pl-req-ws3';
const G = 'g-req-caf', DEV = 'd-req-lobby';
const ins = (sql, ...a) => db.prepare(sql).run(...a);
ins("INSERT INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,'draft')", PL, U.admin, WS, 'Lobby loop');
ins("INSERT INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,'draft')", PL_CAF, U.admin, WS, 'Cafeteria');
ins("INSERT INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,'draft')", PL_DRAFT, U.admin, WS, 'Busy');
ins("INSERT INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,'draft')", PL_ZONED, U.admin, WS, 'Zoned');
ins("INSERT INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,'draft')", PL_OTHER, U.other, WS2, 'Not yours');
ins("INSERT INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,'draft')", PL3, U.a3, WS3, 'Reviewed loop');
ins('INSERT INTO layouts (id,user_id,workspace_id,name,width,height) VALUES (?,?,?,?,1920,1080)', 'l-req', U.admin, WS, 'Split');
ins("INSERT INTO layout_zones (id,layout_id,name,x_percent,y_percent,width_percent,height_percent,sort_order) VALUES ('z-req','l-req','Left',0,0,50,100,0)");
ins('INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES (?,?,?,?,?,?,?)', 'c-req-base', U.admin, WS, 'base.png', 'req-base.png', 'image/png', 10);
ins('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec,zone_id) VALUES (?,?,0,10,?)', PL_ZONED, 'c-req-base', 'z-req');
ins('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,0,10)', PL, 'c-req-base');
ins('INSERT INTO device_groups (id,user_id,workspace_id,name,playlist_id) VALUES (?,?,?,?,?)', G, U.admin, WS, 'Cafeteria screens', PL_CAF);
ins("INSERT INTO devices (id,user_id,workspace_id,name,status,playlist_id,playlist_source) VALUES (?,?,?,?,'offline',?,'device')", DEV, U.admin, WS, 'Lobby', PL);

const emitted = [];
const nsp = { adapter: { rooms: new Map() }, to: () => ({ emit: (...a) => emitted.push(a) }), emit: (...a) => emitted.push(a), sockets: new Map() };
const io = { of: () => nsp };
for (const p of [PL, PL_CAF, PL_DRAFT, PL3]) releases.releasePlaylist(db, p, io, { actor: { userId: U.admin, kind: 'user' } });
// PL_DRAFT then gets an unpublished edit: somebody's half-finished work.
ins('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,5,10)', PL_DRAFT, 'c-req-base');
ins("UPDATE playlists SET status = 'draft' WHERE id = ?", PL_DRAFT);

// ─── app ─────────────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/content-requests', requireAuth, resolveTenancy, require('../routes/content-requests'));
app.use('/api/approvals', requireAuth, resolveTenancy, require('../routes/approvals'));
app.use('/api/public/requests', require('../routes/request-public'));
const server = app.listen(0);
after(() => { server.close(); try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

const base = () => `http://127.0.0.1:${server.address().port}`;
const userRow = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
async function call(method, p, who, body, ws = WS) {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(base() + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken(userRow(U[who]), ws)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}
async function pub(method, p, body, { ticket, headers = {}, raw } = {}) {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const h = { ...headers };
  if (ticket) h['X-Request-Ticket'] = ticket;
  let payload;
  if (raw) { h['Content-Type'] = 'application/octet-stream'; payload = raw; } else if (body) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base() + '/api/public/requests' + p, { method, headers: h, body: payload, redirect: 'manual' });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json, headers: res.headers };
}

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
async function png(w, h) {
  const { Jimp } = require('jimp');
  return Buffer.from(await new Jimp({ width: w, height: h, color: 0x3366ccff }).getBuffer('image/png'));
}

async function upload(code, ticket, buf, { chunk = buf.length } = {}) {
  const c = await pub('POST', `/form/${code}/uploads`, { filename: 'poster.png', size: buf.length }, { ticket });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  let off = 0;
  while (off < buf.length) {
    const r = await pub('PATCH', `/form/${code}/uploads/${c.json.id}`, null, { ticket, raw: buf.subarray(off, off + chunk), headers: { 'Upload-Offset': String(off) } });
    if (r.status !== 200) return { id: c.json.id, refused: r };
    off = r.json.offset;
  }
  return { id: c.json.id };
}

async function linkTicket(code, email = 'pat@campus.edu', name = 'Pat Requester') {
  const r = await pub('POST', `/form/${code}/start`, { name, email });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.ticket;
}

const goodBody = (form, extra = {}) => ({ title: 'Blood drive', audience: 'Students', notes: 'Thanks!', start_date: day(form.lead_days || 0), end_date: day((form.lead_days || 0) + 6), targets: [form.targets[0].id], ...extra });

async function fullSubmit(form, opts = {}) {
  const ticket = opts.ticket || await linkTicket(form.code, opts.email);
  const up = await upload(form.code, ticket, opts.file || await png(1920, 1080));
  assert.ok(!up.refused, JSON.stringify(up.refused && up.refused.json));
  return pub('POST', `/form/${form.code}/submit`, goodBody(form, { upload_id: up.id, ...(opts.body || {}) }), { ticket });
}

async function makeForm(who = 'ed', body = {}, ws = WS) {
  const r = await call('POST', '/api/content-requests/forms', who, {
    title: 'Screens request', intro: 'Send us your posters.',
    targets: [{ label: 'Main lobby', device_id: DEV }, { label: 'Cafeteria', group_id: G }],
    file_rules: { kinds: ['image', 'video'], max_mb: 5, min_width: 1280, min_height: 720, aspect: '16:9', max_video_sec: 30 },
    ...body,
  }, ws);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return cr.getForm(r.json.id, ws);
}

// Mail is captured, never sent.
const mails = [];
const realMail = { isConfigured: emailSvc.isConfigured, sendEmail: emailSvc.sendEmail };
function mailOn() { emailSvc.isConfigured = () => true; emailSvc.sendEmail = async (m) => { mails.push(m); return { sent: true }; }; }
function mailOff() { emailSvc.isConfigured = realMail.isConfigured; emailSvc.sendEmail = realMail.sendEmail; }

beforeEach(() => { cr._resetLimits(); mails.length = 0; mailOff(); });

// ─── forms: who may make them, and what they may point at ────────────────────────────────────

test('forms: editors create them, viewers cannot, and targets resolve to playlists in this workspace only', async () => {
  const f = await makeForm('ed');
  assert.equal(f.targets[0].playlist_id, PL, 'a screen target resolves to the playlist the screen plays');
  assert.equal(f.targets[1].playlist_id, PL_CAF, 'a group target resolves to the group\'s playlist');
  assert.match(f.code, /^[A-Za-z0-9_-]{22}$/);
  assert.equal((await call('POST', '/api/content-requests/forms', 'viewer', { title: 'x', targets: [{ label: 'L', playlist_id: PL }] })).status, 403);
  const cross = await call('POST', '/api/content-requests/forms', 'ed', { title: 'x', targets: [{ label: 'L', playlist_id: PL_OTHER }] });
  assert.equal(cross.status, 400, 'another workspace\'s playlist is not a target');
  const zoned = await call('POST', '/api/content-requests/forms', 'ed', { title: 'x', targets: [{ label: 'L', playlist_id: PL_ZONED }] });
  assert.equal(zoned.json.code, 'target_zoned');
  const html = await call('POST', '/api/content-requests/forms', 'ed', { title: '<b>x</b>', targets: [{ label: 'L', playlist_id: PL }] });
  assert.equal(html.json.code, 'markup_not_allowed');
  const email = await call('POST', '/api/content-requests/forms', 'ed', { title: 'x', access_mode: 'email', allowed_domains: 'campus.edu', targets: [{ label: 'L', playlist_id: PL }] });
  assert.equal(email.json.code, 'email_not_configured', 'email mode is refused (and explained) without outgoing mail');
  const sso = await call('POST', '/api/content-requests/forms', 'ed', { title: 'x', access_mode: 'sso', targets: [{ label: 'L', playlist_id: PL }] });
  assert.equal(sso.json.code, 'sso_not_configured');
  // Tenancy: another workspace cannot see, edit or delete it.
  assert.equal((await call('GET', `/api/content-requests/forms/${f.id}`, 'other', null, WS2)).status, 404);
  assert.equal((await call('PUT', `/api/content-requests/forms/${f.id}`, 'other', { status: 'closed' }, WS2)).status, 404);
  assert.equal((await call('DELETE', `/api/content-requests/forms/${f.id}`, 'other', null, WS2)).status, 404);
  assert.equal((await call('GET', '/api/content-requests/forms', 'other', null, WS2)).json.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action = 'request_form:created' AND workspace_id = ?").get(WS).n >= 1, true, 'audited');
});

test('the public form shows friendly names only: no playlist, screen or group ids', async () => {
  const f = await makeForm();
  const r = await pub('GET', `/form/${f.code}`);
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.json);
  for (const leak of [PL, PL_CAF, DEV, G, WS, f.id]) assert.ok(!text.includes(leak), `leaked ${leak}`);
  assert.deepEqual(r.json.targets.map((t) => t.label), ['Main lobby', 'Cafeteria']);
  assert.ok(r.json.brand && r.json.brand.name);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

// ─── code guessing, rate limits, closed forms, rotation ──────────────────────────────────────

test('guessing codes locks the IP out, valid codes included', async () => {
  const f = await makeForm();
  for (let i = 0; i < cr.LIMITS.MISS_MAX; i++) {
    const r = await pub('GET', `/form/${'A'.repeat(21)}${String.fromCharCode(65 + (i % 26))}`);
    assert.equal(r.status, 404);
  }
  const blocked = await pub('GET', `/form/${f.code}`);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.code, 'locked_out');
  // Status tokens count as guesses too.
  cr._resetLimits();
  for (let i = 0; i < cr.LIMITS.MISS_MAX; i++) await pub('POST', '/status', { token: 'x'.repeat(43) });
  assert.equal((await pub('POST', '/status', { token: 'y'.repeat(43) })).json.code, 'locked_out');
});

test('per-IP limits per action', async () => {
  const f = await makeForm();
  let last;
  for (let i = 0; i < 11; i++) last = await pub('POST', `/form/${f.code}/start`, { name: 'A', email: `a${i}@x.org` });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});

test('paused and closed forms take nothing, and a rotated link is dead', async () => {
  const f = await makeForm();
  const ticket = await linkTicket(f.code);
  await call('PUT', `/api/content-requests/forms/${f.id}`, 'ed', { status: 'paused' });
  const g = await pub('GET', `/form/${f.code}`);
  assert.equal(g.json.status, 'paused');
  assert.equal(g.json.targets, undefined, 'a paused form shows no targets or rules');
  assert.equal((await pub('POST', `/form/${f.code}/start`, { name: 'A', email: 'a@x.org' })).json.code, 'form_paused');
  assert.equal((await pub('POST', `/form/${f.code}/uploads`, { filename: 'a.png', size: 10 }, { ticket })).json.code, 'form_paused');
  await call('PUT', `/api/content-requests/forms/${f.id}`, 'ed', { status: 'closed' });
  assert.equal((await pub('POST', `/form/${f.code}/submit`, { title: 'x' }, { ticket })).json.code, 'form_closed');
  await call('PUT', `/api/content-requests/forms/${f.id}`, 'ed', { status: 'open' });
  const rot = await call('POST', `/api/content-requests/forms/${f.id}/rotate`, 'ed');
  assert.notEqual(rot.json.code, f.code);
  assert.equal((await pub('GET', `/form/${f.code}`)).status, 404, 'the old link stops working');
  assert.equal((await pub('POST', `/form/${rot.json.code}/uploads`, { filename: 'a.png', size: 10 }, { ticket })).status, 401, 'tickets from the old link die with it');
});

// ─── text fields ─────────────────────────────────────────────────────────────────────────────

test('HTML in any text field is refused, not stored', async () => {
  const f = await makeForm();
  assert.equal((await pub('POST', `/form/${f.code}/start`, { name: '<script>alert(1)</script>', email: 'a@x.org' })).json.code, 'markup_not_allowed');
  const ticket = await linkTicket(f.code);
  const up = await upload(f.code, ticket, await png(1920, 1080));
  for (const body of [{ title: '<img src=x onerror=alert(1)>' }, { notes: 'hi &#60;script&#62;' }, { audience: 'a</textarea><b>' }, { title: 'x &lt;b&gt;' }]) {
    const r = await pub('POST', `/form/${f.code}/submit`, goodBody(f, { upload_id: up.id, ...body }), { ticket });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.code, 'markup_not_allowed');
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM content_requests WHERE form_id = ?').get(f.id).n, 0);
  // Ordinary punctuation is fine.
  const ok = await pub('POST', `/form/${f.code}/submit`, goodBody(f, { upload_id: up.id, title: 'Q&A night: 5 > 3?', notes: 'Room <3 is fine' }), { ticket });
  assert.equal(ok.status, 201, 'ampersands, ">" and a "<3" that opens no tag are ordinary text');
});

// ─── uploads: size, sniffing, rules, ownership ───────────────────────────────────────────────

test('uploads: size limits, early sniffing, and the declared size as a ceiling', async () => {
  const f = await makeForm();
  const ticket = await linkTicket(f.code);
  const big = await pub('POST', `/form/${f.code}/uploads`, { filename: 'a.mp4', size: 6 * 1048576 }, { ticket });
  assert.equal(big.status, 413);
  assert.equal(big.json.code, 'too_large');
  // HTML pretending to be a PNG is refused at the first chunk and the session is gone.
  const html = Buffer.from('<!doctype html><script>alert(1)</script>' + ' '.repeat(5000));
  const up = await upload(f.code, ticket, html);
  assert.equal(up.refused.status, 415);
  assert.equal(up.refused.json.code, 'type_not_allowed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM upload_sessions WHERE id = ?').get(up.id).n, 0);
  // An SVG is an image the library takes, but not one a stranger may send.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  assert.equal((await upload(f.code, ticket, svg)).refused.status, 415);
  // More bytes than declared are refused.
  const c = await pub('POST', `/form/${f.code}/uploads`, { filename: 'a.png', size: 10 }, { ticket });
  const over = await pub('PATCH', `/form/${f.code}/uploads/${c.json.id}`, null, { ticket, raw: Buffer.alloc(20), headers: { 'Upload-Offset': '0' } });
  assert.equal(over.status, 413);
  // Resumable: chunks in order, the offset is reported, a wrong offset says where it is.
  const p = await png(1920, 1080);
  const s = await pub('POST', `/form/${f.code}/uploads`, { filename: 'a.png', size: p.length }, { ticket });
  const half = Math.floor(p.length / 2);
  await pub('PATCH', `/form/${f.code}/uploads/${s.json.id}`, null, { ticket, raw: p.subarray(0, half), headers: { 'Upload-Offset': '0' } });
  const where = await pub('GET', `/form/${f.code}/uploads/${s.json.id}`, null, { ticket });
  assert.equal(where.json.offset, half);
  const wrong = await pub('PATCH', `/form/${f.code}/uploads/${s.json.id}`, null, { ticket, raw: p.subarray(half), headers: { 'Upload-Offset': '0' } });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.offset, half);
});

test('an upload belongs to the ticket that opened it', async () => {
  const f = await makeForm();
  const t1 = await linkTicket(f.code, 'one@x.org');
  const t2 = await linkTicket(f.code, 'two@x.org');
  const up = await upload(f.code, t1, await png(1920, 1080));
  assert.equal((await pub('GET', `/form/${f.code}/uploads/${up.id}`, null, { ticket: t2 })).status, 404);
  const r = await pub('POST', `/form/${f.code}/submit`, goodBody(f, { upload_id: up.id }), { ticket: t2 });
  assert.equal(r.json.code, 'no_upload');
  assert.equal((await pub('POST', `/form/${f.code}/uploads`, { filename: 'a', size: 5 })).status, 401, 'no ticket, no upload');
});

test('file rules: resolution and aspect are measured before any content row exists', async () => {
  const f = await makeForm();
  const before = db.prepare('SELECT COUNT(*) n FROM content').get().n;
  const small = await fullSubmit(f, { file: await png(640, 360) });
  assert.equal(small.status, 400); assert.equal(small.json.code, 'too_small');
  const square = await fullSubmit(f, { file: await png(1920, 1920) });
  assert.equal(square.status, 400); assert.equal(square.json.code, 'wrong_aspect');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM content').get().n, before, 'a refused file never touches the library');
});

test('video rules: a clip longer than the form allows is refused', { skip: require('child_process').spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const out = require('path').join(process.env.DATA_DIR, 'clip.mp4');
  const r = require('child_process').spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=10', '-t', '4', '-pix_fmt', 'yuv420p', out]);
  if (r.status !== 0) return;
  const f = await makeForm('ed', { file_rules: { kinds: ['video'], max_mb: 5, max_video_sec: 2 } });
  const long = await fullSubmit(f, { file: fs.readFileSync(out) });
  assert.equal(long.status, 400); assert.equal(long.json.code, 'too_long');
  const images = await makeForm('ed', { file_rules: { kinds: ['video'], max_mb: 5 } });
  const t = await linkTicket(images.code);
  assert.equal((await upload(images.code, t, await png(1920, 1080))).refused.status, 415, 'a video-only form refuses an image at the first chunk');
});

// ─── targets, dates, quotas ──────────────────────────────────────────────────────────────────

test('a request can only target what the form offers', async () => {
  const f = await makeForm();
  const ticket = await linkTicket(f.code);
  const up = await upload(f.code, ticket, await png(1920, 1080));
  for (const targets of [[PL], [PL_OTHER], ['deadbeef00'], [f.targets[0].id, 'nope'], [], [{ id: f.targets[0].id }]]) {
    const r = await pub('POST', `/form/${f.code}/submit`, goodBody(f, { upload_id: up.id, targets }), { ticket });
    assert.equal(r.status, 400, JSON.stringify(targets));
    assert.ok(['target_not_allowed', 'targets_required'].includes(r.json.code));
  }
});

test('lead time and window length', async () => {
  const f = await makeForm('ed', { lead_days: 3, max_window_days: 14 });
  const ticket = await linkTicket(f.code);
  const up = await upload(f.code, ticket, await png(1920, 1080));
  const early = await pub('POST', `/form/${f.code}/submit`, goodBody(f, { upload_id: up.id, start_date: day(1), end_date: day(5) }), { ticket });
  assert.equal(early.json.code, 'lead_time'); assert.equal(early.json.earliest_start, day(3));
  const long = await pub('POST', `/form/${f.code}/submit`, goodBody(f, { upload_id: up.id, start_date: day(3), end_date: day(30) }), { ticket });
  assert.equal(long.json.code, 'window_too_long');
  const back = await pub('POST', `/form/${f.code}/submit`, goodBody(f, { upload_id: up.id, start_date: day(5), end_date: day(4) }), { ticket });
  assert.equal(back.json.code, 'bad_window');
  const fake = await pub('POST', `/form/${f.code}/submit`, goodBody(f, { upload_id: up.id, start_date: '2026-02-30' }), { ticket });
  assert.equal(fake.json.code, 'bad_date');
});

test('quotas: per form per day, per address per day', async () => {
  const f = await makeForm('ed', { daily_quota: 2 });
  assert.equal((await fullSubmit(f, { email: 'q1@x.org' })).status, 201);
  assert.equal((await fullSubmit(f, { email: 'q2@x.org' })).status, 201);
  const t = await linkTicket(f.code, 'q3@x.org');
  const c = await pub('POST', `/form/${f.code}/uploads`, { filename: 'a.png', size: 100 }, { ticket: t });
  assert.equal(c.status, 429); assert.equal(c.json.code, 'form_quota', 'no bytes are accepted once the day\'s quota is used');

  const g = await makeForm('ed', { daily_quota: 50 });
  const saved = cr.LIMITS.PER_EMAIL_DAY;
  cr.LIMITS.PER_EMAIL_DAY = 1;
  try {
    assert.equal((await fullSubmit(g, { email: 'same@x.org' })).status, 201);
    const t2 = await linkTicket(g.code, 'same@x.org');
    assert.equal((await pub('POST', `/form/${g.code}/uploads`, { filename: 'a.png', size: 100 }, { ticket: t2 })).json.code, 'email_quota');
  } finally { cr.LIMITS.PER_EMAIL_DAY = saved; }
});

// ─── email-domain forms ──────────────────────────────────────────────────────────────────────

test('email-domain forms: exact domain, codes are bounded, and bypass attempts fail', async () => {
  mailOn();
  const f = await makeForm('ed', { access_mode: 'email', allowed_domains: 'campus.edu' });
  assert.equal((await pub('GET', `/form/${f.code}`)).json.allowed_domains[0], 'campus.edu');
  assert.equal((await pub('POST', `/form/${f.code}/start`, { name: 'A', email: 'a@campus.edu' })).json.code, 'verification_required', 'no shortcut past verification');
  for (const email of ['a@campus.edu@evil.test', 'a@evil.test', 'a@sub.campus.edu', 'a@campus.edu.evil.test', 'a@campus.edu\n@x', 'a@campus.edu ', 'a@cаmpus.edu', '"a@campus.edu"@evil.test']) {
    cr._resetLimits();
    const r = await pub('POST', `/form/${f.code}/verify`, { name: 'A', email });
    if (email === 'a@campus.edu ') { assert.equal(r.status, 200, 'surrounding spaces are trimmed'); continue; }
    assert.ok([400, 403].includes(r.status), `${JSON.stringify(email)} -> ${r.status}`);
    assert.ok(['domain_not_allowed', 'bad_email'].includes(r.json.code));
  }
  cr._resetLimits(); mails.length = 0;
  db.prepare('DELETE FROM request_email_challenges').run();
  const s = await pub('POST', `/form/${f.code}/verify`, { name: 'Sam', email: 'Sam@Campus.EDU' });
  assert.equal(s.status, 200);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'sam@campus.edu');
  const code = /(\d{6})/.exec(mails[0].text)[1];
  // Five wrong answers kill the code; the right one is then useless.
  for (let i = 0; i < cr.LIMITS.CHALLENGE_ATTEMPTS; i++) {
    const wrongCode = String((Number(code) + 1 + i) % 1000000).padStart(6, '0');
    assert.equal((await pub('POST', `/form/${f.code}/verify/confirm`, { email: 'sam@campus.edu', code: wrongCode })).json.code, 'bad_code');
  }
  assert.equal((await pub('POST', `/form/${f.code}/verify/confirm`, { email: 'sam@campus.edu', code })).json.code, 'bad_code');
  // A fresh code works, and the ticket is an email-verified one.
  const s2 = await pub('POST', `/form/${f.code}/verify`, { name: 'Sam', email: 'sam@campus.edu' });
  assert.equal(s2.status, 200);
  const code2 = /(\d{6})/.exec(mails[mails.length - 1].text)[1];
  const ok = await pub('POST', `/form/${f.code}/verify/confirm`, { email: 'sam@campus.edu', code: code2 });
  assert.equal(ok.status, 201);
  assert.equal(db.prepare('SELECT verified_via FROM request_tickets WHERE token_hash = ?').get(require('crypto').createHash('sha256').update(ok.json.ticket).digest('hex')).verified_via, 'email');
  // Mail is bounded per address per hour.
  cr._resetLimits();
  const third = await pub('POST', `/form/${f.code}/verify`, { name: 'Sam', email: 'sam@campus.edu' });
  assert.equal(third.status, 200);
  cr._resetLimits();
  const fourth = await pub('POST', `/form/${f.code}/verify`, { name: 'Sam', email: 'sam@campus.edu' });
  assert.equal(fourth.json.code, 'too_many_codes');
  // A ticket from link mode is no good once the form demands verification.
  const g = await makeForm();
  const linkT = await linkTicket(g.code, 'x@campus.edu');
  await call('PUT', `/api/content-requests/forms/${g.id}`, 'ed', { access_mode: 'email', allowed_domains: 'campus.edu' });
  assert.equal((await pub('POST', `/form/${g.code}/uploads`, { filename: 'a', size: 10 }, { ticket: linkT })).status, 401);
  // A verified submission gets a receipt; reviewers get told.
  const sub = await fullSubmit(f, { ticket: ok.json.ticket });
  assert.equal(sub.status, 201, JSON.stringify(sub.json));
  assert.ok(mails.some((m) => m.to === 'sam@campus.edu' && /received/.test(m.subject)));
  assert.ok(mails.some((m) => m.to === 'ed@req.local' && /New content request/.test(m.subject)));
  assert.equal(db.prepare('SELECT verified_via FROM content_requests WHERE ref = ?').get(sub.json.ref).verified_via, 'email');
});

// ─── SSO forms ───────────────────────────────────────────────────────────────────────────────

test('SSO forms: only the form\'s own organization\'s provider, a confined and verified address', async () => {
  const id = 'sso-req-1';
  db.prepare("INSERT INTO org_sso_providers (id, organization_id, slug, name, issuer, client_id) VALUES (?, ?, 'orgreq0000000', 'Campus IdP', 'https://idp.campus.edu', 'cid')").run(id, O);
  db.prepare("INSERT INTO org_sso_domains (id, organization_id, provider_id, domain, token, verified_at) VALUES ('dom-req', ?, ?, 'campus.edu', 'tok', 1)").run(O, id);
  const f = await makeForm('ed', { access_mode: 'sso' });
  const mine = { organizationId: O }, theirs = { organizationId: O2 };
  assert.equal(cr.ssoTicket({ formId: f.id, provider: theirs, email: 'a@campus.edu', emailAllowed: true, emailVerified: true }).error, 'provider_mismatch');
  assert.equal(cr.ssoTicket({ formId: f.id, provider: { organizationId: null }, email: 'a@campus.edu', emailAllowed: true, emailVerified: true }).error, 'provider_mismatch', 'an instance-wide provider cannot vouch for an org form');
  assert.equal(cr.ssoTicket({ formId: f.id, provider: mine, email: 'a@evil.test', emailAllowed: false, emailVerified: true }).error, 'domain_not_allowed');
  assert.equal(cr.ssoTicket({ formId: f.id, provider: mine, email: 'a@campus.edu', emailAllowed: true, emailVerified: false }).error, 'email_unverified');
  const ok = cr.ssoTicket({ formId: f.id, provider: mine, email: 'Ann@campus.edu', name: '<b>Ann</b>', emailAllowed: true, emailVerified: true });
  assert.ok(ok.ticket);
  const t = cr.ticketFor(f, ok.ticket);
  assert.equal(t.verified_via, 'sso'); assert.equal(t.email, 'ann@campus.edu');
  assert.ok(!/[<>]/.test(t.name), 'a name from the IdP is flattened');
  // The form's own domain list narrows further.
  await call('PUT', `/api/content-requests/forms/${f.id}`, 'ed', { allowed_domains: 'staff.campus.edu' });
  assert.equal(cr.ssoTicket({ formId: f.id, provider: mine, email: 'a@campus.edu', emailAllowed: true, emailVerified: true }).error, 'domain_not_allowed');
  // The auth.js finish confines the address with emailAllowedForProvider: a provider with no
  // verified domain for the address can vouch for nobody.
  await call('PUT', `/api/content-requests/forms/${f.id}`, 'ed', { allowed_domains: '' });
  const redirects = [];
  const fakeRes = { redirect: (u) => redirects.push(u) };
  require('../routes/auth').finishRequesterSso({}, fakeRes, { provider: { organizationId: O, emailDomains: 'campus.edu', slug: 'orgreq0000000' }, claims: { email: 'x@elsewhere.org', email_verified: true }, formId: f.id });
  assert.match(redirects[0], /#sso_error=domain_not_allowed$/);
  require('../routes/auth').finishRequesterSso({}, fakeRes, { provider: { organizationId: O, emailDomains: 'campus.edu', slug: 'orgreq0000000', assumeEmailVerified: true }, claims: { email: 'x@campus.edu', name: 'X' }, formId: f.id });
  assert.match(redirects[1], new RegExp(`^/r/${f.code}#ticket=`), 'the ticket travels in the fragment');
  // A link-mode ticket is no good on an SSO form.
  assert.equal(cr.ticketFor(f, cr.startLink({ ...(await makeForm()), access_mode: 'link' }, { name: 'a', email: 'a@x.org' }).ticket), null);
  // The SSO start refuses a form that is not an SSO form (no round trip to an identity provider here).
  const linkForm = await makeForm();
  const start = await pub('GET', `/form/${linkForm.code}/sso`);
  assert.equal(start.status, 302);
  assert.equal(start.headers.get('location'), `/r/${linkForm.code}#sso_error=wrong_mode`);
});

// ─── the happy path, approval off: still an explicit approve ─────────────────────────────────

let published = null;
test('approval off: a request waits for an explicit approve, then goes on its screens for its dates', async () => {
  mailOn();
  const f = await makeForm();
  const before = db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE playlist_id = ?').get(PL).n;
  const r = await fullSubmit(f, { body: { targets: [f.targets[0].id, f.targets[1].id] } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.match(r.json.ref, /^R-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(!mails.some((m) => m.to === 'pat@campus.edu'), 'no receipt to an address nobody verified');
  const row = db.prepare('SELECT * FROM content_requests WHERE ref = ?').get(r.json.ref);
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(row.content_id);
  assert.equal(content.workspace_id, WS);
  assert.equal(content.filename, 'Blood drive.png');
  assert.equal(content.expires_at, Date.parse(row.end_date + 'T00:00:00Z') / 1000 + 86400 + 14 * 3600, 'expiry past the end date everywhere');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE content_id = ?').get(content.id).n, 0, 'not on any screen yet');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE playlist_id = ?').get(PL).n, before);

  // It is in the existing queue, labelled with the requester.
  const q = await call('GET', '/api/approvals/queue?status=open', 'ed');
  const qs = q.json.find((s) => s.request_id === row.id);
  assert.ok(qs, 'in the review queue even with approval off');
  assert.equal(qs.request_name, 'Pat Requester'); assert.equal(qs.request_email, 'pat@campus.edu'); assert.equal(qs.request_ref, r.json.ref);
  const detail = await call('GET', `/api/approvals/${qs.id}`, 'ed');
  assert.equal(detail.json.request.can_decide, true);
  assert.deepEqual(detail.json.request.targets.map((t) => t.playlist_name), ['Lobby loop', 'Cafeteria']);

  // Status link: pending, nothing private.
  const st = await pub('POST', '/status', { token: r.json.status_token });
  assert.equal(st.json.state, 'pending');
  assert.deepEqual(st.json.targets, ['Main lobby', 'Cafeteria']);
  assert.ok(!JSON.stringify(st.json).includes(PL));

  // Viewers and other workspaces cannot decide.
  assert.equal((await call('POST', `/api/content-requests/requests/${row.id}/approve`, 'viewer')).status, 403);
  assert.equal((await call('POST', `/api/content-requests/requests/${row.id}/approve`, 'other', {}, WS2)).status, 404);
  assert.equal((await call('GET', `/api/content-requests/requests/${row.id}`, 'other', null, WS2)).status, 404);
  assert.equal((await call('POST', `/api/approvals/${qs.id}/approve`, 'other', {}, WS2)).status, 404);

  // Approve through the existing queue endpoint: it publishes through the release path.
  const ap = await call('POST', `/api/approvals/${qs.id}/approve`, 'ed', { comment: 'Looks good' });
  assert.equal(ap.status, 200, JSON.stringify(ap.json));
  assert.equal(ap.json.all_published, true);
  assert.ok(!('status_token_hash' in ap.json.request) && !('ip_hash' in ap.json.request), 'no token or IP hash leaves the server');
  const after =db.prepare('SELECT * FROM content_requests WHERE id = ?').get(row.id);
  assert.equal(after.status, 'published');
  for (const pl of [PL, PL_CAF]) {
    const item = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? AND content_id = ?').get(pl, content.id);
    assert.ok(item, `added to ${pl}`);
    const sch = db.prepare('SELECT * FROM playlist_item_schedules WHERE playlist_item_id = ?').get(item.id);
    assert.equal(sch.start_date, row.start_date); assert.equal(sch.end_date, row.end_date);
    const p = db.prepare('SELECT status, published_snapshot FROM playlists WHERE id = ?').get(pl);
    assert.equal(p.status, 'published');
    assert.ok(p.published_snapshot.includes(content.id), 'the published snapshot carries it');
  }
  assert.equal(db.prepare('SELECT status FROM submissions WHERE id = ?').get(row.submission_id).status, 'published');
  assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action = 'request:approved' AND workspace_id = ?").get(WS));
  assert.ok(mails.some((m) => m.to === 'pat@campus.edu' && /^Approved/.test(m.subject)), 'decisions are mailed');
  const st2 = await pub('POST', '/status', { token: r.json.status_token });
  assert.equal(st2.json.state, 'live');
  // Approving twice is refused.
  assert.equal((await call('POST', `/api/content-requests/requests/${row.id}/approve`, 'ed')).status, 409);
  published = { row, content };
});

test('expiry: the content sweep takes an ended request off the screens', async () => {
  assert.ok(published, 'depends on the previous test');
  db.prepare('UPDATE content SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 5, published.content.id);
  const out = require('../services/content-expiry').sweepExpiredContent(io);
  assert.ok(out.expired.includes(published.content.id));
  assert.ok(out.republished.includes(PL) && out.republished.includes(PL_CAF));
  const snap = JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(PL).published_snapshot);
  assert.ok(!snap.some((it) => it.content_id === published.content.id), 'gone from what the screens get');
});

test('a playlist with somebody\'s unpublished edits is never published by a request', async () => {
  const f = await makeForm('ed', { targets: [{ label: 'Busy', playlist_id: PL_DRAFT }] });
  const r = await fullSubmit(f);
  const row = db.prepare('SELECT * FROM content_requests WHERE ref = ?').get(r.json.ref);
  const ap = await call('POST', `/api/content-requests/requests/${row.id}/approve`, 'ed');
  assert.equal(ap.status, 409); assert.equal(ap.json.code, 'targets_blocked');
  assert.equal(ap.json.problems[0].code, 'playlist_has_draft');
  assert.equal(db.prepare('SELECT status FROM submissions WHERE id = ?').get(row.submission_id).status, 'submitted', 'nothing was decided');
  assert.equal(db.prepare('SELECT status FROM playlists WHERE id = ?').get(PL_DRAFT).status, 'draft', 'the draft is untouched');
});

test('rejection: a reason is required, the requester is told, and the file is switched off', async () => {
  mailOn();
  const f = await makeForm();
  const r = await fullSubmit(f, { email: 'rej@x.org' });
  const row = db.prepare('SELECT * FROM content_requests WHERE ref = ?').get(r.json.ref);
  assert.equal((await call('POST', `/api/content-requests/requests/${row.id}/reject`, 'ed', {})).json.code, 'field_required');
  assert.equal((await call('POST', `/api/content-requests/requests/${row.id}/reject`, 'viewer', { reason: 'no' })).status, 403);
  const rj = await call('POST', `/api/content-requests/requests/${row.id}/reject`, 'ed', { reason: 'Please use the 2026 logo.' });
  assert.equal(rj.status, 200, JSON.stringify(rj.json));
  assert.equal(rj.json.status, 'rejected');
  assert.equal(db.prepare('SELECT status FROM submissions WHERE id = ?').get(row.submission_id).status, 'changes_requested');
  assert.equal(db.prepare('SELECT is_active FROM content WHERE id = ?').get(row.content_id).is_active, 0);
  const m = mails.find((x) => x.to === 'rej@x.org');
  assert.ok(m && /Please use the 2026 logo/.test(m.text));
  const st = await pub('POST', '/status', { token: r.json.status_token });
  assert.equal(st.json.state, 'rejected'); assert.equal(st.json.reason, 'Please use the 2026 logo.');
  assert.equal(st.json.can_cancel, false);
});

test('a decline carrying a stale version is refused, so two reviewers cannot both decide it', async () => {
  // The dashboard's Decline dialog sends the version it was looking at (as Approve does).
  const f = await makeForm();
  const r = await fullSubmit(f, { email: 'race@x.org' });
  const row = db.prepare('SELECT * FROM content_requests WHERE ref = ?').get(r.json.ref);
  const detail = await call('GET', `/api/content-requests/requests/${row.id}`, 'ed');
  const version = detail.json.submission && detail.json.submission.version;
  assert.equal(typeof version, 'number', 'the detail the dialog reads carries the submission version');
  const stale = await call('POST', `/api/content-requests/requests/${row.id}/reject`, 'ed', { reason: 'Too late', version: version + 1 });
  assert.equal(stale.status, 409); assert.equal(stale.json.code, 'version_conflict');
  assert.ok(stale.json.error, 'the conflict carries a sentence for the dialog to show');
  assert.equal(db.prepare('SELECT status FROM content_requests WHERE id = ?').get(row.id).status, 'pending', 'nothing was decided');
  const ok = await call('POST', `/api/content-requests/requests/${row.id}/reject`, 'ed', { reason: 'Wrong size', version });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.status, 'rejected');
});

test('the requester can withdraw a waiting request from the status link', async () => {
  const f = await makeForm();
  const r = await fullSubmit(f, { email: 'wd@x.org' });
  const c = await pub('POST', '/status/cancel', { token: r.json.status_token });
  assert.equal(c.status, 200); assert.equal(c.json.state, 'cancelled');
  const row = db.prepare('SELECT * FROM content_requests WHERE ref = ?').get(r.json.ref);
  assert.equal(db.prepare('SELECT status FROM submissions WHERE id = ?').get(row.submission_id).status, 'withdrawn');
  assert.equal((await pub('POST', '/status/cancel', { token: r.json.status_token })).status, 409);
});

test('a smart playlist never picks up a request before it is approved (approval off), and does after', async () => {
  // WS has require_approval off, which is where a smart refresh publishes additions straight to screens.
  const smart = require('../lib/smart-playlist');
  const playlists = require('../routes/playlists');
  const http = require('http');
  const { Server } = require('socket.io');
  const setupDeviceSocket = require('../ws/deviceSocket');
  const sockServer = http.createServer();
  const realIo = new Server(sockServer);
  setupDeviceSocket(realIo);
  const SPL = 'pl-req-smart', SDEV = 'd-req-smart';
  try {
    // "name contains" on the title the requester chooses: the rule a requester can aim at.
    ins("INSERT INTO playlists (id,user_id,workspace_id,name,status,smart_rules) VALUES (?,?,?,?,'draft',?)", SPL, U.admin, WS, 'Smart posters',
      JSON.stringify(smart.normalizeRules({ match: 'all', rules: [{ field: 'name', op: 'contains', value: 'Smartmatch' }] })));
    ins("INSERT INTO devices (id,workspace_id,name,status,playlist_id,playlist_source) VALUES (?,?,?,'offline',?,'device')", SDEV, WS, 'Smart screen', SPL);
    releases.releasePlaylist(db, SPL, io, { actor: { userId: U.admin, kind: 'user' } });
    const refresh = () => smart.refreshNow(db, (id, seen) => playlists.publishPlaylist(id, io, seen), WS);
    const inSnapshot = (cid) => (JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(SPL).published_snapshot || '[]')).some((i) => i.content_id === cid);
    const inPayload = (cid) => JSON.stringify(setupDeviceSocket.buildPlaylistPayload(SDEV)).includes(cid);

    const f = await makeForm();
    const submitOne = async (email) => {
      const r = await fullSubmit(f, { email, body: { title: `Smartmatch ${email}` } });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      return { r, row: db.prepare('SELECT * FROM content_requests WHERE ref = ?').get(r.json.ref) };
    };
    const a = await submitOne('sm-a@x.org');
    const rej = await submitOne('sm-rej@x.org');
    const wd = await submitOne('sm-wd@x.org');
    for (const x of [a, rej, wd]) assert.equal(db.prepare('SELECT is_active FROM content WHERE id = ?').get(x.row.content_id).is_active, 0, 'a waiting request is switched off');

    refresh();
    for (const x of [a, rej, wd]) {
      assert.ok(!inSnapshot(x.row.content_id), 'not in the smart playlist while it waits');
      assert.ok(!inPayload(x.row.content_id), 'not in what the screen is sent while it waits');
    }
    // Belt and braces: even switched on by something else, a pending request is not selected.
    db.prepare('UPDATE content SET is_active = 1 WHERE id = ?').run(a.row.content_id);
    refresh();
    assert.ok(!inSnapshot(a.row.content_id), 'a pending request is excluded even if active');
    db.prepare('UPDATE content SET is_active = 0 WHERE id = ?').run(a.row.content_id);

    // Rejected and withdrawn requests stay out.
    assert.equal((await call('POST', `/api/content-requests/requests/${rej.row.id}/reject`, 'ed', { reason: 'No thanks' })).status, 200);
    assert.equal((await pub('POST', '/status/cancel', { token: wd.r.json.status_token })).status, 200);
    refresh();
    for (const x of [rej, wd]) {
      assert.ok(!inSnapshot(x.row.content_id), 'rejected / withdrawn: not in the smart playlist');
      assert.ok(!inPayload(x.row.content_id), 'rejected / withdrawn: not sent to the screen');
    }

    // Approval switches it on and tells the smart playlists; the refresh then carries it.
    const notified = [];
    const realNotify = smart.notifyContentChanged;
    smart.notifyContentChanged = (ws) => notified.push(ws);
    let ap;
    try { ap = await call('POST', `/api/content-requests/requests/${a.row.id}/approve`, 'ed'); } finally { smart.notifyContentChanged = realNotify; }
    assert.equal(ap.status, 200, JSON.stringify(ap.json));
    assert.equal(db.prepare('SELECT is_active FROM content WHERE id = ?').get(a.row.content_id).is_active, 1);
    assert.ok(notified.includes(WS), 'approval wakes the smart playlists');
    refresh();
    assert.ok(inSnapshot(a.row.content_id), 'approved: in the smart playlist');
    assert.ok(inPayload(a.row.content_id), 'approved: sent to the screen');
    for (const x of [rej, wd]) assert.ok(!inSnapshot(x.row.content_id));
  } finally {
    realIo.close(); sockServer.close();
    db.prepare('DELETE FROM devices WHERE id = ?').run(SDEV);
  }
});

// ─── approval on: reviewers decide, and the gate sees a real approval ────────────────────────

test('approval on: only reviewers decide, and the playlist release passes the gate with its own approval', async () => {
  const s = await call('PUT', '/api/approvals/settings', 'a3', { reviewers: [U.rev], require_approval: true }, WS3);
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const fr = await call('POST', '/api/content-requests/forms', 'ed3', { title: 'Reviewed', targets: [{ label: 'Hall', playlist_id: PL3 }], file_rules: { kinds: ['image'], max_mb: 5 } }, WS3);
  assert.equal(fr.status, 201);
  const f = cr.getForm(fr.json.id, WS3);
  const r = await fullSubmit(f, { email: 'ar@x.org' });
  const row = db.prepare('SELECT * FROM content_requests WHERE ref = ?').get(r.json.ref);
  const notReviewer = await call('POST', `/api/content-requests/requests/${row.id}/approve`, 'ed3', {}, WS3);
  assert.equal(notReviewer.status, 403); assert.equal(notReviewer.json.code, 'not_reviewer');
  // Turning approval off does not drop a waiting request on the floor.
  const ok = await call('POST', `/api/content-requests/requests/${row.id}/approve`, 'rev', {}, WS3);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.all_published, true);
  const plSub = db.prepare("SELECT * FROM submissions WHERE resource_type = 'playlist' AND resource_id = ? AND request_id = ?").get(PL3, row.id);
  assert.ok(plSub, 'the playlist change had its own submission');
  assert.equal(plSub.status, 'published'); assert.equal(plSub.reviewer_id, U.rev);
  assert.ok(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(PL3).published_snapshot.includes(row.content_id));

  const r2 = await fullSubmit(f, { email: 'ar2@x.org' });
  const row2 = db.prepare('SELECT * FROM content_requests WHERE ref = ?').get(r2.json.ref);
  await call('PUT', '/api/approvals/settings', 'a3', { require_approval: false }, WS3);
  assert.equal(db.prepare('SELECT status FROM submissions WHERE id = ?').get(row2.submission_id).status, 'submitted', 'a request survives approval being turned off');
  // ...and with approval off any editor may now decide it.
  const ok2 = await call('POST', `/api/content-requests/requests/${row2.id}/approve`, 'ed3', {}, WS3);
  assert.equal(ok2.status, 200, JSON.stringify(ok2.json));
});

test('a request never reaches another workspace\'s screens', async () => {
  const f = await makeForm();
  // Even if the stored target were tampered with, approval re-checks the playlist's workspace.
  const r = await fullSubmit(f);
  const row = db.prepare('SELECT * FROM content_requests WHERE ref = ?').get(r.json.ref);
  db.prepare('UPDATE content_requests SET targets = ? WHERE id = ?').run(JSON.stringify([{ id: 'aaaaaaaa', label: 'Sneaky', playlist_id: PL_OTHER }]), row.id);
  const ap = await call('POST', `/api/content-requests/requests/${row.id}/approve`, 'ed');
  assert.equal(ap.status, 409); assert.equal(ap.json.problems[0].code, 'gone');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE playlist_id = ? AND content_id = ?').get(PL_OTHER, row.content_id).n, 0);
});
