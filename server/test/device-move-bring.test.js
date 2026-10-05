'use strict';

/*
 * Platform admins move a screen to ANY workspace, including another organization, and "bring its
 * playlist" copies what the screen itself uses into the new workspace (lib/device-bring.js) so it
 * keeps playing exactly what it played. Real server, like corporate-move-impact.test.js.
 *
 * MUTATION CHECK (verified once by reverting and watching the named test go red):
 *   - lib/device-move.js validate: drop the isPlatformRole check on another organization
 *       -> "an org admin of BOTH organizations is still refused ..."
 *   - lib/content-files.js unlinkIfUnreferenced: drop the "still referenced" early return (the
 *     refcount is what lets a brought copy SHARE the source's bytes safely)
 *       -> "deleting either copy of a brought file leaves the other playing"
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, LOG, PORT, CONTENT_DIR, FONTS_DIR;
const U = {};
let ORG_A, ORG_B, WA1, WA2, WB;

const dbh = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));
const q = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).all(...a); } finally { r.close(); } };
const q1 = (sql, ...a) => q(sql, ...a)[0];
const run = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).run(...a); } finally { r.close(); } };

function J(who, body, method = 'POST', ws) {
  const h = { 'Content-Type': 'application/json' };
  if (who) h.Authorization = `Bearer ${U[who] ? U[who].token : who}`;
  if (ws) h['X-Workspace-Id'] = ws;
  return { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
async function api(p, opts) {
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
async function register(name) {
  const r = await api('/api/auth/register', J(null, { email: `${name}-${Date.now()}@acme.test`, password: 'Passw0rd123', name }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  U[name] = { token: r.body.token, id: r.body.user.id, ws: r.body.current_workspace_id };
}
async function boot() {
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch { /* */ }
    await sleep(250);
  }
  throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise((r) => { p.once('exit', r); p.kill('SIGKILL'); });
}

const mkFile = (name, bytes = 'PNGDATA') => { fs.mkdirSync(CONTENT_DIR, { recursive: true }); fs.writeFileSync(path.join(CONTENT_DIR, name), bytes); return name; };
const mkContent = (ws, name, { owner = U.admin.id, size = 1000 } = {}) => {
  const id = crypto.randomUUID();
  const file = mkFile(`${id}.png`);
  run(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec, file_size, tags)
       VALUES (?, ?, ?, ?, ?, 'image/png', 10, ?, '["menu"]')`, id, owner, ws, name, file, size);
  return id;
};
const snapItem = (o) => ({ filename: 'x.png', filepath: 'x.png', mime_type: 'image/png', duration_sec: 10, sort_order: 0, ...o });
const mkPlaylist = (ws, name, { snapshot = [], structure = null, smart = null, owner = U.admin.id } = {}) => {
  const id = crypto.randomUUID();
  run(`INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot, published_structure, smart_rules, published_smart_rules)
       VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?)`, id, owner, ws, name, JSON.stringify(snapshot), structure ? JSON.stringify(structure) : null, smart, smart);
  return id;
};
const addItem = (pl, o) => run(`INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, sort_order, duration_sec, muted, weight)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, pl, o.content || null, o.widget || null, o.child || null, o.sort || 0, o.dur || 10, o.muted ? 1 : 0, o.weight || 1).lastInsertRowid;
const mkDevice = (ws, name, { playlist = null, owner = U.admin.id, defaultContent = null } = {}) => {
  const id = crypto.randomUUID();
  run(`INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source, default_content_id, platform, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'web', 'offline')`,
    id, owner, ws, name, crypto.randomUUID().slice(0, 6), playlist, playlist ? 'device' : null, defaultContent);
  return id;
};
const move = (who, ids, ws, extra = {}, hdr = WA1) => api('/api/devices/move-workspace', J(who, { device_ids: ids, workspace_id: ws, ...extra }, 'POST', hdr));
const preview = (who, ids, ws, qs = '', hdr = WA1) => api(`/api/devices/move-workspace/preview?device_ids=${ids.join(',')}&workspace_id=${ws}${qs}`, J(who, undefined, 'GET', hdr));
const dev = (id) => q1('SELECT * FROM devices WHERE id = ?', id);

