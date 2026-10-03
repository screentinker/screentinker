'use strict';

/*
 * Receiving content a hub wants on this node's screens.
 *
 * The two properties everything else hangs off:
 *   - "I have a row" is not "I have the bytes"
 *   - nothing is committed until the bytes are verified and on disk under their final name
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-csync-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { evaluateManifest, admitTransfer, commitStagedAsset } = require('../lib/mesh/content-sync');
const { digestFile } = require('../lib/content-digest');

const id = () => crypto.randomUUID();
const GB = 1024 ** 3;
let wsA, wsB, userId, contentDir;

before(() => {
  userId = id(); const org = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(userId, `c-${userId}@e.com`, 'C', 'x');
  db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(org, 'Org', userId);
  wsA = id();
  db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(wsA, org, 'A');
  wsB = id();
  db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(wsB, org, 'B');
  contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csync-files-'));
});

const mkEdge = (cols = {}) => {
  const e = id();
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories,
              transport_direction, tls_verify, created_at, write_grant, write_scope,
              write_bytes_budget, write_bytes_used)
              VALUES (?,?,'up','[]','["health"]','we-dial',1,strftime('%s','now'),?,?,?,?)`)
    .run(e, cols.peer || id(), JSON.stringify(cols.write_grant || ['content-push']),
         JSON.stringify([wsA]), cols.budget === undefined ? 20 * GB : cols.budget, cols.used || 0);
  return db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(e);
};
const stage = (bytes) => {
  const p = path.join(contentDir, `${id()}.part`);
  fs.writeFileSync(p, bytes);
  return p;
};
/*
 * ⚠️ The sniffer is a real function now, not a stub that returns an extension. This used to be
 * `() => '.mp4'` against a `deps.sniffExt` that had no production implementation at all — so the
 * loudest safety comment in content-sync.js was tested entirely by a stub that never sniffed.
 * It returns BOTH mime and ext because the code must derive both from the same bytes.
 */
const sniff = () => ({ mime: 'video/mp4', ext: '.mp4' });
const entryFor = async (staged, extra = {}) => ({
  oid: id(), kind: 'local', sz: fs.statSync(staged).size, mt: 'video/mp4',
  fn: 'Clip.mp4', dg: await digestFile(staged), ...extra,
});

test('⚠️ a row without bytes on disk still counts as MISSING', async () => {
  /*
   * The check that matters. A large fraction of content rows in a real library have no file behind
   * them — restores, migrations, manual cleanups. Stopping at "is there a row" reports a playlist
   * ready and then plays nothing.
   */
  const edge = mkEdge();
  const oid = id();
  const localId = id();
  db.prepare(`INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size)
              VALUES (?,?,?,?,?,?,?)`).run(localId, userId, wsA, 'gone.mp4', 'gone.mp4', 'video/mp4', 10);
  db.prepare(`INSERT INTO mesh_content_provenance
              (origin_node_id,origin_content_id,local_content_id,bytes,first_seen_at,last_seen_at)
              VALUES (?,?,?,0,0,0)`).run(edge.peer_node_id, oid, localId);

  const r = evaluateManifest(db, edge, { content: [{ oid, kind: 'local', sz: 10 }] }, { contentDir, workspaceId: wsA });
  assert.equal(r.ok, true);
  assert.equal(r.need.length, 1, 'the row exists but the file does not — that is still a need');
  assert.equal(r.need[0].why, 'bytes-missing');
});

test('a second push of the same asset is recognised by provenance and needs nothing', async () => {
  const edge = mkEdge();
  const staged = stage('the same bytes every time');
  const entry = await entryFor(staged);
  const c = await commitStagedAsset(db, edge, entry, staged, { contentDir, sniff, workspaceId: wsA, userId });
  assert.equal(c.ok, true, c.reason);

  const r = evaluateManifest(db, edge, { content: [entry] }, { contentDir, workspaceId: wsA });
  assert.deepEqual(r.need, [], 're-pushing an unchanged asset must transfer nothing');
  assert.equal(r.have[0].matched, 'provenance');
});

