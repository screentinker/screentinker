'use strict';

// #146 P2.6 — a deploy against a PRE-BLOATED device_status_log must still bind + serve
// /api/status quickly, with the chunked startup prune trickling in the background (the
// whole point of the async/chunked startup prune — the old whole-table sort froze boot
// -> healthcheck fail -> restart loop). Seed a big backlog, boot, assert /api/status
// answers fast WHILE the table is still large, then confirm the backlog drains.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { freePort } = require('./helpers/free-port');

const DATA_DIR = path.join(os.tmpdir(), 'st-boot-' + crypto.randomBytes(4).toString('hex'));
const DBPATH = path.join(DATA_DIR, 'db', 'remote_display.db');

test('boots + serves /api/status quickly against a pre-bloated table; prune drains in background', async () => {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const SEED_PORT = await freePort();
  // 1) Create + migrate the DB in a throwaway boot, then seed a large backlog.
  {
    const p = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(SEED_PORT), NODE_ENV: 'test' }, stdio: 'ignore' });
    for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${SEED_PORT}/api/status`); if (r.ok) break; } catch { /* */ } await new Promise(r => setTimeout(r, 200)); }
    p.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 300));
  }
  const seed = new Database(DBPATH);
  const ins = seed.prepare('INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, ?)');
  const now = Math.floor(Date.now() / 1000);
  seed.transaction(() => { for (let i = 0; i < 300000; i++) ins.run('d' + (i % 3), 'online', now); })();
  assert.equal(seed.prepare('SELECT COUNT(*) c FROM device_status_log').get().c, 300000, 'seeded 300k backlog');
  seed.close();

  // 2) Boot for real against the bloated table; time to first /api/status OK.
  const proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', STATUS_LOG_MAX_ROWS_PER_DEVICE: '500' }, stdio: ['ignore', fs.openSync(path.join(os.tmpdir(), 'st-boot.log'), 'w'), 'inherit'] });
  try {
    const t0 = Date.now();
    let up = false;
    for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise(r => setTimeout(r, 100)); }
    const bootMs = Date.now() - t0;
    assert.ok(up, 'server bound and served /api/status');
    assert.ok(bootMs < 3000, `/api/status answered in ${bootMs}ms — NOT blocked by the 300k prune (old sort froze ~40s)`);

    // At first-serve the prune is still trickling: the table should still be large.
    const ro1 = new Database(DBPATH, { readonly: true });
    const atBoot = ro1.prepare('SELECT COUNT(*) c FROM device_status_log').get().c; ro1.close();
    assert.ok(atBoot > 1500, `prune runs in background — table still large at first serve (${atBoot})`);

    // Give the chunked startup prune time to drain, staying responsive throughout.
    for (let i = 0; i < 40; i++) {
      const r = await fetch(BASE + '/api/status'); assert.ok(r.ok, 'stays responsive while pruning');
      const ro = new Database(DBPATH, { readonly: true });
      const c = ro.prepare('SELECT COUNT(*) c FROM device_status_log').get().c; ro.close();
      if (c <= 1500) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const ro2 = new Database(DBPATH, { readonly: true });
    const drained = ro2.prepare('SELECT COUNT(*) c FROM device_status_log').get().c; ro2.close();
    assert.equal(drained, 1500, '3 devices x 500 cap — backlog fully drained by the background startup prune');
  } finally { proc.kill('SIGKILL'); }
});
