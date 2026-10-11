#!/usr/bin/env node
'use strict';
/*
 * Protocol tests for the Roku player, run in brs-node (Node 22):
 *
 *   node roku/tests/run-protocol.js            unit tests of the Engine.IO/socket.io codec + helpers
 *   node roku/tests/run-protocol.js --e2e      …plus the end-to-end run against a real server
 *
 * The end-to-end run starts THIS checkout's server (server/server.js, or SERVER_DIR) on a random
 * port with a throwaway DATA_DIR, creates an admin, runs tests/brs/e2e_main.brs — the Roku's own
 * codec doing a real Engine.IO long-poll session — pairs the code it registers with through the
 * dashboard API, and then checks what the server recorded about the display.
 *
 * Env: BRS_CLI (brs-node's bin/brs.cli.js), NODE_FOR_SERVER (node used for the server; the
 * server's own tests run on Node 20).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROKU = path.resolve(__dirname, '..');
const REPO = path.resolve(ROKU, '..');
const BRS_CLI = process.env.BRS_CLI || [
  path.join(ROKU, 'node_modules/brs-node/bin/brs.cli.js'),
].find((p) => fs.existsSync(p));
if (!BRS_CLI) { console.error('brs-node not found: npm install in roku/ (see tests/README.md)'); process.exit(2); }

let failures = 0;

function runUnit() {
  const files = ['source/lib/util.brs', 'source/lib/engineio.brs', 'tests/brs/engineio_test.brs'].map((f) => path.join(ROKU, f));
  const r = spawnSync(process.execPath, [BRS_CLI, '--no-sg', '-c', '0', ...files], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  for (const l of out.split('\n')) if (l.startsWith('FAIL')) console.log(l);
  const done = out.match(/DONE (\d+) (\d+)/);
  if (!done) { console.log(out); console.log('FAIL codec tests did not finish'); failures++; return; }
  console.log(`codec: ${done[1]} passed, ${done[2]} failed`);
  failures += Number(done[2]);
}

async function api(base, p, opts = {}, token) {
  const r = await fetch(base + '/api' + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${p} -> ${r.status} ${text.slice(0, 200)}`);
  return body;
}

async function runE2E() {
  const serverDir = process.env.SERVER_DIR || path.join(REPO, 'server');
  const nodeForServer = process.env.NODE_FOR_SERVER || process.execPath;
  const port = 3500 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'st-roku-e2e-'));
  const srv = spawn(nodeForServer, ['server.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: data, SELF_HOSTED: 'true', NODE_ENV: 'development', JWT_SECRET: crypto.randomBytes(16).toString('hex') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', (d) => { srvLog += d; });
  srv.stderr.on('data', (d) => { srvLog += d; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-roku-pkg-'));
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(base + '/'); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
    const reg = await api(base, '/auth/register', { method: 'POST', body: JSON.stringify({ email: 'e2e@roku.test', password: crypto.randomBytes(12).toString('base64url') + 'aA1!', name: 'E2E' }) });
    const token = reg.token;
    const code = String(100000 + crypto.randomInt(900000));

    fs.mkdirSync(path.join(root, 'source'), { recursive: true });
    for (const f of ['util.brs', 'engineio.brs']) fs.copyFileSync(path.join(ROKU, 'source/lib', f), path.join(root, 'source', f));
    fs.copyFileSync(path.join(ROKU, 'tests/brs/e2e_main.brs'), path.join(root, 'source/main.brs'));
    const caps = require(path.join(ROKU, 'tests/capabilities.json'));
    fs.writeFileSync(path.join(root, 'e2e.json'), JSON.stringify({ server: base, pairing_code: code, capabilities: caps }));

    // brs-node resolves pkg:/ against --root, and wants the source files RELATIVE to it.
    fs.writeFileSync(path.join(root, 'manifest'), 'title=e2e\nmajor_version=0\nminor_version=1\nbuild_version=1\n');
    const brs = spawn(process.execPath, [BRS_CLI, '--no-sg', '-c', '0', '--root', root, ...fs.readdirSync(path.join(root, 'source')).map((f) => 'source/' + f)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    let pairedVia = null;
    let deviceId = null;
    const finished = new Promise((resolve) => {
      let buf = '';
      const onData = async (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          lines.push(line);
          console.log('  roku> ' + line);
          const m = line.match(/^REGISTERED (\S+) (\S*)/);
          if (m && !pairedVia) {
            deviceId = m[1];
            pairedVia = 'pending';
            try {
              await api(base, '/provision/pair', { method: 'POST', body: JSON.stringify({ pairing_code: code, name: 'Lobby Roku', browser_timezone: 'America/Chicago' }) }, token);
              pairedVia = 'api';
            } catch (e) { console.log('FAIL pairing through the dashboard API: ' + e.message); failures++; }
          }
        }
      };
      brs.stdout.on('data', onData);
      brs.stderr.on('data', onData);
      brs.on('exit', resolve);
    });
    const timer = setTimeout(() => brs.kill('SIGKILL'), 150000);
    await finished;
    clearTimeout(timer);

    const need = ['STEP open', 'STEP connected', 'REGISTERED', 'STEP paired', 'STEP playlist', 'STEP heartbeat acked', 'DONE'];
    for (const n of need) {
      if (!lines.some((l) => l.startsWith(n))) { console.log(`FAIL e2e step missing: ${n}`); failures++; }
    }
    for (const l of lines) if (l.startsWith('FAIL')) failures++;

    if (deviceId) {
      const devices = await api(base, '/devices', {}, token);
      const list = Array.isArray(devices) ? devices : (devices.devices || []);
      const d = list.find((x) => x.id === deviceId);
      if (!d) { console.log('FAIL the paired Roku is not in the device list'); failures++; }
      else {
        console.log(`  server> name=${d.name} status=${d.status} platform=${d.platform} client_type=${d.client_type} platform_family=${d.platform_family}`);
        if (d.status !== 'online') { console.log('FAIL device is not online'); failures++; }
        if (d.client_type !== undefined && d.client_type !== 'roku') { console.log('FAIL client_type was not kept as roku'); failures++; }
      }
    }
    console.log(`e2e: ${failures ? 'FAILED' : 'passed'}`);
  } catch (e) {
    console.log('FAIL e2e: ' + e.message);
    console.log(srvLog.slice(-2000));
    failures++;
  } finally {
    srv.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  runUnit();
  if (process.argv.includes('--e2e')) await runE2E();
  process.exit(failures ? 1 : 0);
})();
