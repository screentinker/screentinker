'use strict';

// RATE_LIMIT_CONTENT: the per-IP budget for content-library writes (server.js contentLimiter).
// Default 30/min, a number overrides it, 0 turns it off. Boots the real server.js each time.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
const { parseLimit } = require('../lib/backstop-limit');

async function boot(extraEnv) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = path.join(os.tmpdir(), 'st-content-limit-' + crypto.randomBytes(4).toString('hex'));
  const log = dataDir + '.log';
  const logFd = fs.openSync(log, 'w');
  const env = { ...process.env, DATA_DIR: dataDir, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test', ...extraEnv };
  for (const k of ['RATE_LIMIT_CONTENT', 'RATE_LIMIT_UPLOAD_CHUNKS', 'RATE_LIMIT_BACKSTOP', 'RATE_LIMIT_BACKSTOP_ANON']) if (!(k in extraEnv)) delete env[k];
  const proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(log, 'utf8').slice(-2000));
  const kill = () => { try { proc.kill('SIGKILL'); } catch { /* */ } fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { base, kill };
}

// Unauthenticated writes: the limiter runs before auth, so each one still counts against the IP.
async function writes(base, n, ip) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const r = await fetch(base + '/api/content/batch-move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: '{}',
    });
    codes.push(r.status);
    await r.arrayBuffer();
  }
  return codes;
}

test('parseLimit keeps 0 as "off" and falls back to the default on junk', () => {
  assert.equal(parseLimit(undefined, 30), 30);
  assert.equal(parseLimit('', 30), 30);
  assert.equal(parseLimit('abc', 30), 30);
  assert.equal(parseLimit('0', 30), 0);
  assert.equal(parseLimit('120', 30), 120);
});

describe('RATE_LIMIT_CONTENT unset', () => {
  let s;
  before(async () => { s = await boot({}); });
  after(() => s && s.kill());

  test('the 31st write in a minute is refused, reads are not counted', async () => {
    const codes = await writes(s.base, 31, '198.51.90.1');
    assert.ok(!codes.slice(0, 30).includes(429), 'first 30 pass the limiter');
    assert.equal(codes[30], 429);
    const r = await fetch(s.base + '/api/content', { headers: { 'X-Forwarded-For': '198.51.90.1' } });
    assert.notEqual(r.status, 429, 'a GET is not a content operation');
  });
});

describe('RATE_LIMIT_CONTENT=5', () => {
  let s;
  before(async () => { s = await boot({ RATE_LIMIT_CONTENT: '5' }); });
  after(() => s && s.kill());

  test('the configured number is the ceiling', async () => {
    const codes = await writes(s.base, 6, '198.51.90.2');
    assert.ok(!codes.slice(0, 5).includes(429));
    assert.equal(codes[5], 429);
  });
});

describe('RATE_LIMIT_CONTENT=0', () => {
  let s;
  before(async () => { s = await boot({ RATE_LIMIT_CONTENT: '0' }); });
  after(() => s && s.kill());

  test('the content limiter is off', async () => {
    const codes = await writes(s.base, 60, '198.51.90.3');
    assert.ok(!codes.includes(429), 'not one 429');
  });
});

// RATE_LIMIT_UPLOAD_CHUNKS: chunk traffic on an open session (PATCH /api/content/uploads/:id).
async function chunks(base, n, ip) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const r = await fetch(base + '/api/content/uploads/sess' + i, {
      method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'X-Forwarded-For': ip }, body: 'x',
    });
    codes.push(r.status);
    await r.arrayBuffer();
  }
  return codes;
}

describe('RATE_LIMIT_UPLOAD_CHUNKS=5', () => {
  let s;
  before(async () => { s = await boot({ RATE_LIMIT_UPLOAD_CHUNKS: '5' }); });
  after(() => s && s.kill());

  test('every session of one IP shares the ceiling, and it is not the content budget', async () => {
    const codes = await chunks(s.base, 6, '198.51.91.1');
    assert.ok(!codes.slice(0, 5).includes(429));
    assert.equal(codes[5], 429);
    const w = await writes(s.base, 1, '198.51.91.1');
    assert.notEqual(w[0], 429, 'content writes keep their own budget');
  });
});

describe('RATE_LIMIT_UPLOAD_CHUNKS=0', () => {
  let s;
  before(async () => { s = await boot({ RATE_LIMIT_UPLOAD_CHUNKS: '0' }); });
  after(() => s && s.kill());

  test('the chunk limiter is off', async () => {
    const codes = await chunks(s.base, 1300, '198.51.91.2');
    assert.ok(!codes.includes(429), 'not one 429 in 1300 chunks');
  });
});
