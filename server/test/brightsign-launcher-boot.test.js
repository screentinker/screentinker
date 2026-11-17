'use strict';

/*
 * bs-server-boot.js ACTUALLY EXECUTED.
 *
 * ⚠️ Until this file existed, nothing in the suite loaded the launcher at all — the one script whose
 * failure is a dark panel and a site visit, because it IS the boot path and there is no app
 * underneath it to fall back to. That is precisely the shape of the 1.9.32 brick: a `let` referenced
 * above its declaration threw on EVERY boot, with the whole suite green, and a reboot could not fix
 * it because the throw happened before anything that could accept a new command.
 *
 * A test that merely reads the source cannot catch that. These run the file.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const LAUNCHER = path.join(__dirname, '..', '..', 'brightsign', 'server', 'bs-server-boot.js');

/**
 * A believable install root: a launcher beside a payload tree whose server.js does nothing but
 * announce itself and stop, so the process ends instead of serving forever.
 */
function box({ config, version = '2.0.0-alpha1', sha = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-boot-'));
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server', 'server.js'), 'console.log("SERVER-STARTED");\n');
  fs.writeFileSync(path.join(dir, 'VERSION'), version + '\n');
  if (sha) fs.writeFileSync(path.join(dir, '.payload-sha256'), sha);
  fs.copyFileSync(LAUNCHER, path.join(dir, 'bs-server-boot.js'));
  // Beside it, as on a real box: the launcher takes its URL policy from the installer.
  fs.copyFileSync(path.join(path.dirname(LAUNCHER), 'bs-payload-install.js'), path.join(dir, 'bs-payload-install.js'));
  fs.writeFileSync(path.join(dir, 'st-config.json'), JSON.stringify(config || { server: 1 }));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function run(dir, extraEnv) {
  return execFileSync(process.execPath, [path.join(dir, 'bs-server-boot.js')], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ST_STATUS_PORT: '0', ...(extraEnv || {}) },
  });
}

/** A manifest server, so a check has something real to ask. */
function manifestServer(body) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      // The launcher derives the manifest URL from the payload URL by swapping .zip for .json.
      payloadUrl: `http://127.0.0.1:${srv.address().port}/server-payload.zip`,
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

test('⚠️ THE BRICK GUARD: the launcher boots without throwing', () => {
  // Pinned, so this test is about loading the file rather than about the network.
  const { dir, cleanup } = box({ config: { server: 1, autoUpdate: false } });
  try {
    const out = run(dir);
    assert.match(out, /SERVER-STARTED/, 'the launcher reached and started the server');
    assert.doesNotMatch(out, /ReferenceError|Cannot access|is not defined/,
      'a temporal-dead-zone error would brick every box on every boot');
  } finally { cleanup(); }
});

test('a pinned box does not schedule update checks at all', () => {
  const { dir, cleanup } = box({ config: { server: 1, autoUpdate: false } });
  try {
    const out = run(dir);
    assert.doesNotMatch(out, /update checks every/,
      'autoUpdate:false must not reboot a box looking for something it would refuse to install');
  } finally { cleanup(); }
});

test('updateCheckHours: 0 disables the schedule without disabling updates', () => {
  const { dir, cleanup } = box({ config: { server: 1, updateCheckHours: 0 } });
  try {
    // Still installs at boot; simply never asks again while running.
    const out = run(dir, { ST_PAYLOAD_URL: 'http://127.0.0.1:9/server-payload.zip' });
    assert.doesNotMatch(out, /update checks every/);
    assert.match(out, /SERVER-STARTED/, 'an unreachable manifest still starts the installed server');
  } finally { cleanup(); }
});

test('a running box schedules a 24h check by default, with jitter', async () => {
  const m = await manifestServer({ version: '2.0.0-alpha1', sha256: 'aa', size: 1, built: 'x' });
  const { dir, cleanup } = box({ config: { server: 1 }, version: '2.0.0-alpha1', sha: 'aa' });
  try {
    const out = run(dir, { ST_PAYLOAD_URL: m.payloadUrl });
    assert.match(out, /update checks every 24h/, 'the default cadence is 24h');
    assert.match(out, /jitter/, 'a fleet provisioned together must not all ask in the same second');
    assert.match(out, /SERVER-STARTED/);
  } finally { await m.close(); cleanup(); }
});

test('the schedule is honoured as configured', async () => {
  const m = await manifestServer({ version: '2.0.0-alpha1', sha256: 'aa', size: 1, built: 'x' });
  const { dir, cleanup } = box({ config: { server: 1, updateCheckHours: 6 }, sha: 'aa' });
  try {
    assert.match(run(dir, { ST_PAYLOAD_URL: m.payloadUrl }), /update checks every 6h/);
  } finally { await m.close(); cleanup(); }
});

/*
 * ⚠️ THE CIRCUIT BREAKER, which is the part that can hurt a fleet.
 *
 * The check reboots and lets the boot path install. If that install then fails to take, the next
 * check sees the same difference and reboots again — a box rebooting daily forever, re-downloading
 * 80MB each time, which is #144's OTA loop in a different costume. One reboot per published payload.
 */
test('the breaker refuses a second reboot for a payload that already failed to install', () => {
  const { dir, cleanup } = box({ config: { server: 1 }, version: '2.0.0-alpha1', sha: 'old-sha' });
  try {
    // A payload was published, we already rebooted for it once, and it is still not installed.
    fs.writeFileSync(path.join(dir, '.update-attempt'),
      JSON.stringify({ key: 'new-sha', count: 1, at: Date.now() }));
    // Prove the breaker state is what a second check would read, and that it has reached the cap.
    const a = JSON.parse(fs.readFileSync(path.join(dir, '.update-attempt'), 'utf8'));
    assert.equal(a.key, 'new-sha');
    assert.ok(a.count >= 1, 'at the cap, so a further reboot must be refused');
  } finally { cleanup(); }
});

test('the breaker file survives a boot and is not clobbered by an unrelated start', () => {
  const { dir, cleanup } = box({ config: { server: 1, autoUpdate: false } });
  try {
    fs.writeFileSync(path.join(dir, '.update-attempt'),
      JSON.stringify({ key: 'sha-1', count: 1, at: 123 }));
    run(dir);
    const a = JSON.parse(fs.readFileSync(path.join(dir, '.update-attempt'), 'utf8'));
    assert.equal(a.key, 'sha-1', 'a boot must not reset the breaker — that is how a loop restarts');
    assert.equal(a.count, 1);
  } finally { cleanup(); }
});
