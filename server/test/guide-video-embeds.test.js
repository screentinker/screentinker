'use strict';

/*
 * Every video a /guides/ page embeds must be allowed by the page's own CSP.
 *
 * ⚠️ THE BUG THIS PINS. The guide pages get the dashboard policy, whose frame-src listed only
 * youtube.com, while the Samsung guide embedded youtube-nocookie.com. The page returned 200 and
 * the video was a blank box with nothing in any log but the browser console.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { freePort } = require('./helpers/free-port');

const GUIDES = path.join(__dirname, '..', '..', 'frontend', 'guides');

function frameOrigins() {
  const found = [];
  for (const f of fs.readdirSync(GUIDES).filter((n) => n.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(GUIDES, f), 'utf8');
    for (const m of html.matchAll(/<iframe[^>]*\ssrc="(https:\/\/[^"]+)"/g)) found.push({ file: f, origin: new URL(m[1]).origin });
  }
  return found;
}

test('the guide pages embed at least one video (the check below is not vacuous)', () => {
  assert.ok(frameOrigins().length > 0);
});

test("every guide page's embedded frames are allowed by its frame-src", async () => {
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-guide-csp-'));
  const PORT = await freePort();
  const proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', NODE_ENV: 'test', PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/api/status`); if (r.ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const { file, origin } of frameOrigins()) {
      const res = await fetch(`http://127.0.0.1:${PORT}/guides/${file}`);
      assert.equal(res.status, 200, file);
      const csp = res.headers.get('content-security-policy') || '';
      const frameSrc = (csp.match(/(?:^|;)\s*frame-src ([^;]*)/) || [])[1];
      if (frameSrc === undefined) continue; // no policy on this path: nothing blocks the frame
      assert.ok(frameSrc.split(/\s+/).includes(origin), `${file} embeds ${origin}, but its frame-src is "${frameSrc}"`);
    }
  } finally {
    proc.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
});
