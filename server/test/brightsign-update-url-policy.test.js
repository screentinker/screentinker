'use strict';

/*
 * GHSA-rvxj (BrightSign section): where the on-player server updater may fetch code from, what it
 * will install without a checksum, and what it prints about the URL.
 *
 * ⚠️ WHAT IS AT STAKE. The payload this downloads is unpacked and require()d — it IS the server.
 *   1.2  plain http to a public host, or an https -> http redirect, lets anyone on the path swap
 *        the archive AND the manifest that carries its checksum.
 *   1.1  an update with no checksum used to replace a working server unverified.
 *   15.1 the full URL (userinfo, ?token=) went into the install log, installState and the log
 *        ring, all readable without auth.
 *   and  with no payloadUrl set, a self-hosted box took its server code from alpha.screentinker.com
 *        even when it had been told which server it belongs to.
 *
 * ⚠️ PLAIN HTTP ON THE LAN MUST KEEP WORKING. Self-hosted sites point payloadUrl at
 * http://192.168.x.y:port with no certificate; refusing that would brick a supported setup.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const BS = path.join(__dirname, '..', '..', 'brightsign', 'server');
const installer = require(path.join(BS, 'bs-payload-install.js'));

/* ---------------------------------------------------------------- a minimal STORED zip */
function storedZip(files) {
  const chunks = []; const central = []; let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body); const nameBuf = Buffer.from(name); const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}
const PAYLOAD = storedZip({ 'VERSION': '9.9.9-new\n', 'server/server.js': 'console.log("NEW-SERVER");\n' });
const SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

