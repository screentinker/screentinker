'use strict';

/*
 * Head office (corporate) playlists, Stage D — the server reads the dashboard needs to EXPLAIN a
 * refusal before it happens (spec §7), against the real server:
 *
 *   GET /api/corporate/workspace   which screens, groups and walls of the active workspace head
 *                                  office drives, and which schedules it shadows (pickers, badges)
 *   GET /api/corporate/targets     the org's workspaces / groups / walls / screens (admins, authors)
 *   GET /api/corporate/preview     authors may preview any screen of the org (role matrix §4.10)
 *   GET /api/devices/:id           corporate.controls_locked / gated_commands, head_office_triggers
 *   GET /api/corporate/store       mandates[].since and paused_schedules for the store notice
 *   GET /api/approvals/:id         an approved corporate change says "waiting for an admin" to a
 *                                  reviewer who is not an author, and does not offer Publish
 *   fill views                     scope_name (the level's bare name) and the draft status
 *
 * Cast (one org "Acme"): admin = org owner; hqed = editor of the head office workspace (NOT an
 * author unless corporate_authors says so); store = editor of "Store 1".
 *
 * MUTATION CHECKS (each verified once by reverting the line and watching a named test go red):
 *   - routes/corporate.js GET /workspace: drop the shadowed_schedules loop -> "workspace coverage: ..."
 *   - routes/corporate.js GET /preview: drop canAuthor from hqReader       -> "preview: an author ..."
 *   - routes/approvals.js publishRight: return { can_publish: write }       -> "approvals: a reviewer ..."
 *   - routes/devices.js: drop controls_locked                               -> "device read: ..."
 *   - routes/corporate.js GET /targets: admins only (drop canAuthor)        -> "targets: org admins and ..."
 *   - routes/corporate-slots.js GET /store: drop `p.since = since`          -> "store page: when head office ..."
 *   - lib/corporate/fills.js describeFill: drop `status`                    -> "device add: the redirect says ..."
 * (scratchpad script mutate-d.py; also covers the frontend, device-controls-hidden and MCP checks.)
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
let proc, BASE, DATA_DIR, LOG;
const U = {};
let ORG, HQ, STORE, P, SLOT, GROUP, dev, dev2, hqContent, sA, SCHED, MANDATE;

const dbh = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));
const q = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).all(...a); } finally { r.close(); } };
const q1 = (sql, ...a) => q(sql, ...a)[0];
const run = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).run(...a); } finally { r.close(); } };

function J(who, body, method = 'POST', ws) {
  const h = { 'Content-Type': 'application/json' };
  if (who) h.Authorization = `Bearer ${U[who].token}`;
  if (ws) h['X-Workspace-Id'] = ws;
  return { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
async function api(p, opts) {
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
const get = (who, p, ws) => api(p, J(who, undefined, 'GET', ws));

async function register(name) {
  const r = await api('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${name}-${Date.now()}@acme.test`, password: 'Passw0rd123', name }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  U[name] = { token: r.body.token, id: r.body.user.id, ws: r.body.current_workspace_id };
}
const mkContent = (ws, name) => {
  const id = crypto.randomUUID();
  run(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec, file_size) VALUES (?, ?, ?, ?, ?, 'image/png', 10, 1)`, id, U.admin.id, ws, name, name);
  return id;
};
const mkDevice = (ws, name) => {
  const id = crypto.randomUUID();
  run('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code) VALUES (?, ?, ?, ?, ?)', id, U.admin.id, ws, name, crypto.randomUUID().slice(0, 6));
  return id;
};

before(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'corp-ui-'));
  LOG = path.join(DATA_DIR, 'server.log');
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  await register('plat');
  await register('admin');
  await register('hqed');
  await register('store');
  HQ = U.admin.ws;
  ORG = q1('SELECT organization_id FROM workspaces WHERE id = ?', HQ).organization_id;
  STORE = crypto.randomUUID();
  run('INSERT INTO workspaces (id, organization_id, name, slug) VALUES (?, ?, ?, ?)', STORE, ORG, 'Store 1', 'store-1');
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", HQ, U.hqed.id);
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", STORE, U.store.id);
  hqContent = mkContent(HQ, 'brand.png');
  sA = mkContent(STORE, 'a.png');
  dev = mkDevice(STORE, 'Till');
  dev2 = mkDevice(STORE, 'Window');
  GROUP = crypto.randomUUID();
  run("INSERT INTO device_groups (id, user_id, workspace_id, name, sync_enabled) VALUES (?, ?, ?, 'Tills', 1)", GROUP, U.admin.id, STORE);
  run('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)', dev, GROUP);
  // The store's own schedule on a screen, BEFORE head office takes over: it will be shadowed.
  SCHED = crypto.randomUUID();
  run(`INSERT INTO schedules (id, user_id, workspace_id, device_id, title, start_time, end_time) VALUES (?, ?, ?, ?, 'Lunch', '2026-01-01T12:00', '2026-01-01T13:00')`, SCHED, U.store.id, STORE, dev);

  let r = await api('/api/corporate/settings', J('admin', { corporate_enabled: true, hq_workspace_id: HQ }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api('/api/corporate/playlists', J('admin', { name: 'Brand loop' }, 'POST', HQ));
  P = r.body.id;
  assert.equal(r.body.slot_count, 0);
  r = await api(`/api/playlists/${P}/items`, J('admin', { content_id: hqContent, duration_sec: 10 }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await api(`/api/corporate/playlists/${P}/slots`, J('admin', { name: 'Promo', max_items: 3 }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  SLOT = r.body.id;
  r = await api(`/api/playlists/${P}/publish`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('workspace coverage: empty before head office plays anything here', async () => {
  const r = await get('store', '/api/corporate/workspace', STORE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.active, false);
  assert.deepEqual(r.body.devices, {});
  assert.deepEqual(r.body.groups, {});
  assert.deepEqual(r.body.shadowed_schedules, []);
  assert.equal(r.body.is_admin, false);
  assert.equal((await get('admin', '/api/corporate/workspace', STORE)).body.is_admin, true);
});

test('workspace coverage: mandated screens, covered groups and shadowed schedules are named', async () => {
  const m = await api('/api/corporate/mandates', J('admin', { target_kind: 'workspace', target_id: STORE, playlist_id: P }, 'POST', HQ));
  assert.equal(m.status, 201, JSON.stringify(m.body));
  MANDATE = m.body.id;
  const r = await get('store', '/api/corporate/workspace', STORE);
  assert.equal(r.status, 200);
  assert.equal(r.body.active, true);
  assert.deepEqual(Object.keys(r.body.devices).sort(), [dev, dev2].sort());
  assert.equal(r.body.devices[dev].playlist_name, 'Brand loop');
  assert.equal(r.body.devices[dev].target_kind, 'workspace');
  assert.equal(r.body.devices[dev].dark, false);
  assert.equal(r.body.groups[GROUP].covered, true);
  assert.equal(r.body.groups[GROUP].mandated_members, 1);
  assert.equal(r.body.groups[GROUP].sync_excluded, 0, 'no member has its own slot content yet');
  assert.deepEqual(r.body.shadowed_schedules, [SCHED]);
  // Someone outside the workspace learns nothing about it: tenancy keeps them in their own workspace.
  const other = await get('hqed', '/api/corporate/workspace', STORE);
  assert.notEqual(other.body.workspace_id, STORE);
  assert.ok(!other.body.devices[dev] && !other.body.groups[GROUP], 'a store\'s screens leaked to a non-member');
});

test('workspace coverage: a member with its own slot content is counted out of group sync', async () => {
  // Store content for the slot at screen level for `dev`: it now plays a different loop from its group.
  let r = await api(`/api/corporate/slots/${SLOT}/fills`, J('store', { scope_kind: 'workspace', scope_id: STORE }, 'POST', STORE));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.scope_name, 'Store 1', 'the level carries its bare name for the UI to word');
  await api(`/api/playlists/${r.body.fill_playlist_id}/items`, J('store', { content_id: sA, duration_sec: 5 }, 'POST', STORE));
  await api(`/api/playlists/${r.body.fill_playlist_id}/publish`, J('store', {}, 'POST', STORE));
  r = await api(`/api/corporate/slots/${SLOT}/fills`, J('store', { scope_kind: 'device', scope_id: dev, copy: false }, 'POST', STORE));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.scope_name, 'Till');
  await api(`/api/playlists/${r.body.fill_playlist_id}/items`, J('store', { content_id: sA, duration_sec: 7 }, 'POST', STORE));
  await api(`/api/playlists/${r.body.fill_playlist_id}/publish`, J('store', {}, 'POST', STORE));
  const cov = await get('store', '/api/corporate/workspace', STORE);
  assert.equal(cov.body.groups[GROUP].sync_excluded, 1);
});

test('targets: org admins and corporate authors, nobody else', async () => {
  let r = await get('admin', '/api/corporate/targets', HQ);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const store = r.body.workspaces.find((w) => w.id === STORE);
  assert.ok(store, 'every workspace of the org is listed');
  assert.deepEqual(store.devices.map((d) => d.name).sort(), ['Till', 'Window']);
  assert.ok(store.groups.some((g) => g.id === GROUP));
  assert.equal(r.body.workspaces.find((w) => w.id === HQ).hq, true);
  r = await get('store', '/api/corporate/targets', STORE);
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_ADMIN_REQUIRED');
  r = await get('hqed', '/api/corporate/targets', HQ);
  assert.equal(r.status, 403, 'an HQ editor is not an author by default');
  await api('/api/corporate/settings', J('admin', { corporate_authors: 'org_admins_and_hq_editors' }, 'PUT', HQ));
  try {
    r = await get('hqed', '/api/corporate/targets', HQ);
    assert.equal(r.status, 200, 'an HQ editor who authors picks screens to preview');
  } finally {
    await api('/api/corporate/settings', J('admin', { corporate_authors: 'org_admins' }, 'PUT', HQ));
  }
});

test('preview: an author previews any screen of the org; a non-author outside the store cannot', async () => {
  let r = await get('hqed', `/api/corporate/preview?device_id=${dev2}`, HQ);
  assert.equal(r.status, 403, 'not an author, not a member of the store');
  await api('/api/corporate/settings', J('admin', { corporate_authors: 'org_admins_and_hq_editors' }, 'PUT', HQ));
  try {
    r = await get('hqed', `/api/corporate/preview?device_id=${dev2}`, HQ);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.source, 'corporate');
    assert.ok(r.body.items.some((i) => i.tag === 'corporate'));
    assert.ok(r.body.items.some((i) => i.tag === 'slot' && i.slot_name === 'Promo'));
  } finally {
    await api('/api/corporate/settings', J('admin', { corporate_authors: 'org_admins' }, 'PUT', HQ));
  }
  // The store still previews its own screens.
  r = await get('store', `/api/corporate/preview?device_id=${dev2}`, STORE);
  assert.equal(r.status, 200);
});

test('device read: gated controls are locked for the store, not for an org admin', async () => {
  let r = await get('store', `/api/devices/${dev2}`, STORE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.playlist_source, 'corporate');
  assert.equal(r.body.corporate.controls_locked, true);
  for (const c of ['shell', 'screen_off', 'set_server_url', 'install_apk']) assert.ok(r.body.corporate.gated_commands.includes(c), c);
  assert.ok(!r.body.corporate.gated_commands.includes('reboot'), 'restart stays with the store');
  // Add content's slot list arrives with the page, and the slot content's draft state with it.
  const slot = r.body.corporate.slots.find((s) => s.id === SLOT);
  assert.ok(slot && slot.fill, JSON.stringify(r.body.corporate.slots));
  assert.equal(slot.fill.scope_name, 'Store 1');
  assert.equal(slot.fill.status, 'published');
  assert.equal(slot.fill.has_published, true);
  r = await get('admin', `/api/devices/${dev2}`, STORE);
  assert.equal(r.body.corporate.controls_locked, false);
});

test('device add: the redirect says the slot content is now a draft, and names the level', async () => {
  const r = await api(`/api/assignments/device/${dev2}`, J('store', { content_id: sA, slot_id: SLOT }, 'POST', STORE));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.redirected_to.scope_kind, 'workspace');
  assert.equal(r.body.redirected_to.scope_name, 'Store 1');
  assert.equal(r.body.redirected_to.status, 'draft', 'the add landed in the draft: the device page offers Publish');
  assert.equal(r.body.redirected_to.has_published, true);
});

test('store page: when head office took over, and how many of the store\'s schedules it paused', async () => {
  const r = await get('store', '/api/corporate/store', STORE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = r.body.mandates.find((x) => x.playlist_id === P);
  assert.ok(m, JSON.stringify(r.body.mandates));
  const created = q1('SELECT created_at FROM corporate_mandates WHERE id = ?', MANDATE).created_at;
  assert.equal(m.since, created);
  assert.equal(r.body.paused_schedules, 1);
  assert.ok(r.body.slots[0].fills.every((f) => typeof f.scope_name === 'string'));
});

test('corporate playlist rows count their local slots', async () => {
  const r = await get('admin', '/api/corporate/playlists', HQ);
  assert.equal(r.body.playlists.find((p) => p.id === P).slot_count, 1);
});

test('approvals: a reviewer who is not an author is told an admin publishes, and is not offered Publish', async () => {
  let r = await api('/api/approvals/settings', J('admin', { require_approval: true, reviewers: [U.hqed.id] }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api(`/api/playlists/${P}/items`, J('admin', { content_id: hqContent, duration_sec: 12 }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await api('/api/approvals/submit', J('admin', { resource_type: 'playlist', resource_id: P }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const sub = r.body.id;
  r = await get('hqed', `/api/approvals/${sub}`, HQ);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.can_publish, false);
  assert.equal(r.body.waiting_for_author, true);
  r = await get('admin', `/api/approvals/${sub}`, HQ);
  assert.equal(r.body.can_publish, true);
  assert.equal(r.body.waiting_for_author, false);
  // An ordinary playlist (not corporate) is unchanged: no corporate fields at all.
  const own = await api('/api/playlists', J('admin', { name: 'HQ ordinary' }, 'POST', HQ));
  await api(`/api/playlists/${own.body.id}/items`, J('admin', { content_id: hqContent, duration_sec: 5 }, 'POST', HQ));
  r = await api('/api/approvals/submit', J('admin', { resource_type: 'playlist', resource_id: own.body.id }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await get('hqed', `/api/approvals/${r.body.id}`, HQ);
  assert.equal(r.body.can_publish, true, 'an HQ editor publishes ordinary playlists as before');
  assert.equal(r.body.waiting_for_author, undefined);
  assert.equal(r.body.corporate, undefined);
});

test('device read: head office trigger lock and the listeners-off warning (emergency alerts on)', async () => {
  let r = await api('/api/corporate/settings', J('admin', { emergency_triggers_enabled: true }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api('/api/corporate/emergency', J('admin', {
    name: 'Evacuate', match_token: 'EVAC-1', target_kind: 'playlist', target_ref: P, source_http: true, source_udp: false,
    mode: 'until_cleared', lease_sec: 60, priority: 5, enabled: true, scopes: [{ scope_kind: 'workspace', scope_id: STORE }],
  }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await get('store', `/api/devices/${dev2}`, STORE);
  assert.deepEqual(r.body.head_office_triggers.alerts.map((a) => a.name), ['Evacuate']);
  assert.equal(r.body.head_office_triggers.settings_locked, true);
  assert.equal(r.body.head_office_triggers.listeners_off, true);
  r = await get('admin', `/api/devices/${dev2}`, STORE);
  assert.equal(r.body.head_office_triggers.settings_locked, false);
  // The Triggers page lists it for the store, read-only.
  r = await get('store', '/api/triggers', STORE);
  assert.ok(r.body.head_office.emergency.some((e) => e.name === 'Evacuate'));
});