// The fixture the cross-org test brings: a playlist with a nested child, a widget naming content,
// a data source by slug (with a credential), a custom font by CSS family, a template item, a
// muted item and a dayparted item; plus a second screen sharing the same playlist.
const F = {};

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'move-bring-'));
  CONTENT_DIR = path.join(DATA_DIR, 'uploads', 'content');
  FONTS_DIR = path.join(DATA_DIR, 'uploads', 'fonts');
  LOG = path.join(DATA_DIR, 'server.log');
  await boot();
  // ⚠️ The FIRST account on an instance is its platform admin — so padmin registers first, and
  // admin is an ordinary org owner (otherwise "an org admin is refused" would test a platform admin).
  for (const n of ['padmin', 'admin', 'other', 'op']) await register(n);
  assert.equal(q1('SELECT role FROM users WHERE id = ?', U.admin.id).role, 'user');
  run("UPDATE users SET role = 'platform_admin' WHERE id = ?", U.padmin.id);
  run("UPDATE users SET role = 'platform_operator' WHERE id = ?", U.op.id);
  WA1 = U.admin.ws; WB = U.other.ws;
  ORG_A = q1('SELECT organization_id FROM workspaces WHERE id = ?', WA1).organization_id;
  ORG_B = q1('SELECT organization_id FROM workspaces WHERE id = ?', WB).organization_id;
  WA2 = crypto.randomUUID();
  run('INSERT INTO workspaces (id, organization_id, name, slug) VALUES (?, ?, ?, ?)', WA2, ORG_A, 'Store A2', 'store-a2');
  run("UPDATE organizations SET name = 'Org B' WHERE id = ?", ORG_B);

  F.c1 = mkContent(WA1, 'menu.png');
  F.c2 = mkContent(WA1, 'inside-widget.png');
  F.c3 = mkContent(WA1, 'child.png');
  F.c4 = mkContent(WA1, 'fallback.png');
  F.tpl = crypto.randomUUID();
  run(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES (?, NULL, NULL, 'tpl.png', ?, 'image/png', 5)`, F.tpl, mkFile('tpl.png'));
  F.ds = crypto.randomUUID();
  run(`INSERT INTO data_sources (id, workspace_id, slug, name, type, config) VALUES (?, ?, 'menuprices', 'Menu prices', 'rest', ?)`,
    F.ds, WA1, JSON.stringify({ url: 'https://example.test/prices', auth_token: 'SUPERSECRET' }));
  F.font = crypto.randomUUID();
  fs.mkdirSync(FONTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(FONTS_DIR, `${F.font}.woff2`), 'FONTBYTES');
  run(`INSERT INTO custom_fonts (id, workspace_id, uploaded_by, name, css_family, filepath, format, file_size, created_at) VALUES (?, ?, ?, 'Brand', 'stu_brandfont00001', ?, 'woff2', 9, strftime('%s','now'))`,
    F.font, WA1, U.admin.id, `${F.font}.woff2`);
  F.w1 = crypto.randomUUID();
  run(`INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES (?, ?, ?, 'text', 'Prices', ?)`,
    F.w1, U.admin.id, WA1, JSON.stringify({ image_content_id: F.c2, text: '{{menuprices.price}}', font_family: 'stu_brandfont00001', api_key: 'WIDGETKEY' }));

  F.child = mkPlaylist(WA1, 'Child', { snapshot: [snapItem({ content_id: F.c3 })] });
  addItem(F.child, { content: F.c3 });
  F.p = mkPlaylist(WA1, 'Front window', {
    snapshot: [snapItem({ content_id: F.c1, sort_order: 0 }), snapItem({ widget_id: F.w1, mime_type: 'widget', sort_order: 1 }),
      snapItem({ content_id: F.c3, sort_order: 2 }), snapItem({ content_id: F.tpl, sort_order: 3 })],
    structure: [{ content_id: F.c1 }, { widget_id: F.w1 }, { child_playlist_id: F.child }, { content_id: F.tpl }],
  });
  F.i1 = addItem(F.p, { content: F.c1, sort: 0 });
  addItem(F.p, { widget: F.w1, sort: 1, muted: true, weight: 3 });
  addItem(F.p, { child: F.child, sort: 2 });
  addItem(F.p, { content: F.tpl, sort: 3 });
  run(`INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, sort_order) VALUES (?, ?, '1,2,3', '08:00', '11:00', 0)`, crypto.randomUUID(), F.i1);
  F.d1 = mkDevice(WA1, 'Front window', { playlist: F.p, defaultContent: F.c4 });
  F.d2 = mkDevice(WA1, 'Side window', { playlist: F.p });
});

after(async () => { await stop(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('an org admin of BOTH organizations is still refused a move to another organization; a platform operator and an API token are refused', async () => {
  run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_admin')", ORG_B, U.admin.id);
  try {
    const r = await move('admin', [F.d2], WB, { acknowledge_other_org: true, bring_playlist: true });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'MOVE_OTHER_ORG');
  } finally {
    run('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?', ORG_B, U.admin.id);
  }
  assert.equal((await move('op', [F.d2], WB, { acknowledge_other_org: true })).status, 403, 'platform operator: read-only staff');
  const tok = await api('/api/tokens', J('admin', { name: 'ci', scope: 'full' }, 'POST', WA1));
  assert.equal(tok.status, 201, JSON.stringify(tok.body));
  const viaToken = await move(tok.body.token, [F.d2], WA2);
  assert.equal(viaToken.status, 403);
  assert.equal(dev(F.d2).workspace_id, WA1, 'nothing moved');
});

test('the preview of a platform admin\'s move to another organization says so and lists what is copied', async () => {
  const r = await preview('padmin', [F.d1], WB, '&bring_playlist=1');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.other_organization, { id: ORG_B, name: 'Org B' });
  assert.equal(r.body.bring_playlist, true);
  const b = r.body.screens[0].brought;
  assert.ok(b, JSON.stringify(r.body.screens[0]));
  assert.equal(b.playlist_name, 'Front window');
  assert.equal(b.playlist_others, 1, 'the side window still uses it');
  assert.equal(b.playlists, 2, 'its own + the nested child');
  assert.equal(b.content, 4, 'c1, c2 (inside the widget), c3 (child), c4 (default) — not the template');
  assert.equal(b.widgets, 1);
  assert.equal(b.data_sources, 1);
  assert.equal(b.fonts, 1);
  assert.equal(b.bytes, 4000);
  assert.equal(r.body.screens[0].has_own, true);
  // A preview writes nothing.
  assert.equal(dev(F.d1).workspace_id, WA1);
  assert.equal(q1('SELECT COUNT(*) AS n FROM playlists WHERE workspace_id = ?', WB).n, 0);
  assert.ok(!fs.readdirSync(FONTS_DIR).some((f) => f !== `${F.font}.woff2`), 'no font file copied by a preview');
});

test('⚠️ a platform admin moves a screen AND its playlist to another organization: the screen plays the same loop from copies', async () => {
  let r = await move('padmin', [F.d1], WB, { bring_playlist: true });
  assert.equal(r.status, 409, 'another organization needs its own confirmation');
  assert.equal(r.body.code, 'MOVE_OTHER_ORG_CONFIRM');
  assert.equal(dev(F.d1).workspace_id, WA1, 'nothing moved without it');

  r = await move('padmin', [F.d1], WB, { bring_playlist: true, acknowledge_other_org: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = dev(F.d1);
  assert.equal(d.workspace_id, WB);
  assert.equal(d.user_id, U.other.id, 'handed to the new organization\'s owner');
  assert.equal(d.playlist_source, 'device');
  assert.notEqual(d.playlist_id, F.p);
  const np = q1('SELECT * FROM playlists WHERE id = ?', d.playlist_id);
  assert.equal(np.workspace_id, WB);
  assert.equal(np.name, 'Front window');

  // Every reference in the copied snapshot points into Org B, at rows sharing the same bytes.
  const snap = JSON.parse(np.published_snapshot);
  const src = JSON.parse(q1('SELECT published_snapshot FROM playlists WHERE id = ?', F.p).published_snapshot);
  assert.equal(snap.length, src.length);
  for (let i = 0; i < snap.length; i++) {
    const s = snap[i], o = src[i];
    if (o.content_id === F.tpl) { assert.equal(s.content_id, F.tpl, 'template content is referenced, not copied'); continue; }
    const ref = s.content_id || s.widget_id;
    assert.notEqual(ref, o.content_id || o.widget_id);
    const table = s.content_id ? 'content' : 'widgets';
    assert.equal(q1(`SELECT workspace_id FROM ${table} WHERE id = ?`, ref).workspace_id, WB);
    if (s.content_id) {
      const a = q1('SELECT filepath, user_id FROM content WHERE id = ?', s.content_id);
      assert.equal(a.filepath, q1('SELECT filepath FROM content WHERE id = ?', o.content_id).filepath);
      assert.equal(a.user_id, U.other.id);
    }
  }
  // Items: the nested child, the mute, the weight and the daypart all came along.
  const items = q('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order', np.id);
  assert.equal(items.length, 4);
  assert.equal(items[1].muted, 1); assert.equal(items[1].weight, 3);
  const child = q1('SELECT * FROM playlists WHERE id = ?', items[2].child_playlist_id);
  assert.equal(child.workspace_id, WB); assert.equal(child.name, 'Child');
  assert.equal(q('SELECT * FROM playlist_items WHERE playlist_id = ?', child.id).length, 1);
  assert.equal(q('SELECT * FROM playlist_item_schedules WHERE playlist_item_id = ?', items[0].id).length, 1);
  assert.deepEqual(JSON.parse(np.published_structure).map((x) => !!x.child_playlist_id), [false, false, true, false]);
  assert.equal(JSON.parse(np.published_structure)[2].child_playlist_id, child.id);
  // The widget names its own copies; its credential and the data source's did not cross over.
  const w = q1('SELECT * FROM widgets WHERE id = ?', items[1].widget_id);
  const cfg = JSON.parse(w.config);
  assert.equal(q1('SELECT workspace_id FROM content WHERE id = ?', cfg.image_content_id).workspace_id, WB);
  assert.equal(cfg.api_key, '', 'a widget credential is blanked across organizations');
  const ds = q1("SELECT * FROM data_sources WHERE workspace_id = ? AND slug = 'menuprices'", WB);
  assert.ok(ds, 'the data source the widget names by slug came along');
  assert.equal(JSON.parse(ds.config).auth_token, '');
  assert.equal(JSON.parse(ds.config).url, 'https://example.test/prices');
  const font = q1("SELECT * FROM custom_fonts WHERE workspace_id = ? AND css_family = 'stu_brandfont00001'", WB);
  assert.ok(font);
  assert.notEqual(font.filepath, `${F.font}.woff2`);
  assert.equal(fs.readFileSync(path.join(FONTS_DIR, font.filepath), 'utf8'), 'FONTBYTES', 'a font file is copied (font delete does not refcount)');
  assert.equal(q1('SELECT workspace_id FROM content WHERE id = ?', d.default_content_id).workspace_id, WB, 'default content copied');

  // The source is untouched: the side window still plays the original.
  assert.equal(dev(F.d2).playlist_id, F.p);
  assert.equal(q('SELECT * FROM playlist_items WHERE playlist_id = ?', F.p).length, 4);
  assert.equal(JSON.parse(q1('SELECT config FROM data_sources WHERE id = ?', F.ds).config).auth_token, 'SUPERSECRET');
  // Both organizations' feeds say where it went.
  const logs = q("SELECT workspace_id FROM activity_log WHERE action = 'device.move_workspace' AND device_id = ?", F.d1).map((x) => x.workspace_id).sort();
  assert.deepEqual(logs, [WA1, WB].sort());
  // What the screen is sent now: the copied loop.
  const pv = await api(`/api/devices/${F.d1}/preview-payload`, J('other', undefined, 'GET', WB));
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal((pv.body.assignments || []).length, 4);
});

test('deleting either copy of a brought file leaves the other playing', async () => {
  const d = dev(F.d1);
  const copy = q1(`SELECT c.id, c.filepath FROM playlist_items i JOIN content c ON c.id = i.content_id
                    WHERE i.playlist_id = ? AND c.filename = 'menu.png'`, d.playlist_id);
  const file = path.join(CONTENT_DIR, copy.filepath);
  let r = await api(`/api/content/${F.c1}`, J('admin', undefined, 'DELETE', WA1));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(fs.existsSync(file), 'the source delete left the bytes the copy uses');
  assert.ok(q1('SELECT 1 AS x FROM content WHERE id = ?', copy.id));
  r = await api(`/api/content/${copy.id}`, J('other', undefined, 'DELETE', WB));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!fs.existsSync(file), 'the last reference gone, the file goes');
});

test('same organization: bring copies the screen\'s playlist without any other-organization confirmation; owner unchanged', async () => {
  const c = mkContent(WA1, 'a2.png');
  const p = mkPlaylist(WA1, 'Solo', { snapshot: [snapItem({ content_id: c })] });
  addItem(p, { content: c });
  const d = mkDevice(WA1, 'Solo screen', { playlist: p });
  const pv = await preview('admin', [d], WA2, '&bring_playlist=1');
  assert.equal(pv.status, 200);
  assert.equal(pv.body.other_organization, null);
  assert.equal(pv.body.screens[0].brought.playlist_others, 0);
  const r = await move('admin', [d], WA2, { bring_playlist: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = dev(d);
  assert.equal(row.workspace_id, WA2);
  assert.equal(row.user_id, U.admin.id);
  assert.equal(q1('SELECT workspace_id FROM playlists WHERE id = ?', row.playlist_id).workspace_id, WA2);
  assert.ok(q1('SELECT 1 AS x FROM playlists WHERE id = ?', p), 'the original stays where it was');
  // Without bring the old behaviour stands: it arrives with nothing of its own.
  const d3 = mkDevice(WA1, 'Bare', { playlist: p });
  assert.equal((await move('admin', [d3], WA2)).status, 200);
  assert.equal(dev(d3).playlist_id, null);
});

test('a smart playlist arrives as an ordinary one holding what it was showing', async () => {
  const c = mkContent(WA1, 'smart.png');
  const rules = JSON.stringify({ rules: [{ field: 'tag', op: 'has', value: 'menu' }] });
  const p = mkPlaylist(WA1, 'Smart', { snapshot: [snapItem({ content_id: c })], smart: rules });
  const d = mkDevice(WA1, 'Smart screen', { playlist: p });
  const r = await move('admin', [d], WA2, { bring_playlist: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const np = q1('SELECT * FROM playlists WHERE id = ?', dev(d).playlist_id);
  assert.equal(np.smart_rules, null);
  const items = q('SELECT * FROM playlist_items WHERE playlist_id = ?', np.id);
  assert.equal(items.length, 1);
  assert.equal(q1('SELECT workspace_id FROM content WHERE id = ?', items[0].content_id).workspace_id, WA2);
  assert.equal(JSON.parse(np.published_snapshot)[0].content_id, items[0].content_id);
});

test('a copy the target account has no storage for is refused before anything moves', async () => {
  run("INSERT OR IGNORE INTO plans (id, name, display_name, max_devices, max_storage_mb) VALUES ('tiny', 'tiny', 'Tiny', -1, 0)");
  const prevPlan = q1('SELECT plan_id FROM users WHERE id = ?', U.other.id).plan_id;
  run("UPDATE users SET plan_id = 'tiny' WHERE id = ?", U.other.id);
  try {
    const c = mkContent(WA1, 'big.png', { size: 5 * 1024 * 1024 });
    const p = mkPlaylist(WA1, 'Big', { snapshot: [snapItem({ content_id: c })] });
    addItem(p, { content: c });
    const d = mkDevice(WA1, 'Big screen', { playlist: p });
    const pv = await preview('padmin', [d], WB, '&bring_playlist=1');
    assert.equal(pv.status, 200);
    assert.equal(pv.body.storage_refusal && pv.body.storage_refusal.code, 'STORAGE_LIMIT');
    const r = await move('padmin', [d], WB, { bring_playlist: true, acknowledge_other_org: true });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'STORAGE_LIMIT');
    assert.equal(dev(d).workspace_id, WA1);
    // Without the playlist the screen itself can still go.
    const r2 = await move('padmin', [d], WB, { acknowledge_other_org: true });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
  } finally {
    run('UPDATE users SET plan_id = ? WHERE id = ?', prevPlan, U.other.id);
  }
});

test('a cross-organization move drops the old organization\'s head office rows for the screen', async () => {
  const d = mkDevice(WA1, 'Mandated');
  const corp = mkPlaylist(WA1, 'HQ loop', { snapshot: [] });
  run('UPDATE playlists SET corporate = 1 WHERE id = ?', corp);
  run("INSERT INTO corporate_mandates (id, organization_id, playlist_id, target_kind, target_id) VALUES (?, ?, ?, 'device', ?)", crypto.randomUUID(), ORG_A, corp, d);
  const r = await move('padmin', [d], WB, { acknowledge_other_org: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(q1("SELECT COUNT(*) AS n FROM corporate_mandates WHERE target_kind = 'device' AND target_id = ?", d).n, 0);
  assert.equal(r.body.moved[0].dropped.head_office, 1);
});