/** A local host for the manifest and the archive, counting what was asked for. */
function host({ manifest, zip = PAYLOAD, redirectTo = null } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (redirectTo) { res.writeHead(302, { location: redirectTo }); return res.end(); }
    if (req.url.split('?')[0].endsWith('.json') && manifest) {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(manifest));
    }
    if (req.url.split('?')[0].endsWith('.zip') && zip) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length }); return res.end(zip);
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${srv.address().port}`, hits,
    close: () => new Promise((r) => srv.close(r)),
  })));
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bs-urlpol-'));
const readLog = (d) => { try { return fs.readFileSync(path.join(d, '.payload-install.log'), 'utf8'); } catch (e) { return ''; } };

/* ================================================================= 1.2 the URL policy */

test('1.2: https is always fetchable; plain http only to hosts that cannot be on the internet', () => {
  for (const ok of [
    'https://cms.example.com/scripts/server-payload.zip',
    'http://127.0.0.1:3001/scripts/server-payload.zip',
    'http://localhost:3001/x.zip',
    'http://192.168.1.20:3001/scripts/server-payload.zip',
    'http://10.0.0.5/x.zip', 'http://172.16.4.4/x.zip', 'http://172.31.255.1/x.zip',
    'http://169.254.10.10/x.zip', 'http://100.64.0.1/x.zip',
    'http://[fd00::12]/x.zip', 'http://[fe80::1]/x.zip', 'http://[::1]:8181/x.zip',
    'http://signage-server:3001/x.zip', 'http://cms.local/x.zip', 'http://cms.corp.lan/x.zip',
    'http://cms.home.arpa/x.zip', 'http://cms.internal/x.zip',
  ]) assert.equal(installer.urlRefusal(ok), null, ok + ' must stay allowed');

  for (const bad of [
    'http://cms.example.com/scripts/server-payload.zip',
    'http://8.8.8.8/x.zip', 'http://172.32.0.1/x.zip', 'http://192.169.1.1/x.zip',
    'http://192.168.1.5.nip.io/x.zip', 'http://[2001:db8::1]/x.zip',
    'ftp://cms.local/x.zip', 'file:///etc/passwd', 'not a url',
  ]) assert.ok(installer.urlRefusal(bad), bad + ' must be refused');
});

test('1.2: the operator can accept plain http to a public host, explicitly', () => {
  assert.equal(installer.urlRefusal('http://cms.example.com/x.zip', { allowInsecure: true }), null);
  assert.ok(installer.urlRefusal('ftp://cms.example.com/x.zip', { allowInsecure: true }),
    'the opt-in is about http, not about any scheme at all');
});

test('1.2: a redirect may never downgrade https -> http, even to a LAN host or with the opt-in', () => {
  assert.match(installer.redirectRefusal('https://cms.example.com/a.zip', 'http://192.168.1.2/a.zip'), /https/);
  assert.match(installer.redirectRefusal('https://cms.example.com/a.zip', 'http://x.example.com/a.zip',
    { allowInsecure: true }), /https/);
  assert.equal(installer.redirectRefusal('https://a.example.com/x', 'https://cdn.example.net/x'), null);
  // An http hop must pass the same test as a configured URL.
  assert.ok(installer.redirectRefusal('http://192.168.1.2/a.zip', 'http://evil.example.com/a.zip'));
  assert.equal(installer.redirectRefusal('http://192.168.1.2/a.zip', 'http://10.1.1.1/a.zip'), null);
});

test('1.2: download refuses a public plain-http URL without connecting', async () => {
  const dir = tmp();
  try {
    await assert.rejects(installer.download('http://cms.example.com/x.zip', path.join(dir, 'x.zip')),
      /refusing to download .*plain http/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('1.2: download refuses to follow a redirect to a public plain-http host', async () => {
  const h = await host({ redirectTo: 'http://cms.example.com/server-payload.zip' });
  const dir = tmp();
  try {
    await assert.rejects(installer.install({ url: h.base + '/server-payload.zip', installDir: dir, expectSha256: SHA }),
      /plain http/);
    assert.equal(h.hits.length, 1, 'only the first hop was requested');
    assert.ok(!fs.existsSync(path.join(dir, 'server')), 'nothing was installed');
  } finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('1.2: a plain-http LAN payload still installs (self-hosted sites rely on it)', async () => {
  const h = await host({});
  const dir = tmp();
  try {
    const r = await installer.install({ url: h.base + '/server-payload.zip', installDir: dir, expectSha256: SHA });
    assert.ok(r.files >= 2);
  } finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ================================================================= 1.1 no unverified replace */

test('1.1: with requireChecksum, no checksum means no download and no install', async () => {
  const h = await host({});
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'server.js'), 'OLD');
    await assert.rejects(installer.install({ url: h.base + '/server-payload.zip', installDir: dir,
      expectSha256: null, requireChecksum: true }), /unverified/);
    assert.equal(h.hits.length, 0, 'it did not even download');
    assert.equal(fs.readFileSync(path.join(dir, 'server', 'server.js'), 'utf8'), 'OLD');
    assert.match(readLog(dir), /refusing to replace/);
  } finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('1.1: a first install with no checksum is still allowed (nothing to fall back to)', async () => {
  const h = await host({});
  const dir = tmp();
  try {
    await installer.install({ url: h.base + '/server-payload.zip', installDir: dir, expectSha256: null });
    assert.ok(fs.existsSync(path.join(dir, 'server', 'server.js')));
    assert.match(readLog(dir), /NO checksum supplied/);
  } finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a checksum in capitals is the same checksum', async () => {
  const h = await host({});
  const dir = tmp();
  try {
    await installer.install({ url: h.base + '/server-payload.zip', installDir: dir,
      expectSha256: SHA.toUpperCase(), requireChecksum: true });
    assert.match(readLog(dir), /checksum verified/);
  } finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ================================================================= 15.1 redaction */

test('15.1: redactUrl keeps origin and path, drops userinfo, query and fragment', () => {
  assert.equal(installer.redactUrl('https://bob:hunter2@cms.example.com/p/server-payload.zip?token=SECRET#x'),
    'https://***@cms.example.com/p/server-payload.zip?…');
  assert.equal(installer.redactUrl('https://cms.example.com/server-payload.zip'),
    'https://cms.example.com/server-payload.zip');
  assert.doesNotMatch(installer.redactUrl('weird://u:SECRET@x?token=SECRET'), /SECRET/);
});

test('15.1: neither the install log, the progress states nor an error carry the credential', async () => {
  const h = await host({});
  const dir = tmp();
  const states = [];
  try {
    const url = h.base.replace('http://', 'http://user:PASSWORD1@') + '/server-payload.zip?token=TOKEN1';
    await installer.install({ url, installDir: dir, expectSha256: SHA, onState: (s) => states.push(s) });
    const seen = readLog(dir) + JSON.stringify(states);
    assert.doesNotMatch(seen, /PASSWORD1|TOKEN1/);
    assert.match(readLog(dir), /install starting from http:\/\/\*\*\*@127\.0\.0\.1/);

    const dir2 = tmp();
    try {
      const missing = h.base + '/nope.bin?token=TOKEN2';
      await assert.rejects(installer.install({ url: missing, installDir: dir2 }),
        (e) => { assert.doesNotMatch(e.message, /TOKEN2/); return /HTTP 404/.test(e.message); });
      assert.doesNotMatch(readLog(dir2), /TOKEN2/);
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
  } finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ================================================================= the launcher, actually run */

function box({ config, version = '2.0.0-old', sha = null, playerConfig = null, installed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-urlpol-boot-'));
  if (installed) {
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'server.js'), 'console.log("OLD-SERVER");\n');
    fs.writeFileSync(path.join(dir, 'VERSION'), version + '\n');
    if (sha) fs.writeFileSync(path.join(dir, '.payload-sha256'), sha);
  }
  // Both, as on a real box: the boot zip and the payload carry them side by side.
  fs.copyFileSync(path.join(BS, 'bs-server-boot.js'), path.join(dir, 'bs-server-boot.js'));
  fs.copyFileSync(path.join(BS, 'bs-payload-install.js'), path.join(dir, 'bs-payload-install.js'));
  fs.writeFileSync(path.join(dir, 'st-config.json'), JSON.stringify(config || { server: 1 }));
  if (playerConfig) fs.writeFileSync(path.join(dir, 'screentinker.json'), JSON.stringify(playerConfig));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function run(dir, extraEnv) {
  const env = { ...process.env, ST_STATUS_PORT: '0', ...(extraEnv || {}) };
  if (!extraEnv || !('ST_PAYLOAD_URL' in extraEnv)) delete env.ST_PAYLOAD_URL;
  // Async (not execFileSync): the test's own HTTP host has to keep answering while this runs.
  return new Promise((resolve, reject) => {
    require('node:child_process').execFile(process.execPath, [path.join(dir, 'bs-server-boot.js')],
      { cwd: dir, encoding: 'utf8', timeout: 60000, env },
      // stderr folded in: console.warn/error lines are part of what the box reports.
      (err, stdout, stderr) => (err && err.killed ? reject(err) : resolve(stdout + stderr)));
  });
}

test('1.1: a published update WITHOUT a sha256 never replaces a working server', async () => {
  const h = await host({ manifest: { version: '9.9.9-new' } });
  const { dir, cleanup } = box({ config: { server: 1, updateCheckHours: 0 } });
  try {
    const out = await run(dir, { ST_PAYLOAD_URL: h.base + '/server-payload.zip' });
    assert.match(out, /OLD-SERVER/, 'the installed server still starts');
    assert.ok(!h.hits.some((u) => u.endsWith('.zip')), 'the archive was never even downloaded');
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(), '2.0.0-old');
  } finally { await h.close(); cleanup(); }
});

test('control: a published update WITH a valid sha256 still installs', async () => {
  const h = await host({ manifest: { version: '9.9.9-new', sha256: SHA } });
  const { dir, cleanup } = box({ config: { server: 1, updateCheckHours: 0 } });
  try {
    const out = await run(dir, { ST_PAYLOAD_URL: h.base + '/server-payload.zip' });
    assert.match(out, /NEW-SERVER/);
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(), '9.9.9-new');
  } finally { await h.close(); cleanup(); }
});

test('1.2: the launcher does not fetch a manifest from a public plain-http URL', async () => {
  const { dir, cleanup } = box({ config: { server: 1, updateCheckHours: 0 } });
  try {
    const out = await run(dir, { ST_PAYLOAD_URL: 'http://cms.example.com/server-payload.zip' });
    assert.match(out, /OLD-SERVER/, 'refused reads as "no manifest": the installed server starts');
    assert.match(out, /not fetching the manifest http:\/\/cms\.example\.com\/server-payload\.json: plain http/);
  } finally { cleanup(); }
});

test('1.2: the launcher will not follow a manifest redirect to a public plain-http host', async () => {
  const h = await host({ redirectTo: 'http://cms.example.com/server-payload.json' });
  const { dir, cleanup } = box({ config: { server: 1, updateCheckHours: 0 } });
  try {
    const out = await run(dir, { ST_PAYLOAD_URL: h.base + '/server-payload.zip' });
    assert.match(out, /OLD-SERVER/);
    assert.equal(h.hits.length, 1);
    assert.match(out, /not fetching the manifest http:\/\/cms\.example\.com\/server-payload\.json: plain http/);
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(), '2.0.0-old');
  } finally { await h.close(); cleanup(); }
});

test('15.1: a failed first install does not print the credential in its fatal message', async () => {
  const h = await host({ zip: null });
  const { dir, cleanup } = box({ config: { server: 1 }, installed: false });
  try {
    const url = h.base.replace('http://', 'http://user:PASSWORD3@') + '/server-payload.zip?sig=TOKEN3';
    const out = await run(dir, { ST_PAYLOAD_URL: url });
    assert.match(out, /st-server-fatal/, 'the first install failed, as arranged');
    assert.doesNotMatch(out, /PASSWORD3|TOKEN3/);
  } finally { await h.close(); cleanup(); }
});

test('no payloadUrl: a box with a configured server takes the payload from THAT server', async () => {
  const { dir, cleanup } = box({ config: { server: 1, autoUpdate: false },
    playerConfig: { server_url: 'https://cms.example.org/' } });
  try {
    const out = await run(dir);
    assert.match(out, /server payload source: https:\/\/cms\.example\.org\/scripts\/server-payload\.zip \(this box's configured server\)/);
  } finally { cleanup(); }
});

test('no payloadUrl: st-config serverUrl works too, and an explicit payloadUrl still wins', async () => {
  let b = box({ config: { server: 1, autoUpdate: false, serverUrl: 'https://cms.example.org' } });
  try {
    assert.match(await run(b.dir), /source: https:\/\/cms\.example\.org\/scripts\/server-payload\.zip/);
  } finally { b.cleanup(); }
  b = box({ config: { server: 1, autoUpdate: false, payloadUrl: 'https://p.example.net/x.zip',
    serverUrl: 'https://cms.example.org' } });
  try {
    assert.match(await run(b.dir), /source: https:\/\/p\.example\.net\/x\.zip \(st-config\.json payloadUrl\)/);
  } finally { b.cleanup(); }
});

test('no payloadUrl: our own hosts, loopback, and no config at all keep the built-in default', async () => {
  for (const playerConfig of [{ server_url: 'https://screentinker.com' }, { server_url: 'http://127.0.0.1:8181' }, null]) {
    const { dir, cleanup } = box({ config: { server: 1, autoUpdate: false }, playerConfig });
    try {
      assert.match(await run(dir), /source: https:\/\/alpha\.screentinker\.com\/scripts\/server-payload\.zip \(built-in default/,
        JSON.stringify(playerConfig));
    } finally { cleanup(); }
  }
});
