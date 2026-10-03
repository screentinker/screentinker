'use strict';

/*
 * Playlists of playlists, phase 1 (stateless). See docs/playlist-nesting-design.md.
 *
 * The design decision these tests pin: nesting is expanded in buildSnapshotItems() and NOWHERE
 * else, so `published_snapshot` stays a FLAT ordered array and no player learns what nesting is.
 * Industry research across 17 vendors found the flatten-vs-runtime split is decided by whether the
 * nested playlist has a CURSOR ("play N of the child per parent rotation") — a cursor is stateful
 * across parent loops and cannot be flattened. Phase 1 is deliberately stateless, so it flattens.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, jwt, workspaceId, PORT, contentId;

const J = (t, b, m = 'POST') => ({
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  ...(b === undefined ? {} : { body: JSON.stringify(b) }),
});
const api = async (p, ...a) => { const r = await fetch(BASE + p, ...a); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const newPlaylist = async (name) => (await api('/api/playlists', J(jwt, { name }))).body;
const addContent = (pl, dur = 10) => api(`/api/playlists/${pl}/items`, J(jwt, { content_id: contentId, duration_sec: dur }));
const addChild = (pl, child) => api(`/api/playlists/${pl}/items`, J(jwt, { child_playlist_id: child }));
const publish = (pl) => api(`/api/playlists/${pl}/publish`, J(jwt, {}));
const dbHandle = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));
const snapshot = (pl) => {
  const raw = dbHandle();
  const row = raw.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(pl);
  raw.close();
  return row && row.published_snapshot ? JSON.parse(row.published_snapshot) : null;
};

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-'));
  const logFd = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot');

  const reg = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `nest${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Nest',
  }))).json();
  jwt = reg.token; workspaceId = reg.current_workspace_id;

  // A real content row so items have a filepath — the thing pinning and the trigger guard key on.
  const raw = dbHandle();
  contentId = crypto.randomUUID();
  const u = raw.prepare('SELECT id FROM users LIMIT 1').get();
  raw.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec)
               VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(contentId, u.id, workspaceId, 'clip.mp4', 'uploads/clip.mp4', 'video/mp4', 10);
  raw.close();
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('⚠️ a child playlist is FLATTENED into the parent snapshot — the player never sees nesting', async () => {
  const child = await newPlaylist('child'); const parent = await newPlaylist('parent');
  await addContent(child.id); await addContent(child.id);
  await addContent(parent.id); await addChild(parent.id, child.id);
  await publish(child.id);
  assert.equal((await publish(parent.id)).status, 200);

  const snap = snapshot(parent.id);
  assert.equal(snap.length, 3, 'expected 1 own item + 2 expanded from the child');
  assert.ok(snap.every((i) => !i.child_playlist_id),
    'a child reference survived into the snapshot — the player would have to understand nesting');
  assert.ok(snap.every((i) => i.filepath),
    'expanded items lost their filepath, so offline pinning and the trigger guard would both miss them');
});

test('expansion preserves ORDER — the child lands where the reference sat', async () => {
  const child = await newPlaylist('c-order'); const parent = await newPlaylist('p-order');
  await addContent(child.id, 55);
  await addContent(parent.id, 11);
  await addChild(parent.id, child.id);
  await addContent(parent.id, 22);
  await publish(child.id); await publish(parent.id);
  assert.deepEqual(snapshot(parent.id).map((i) => i.duration_sec), [11, 55, 22]);
});

test('⚠️ depth is capped at 1, and the error NAMES the playlist', async () => {
  // Enforced by TYPE at creation, not by traversal at publish — which is also what makes A→B→A
  // unconstructible, so this feature has no cycle detector and needs none.
  const a = await newPlaylist('A'); const b = await newPlaylist('B'); const c = await newPlaylist('C');
  await addContent(c.id);
  assert.equal((await addChild(b.id, c.id)).status, 201, 'one level must be allowed');
  const deep = await addChild(a.id, b.id);
  assert.equal(deep.status, 400, 'two levels were allowed');
  assert.match(deep.body.error, /only nest one level/);
  assert.match(deep.body.error, /"C"/, 'the error must name the offending grandchild');
});

test('⚠️ the reverse direction is refused too — a child cannot take a child', async () => {
  // Without this, A (already inside B) could take C, giving B→A→C: two levels built from the far end.
  const outer = await newPlaylist('outer'); const mid = await newPlaylist('mid'); const leaf = await newPlaylist('leaf');
  await addContent(mid.id); await addContent(leaf.id);
  await addChild(outer.id, mid.id);
  const r = await addChild(mid.id, leaf.id);
  assert.equal(r.status, 400, 'a playlist already used as a child was allowed to take a child');
  assert.match(r.body.error, /already used inside "outer"/);
});

test('a playlist cannot contain itself', async () => {
  const p = await newPlaylist('self');
  const r = await addChild(p.id, p.id);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cannot contain itself/);
});

test('an item is content, a widget, or a child — not two of them', async () => {
  const p = await newPlaylist('mixed'); const c = await newPlaylist('mixed-child');
  await addContent(c.id);
  const r = await api(`/api/playlists/${p.id}/items`, J(jwt, { content_id: contentId, child_playlist_id: c.id }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not more than one/);
});

test('a child from another workspace is refused', async () => {
  const other = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `nest2${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Other',
  }))).json();
  const foreign = await (await fetch(BASE + '/api/playlists', J(other.token, { name: 'foreign' }))).json();
  const mine = await newPlaylist('mine');
  const r = await addChild(mine.id, foreign.id);
  assert.ok(r.status === 403 || r.status === 404, `expected a refusal, got ${r.status}`);
});

test('⚠️ publishing is refused while a nested reference expands to nothing', async () => {
  /*
   * "Three or more 'empty' nested playlists in succession may fail to skip, resulting in a black
   * screen. Affected: Samsung Tizen, BrightSign XD (8.5.47)." We ship BrightSign. The vendor's own
   * workaround lives in the operator's head; this puts it in the product.
   */
  const empty = await newPlaylist('empty-one'); const parent = await newPlaylist('p-empty');
  await addContent(parent.id);
  await addChild(parent.id, empty.id);
  const r = await publish(parent.id);
  assert.equal(r.status, 400, 'an empty nested playlist was published');
  assert.match(r.body.error, /"empty-one"/, 'the error must name which child is empty');
  assert.match(r.body.error, /black screen/);

  await addContent(empty.id);
  assert.equal((await publish(parent.id)).status, 200, 'filling the child must unblock the publish');
});

