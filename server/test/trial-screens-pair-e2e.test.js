'use strict';

// One free trial per screen, end to end: a HOSTED server (no SELF_HOSTED), a real signup (so a
// real running trial), real player registers over the socket, real claims over HTTP.
//
// The earlier account's trial is seeded straight into the database rather than driven through
// pairing: /api/provision is rate limited to 5 requests a minute per address, and every request
// here comes from 127.0.0.1. Four claims fit.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const Database = require('better-sqlite3');
const { screenKeyOf } = require('../lib/trial-screens');
const { freePort } = require('./helpers/free-port');

let PORT, BASE, JWT, USER, WS;
const DATA_DIR = path.join(os.tmpdir(), 'st-trialpair-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const DB_PATH = path.join(DATA_DIR, 'db', 'remote_display.db');
let proc, tdb;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => String(crypto.randomInt(100000, 1000000));
const webFp = () => `web-apc59o-75-${crypto.randomBytes(8).toString('hex')}`;

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  const env = { ...process.env, DATA_DIR, PORT: String(PORT), NODE_ENV: 'test' };
  delete env.SELF_HOSTED;
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const r = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hopper@test.local', password: 'test12345', name: 'Hopper' }) });
  const j = await r.json();
  JWT = j.token;
  WS = j.current_workspace_id;
  tdb = new Database(DB_PATH); tdb.pragma('busy_timeout = 3000');
  USER = (j.user && j.user.id) || tdb.prepare("SELECT id FROM users WHERE email = 'hopper@test.local'").get().id;
});
after(() => {
  try { tdb && tdb.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(LOG, { force: true }); } catch { /* */ }
});

function provision(code, fingerprint) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code, fingerprint }));
    sock.on('device:registered', (d) => { try { sock.close(); } catch { /* */ } resolve(d.device_id); });
    setTimeout(() => { try { sock.close(); } catch { /* */ } resolve(null); }, 4000);
  });
}
async function claim(code) {
  const r = await fetch(BASE + '/api/provision/pair', { method: 'POST',
    headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairing_code: code }) });
  return { status: r.status, body: await r.json() };
}

test('a fresh signup is on a running trial (precondition: the rule only ever applies to one)', () => {
  const u = tdb.prepare('SELECT trial_started, plan_id, trial_plan, stripe_subscription_id FROM users WHERE id = ?').get(USER);
  assert.ok(u.trial_started);
  assert.equal(u.plan_id, u.trial_plan);
  assert.equal(u.stripe_subscription_id, null);
});

test('THE HOP: screens an earlier unpaid trial used: two pair, the third is refused with TRIAL_SCREEN_USED; a new screen still pairs and is recorded', async () => {
  // The earlier account: its trial lapsed unpaid, and it used three screens.
  const prior = 'prior-' + crypto.randomBytes(4).toString('hex');
  tdb.prepare("INSERT INTO users (id, email, password_hash, plan_id, trial_plan, trial_expired_at) VALUES (?, ?, 'x', 'free', 'pro', strftime('%s','now') - 86400)")
    .run(prior, prior + '@test.local');
  const fps = [webFp(), webFp(), webFp()];
  for (const fp of fps) {
    tdb.prepare("INSERT INTO trial_screen_ledger (screen_key, user_id, first_trial_at, last_seen_at) VALUES (?, ?, strftime('%s','now') - 864000, strftime('%s','now'))")
      .run(screenKeyOf(fp), prior);
  }

  const codes = [rnd(), rnd(), rnd()];
  const ids = [];
  for (let i = 0; i < 3; i++) { ids.push(await provision(codes[i], fps[i])); assert.ok(ids[i], `screen ${i + 1} registered`); }

  assert.equal((await claim(codes[0])).status, 200, '1st re-used screen pairs');
  assert.equal((await claim(codes[1])).status, 200, '2nd pairs');
  const third = await claim(codes[2]);
  assert.equal(third.status, 403, '3rd is refused');
  assert.equal(third.body.code, 'TRIAL_SCREEN_USED');
  assert.ok(third.body.suggested_plan, 'with a plan to buy, for the upgrade prompt');
  const d = tdb.prepare('SELECT user_id, pairing_code FROM devices WHERE id = ?').get(ids[2]);
  assert.equal(d.user_id, null, 'the refused screen was not claimed');
  assert.equal(d.pairing_code, codes[2], 'and still shows its code (pairs once a plan is bought)');
  const ev = tdb.prepare("SELECT meta FROM conversion_events WHERE user_id = ? AND event = 'limit_hit'").all(USER).map((r) => JSON.parse(r.meta || '{}'));
  assert.ok(ev.some((m) => m.code === 'TRIAL_SCREEN_USED'), 'counted in the funnel as a limit hit');

  // A screen nobody trialed pairs normally, and is now burned for other accounts.
  const fresh = webFp(), code = rnd();
  assert.ok(await provision(code, fresh));
  assert.equal((await claim(code)).status, 200);
  const row = tdb.prepare('SELECT user_id FROM trial_screen_ledger WHERE screen_key = ?').get(screenKeyOf(fresh));
  assert.equal(row && row.user_id, USER, 'recorded against this trial');
});

