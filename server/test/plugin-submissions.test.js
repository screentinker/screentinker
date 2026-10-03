'use strict';

/*
 * Plugin upload, inspect, approve, allowlist. The property this file exists to
 * hold: an uploaded zip is never require()'d, and approve of an exact sha256 is
 * the only path that copies it onto a plugin root.
 *
 * Zip-slip names are built byte-by-byte (same reason as html-bundle.test.js):
 * archiver will not write `../../etc/passwd` as an entry name.
 *
 * The db is an in-memory stub. These tests must still run on a host that has
 * not compiled better-sqlite3 (same constraint as plugins-invariants.test.js).
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const archiver = require('archiver');

const inbox = require('../lib/plugins/inbox');
const submissions = require('../lib/plugins/submissions');
const allowlist = require('../lib/plugins/allowlist');
const { loadPlugins } = require('../lib/plugins/load');
const registry = require('../lib/plugins/registry');
const hooks = require('../lib/plugins/hooks');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-plugsub-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
beforeEach(() => { hooks.reset(); registry.reset(); });

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ -1) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data == null ? '' : e.data);
    const body = raw;
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(raw);
    const flags = 0x800;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(((e.mode != null ? e.mode : 0o100644) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function writeHostile(entries) {
  const p = path.join(TMP, crypto.randomBytes(6).toString('hex') + '.zip');
  fs.writeFileSync(p, buildZip(entries));
  return p;
}

function writeZip(filePath, files) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const out = fs.createWriteStream(filePath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    for (const [name, content] of Object.entries(files)) {
      archive.append(Buffer.from(content), { name });
    }
    archive.finalize();
  });
}

const GOOD = {
  'plugin.json': JSON.stringify({
    id: 'ok-widget',
    name: 'Ok',
    version: '1.2.3',
    main: 'index.js',
    capabilities: ['widget'],
    widget: { type: 'ok-widget', fields: [] },
  }),
  'index.js': "module.exports = { activate(api) { api.registerWidget({ type: 'ok-widget', render() { return 'OK'; } }); } };\n",
  'README.md': 'hello\n',
};

function memDb() {
  const submissionsRows = [];
  const allowRows = new Map();
  const stateRows = new Map();
  let nextId = 1;
  function now() { return Math.floor(Date.now() / 1000); }
  return {
    prepare(sql) {
      const s = sql.replace(/\s+/g, ' ');
      return {
        run(...a) {
          if (/INSERT INTO plugin_submissions/.test(s)) {
            const row = {
              id: nextId++,
              plugin_id: a[0], name: a[1], version: a[2], description: a[3],
              sha256: a[4], archive_name: a[5], manifest_json: a[6], files_json: a[7],
              size_bytes: a[8], submitted_by: a[9], workspace_id: a[10],
              submitted_at: now(), status: 'pending', tree_sha256: null,
              decided_by: null, decided_at: null, decision_note: null,
            };
            submissionsRows.push(row);
            return { lastInsertRowid: row.id, changes: 1 };
          }
          if (/UPDATE plugin_submissions\s+SET status = 'approved'/.test(s)) {
            const row = submissionsRows.find((r) => r.id === a[2]);
            if (row) {
              row.status = 'approved';
              row.tree_sha256 = a[0];
              row.decided_by = a[1];
              row.decided_at = now();
            }
            return { changes: row ? 1 : 0 };
          }
          if (/UPDATE plugin_submissions\s+SET status = 'rejected'/.test(s)) {
            const row = submissionsRows.find((r) => r.id === a[2]);
            if (row) {
              row.status = 'rejected';
              row.decided_by = a[0];
              row.decided_at = now();
              row.decision_note = a[1];
            }
            return { changes: row ? 1 : 0 };
          }
          if (/INSERT INTO plugin_allowlist/.test(s)) {
            allowRows.set(a[0], {
              plugin_id: a[0], sha256: a[1], source: a[2], submission_id: a[3],
              approved_by: a[4], approved_at: now(), note: a[5],
            });
            return { changes: 1 };
          }
          if (/INSERT INTO plugin_state/.test(s) && /allowlist_required/.test(s)) {
            const prev = stateRows.get(a[0]) || { id: a[0], enabled: 0, allowlist_required: 0, error: null };
            prev.allowlist_required = 1;
            stateRows.set(a[0], prev);
            return { changes: 1 };
          }
          if (/DELETE FROM plugin_allowlist/.test(s)) {
            allowRows.delete(a[0]);
            return { changes: 1 };
          }
          if (/UPDATE plugin_state SET enabled = 0, allowlist_required = 1/.test(s)) {
            const prev = stateRows.get(a[0]) || { id: a[0], enabled: 0, allowlist_required: 0 };
            prev.enabled = 0;
            prev.allowlist_required = 1;
            stateRows.set(a[0], prev);
            return { changes: 1 };
          }
          if (/UPDATE plugin_state SET allowlist_required = 0/.test(s)) {
            const prev = stateRows.get(a[0]) || { id: a[0], enabled: 0, allowlist_required: 0 };
            prev.allowlist_required = 0;
            stateRows.set(a[0], prev);
            return { changes: 1 };
          }
          if (/UPDATE plugin_state SET enabled = 1/.test(s) || /INSERT INTO plugin_state \(id, enabled, error/.test(s)) {
            const id = a[0];
            const prev = stateRows.get(id) || { id, enabled: 0, allowlist_required: 0, error: null };
            if (typeof a[1] === 'number' || a[1] === 1 || a[1] === 0) prev.enabled = Number(a[1]);
            else prev.enabled = 1;
            stateRows.set(id, prev);
            return { changes: 1 };
          }
          return { changes: 0, lastInsertRowid: 0 };
        },
        get(...a) {
          if (/FROM plugin_submissions WHERE plugin_id = \? AND status = 'pending'/.test(s)) {
            return submissionsRows.find((r) => r.plugin_id === a[0] && r.status === 'pending') || null;
          }
          if (/FROM plugin_submissions WHERE id = \?/.test(s)) {
            return submissionsRows.find((r) => r.id === a[0]) || null;
          }
          if (/FROM plugin_allowlist WHERE plugin_id = \?/.test(s)) {
            return allowRows.get(a[0]) || null;
          }
          if (/FROM plugin_state WHERE id = \?/.test(s) || /allowlist_required FROM plugin_state/.test(s)) {
            return stateRows.get(a[0]) || null;
          }
          return null;
        },
        all(...a) {
          if (/FROM plugin_state/.test(s)) return [...stateRows.values()];
          if (/FROM plugin_allowlist/.test(s)) return [...allowRows.values()];
          if (/FROM plugin_submissions/.test(s)) {
            let rows = submissionsRows.slice();
            if (/status = \?/.test(s)) rows = rows.filter((r) => r.status === a[0]);
            if (/submitted_by = \?/.test(s)) {
              const who = /status = \?/.test(s) ? a[1] : a[0];
              rows = rows.filter((r) => r.submitted_by === who);
            }
            return rows;
          }
          return [];
        },
      };
    },
  };
}

test('a well-formed zip inspects as the plugin it claims to be', async () => {
  const zip = path.join(TMP, 'good.zip');
  await writeZip(zip, GOOD);
  const info = await inbox.inspectZip(zip);
  assert.equal(info.pluginId, 'ok-widget');
  assert.equal(info.version, '1.2.3');
  assert.ok(info.files.some((f) => f.name === 'plugin.json'));
  assert.ok(info.files.some((f) => f.name === 'index.js'));
  assert.match(info.sha256, /^[a-f0-9]{64}$/);
});

test('a wrapping folder is stripped so zipping the plugin directory works', async () => {
  const zip = path.join(TMP, 'wrapped.zip');
  const wrapped = {};
  for (const [k, v] of Object.entries(GOOD)) wrapped['ok-widget/' + k] = v;
  await writeZip(zip, wrapped);
  const info = await inbox.inspectZip(zip);
  assert.equal(info.wrapper, 'ok-widget');
  assert.equal(info.pluginId, 'ok-widget');
  assert.ok(info.files.every((f) => !f.name.startsWith('ok-widget/')));
});

test('zip-slip paths are refused', async () => {
  const zip = writeHostile([
    { name: 'plugin.json', data: GOOD['plugin.json'] },
    { name: 'index.js', data: GOOD['index.js'] },
    { name: '../../etc/passwd', data: 'root:x:0:0:root:/root:/bin/sh\n' },
  ]);
  await assert.rejects(() => inbox.inspectZip(zip), /unsafe path/);
});

test('a file off the allowlist is refused', async () => {
  const zip = path.join(TMP, 'sh.zip');
  await writeZip(zip, { ...GOOD, 'install.sh': '#!/bin/sh\necho pwned\n' });
  await assert.rejects(() => inbox.inspectZip(zip), /allowlist/);
});

test('package.json is refused so an upload cannot imply npm install', async () => {
  const zip = path.join(TMP, 'npm.zip');
  await writeZip(zip, { ...GOOD, 'package.json': '{"dependencies":{"leftpad":"*"}}' });
  await assert.rejects(() => inbox.inspectZip(zip), /allowlist|package\.json/i);
});

test('a reserved widget type is refused at inspect, not at load', async () => {
  const zip = path.join(TMP, 'clock.zip');
  await writeZip(zip, {
    'plugin.json': JSON.stringify({
      id: 'my-clock', name: 'Clock', main: 'index.js',
      capabilities: ['widget'], widget: { type: 'clock', fields: [] },
    }),
    'index.js': 'module.exports = { activate() {} };\n',
  });
  await assert.rejects(() => inbox.inspectZip(zip), /reserved/);
});

test('submit stores pending and never copies onto a plugin root', async () => {
  const db = memDb();
  const inboxDir = fs.mkdtempSync(path.join(TMP, 'inbox-'));
  const dataDir = fs.mkdtempSync(path.join(TMP, 'data-'));
  const zip = path.join(TMP, 'submit.zip');
  await writeZip(zip, GOOD);
  const row = await submissions.create(db, {
    buffer: fs.readFileSync(zip),
    inboxDir,
    submittedBy: 'user-1',
    workspaceId: 'ws-1',
  });
  assert.equal(row.status, 'pending');
  assert.equal(row.plugin_id, 'ok-widget');
  assert.equal(fs.readdirSync(dataDir).length, 0, 'inbox is not a plugin root');
  const stored = db.prepare('SELECT * FROM plugin_submissions WHERE id = ?').get(row.id);
  assert.ok(fs.existsSync(path.join(inboxDir, stored.archive_name)));
});

test('approve copies onto the data-dir plugin root and pins the hash; it does not enable', async () => {
  const db = memDb();
  const inboxDir = fs.mkdtempSync(path.join(TMP, 'inbox-'));
  const dataDir = fs.mkdtempSync(path.join(TMP, 'data-'));
  const zip = path.join(TMP, 'approve.zip');
  await writeZip(zip, GOOD);
  const created = await submissions.create(db, {
    buffer: fs.readFileSync(zip), inboxDir, submittedBy: 'user-1',
  });
  const approved = await submissions.approve(db, {
    id: created.id, approvedBy: 'admin-1', inboxDir, dataPluginsDir: dataDir,
  });
  assert.equal(approved.status, 'approved');
  assert.ok(fs.existsSync(path.join(dataDir, 'ok-widget', 'index.js')));
  const pin = allowlist.get(db, 'ok-widget');
  assert.equal(pin.source, 'upload');
  assert.equal(pin.sha256, allowlist.hashTree(path.join(dataDir, 'ok-widget')));
  const state = db.prepare('SELECT allowlist_required FROM plugin_state WHERE id = ?').get('ok-widget');
  assert.equal(state.enabled, 0, 'approve is not enable');
  assert.equal(state.allowlist_required, 1);
});

test('loader refuses an allowlisted plugin whose files changed (P9)', async () => {
  const db = memDb();
  const inboxDir = fs.mkdtempSync(path.join(TMP, 'inbox-'));
  const dataDir = fs.mkdtempSync(path.join(TMP, 'data-'));
  const zip = path.join(TMP, 'tamper.zip');
  await writeZip(zip, GOOD);
  const created = await submissions.create(db, {
    buffer: fs.readFileSync(zip), inboxDir, submittedBy: 'user-1',
  });
  await submissions.approve(db, {
    id: created.id, approvedBy: 'admin-1', inboxDir, dataPluginsDir: dataDir,
  });
  db.prepare('UPDATE plugin_state SET enabled = 1 WHERE id = ?').run('ok-widget');
  fs.writeFileSync(path.join(dataDir, 'ok-widget', 'index.js'), 'module.exports = { activate() { throw new Error("pwned"); } };\n');
  registry.reset();
  hooks.reset();
  loadPlugins({
    config: { pluginsEnabled: true, bundledPluginsDir: path.join(TMP, 'empty-b'), dataPluginsDir: dataDir },
    db,
  });
  const p = registry.getPlugin('ok-widget');
  assert.ok(p && p.error);
  assert.match(p.error, /sha256 mismatch|changed since approval/);
  assert.equal(p.loaded, false);
  assert.equal(registry.hasWidget('ok-widget'), false, 'must not have required the tampered main');
});

test('loader never scans the inbox directory (P2/P9)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'plugins', 'paths.js'), 'utf8');
  assert.doesNotMatch(src, /pluginInboxDir/, 'inbox is not a plugin root');
  assert.doesNotMatch(src, /plugin-inbox/, 'inbox path must not appear in pluginRoots');
  const loadSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'plugins', 'load.js'), 'utf8');
  assert.doesNotMatch(loadSrc, /pluginInboxDir/);
  assert.match(loadSrc, /assertLoadable/, 'upload-origin plugins must pass the allowlist before require()');
});

test('reject deletes the archive and does not install', async () => {
  const db = memDb();
  const inboxDir = fs.mkdtempSync(path.join(TMP, 'inbox-'));
  const dataDir = fs.mkdtempSync(path.join(TMP, 'data-'));
  const zip = path.join(TMP, 'rej.zip');
  await writeZip(zip, GOOD);
  const created = await submissions.create(db, {
    buffer: fs.readFileSync(zip), inboxDir, submittedBy: 'user-1',
  });
  const stored = db.prepare('SELECT * FROM plugin_submissions WHERE id = ?').get(created.id);
  const archive = path.join(inboxDir, stored.archive_name);
  assert.ok(fs.existsSync(archive));
  submissions.reject(db, { id: created.id, decidedBy: 'admin-1', note: 'nope', inboxDir });
  assert.equal(fs.existsSync(archive), false);
  assert.equal(fs.readdirSync(dataDir).length, 0);
  assert.equal(allowlist.get(db, 'ok-widget'), null);
});

test('a second pending submission for the same id is refused', async () => {
  const db = memDb();
  const inboxDir = fs.mkdtempSync(path.join(TMP, 'inbox-'));
  const zip = path.join(TMP, 'dup.zip');
  await writeZip(zip, GOOD);
  await submissions.create(db, { buffer: fs.readFileSync(zip), inboxDir, submittedBy: 'a' });
  await assert.rejects(
    () => submissions.create(db, { buffer: fs.readFileSync(zip), inboxDir, submittedBy: 'b' }),
    /pending submission/
  );
});

test('unpin of an upload-sourced plugin keeps allowlist_required so it cannot load as a drop-folder', () => {
  const db = memDb();
  const dir = fs.mkdtempSync(path.join(TMP, 'tree-'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'x');
  allowlist.pin(db, {
    pluginId: 'ok-widget',
    sha256: allowlist.hashTree(dir),
    source: 'upload',
    approvedBy: 'admin',
  });
  allowlist.unpin(db, 'ok-widget');
  const state = db.prepare('SELECT allowlist_required FROM plugin_state WHERE id = ?').get('ok-widget');
  assert.equal(state.allowlist_required, 1);
  assert.equal(state.enabled, 0);
  assert.equal(allowlist.assertLoadable(db, 'ok-widget', dir), 'not on the allowlist');
});

test('content.uploaded is on the hook allowlist', () => {
  assert.equal(hooks.ALLOWED.has('content.uploaded'), true);
  assert.doesNotThrow(() => hooks.register('x', 'content.uploaded', () => {}));
});

test('a symlink entry is refused', async () => {
  const zip = writeHostile([
    { name: 'plugin.json', data: GOOD['plugin.json'] },
    { name: 'index.js', data: GOOD['index.js'], mode: 0o120777 },
  ]);
  await assert.rejects(() => inbox.inspectZip(zip), /symlink/);
});

test('readFile returns inspected bytes and does not require() them', async () => {
  const db = memDb();
  const inboxDir = fs.mkdtempSync(path.join(TMP, 'inbox-'));
  const zip = path.join(TMP, 'read.zip');
  await writeZip(zip, GOOD);
  const created = await submissions.create(db, {
    buffer: fs.readFileSync(zip), inboxDir, submittedBy: 'user-1',
  });
  const buf = await submissions.readFile(db, { id: created.id, rel: 'index.js', inboxDir });
  assert.match(buf.toString('utf8'), /registerWidget/);
  assert.equal(registry.hasWidget('ok-widget'), false, 'inspecting a zip must not load it');
});

test('approve with replace:false refuses when the plugin id is already installed', async () => {
  const db = memDb();
  const inboxDir = fs.mkdtempSync(path.join(TMP, 'inbox-'));
  const dataDir = fs.mkdtempSync(path.join(TMP, 'data-'));
  fs.mkdirSync(path.join(dataDir, 'ok-widget'));
  fs.writeFileSync(path.join(dataDir, 'ok-widget', 'index.js'), 'old\n');
  const zip = path.join(TMP, 'clash.zip');
  await writeZip(zip, GOOD);
  const created = await submissions.create(db, {
    buffer: fs.readFileSync(zip), inboxDir, submittedBy: 'user-1',
  });
  await assert.rejects(
    () => submissions.approve(db, {
      id: created.id, approvedBy: 'admin-1', inboxDir, dataPluginsDir: dataDir, replace: false,
    }),
    /already installed/
  );
  assert.equal(fs.readFileSync(path.join(dataDir, 'ok-widget', 'index.js'), 'utf8'), 'old\n');
});

test('rescan after approve lists the plugin disabled and does not require() it', async () => {
  const db = memDb();
  const inboxDir = fs.mkdtempSync(path.join(TMP, 'inbox-'));
  const dataDir = fs.mkdtempSync(path.join(TMP, 'data-'));
  const zip = path.join(TMP, 'rescan.zip');
  await writeZip(zip, GOOD);
  const created = await submissions.create(db, {
    buffer: fs.readFileSync(zip), inboxDir, submittedBy: 'user-1',
  });
  await submissions.approve(db, {
    id: created.id, approvedBy: 'admin-1', inboxDir, dataPluginsDir: dataDir,
  });
  registry.reset();
  hooks.reset();
  const { rescan } = require('../lib/plugins/load');
  rescan({
    config: { pluginsEnabled: true, bundledPluginsDir: path.join(TMP, 'empty-b2'), dataPluginsDir: dataDir },
    db,
  });
  const p = registry.getPlugin('ok-widget');
  assert.ok(p, 'approved tree must appear in Admin without a restart');
  assert.equal(p.enabled, false, 'approve is not enable');
  assert.equal(p.loaded, false);
  assert.equal(registry.hasWidget('ok-widget'), false, 'rescan must not require()');
});

test('rescan never require()s even when plugin_state.enabled=1', async () => {
  const db = memDb();
  const inboxDir = fs.mkdtempSync(path.join(TMP, 'inbox-'));
  const dataDir = fs.mkdtempSync(path.join(TMP, 'data-'));
  const zip = path.join(TMP, 'hot.zip');
  await writeZip(zip, GOOD);
  const created = await submissions.create(db, {
    buffer: fs.readFileSync(zip), inboxDir, submittedBy: 'user-1',
  });
  await submissions.approve(db, {
    id: created.id, approvedBy: 'admin-1', inboxDir, dataPluginsDir: dataDir,
  });
  db.prepare('UPDATE plugin_state SET enabled = 1 WHERE id = ?').run('ok-widget');
  registry.reset();
  hooks.reset();
  const { rescan } = require('../lib/plugins/load');
  rescan({
    config: { pluginsEnabled: true, bundledPluginsDir: path.join(TMP, 'empty-b3'), dataPluginsDir: dataDir },
    db,
  });
  const p = registry.getPlugin('ok-widget');
  assert.equal(p.enabled, true);
  assert.equal(p.loaded, false, 'enable still needs a restart to require()');
  assert.equal(registry.hasWidget('ok-widget'), false);
});

test('submit/approve/reject emit plugin.* hooks and never include zip bytes', async () => {
  const seen = [];
  hooks.register('wh', 'plugin.submitted', (p) => seen.push(['submitted', p]));
  hooks.register('wh', 'plugin.approved', (p) => seen.push(['approved', p]));
  hooks.register('wh', 'plugin.rejected', (p) => seen.push(['rejected', p]));

  const db = memDb();
  const inboxDir = fs.mkdtempSync(path.join(TMP, 'inbox-'));
  const dataDir = fs.mkdtempSync(path.join(TMP, 'data-'));
  const zip = path.join(TMP, 'hook-ok.zip');
  await writeZip(zip, GOOD);

  const created = await submissions.create(db, {
    buffer: fs.readFileSync(zip), inboxDir, submittedBy: 'user-1', workspaceId: 'ws-1',
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'submitted');
  assert.equal(seen[0][1].plugin_id, 'ok-widget');
  assert.equal(seen[0][1].submitted_by, 'user-1');
  assert.equal(seen[0][1].workspace_id, 'ws-1');
  assert.equal(seen[0][1].buffer, undefined);
  assert.equal(seen[0][1].archive, undefined);
  assert.ok(!JSON.stringify(seen[0][1]).includes('registerWidget'), 'payload must not carry source');

  await submissions.approve(db, {
    id: created.id, approvedBy: 'admin-1', inboxDir, dataPluginsDir: dataDir,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(seen[1][0], 'approved');
  assert.equal(seen[1][1].plugin_id, 'ok-widget');
  assert.equal(seen[1][1].approved_by, 'admin-1');
  assert.match(String(seen[1][1].sha256), /^[a-f0-9]{64}$/);

  const zip2 = path.join(TMP, 'hook-rej.zip');
  const other = {
    ...GOOD,
    'plugin.json': JSON.stringify({
      id: 'ok-widget-2',
      name: 'Ok2',
      version: '0.0.1',
      main: 'index.js',
      capabilities: ['widget'],
      widget: { type: 'ok-widget-2', fields: [] },
    }),
  };
  await writeZip(zip2, other);
  const created2 = await submissions.create(db, {
    buffer: fs.readFileSync(zip2), inboxDir, submittedBy: 'user-2',
  });
  await new Promise((r) => setImmediate(r));
  submissions.reject(db, { id: created2.id, decidedBy: 'admin-1', note: 'nope', inboxDir });
  await new Promise((r) => setImmediate(r));
  const last = seen[seen.length - 1];
  assert.equal(last[0], 'rejected');
  assert.equal(last[1].plugin_id, 'ok-widget-2');
  assert.equal(last[1].decided_by, 'admin-1');
});

test('plugin.submitted/approved/rejected are on the hook allowlist', () => {
  for (const name of ['plugin.submitted', 'plugin.approved', 'plugin.rejected']) {
    assert.equal(hooks.ALLOWED.has(name), true, name);
    assert.doesNotThrow(() => hooks.register('x', name, () => {}));
  }
});