test('⚠️ republishing an UNCHANGED playlist writes nothing — the restart must be change-triggered', async () => {
  /*
   * A child edit changes every ancestor's flattened items, so the player's structural fingerprint
   * changes and every screen showing an ancestor restarts at item 1 (#234, estate-wide). This is
   * the mitigation BrightSign ships as CONTENT_DATA_FEED_UNCHANGED: if the resolved snapshot is
   * byte-identical, do not write and do not push.
   */
  const child = await newPlaylist('c-nochange'); const parent = await newPlaylist('p-nochange');
  await addContent(child.id); await addContent(parent.id); await addChild(parent.id, child.id);
  await publish(child.id); await publish(parent.id);

  const raw = dbHandle();
  const before = raw.prepare('SELECT updated_at, published_snapshot FROM playlists WHERE id = ?').get(parent.id);
  raw.close();
  await sleep(1100);                       // updated_at has 1-second resolution
  assert.equal((await publish(parent.id)).status, 200);
  const raw2 = dbHandle();
  const after = raw2.prepare('SELECT updated_at, published_snapshot FROM playlists WHERE id = ?').get(parent.id);
  raw2.close();
  assert.equal(after.published_snapshot, before.published_snapshot, 'the snapshot changed with no edit');
  assert.equal(after.updated_at, before.updated_at,
    'an unchanged republish bumped updated_at, which would push and restart every screen');
});