test('⚠️ bytes we already hold from ANOTHER origin are matched by digest, not re-sent', async () => {
  const edgeA = mkEdge();
  const staged = stage('a stock clip both sites happen to have');
  const entry = await entryFor(staged);
  await commitStagedAsset(db, edgeA, entry, staged, { contentDir, sniff, workspaceId: wsA, userId });

  // A different hub, a different origin id, the same bytes.
  const edgeB = mkEdge();
  const r = evaluateManifest(db, edgeB, { content: [{ ...entry, oid: id() }] }, { contentDir, workspaceId: wsA });
  assert.deepEqual(r.need, [], 'identical bytes must not be transferred twice');
  assert.equal(r.have[0].matched, 'digest');
});

test('remote and YouTube items need a row but never any bytes', () => {
  const edge = mkEdge();
  const r = evaluateManifest(db, edge, {
    content: [{ oid: id(), kind: 'youtube', sz: 0 }, { oid: id(), kind: 'remote', sz: 0 }],
  }, { contentDir, workspaceId: wsA });
  assert.deepEqual(r.need, []);
  assert.equal(r.bytesNeeded, 0);
  assert.equal(r.have.every((h) => h.matched === 'no-bytes'), true);
});

test('⚠️ the budget is checked BEFORE any bytes move', () => {
  const edge = mkEdge({ budget: 10 * GB, used: 9 * GB });
  const ok = admitTransfer(edge, 512 * 1024 * 1024, {});
  const no = admitTransfer(edge, 4 * GB, {});
  assert.equal(ok.ok, true);
  assert.equal(no.ok, false);
  assert.match(no.reason, /allowance is left/i, 'the refusal must say how much room there is');
});

test('an edge without content-push cannot send bytes however much budget it has', () => {
  const edge = mkEdge({ write_grant: ['device-command'], budget: 100 * GB });
  const r = admitTransfer(edge, 1, {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /may not send content/i);
});

test('⚠️ free space is checked as well as the allowance — they are different limits', () => {
  // The budget is what the operator agreed to give. Free space is what the machine has, and it can
  // be smaller. A full disk on a signage server takes the screens down with it.
  const edge = mkEdge({ budget: 100 * GB, used: 0 });
  const r = admitTransfer(edge, 10 * GB, { freeBytes: () => 5 * GB, freeFloorBytes: GB });
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not have room/i);
});

test('⚠️ a file that arrives the wrong SIZE is refused and nothing is committed', async () => {
  const edge = mkEdge();
  const staged = stage('short');
  const entry = await entryFor(staged, { sz: 999999 });
  const before = db.prepare('SELECT COUNT(*) n FROM content').get().n;
  const r = await commitStagedAsset(db, edge, entry, staged, { contentDir, sniff, workspaceId: wsA, userId });
  assert.equal(r.ok, false);
  assert.match(r.reason, /bytes, not the/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM content').get().n, before, 'no row may be written');
});

test('⚠️ a file that does not match its CHECKSUM is refused', async () => {
  const edge = mkEdge();
  const staged = stage('these are not the bytes you were promised');
  const entry = await entryFor(staged, { dg: 'f'.repeat(64) });
  const r = await commitStagedAsset(db, edge, entry, staged, { contentDir, sniff, workspaceId: wsA, userId });
  assert.equal(r.ok, false);
  assert.match(r.reason, /checksum/i);
});

test('⚠️ the type is SNIFFED here too — the peer does not choose the extension', async () => {
  const edge = mkEdge();
  const staged = stage('whatever the hub claims this is');
  const entry = await entryFor(staged, { mt: 'video/mp4' });
  const r = await commitStagedAsset(db, edge, entry, staged,
    { contentDir, sniff: () => null, workspaceId: wsA, userId });
  assert.equal(r.ok, false, 'a type this server does not accept must be refused');
  assert.match(r.reason, /not a type this server accepts/i);
});

test('⚠️ the stored file is named by its DIGEST, so an unchanged re-push cannot move the fingerprint', async () => {
  const edge = mkEdge();
  const staged = stage('stable bytes');
  const entry = await entryFor(staged);
  const r = await commitStagedAsset(db, edge, entry, staged, { contentDir, sniff, workspaceId: wsA, userId });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.filepath, /^[0-9a-f]{64}\.mp4$/,
    'filepath is in the player fingerprint; a random name per push restarts every screen');
  assert.equal(r.filepath, `${entry.dg}.mp4`);
});

