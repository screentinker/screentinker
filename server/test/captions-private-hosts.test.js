'use strict';

/*
 * "Generate captions" on a HOSTED instance follows exactly the Private AI rule: a speech-to-text
 * server on a private address is refused, unless a platform administrator allowed that exact host
 * for the workspace's organization (ai_private_hosts) — and then it works, end to end, through the
 * real guarded transport (lib/ai-fetch) to a fake Whisper server on 127.0.0.1. No real network.
 *
 * Before the fix lib/a11y/captions.js asked endpointAllowed(url) without the workspace, so the
 * allow list was never consulted and an allowed local Whisper server was still refused.
 */
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-capt-priv-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-captions-private';
process.env.NODE_ENV = 'test';
delete process.env.SELF_HOSTED;
delete process.env.OUTBOUND_ALLOW_HOSTS;
delete process.env.OUTBOUND_ALLOW_PRIVATE;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const express = require('express');
const { db } = require('../db/database');
const config = require('../config');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const privateAi = require('../lib/private-ai');
const captions = require('../lib/a11y/captions');

let FFMPEG = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { FFMPEG = false; }

const O = 'org-capt', O2 = 'org-capt-other', WS = 'ws-capt', WS2 = 'ws-capt-other';
const U = { admin: 'u-capt-admin', other: 'u-capt-other', owner: 'u-capt-owner' };
for (const [k, id] of Object.entries(U)) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name) VALUES (?,?,'x','user',?)").run(id, `${k}@capt.local`, k);
}
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'School', U.owner);
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O2, 'Elsewhere', U.owner);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'Hall');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS2, O2, 'Theirs');
db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(WS, U.admin, 'workspace_admin');
db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(WS2, U.other, 'workspace_admin');

const app = express();
app.use(express.json());
app.use('/api/accessibility', requireAuth, resolveTenancy, require('../routes/accessibility'));
const server = app.listen(0, '127.0.0.1');

// The fake local Whisper server.
const heard = [];
const whisper = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    heard.push({ url: req.url, bytes: Buffer.concat(chunks).length });
    res.writeHead(200, { 'content-type': 'text/vtt' });
    res.end('WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nWelcome to the hall\n');
  });
});

let BASE;
before(async () => {
  await new Promise((r) => whisper.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${whisper.address().port}/v1`;
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  fs.mkdirSync(config.contentDir, { recursive: true });
  if (FFMPEG) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=gray:s=160x90:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(config.contentDir, 'capt-talk.mp4')]);
  }
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, updated_at, duration_sec)
              VALUES ('c-capt-talk', ?, ?, 'Assembly.mp4', 'capt-talk.mp4', 'video/mp4', 1000, 100, 2)`).run(U.admin, WS);
});
after(async () => {
  server.close();
  whisper.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const userRow = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
async function call(method, pathname, who, body, ws = WS) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken(userRow(U[who]), ws)}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}
async function waitJob(id) {
  let st;
  for (let i = 0; i < 150; i++) {
    st = await call('GET', `/api/accessibility/captions/${id}`, 'admin');
    if (st.json.job && st.json.job.status !== 'running') return st.json.job;
    await new Promise((r) => setTimeout(r, 100));
  }
  return st.json.job;
}

test('hosted: a private speech-to-text host that is NOT allowed is refused, and nothing is sent', async () => {
  assert.equal(config.selfHosted, false, 'this test is about the hosted rules');
  const r = await call('PUT', '/api/accessibility/stt', 'admin', { base_url: BASE, model: 'whisper-1' });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /not allowed/);
  assert.equal(captions.getStt(db, WS).configured, false);
  assert.equal(heard.length, 0);
});

test('hosted: once the platform admin allows that host for Private AI, captions use it, end to end', { skip: !FFMPEG && 'ffmpeg not installed' }, async () => {
  privateAi.addAllowedHost(O, '127.0.0.1', U.owner);
  const r = await call('PUT', '/api/accessibility/stt', 'admin', { base_url: BASE, model: 'whisper-1' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const g = await call('POST', '/api/accessibility/captions/c-capt-talk', 'admin', { lang: 'en' });
  assert.equal(g.status, 202, JSON.stringify(g.json));
  const job = await waitJob('c-capt-talk');
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(heard.length, 1, 'sent once, through the real guarded transport');
  assert.equal(heard[0].url, '/v1/audio/transcriptions');
  const row = db.prepare('SELECT subtitle_url FROM content WHERE id = ?').get('c-capt-talk');
  assert.match(fs.readFileSync(path.join(config.contentDir, row.subtitle_url), 'utf8'), /Welcome to the hall/);
});

test('⚠️ hosted: the allow list opens that ONE host for that ONE organization — nothing else loosens', async () => {
  privateAi.addAllowedHost(O, '127.0.0.1', U.owner);
  // Another private host in the same organization.
  const other = await call('PUT', '/api/accessibility/stt', 'admin', { base_url: 'http://192.168.77.5:8000/v1' });
  assert.equal(other.status, 400);
  // The same host from a workspace in another organization.
  const foreign = await call('PUT', '/api/accessibility/stt', 'other', { base_url: BASE }, WS2);
  assert.equal(foreign.status, 400);
  assert.equal(captions.saveStt(db, WS2, { base_url: BASE }).ok, false);
  // Cloud metadata is never allowed.
  assert.equal(captions.saveStt(db, WS, { base_url: 'http://169.254.169.254/latest' }).ok, false);
});

test('⚠️ hosted: a host removed from the allow list after it was saved is refused at Generate time', { skip: !FFMPEG && 'ffmpeg not installed' }, async () => {
  privateAi.addAllowedHost(O, '127.0.0.1', U.owner);
  assert.equal(captions.saveStt(db, WS, { base_url: BASE }).ok, true);
  privateAi.removeAllowedHost(O, '127.0.0.1');
  const n = heard.length;
  assert.equal((await call('POST', '/api/accessibility/captions/c-capt-talk', 'admin')).status, 202);
  const job = await waitJob('c-capt-talk');
  assert.equal(job.status, 'failed');
  assert.match(job.error, /not allowed/);
  assert.equal(heard.length, n, 'nothing was sent');
});

test('"only private AI": captions to a public endpoint are refused, like every other AI feature', { skip: !FFMPEG && 'ffmpeg not installed' }, async () => {
  db.prepare("UPDATE ai_settings SET stt_base_url = 'http://8.8.8.8/v1' WHERE workspace_id = ?").run(WS);
  privateAi.setOnlyPrivate(O, true, U.owner);
  try {
    assert.equal((await call('POST', '/api/accessibility/captions/c-capt-talk', 'admin')).status, 202);
    const job = await waitJob('c-capt-talk');
    assert.equal(job.status, 'failed');
    assert.equal(job.error, privateAi.POLICY_ERROR);
  } finally { privateAi.setOnlyPrivate(O, false, U.owner); }
});