test('⚠️ publishing a CHILD reaches a device that only holds the PARENT', async () => {
  /*
   * A nested child is nobody's playlist_id, so the base-playlist query cannot see those devices.
   * This is the THIRD time this shape has bitten: pushToDevices missed trigger-target devices, and
   * the trigger routes pushed nothing at all. Asserted over a real socket, because asserting on the
   * database would prove resolution rather than delivery.
   */
  const child = await newPlaylist('c-push'); const parent = await newPlaylist('p-push');
  await addContent(child.id); await addContent(parent.id); await addChild(parent.id, child.id);
  await publish(child.id); await publish(parent.id);

  const code = String(crypto.randomInt(100000, 1000000));
  const dev = await new Promise((res, rej) => {
    const s = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    s.on('connect', () => s.emit('device:register', { pairing_code: code }));
    s.on('device:registered', (d) => { s.close(); res({ id: d.device_id, token: d.device_token }); });
    setTimeout(() => rej(new Error('provision timeout')), 15000);
  });
  await api('/api/provision/pair', J(jwt, { pairing_code: code, name: 'Nest panel' }));
  await api(`/api/playlists/${parent.id}/assign`, J(jwt, { device_id: dev.id }));

  const sock = await new Promise((res, rej) => {
    const s = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    s.on('connect', () => s.emit('device:register', { device_id: dev.id, device_token: dev.token, device_info: { app_version: 't' } }));
    s.on('device:registered', () => res(s));
    setTimeout(() => rej(new Error('register timeout')), 15000);
  });
  try {
    const seen = new Promise((res) => {
      const t = setTimeout(() => res(null), 6000);
      sock.on('device:playlist-update', (p) => {
        if ((p.assignments || []).some((a) => a.duration_sec === 77)) { clearTimeout(t); res(p); }
      });
    });
    await addContent(child.id, 77);        // edit the CHILD only
    await publish(child.id);
    const payload = await seen;
    assert.ok(payload, 'publishing the child never reached a device that only holds the parent');
  } finally { try { sock.close(); } catch { /* */ } }
});

test('⚠️ deleting a playlist that is nested elsewhere is REFUSED, and names what uses it', async () => {
  /*
   * child_playlist_id is ON DELETE RESTRICT, so this DELETE throws a raw SqliteError. Unhandled it
   * reached the client as a 500 carrying "FOREIGN KEY constraint failed" AND a stack trace with
   * server paths in it — a regression introduced by adding the constraint, caught by running it.
   *
   * The constraint is correct; what was missing is the answer to the only question the operator has
   * at that moment: which playlist is using this one. Appspace ships this failure with no reverse
   * view at all; BrightSign gets it right with a lock icon on anything in use.
   */
  const child = await newPlaylist('shared-block'); const parent = await newPlaylist('uses-it');
  await addContent(child.id);
  await addChild(parent.id, child.id);

  const r = await api(`/api/playlists/${child.id}`, J(jwt, undefined, 'DELETE'));
  assert.equal(r.status, 409, `expected a named refusal, got ${r.status}`);
  assert.match(r.body.error, /"uses-it"/, 'the error must name the playlist using it');
  assert.deepEqual(r.body.used_by, ['uses-it']);

  const raw = dbHandle();
  const still = raw.prepare('SELECT id FROM playlists WHERE id = ?').get(child.id);
  raw.close();
  assert.ok(still, 'the playlist was deleted despite the refusal');
});

test('a playlist nobody nests still deletes cleanly', async () => {
  // The guard must refuse USE, not deletion in general.
  const lonely = await newPlaylist('lonely');
  await addContent(lonely.id);
  assert.equal((await api(`/api/playlists/${lonely.id}`, J(jwt, undefined, 'DELETE'))).status, 200);
});

test('removing the reference releases the child for deletion', async () => {
  const child = await newPlaylist('releasable'); const parent = await newPlaylist('holder');
  await addContent(child.id);
  const item = (await addChild(parent.id, child.id)).body;
  assert.equal((await api(`/api/playlists/${child.id}`, J(jwt, undefined, 'DELETE'))).status, 409);
  assert.equal((await api(`/api/playlists/${parent.id}/items/${item.id}`, J(jwt, undefined, 'DELETE'))).status, 200);
  assert.equal((await api(`/api/playlists/${child.id}`, J(jwt, undefined, 'DELETE'))).status, 200,
    'the child stayed locked after its only reference was removed');
});