test('committing spends the allowance in the SAME transaction as the row', async () => {
  const edge = mkEdge({ used: 0 });
  const staged = stage('some bytes to account for');
  const entry = await entryFor(staged);
  const r = await commitStagedAsset(db, edge, entry, staged, { contentDir, sniff, workspaceId: wsA, userId });
  const after = db.prepare('SELECT write_bytes_used FROM mesh_edges WHERE id = ?').get(edge.id);
  assert.equal(after.write_bytes_used, r.bytes, 'accounting done separately is accounting that drifts');
});

test('an over-long manifest is refused with a readable reason rather than truncated', () => {
  const edge = mkEdge();
  const content = Array.from({ length: 501 }, () => ({ oid: id(), kind: 'local', sz: 1 }));
  const r = evaluateManifest(db, edge, { content }, { contentDir, workspaceId: wsA });
  assert.equal(r.ok, false);
  assert.match(r.reason, /send it in pages/i, 'silent truncation would report a playlist ready that is not');
});

/*
 * ⚠️ THE BUDGET WAS BYPASSED BY OMITTING ONE FIELD.
 *
 * Every byte limit is computed from the sum of the declared sizes, and the sum was built with
 * `Number(e.sz) || 0`. An entry with no `sz` therefore contributed nothing, a manifest of such
 * entries "needed" zero bytes, and zero passes every budget and every free-space floor ever set.
 * The transfer then arrived at whatever size it liked. A JSON string did the same, and the later
 * per-file size verification was written `if (typeof entry.sz === 'number')`, so the string form
 * skipped that check too — both halves of the defence had the same hole.
 */
test('⚠️ an entry with no usable declared size is refused, not counted as free', () => {
  const edge = mkEdge({ budget: 10 });      // ten bytes of allowance, total
  const bad = [
    { oid: id(), kind: 'local' },                         // omitted entirely
    { oid: id(), kind: 'local', sz: '5000000000' },       // a string
    { oid: id(), kind: 'local', sz: -1 },
    { oid: id(), kind: 'local', sz: NaN },
    { oid: id(), kind: 'local', sz: Infinity },
  ];
  const r = evaluateManifest(db, edge, { content: bad }, { contentDir, workspaceId: wsA });
  assert.equal(r.ok, true);
  assert.equal(r.need.length, 0, 'nothing without a size may be queued for transfer');
  assert.equal(r.cannot.length, bad.length, 'each is reported, so a hub is told which entry is wrong');
  assert.equal(r.bytesNeeded, 0);
});

test('⚠️ a declared size that lies is caught by the disk before anything is committed', async () => {
  const staged = stage('lying');
  const entry = await entryFor(staged);
  entry.sz = entry.sz + 1;                                // one byte off is enough
  const edge = mkEdge({ budget: 1e9 });
  const r = await commitStagedAsset(db, edge, entry, staged, { contentDir, sniff, workspaceId: wsA, userId });
  assert.equal(r.ok, false);
  assert.match(r.reason, /bytes, not the/);
});

/*
 * ⚠️ MIME COMES FROM THE BYTES, NOT FROM THE SENDER.
 *
 * The extension was sniffed and the mime_type was taken from the peer's manifest, which is the
 * worst of both: a hub declaring video/mp4 for bytes that sniff as PNG landed the file as
 * <sha>.png and told the player to build a <video> around it — a black frame for the item's whole
 * duration, on every screen in the playlist, while the static route served image/png.
 */
