'use strict';

/*
 * Framing headers when this server IS the display it serves.
 *
 * ⚠️ THE BUG THIS PINS. A BrightSign hosting ScreenTinker shows a local page from
 * `file:///ssd:/node-server.html` that layers the player in an iframe. helmet sets
 * X-Frame-Options: SAMEORIGIN, file:// is not the same origin as http://127.0.0.1:8181, and the
 * result was a BLACK SCREEN on real hardware while every asset inside the frame returned 200 — the
 * player page, its six scripts, all fine, nothing in any log. Only the response headers said why.
 *
 * ⚠️ AND IT IS NOT JUST /player. Chrome evaluates SAMEORIGIN against the TOP-LEVEL document rather
 * than the immediate parent, so with a file:// page at the top, every iframe the player itself uses
 * — widget renders, kiosk views — is blocked by the same rule one level deeper. A fix scoped to
 * /player would have cleared the black screen and left every widget in the playlist black instead.
 * That is why the test below checks a widget-render path too, not only the player.
 *
 * The exception must stay narrow: player-host mode only, loopback only. A normal server must keep
 * SAMEORIGIN, or this "fix" is a clickjacking regression for every hosted install.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { freePort } = require('./helpers/free-port');
const VERSION = require('../version');

async function withServer(env, fn) {
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-framing-'));
  const PORT = await freePort();
  const proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', NODE_ENV: 'test', PORT: String(PORT), ...env },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/api/status`); if (r.ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    await fn(`http://127.0.0.1:${PORT}`);
  } finally {
    proc.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

test('an ordinary server refuses to be framed', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/player/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN',
      'a normal install must keep clickjacking protection');
  });
});

test('a player host lets its own local page frame the player', async () => {
  await withServer({ ST_PLAYER_HOST: '1' }, async (base) => {
    const res = await fetch(`${base}/player/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-frame-options'), null,
      'the file:// diagnostics page cannot frame the player while this header is set');
  });
});

test('the legacy route serves prebuilt player assets without a runtime transform', async () => {
  await withServer({}, async (base) => {
    for (const route of ['/player/legacy', '/player/legacy.html']) {
      const page = await fetch(`${base}${route}?host=webos`);
      assert.equal(page.status, 200, route);
      const html = await page.text();
      assert.match(html, /window\.__playerConfig/, route);
      assert.match(html, new RegExp("const PLAYER_VERSION\\s*=\\s*'" + String(VERSION).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'"), route);
      assert.match(html, /live-publish-legacy\.js/, route);
      assert.match(html, /talk-legacy\.js/, route);
    }
    for (const asset of ['/sw-legacy.js', '/player/live-publish-legacy.js', '/player/talk-legacy.js']) {
      const res = await fetch(base + asset);
      assert.equal(res.status, 200, asset);
    }
  });
});

test('THE DEEPER CASE: nested frames inside the player are freed too', async () => {
  // SAMEORIGIN is judged against the top-level document, which here is file://. If this header
  // survives anywhere the player frames, that content is black even though /player itself renders.
  await withServer({ ST_PLAYER_HOST: '1' }, async (base) => {
    for (const p of ['/', '/app', '/player/debug-overlay.js']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.headers.get('x-frame-options'), null,
        `${p} still refuses framing, so anything the player embeds from it renders black`);
    }
  });
});

test('the frame-ancestors directive is relaxed rather than the whole policy dropped', async () => {
  // Where a CSP is set, frame-ancestors 'self' blocks the frame just as effectively as the header
  // above — but the rest of that policy is still worth keeping.
  await withServer({ ST_PLAYER_HOST: '1' }, async (base) => {
    const res = await fetch(`${base}/app`);
    const csp = res.headers.get('content-security-policy');
    if (!csp) return;   // no policy on this route, nothing to assert
    assert.match(csp, /frame-ancestors \*/, 'frame-ancestors must be relaxed for the local page');
    assert.match(csp, /default-src/, 'the remainder of the policy must survive');
  });
});