test('the list reports used_by_count and has_children so the UI can warn first', async () => {
  const child = await newPlaylist('counted'); const p1 = await newPlaylist('h1'); const p2 = await newPlaylist('h2');
  await addContent(child.id);
  await addChild(p1.id, child.id); await addChild(p2.id, child.id);
  const list = (await api('/api/playlists', { headers: { Authorization: `Bearer ${jwt}` } })).body;
  const row = list.find((x) => x.id === child.id);
  assert.equal(row.used_by_count, 2, 'a shared child must report how many playlists include it');
  assert.equal(row.has_children, 0, 'a leaf must not claim to have children');
  assert.equal(list.find((x) => x.id === p1.id).has_children, 1);
});

/*
 * ─── The writers that phase 1 did not visit ────────────────────────────────────────────────
 *
 * The guards above all sit on the ADD path, because that is where nesting is created. But
 * playlist_items has twelve writers across seven files, and an audit found four of them silently
 * corrupting or destroying a nested row. Every test below FAILED before its fix; each was then
 * mutation-checked by reverting the fix alone.
 */

const items = async (pl) => (await api(`/api/playlists/${pl}/items`, { headers: { Authorization: `Bearer ${jwt}` } })).body;
const rawItems = (pl) => {
  const raw = dbHandle();
  const rows = raw.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order').all(pl);
  raw.close();
  return rows;
};

test('⚠️ DISCARDING a draft must not destroy the nesting — the snapshot cannot describe it', async () => {
  const child = await newPlaylist('d-child'); const parent = await newPlaylist('d-parent');
  await addContent(child.id);
  await addChild(parent.id, child.id);
  await publish(child.id); await publish(parent.id);

  // Dirty the draft, then undo.
  await addContent(parent.id);
  assert.equal((await api(`/api/playlists/${parent.id}/discard`, J(jwt, {}))).status, 200);

  const rows = rawItems(parent.id);
  assert.equal(rows.length, 1, 'discard should restore exactly the one published item');
  assert.equal(rows[0].child_playlist_id, child.id,
    'discard rebuilt the playlist from the FLAT snapshot, replacing the child reference with a '
    + 'snapshot-time copy of its contents — the nesting was destroyed and it reported success');
});

test('⚠️ SWAPPING a nested item to content must clear the child reference', async () => {
  const child = await newPlaylist('s-child'); const parent = await newPlaylist('s-parent');
  await addContent(child.id);
  const item = (await addChild(parent.id, child.id)).body;

  assert.equal((await api(`/api/playlists/${parent.id}/items/${item.id}`,
    J(jwt, { content_id: contentId }, 'PUT'))).status, 200);

  const row = rawItems(parent.id)[0];
  assert.equal(row.content_id, contentId);
  assert.equal(row.child_playlist_id, null,
    'both content_id and child_playlist_id were set: expandChildPlaylists tests the child first, '
    + 'so this row kept expanding as a playlist while every UI query showed it as content');
});

test('DUPLICATING a nested item copies the reference, not a ghost row', async () => {
  const child = await newPlaylist('dup-child'); const parent = await newPlaylist('dup-parent');
  await addContent(child.id);
  const item = (await addChild(parent.id, child.id)).body;

  assert.equal((await api(`/api/playlists/${parent.id}/items/${item.id}/duplicate`, J(jwt, {}))).status, 201);
  const rows = rawItems(parent.id);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.child_playlist_id === child.id),
    'the duplicate had no content, no widget and no child — an item that renders as nothing');
});