test('an INVITED signup gets no workspace of its own: accepting the invite is where it lands', async () => {
  assert.ok(WS, 'an ordinary signup still gets its own workspace');
  const email = 'invitee-' + crypto.randomBytes(3).toString('hex') + '@test.local';
  const inv = await fetch(`${BASE}/api/workspaces/${WS}/invites`, { method: 'POST',
    headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, role: 'workspace_editor' }) });
  assert.ok(inv.ok, 'invite created: ' + inv.status);
  const inviteId = tdb.prepare('SELECT id FROM workspace_invites WHERE lower(email) = ?').get(email).id;

  const r = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'test12345', name: 'Invitee' }) });
  const j = await r.json();
  assert.equal(r.status, 201);
  assert.equal(j.current_workspace_id, null, 'no personal workspace minted');
  const uid = j.user.id;
  assert.equal(tdb.prepare('SELECT COUNT(*) n FROM organizations WHERE owner_user_id = ?').get(uid).n, 0, 'and no organization');

  const acc = await fetch(`${BASE}/api/auth/accept-invite/${inviteId}`, { method: 'POST', headers: { Authorization: 'Bearer ' + j.token } });
  assert.equal(acc.status, 200);
  assert.equal((await acc.json()).workspace_id, WS);
  assert.deepEqual(tdb.prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ?').all(uid).map((x) => x.workspace_id), [WS],
    'their one workspace is the one they were invited to');

  // Signing in again after accepting finds that membership; nothing new is minted either.
  const li = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'test12345' }) });
  assert.equal((await li.json()).current_workspace_id, WS);
  assert.equal(tdb.prepare('SELECT COUNT(*) n FROM organizations WHERE owner_user_id = ?').get(uid).n, 0);
});

test('the no-workspace screen: an invitee who missed the link sees the invite, and can always make a workspace of their own', async () => {
  const email = 'stranded-' + crypto.randomBytes(3).toString('hex') + '@test.local';
  const inv = await fetch(`${BASE}/api/workspaces/${WS}/invites`, { method: 'POST',
    headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, role: 'workspace_viewer' }) });
  assert.ok(inv.ok);
  const r = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'test12345', name: 'Stranded' }) });
  const j = await r.json();
  assert.equal(j.current_workspace_id, null);
  const auth = { Authorization: 'Bearer ' + j.token };
  // An invite id is a capability: an address that has not been proved gets none.
  tdb.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run(j.user.id);
  const unverified = await (await fetch(BASE + '/api/auth/my-invites', { headers: auth })).json();
  assert.equal(unverified.invites.length, 0);
  assert.equal(unverified.verify_required, true);
  tdb.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(j.user.id);
  const mine = await (await fetch(BASE + '/api/auth/my-invites', { headers: auth })).json();
  assert.equal(mine.invites.length, 1, 'their invite is listed');
  assert.equal(mine.can_create_own, true);
  assert.ok(!('email' in mine.invites[0]) || mine.invites[0].email === undefined, 'shape: id, role, names');

  const own = await fetch(BASE + '/api/auth/own-workspace', { method: 'POST', headers: auth });
  assert.equal(own.status, 200);
  const ow = await own.json();
  assert.ok(ow.current_workspace_id && ow.current_workspace_id !== WS, 'a workspace of their own, despite the pending invite');
  assert.equal(tdb.prepare('SELECT COUNT(*) n FROM organizations WHERE owner_user_id = ?').get(j.user.id).n, 1);
  const again = await (await fetch(BASE + '/api/auth/own-workspace', { method: 'POST', headers: auth })).json();
  assert.equal(again.current_workspace_id, ow.current_workspace_id, 'idempotent: never a second one');
});