test('⚠️ the stored mime type is the sniffed one, never the one the peer claimed', async () => {
  const staged = stage('mime');
  const entry = await entryFor(staged);
  entry.mt = 'video/mp4';                                  // the peer's claim
  const edge = mkEdge({ budget: 1e9 });
  const r = await commitStagedAsset(db, edge, entry, staged, {
    contentDir, workspaceId: wsA, userId,
    sniff: () => ({ mime: 'image/png', ext: '.png' }),     // what the bytes actually are
  });
  assert.equal(r.ok, true);
  const row = db.prepare('SELECT mime_type, filepath FROM content WHERE id = ?').get(r.localId);
  assert.equal(row.mime_type, 'image/png', 'the peer does not get to name the type');
  assert.match(row.filepath, /\.png$/);
});

/*
 * ⚠️ ONE ROW PER FILE PER WORKSPACE — the naming scheme created this hazard and must close it.
 *
 * Content-addressed names mean two pushes can resolve to the same file. Minting a fresh row each
 * time put TWO rows on ONE file, and nothing in this codebase refcounted a filepath, so deleting
 * either row unlinked the bytes out from under the other.
 */
test('⚠️ a re-push of identical bytes reuses the row instead of minting a second one', async () => {
  const edge = mkEdge({ budget: 1e9 });
  const bytes = 'identical-bytes-for-both-pushes';

  const first = await commitStagedAsset(db, edge, await entryFor(stage(bytes)), stage(bytes),
    { contentDir, sniff, workspaceId: wsA, userId });
  assert.equal(first.ok, true);

  const secondEntry = await entryFor(stage(bytes));
  secondEntry.oid = id();                                  // a DIFFERENT origin id, same bytes
  const second = await commitStagedAsset(db, edge, secondEntry, stage(bytes),
    { contentDir, sniff, workspaceId: wsA, userId });
  assert.equal(second.ok, true);

  assert.equal(second.localId, first.localId, 'the same file must not gain a second row');
  assert.equal(second.reusedRow, true);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM content WHERE filepath = ? AND workspace_id = ?')
    .get(first.filepath, wsA);
  assert.equal(rows.n, 1);
});

test('⚠️ and the allowance is not charged twice for bytes already stored', async () => {
  const edge = mkEdge({ budget: 1e9 });
  const bytes = 'charged-once-only';
  const e1 = await entryFor(stage(bytes));
  await commitStagedAsset(db, edge, e1, stage(bytes), { contentDir, sniff, workspaceId: wsA, userId });
  const afterFirst = db.prepare('SELECT write_bytes_used AS u FROM mesh_edges WHERE id = ?').get(edge.id).u;

  const e2 = await entryFor(stage(bytes)); e2.oid = id();
  await commitStagedAsset(db, edge, e2, stage(bytes), { contentDir, sniff, workspaceId: wsA, userId });
  const afterSecond = db.prepare('SELECT write_bytes_used AS u FROM mesh_edges WHERE id = ?').get(edge.id).u;

  assert.equal(afterSecond, afterFirst, 'storage the operator already paid for is not billed again');
});

/*
 * ⚠️ DEDUP BY DIGEST IS SCOPED TO A WORKSPACE. The lookup had no workspace predicate, so the first
 * time two customers on one server happened to hold the same stock clip, one customer's playlist
 * would start pointing at the other's asset — and deleting it from one library would empty a
 * screen in the other. The schema note beside byte_digest warns about exactly this.
 */
test('⚠️ identical bytes in ANOTHER workspace are not adopted across the tenancy line', async () => {
  const edge = mkEdge({ budget: 1e9 });
  const bytes = 'shared-stock-clip';
  const committed = await commitStagedAsset(db, edge, await entryFor(stage(bytes)), stage(bytes),
    { contentDir, sniff, workspaceId: wsA, userId });
  assert.equal(committed.ok, true);

  const probe = await entryFor(stage(bytes)); probe.oid = id();
  const seenFromB = evaluateManifest(db, mkEdge({ budget: 1e9 }), { content: [probe] },
    { contentDir, workspaceId: wsB });
  assert.equal(seenFromB.need.length, 1, 'workspace B must fetch its own copy');
  assert.equal(seenFromB.have.length, 0, "and must never be pointed at workspace A's row");
});