test('⚠️ EXPORT/IMPORT round-trips nesting instead of quietly shortening the playlist', async () => {
  const child = await newPlaylist('x-child'); const parent = await newPlaylist('x-parent');
  await addContent(child.id);
  await addContent(parent.id); await addChild(parent.id, child.id);

  // ⚠️ /export authenticates by QUERY PARAMETER, not by header — a JWT in a URL. Pre-existing,
  // noted here because the header form silently 401s and the test would read {error} as a dump.
  const dump = await (await fetch(`${BASE}/api/status/export?token=${jwt}`)).json();
  const exported = dump.playlist_items.filter((i) => i.playlist_id === parent.id);
  assert.equal(exported.length, 2, 'the export dropped an item');
  assert.ok(exported.some((i) => i.child_playlist_id === child.id),
    'the export omitted child_playlist_id, so nesting could not survive any restore');

  // Import it into a SECOND workspace and check the reference was remapped, not dropped.
  const reg2 = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `nestimp${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Imp',
  }))).json();
  // A multipart upload is ALWAYS treated as a ZIP; a plain dump goes in the JSON body.
  const imp = await api('/api/status/import', J(reg2.token, dump));
  assert.equal(imp.status, 200, JSON.stringify(imp.body));

  const raw = dbHandle();
  const newParent = raw.prepare("SELECT id FROM playlists WHERE name = 'x-parent' AND workspace_id = ?")
    .get(reg2.current_workspace_id);
  const newChild = raw.prepare("SELECT id FROM playlists WHERE name = 'x-child' AND workspace_id = ?")
    .get(reg2.current_workspace_id);
  const rows = raw.prepare('SELECT * FROM playlist_items WHERE playlist_id = ?').all(newParent.id);
  raw.close();

  assert.equal(rows.length, 2, 'the imported playlist came back SHORTER than the one exported');
  const ref = rows.find((r) => r.child_playlist_id);
  assert.ok(ref, 'the nested item was dropped on import');
  assert.equal(ref.child_playlist_id, newChild.id,
    'the child reference was not remapped to the imported copy — it points at another workspace');
});

test('COPYING a device playlist carries the reference — and refuses to build depth 2 sideways', async () => {
  const raw = dbHandle();
  const u = raw.prepare('SELECT id FROM users LIMIT 1').get();
  const mk = (name) => {
    const id = crypto.randomUUID();
    raw.prepare('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code) VALUES (?, ?, ?, ?, ?)')
      .run(id, u.id, workspaceId, name, crypto.randomUUID().slice(0, 6));
    return id;
  };
  const src = mk('copy-src'); const dst = mk('copy-dst'); const deep = mk('copy-deep');
  raw.close();

  const child = await newPlaylist('copy-child');
  await addContent(child.id);

  // Build the SOURCE device's playlist through the device API so ensureDevicePlaylist runs.
  await api(`/api/assignments/device/${src}`, J(jwt, { content_id: contentId, duration_sec: 10 }));
  const srcPl = (() => { const r = dbHandle(); const v = r.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(src); r.close(); return v.playlist_id; })();
  await addChild(srcPl, child.id);

  assert.equal((await api(`/api/assignments/device/${src}/copy-to/${dst}`, J(jwt, { replace: true }))).status, 200);
  const copied = rawItems((() => { const r = dbHandle(); const v = r.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(dst); r.close(); return v.playlist_id; })());
  assert.equal(copied.length, 2);
  assert.ok(copied.some((i) => i.child_playlist_id === child.id),
    'the copy flattened or dropped the nested item — editing the child would no longer reach this device');

  // Now make the THIRD device's playlist a child of something, then copy into it: that would give
  // holder -> deepPl -> child, two levels built from the far end. The add-path guard cannot see it.
  await api(`/api/assignments/device/${deep}`, J(jwt, { content_id: contentId, duration_sec: 10 }));
  const deepPl = (() => { const r = dbHandle(); const v = r.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(deep); r.close(); return v.playlist_id; })();
  const holder = await newPlaylist('copy-holder');
  assert.equal((await addChild(holder.id, deepPl)).status, 201);

  const refused = await api(`/api/assignments/device/${src}/copy-to/${deep}`, J(jwt, { replace: true }));
  assert.equal(refused.status, 400, 'the copy built a two-level chain the add path would have refused');
  assert.match(refused.body.error, /copy-holder/, 'the refusal must name the playlist that blocks it');
});

test('⚠️ an unchanged SNAPSHOT still records changed STRUCTURE, or undo resurrects the reference', async () => {
  const child = await newPlaylist('id-child'); const parent = await newPlaylist('id-parent');
  await addContent(child.id, 33);
  await addChild(parent.id, child.id);
  await publish(child.id); await publish(parent.id);

  // Replace the reference with the child's own item. The FLAT snapshot is byte-identical, so
  // publish takes its no-change early exit, pushes nothing and nothing restarts — correct, and the
  // reason the early exit exists. The structure, however, HAS changed.
  //
  // Every UI edit calls markDraft, so today only a writer that mutates items without it can reach
  // this branch with a real structure change. Rather than assume none ever will, the state is set
  // up directly: this tests publishPlaylist's contract, not the route that happens to precede it.
  const ref = rawItems(parent.id)[0];
  await api(`/api/playlists/${parent.id}/items/${ref.id}`, J(jwt, undefined, 'DELETE'));
  await addContent(parent.id, 33);
  { const r = dbHandle(); r.prepare("UPDATE playlists SET status = 'published' WHERE id = ?").run(parent.id); r.close(); }

  await publish(parent.id);
  assert.deepEqual(snapshot(parent.id).map((i) => i.duration_sec), [33],
    'the snapshot should be untouched — this is the no-restart path');

  await addContent(parent.id, 99);
  await api(`/api/playlists/${parent.id}/discard`, J(jwt, {}));
  const rows = rawItems(parent.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].child_playlist_id, null,
    'discard restored a stale structure and brought back the child reference the user removed');
  assert.equal(rows[0].content_id, contentId);
});

test('discard restores per-item MUTE — it used to silently un-mute everything', async () => {
  const pl = await newPlaylist('mute-restore');
  const item = (await addContent(pl.id)).body;
  await api(`/api/playlists/${pl.id}/items/${item.id}`, J(jwt, { muted: true }, 'PUT'));
  await publish(pl.id);

  await addContent(pl.id, 99);
  await api(`/api/playlists/${pl.id}/discard`, J(jwt, {}));

  const rows = rawItems(pl.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].muted, 1, 'discarding an unrelated edit un-muted an item the user had muted');
});

// The dashboard's mute toggle is on the device page, so this is API surface rather than a broken
// screen — but the endpoint answered 200 and wrote nothing, which is worse than a 400.
test('⚠️ the playlist item endpoint persists muted — it dropped the field entirely', async () => {
  const pl = await newPlaylist('mute-route');
  const item = (await addContent(pl.id)).body;
  assert.equal((await api(`/api/playlists/${pl.id}/items/${item.id}`, J(jwt, { muted: true }, 'PUT'))).status, 200);
  assert.equal(rawItems(pl.id)[0].muted, 1,
    'the endpoint accepted a mute, reported success and wrote nothing — #129, one route over');
});

test('⚠️ muting an item inside a CHILD reaches the parent snapshot devices actually play', async () => {
  const child = await newPlaylist('mute-child'); const parent = await newPlaylist('mute-parent');
  const item = (await addContent(child.id)).body;
  await addChild(parent.id, child.id);
  await publish(child.id); await publish(parent.id);
  assert.equal(snapshot(parent.id)[0].muted, 0);

  await api(`/api/playlists/${child.id}/items/${item.id}`, J(jwt, { muted: true }, 'PUT'));

  assert.equal(snapshot(child.id)[0].muted, 1);
  assert.equal(snapshot(parent.id)[0].muted, 1,
    'the parent holds a FLATTENED copy of the child, so patching only the child leaves every '
    + 'screen on the parent playing the old flag — the same tax publish pays by republishing ancestors');
});

test('⚠️ a cyclic nest (A->B->A) does not crash publish — the render refuses the cycle', async () => {
  // Construct the cycle by RAW insert, bypassing the create-time guards, to simulate a row written
  // by some other path (an import, a migration, an older build). buildSnapshotItems used to reset
  // depth to 0 on every recursion, so its MAX_NEST_DEPTH guard was dead and this recursed until a
  // stack-overflow 500 on publish/preview.
  const A = await newPlaylist('cyc-A');
  const B = await newPlaylist('cyc-B');
  await addContent(A.id);
  await addContent(B.id);
  const raw = dbHandle();
  const ins = raw.prepare('INSERT INTO playlist_items (playlist_id, child_playlist_id, sort_order, duration_sec) VALUES (?,?,?,?)');
  ins.run(A.id, B.id, 5, 0);   // A contains B
  ins.run(B.id, A.id, 5, 0);   // B contains A -> cycle
  raw.close();

  const pub = await publish(A.id);
  assert.equal(pub.status, 200, 'publish must not 500 on a cyclic nest');
  const snap = snapshot(A.id);
  assert.ok(Array.isArray(snap), 'a bounded, flat snapshot is produced');
  assert.ok(snap.length < 10, `snapshot is bounded (no runaway re-expansion), got ${snap.length}`);
});

test('⚠️ paste refuses a child that would build a second nesting level', async () => {
  const P = await newPlaylist('paste-P');
  const C = await newPlaylist('paste-C');
  const G = await newPlaylist('paste-G');
  await addContent(G.id);
  assert.equal((await addChild(C.id, G.id)).status, 201);       // C -> G, so C already holds a child
  // Pasting C into P would make P -> C -> G, two levels deep. The single-item add route refuses this;
  // paste skipped the check and would have built it.
  const res = await api(`/api/playlists/${P.id}/items/selection`,
    J(jwt, { action: 'paste', items: [{ child_playlist_id: C.id }] }));
  assert.equal(res.status, 200);
  assert.equal(res.body.added, 0, 'the over-deep child must be skipped, not pasted');
  assert.equal(rawItems(P.id).length, 0, 'nothing landed in the destination');
});

/*
 * Display → Playlist → + Add Content now offers the same Playlists tab as a playlist does, so the
 * display route takes child_playlist_id too — under the SAME rules (lib/playlist-nesting.js).
 */
test('a display can nest a playlist into its own playlist, under the same rules as a playlist', async () => {
  const raw = dbHandle();
  const u = raw.prepare('SELECT id FROM users LIMIT 1').get();
  const devId = crypto.randomUUID();
  raw.prepare('INSERT INTO devices (id, name, status, workspace_id, user_id) VALUES (?,?,?,?,?)')
    .run(devId, 'Lobby', 'online', workspaceId, u.id);
  raw.close();
  const child = await newPlaylist('menu-board');
  await addContent(child.id);

  const ok = await api(`/api/assignments/device/${devId}`, J(jwt, { child_playlist_id: child.id }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.child_playlist_id, child.id);
  assert.equal(ok.body.child_playlist_name, 'menu-board');

  const dev = await api(`/api/devices/${devId}`, J(jwt, undefined, 'GET'));
  const row = dev.body.assignments.find((a) => a.child_playlist_id === child.id);
  assert.ok(row, 'the display page lists the nested playlist');
  assert.equal(row.filename, 'menu-board');
  assert.equal(row.child_item_count, 1);

  // Two levels deep is refused here exactly as on the playlist route, naming the culprit.
  const inner = await newPlaylist('inner');
  const outer = await newPlaylist('outer');
  await addContent(inner.id);
  await addChild(outer.id, inner.id);
  const deep = await api(`/api/assignments/device/${devId}`, J(jwt, { child_playlist_id: outer.id }));
  assert.equal(deep.status, 400);
  assert.match(deep.body.error, /"outer" already contains the playlist "inner"/);

  // Exactly one of content / widget / child playlist.
  const both = await api(`/api/assignments/device/${devId}`, J(jwt, { child_playlist_id: child.id, content_id: contentId }));
  assert.equal(both.status, 400);
});

test('a refused nesting on a display that has no playlist yet leaves no empty playlist behind', async () => {
  const raw = dbHandle();
  const u = raw.prepare('SELECT id FROM users LIMIT 1').get();
  const devId = crypto.randomUUID();
  raw.prepare('INSERT INTO devices (id, name, status, workspace_id, user_id) VALUES (?,?,?,?,?)')
    .run(devId, 'Fresh', 'online', workspaceId, u.id);
  raw.close();
  const r = await api(`/api/assignments/device/${devId}`, J(jwt, { child_playlist_id: crypto.randomUUID() }));
  assert.equal(r.status, 404);
  const check = dbHandle();
  const d = check.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(devId);
  check.close();
  assert.equal(d.playlist_id, null, 'the display was not given a playlist for a refused add');
});