test('⚠️ a size sent as a STRING is refused at the commit, not silently skipped', async () => {
  /*
   * The second half of the same hole, and the reason the check is `Number.isFinite` rather than
   * `typeof === 'number'`. A JSON string passed the budget upstream (it summed as 0) AND skipped
   * the per-file verification here, because the guard asked about the type instead of the value.
   * Both halves are now value-based, and this asserts the commit stands on its own — it must not
   * rely on evaluateManifest having screened the entry first.
   */
  const staged = stage('string-size');
  const entry = await entryFor(staged);
  entry.sz = String(entry.sz);                 // the exact right number, as a string
  const edge = mkEdge({ budget: 1e9 });
  const r = await commitStagedAsset(db, edge, entry, staged, { contentDir, sniff, workspaceId: wsA, userId });
  assert.equal(r.ok, false, 'a size that is not a number is not a size');
});

/*
 * ⚠️ THE DISK CHECK NEVER RAN.
 *
 * admitTransfer read `deps.freeBytes` and nothing in the tree ever supplied one, so `free` was null
 * on every real call and the check was skipped entirely — the comment beside it described a guard
 * that did not exist. The budget is what the operator agreed to give; free space is what the
 * machine actually has, and on a signage box a full disk takes the screens down with it.
 */
test('⚠️ a transfer larger than the free disk is refused, budget notwithstanding', () => {
  const edge = mkEdge({ budget: 100 * GB });
  const r = admitTransfer(edge, 50 * GB, {
    contentDir,
    freeBytes: () => 2 * GB,             // plenty of allowance, nowhere to put it
    freeFloorBytes: 1 * GB,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not have room/i);
});

test('the floor is kept free rather than filled to the last byte', () => {
  const edge = mkEdge({ budget: 100 * GB });
  // Exactly enough for the file, but it would leave nothing behind — a signage server with a full
  // disk cannot write a log, a snapshot, or the next playlist.
  assert.equal(admitTransfer(edge, 10 * GB, {
    contentDir, freeBytes: () => 10 * GB, freeFloorBytes: 1 * GB,
  }).ok, false);
  assert.equal(admitTransfer(edge, 10 * GB, {
    contentDir, freeBytes: () => 12 * GB, freeFloorBytes: 1 * GB,
  }).ok, true);
});

test('a disk that cannot be measured does not block every transfer', () => {
  // statfs is unavailable on some platforms this runs on. Refusing everything on a box that cannot
  // measure its own disk would break the feature for a diagnostic; the budget still bounds it.
  const edge = mkEdge({ budget: 100 * GB });
  assert.equal(admitTransfer(edge, 1 * GB, { contentDir, freeBytes: () => null }).ok, true);
});

test('⚠️ with no freeBytes supplied it measures the real disk rather than skipping the check', () => {
  /*
   * ⚠️ The budget must be BIGGER than the ask, or the budget refuses first and this test passes
   * while proving nothing about the disk. (It did, on the first attempt.)
   *
   * ⚠️ And it must stay within Number.MAX_SAFE_INTEGER. 1e18 is a valid SQLite integer but not a
   * safe JavaScript one — better-sqlite3 accepted it and node:sqlite threw
   * "Value is too large to be represented as a JavaScript number", so this passed locally and
   * failed the Node 24 fallback-driver job. Both drivers, every time.
   */
  const edge = mkEdge({ budget: 9e15 });     // ~9 PB: larger than the ask, smaller than 2^53
  const r = admitTransfer(edge, 900 * 1024 * GB, { contentDir });
  assert.equal(r.ok, false, 'the default free-space measurement must actually run');
  assert.match(r.reason, /does not have room/i);
});
