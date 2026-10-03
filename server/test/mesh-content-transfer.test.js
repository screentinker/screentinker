'use strict';

/*
 * THE BYTES ACTUALLY MOVING — end to end, over real HTTP, including the link dropping mid-file.
 *
 * ⚠️ THIS IS THE TEST THE REST OF THE CONTENT WORK DID NOT HAVE. Everything above this layer was
 * covered by unit tests with stubbed collaborators, and that is exactly the shape that has hidden
 * every serious bug in this feature: an unawaited promise, a followed redirect, a principal with no
 * membership, a stub simpler than the thing it stood for. So this runs a real server, serves real
 * files with real Range handling, kills the connection halfway, and looks at what ended up on disk.
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-xfer-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { downloadResumable } = require('../lib/mesh/pull-download');
const { receiveContentOffer, sweepStagedParts } = require('../lib/mesh/content-receive');
const { digestFile } = require('../lib/content-digest');

const id = () => crypto.randomUUID();
const GB = 1024 ** 3;

let server, origin, contentDir, wsA, userId, edge;
let serve;                       // per-test handler: (req, res) => void

before(async () => {
  userId = id(); const org = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(userId, `x-${userId}@e.com`, 'X', 'x');
  db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(org, 'Org', userId);
  wsA = id();
  db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(wsA, org, 'A');
  contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfer-files-'));

  server = http.createServer((req, res) => serve(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;

  edge = id();
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories,
              transport_direction, tls_verify, created_at, peer_url, write_grant, write_scope,
              write_bytes_budget, write_bytes_used)
              VALUES (?,?,'up','[]','["health"]','we-dial',1,strftime('%s','now'),?,?,?,?,0)`)
    .run(edge, 'parent-1', origin, JSON.stringify(['content-push']), JSON.stringify([wsA]), 20 * GB);
});

after(() => new Promise((r) => server.close(r)));

const theEdge = () => db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge);

/** A file server that honours Range, so resuming means what it means in production. */
function fileServer(body, { breakAfter = null } = {}) {
  return (req, res) => {
    const range = /^bytes=(\d+)-/.exec(req.headers.range || '');
    const from = range ? Number(range[1]) : 0;
    const slice = body.subarray(from);
    res.writeHead(from > 0 ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(slice.length),
      ETag: '"v1"',
    });
    if (breakAfter !== null && slice.length > breakAfter) {
      // Write a prefix, then hang up — the shape of a link dropping mid-file. Destroyed on a later
      // tick so the prefix genuinely reaches the client; same tick means it never leaves the buffer.
      res.write(slice.subarray(0, breakAfter));
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    res.end(slice);
  };
}

test('a whole file arrives, byte for byte', async () => {
  const body = crypto.randomBytes(64 * 1024);
  serve = fileServer(body);
  const staged = path.join(contentDir, `mesh-${id()}.part`);

  const r = await downloadResumable({ url: `${origin}/f`, stagedPath: staged, expectedBytes: body.length });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(fs.readFileSync(staged), body);
});

test('⚠️ a link that drops halfway RESUMES rather than starting again', async () => {
  /*
   * ⚠️ THIS COUNTS BYTES ON THE WIRE, and the first version did not — it asserted only that the
   * file was correct afterwards, which is equally true of restarting from zero every time. That is
   * the entire point of the feature: on the links this runs over (a shop on 4G, a coach with a
   * rooftop modem) a large file that restarts on every drop never completes at all, while the
   * bytes arriving are identical either way. A mutation removing Range entirely survived that test.
   */
  const body = crypto.randomBytes(200 * 1024);
  let served = 0;
  let bytesServed = 0;
  const ranges = [];

  serve = (req, res) => {
    served += 1;
    ranges.push(req.headers.range || null);
    const m = /^bytes=(\d+)-/.exec(req.headers.range || '');
    const from = m ? Number(m[1]) : 0;
    const slice = body.subarray(from);
    res.writeHead(from > 0 ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(slice.length),
      ETag: '"v1"',
    });
    if (served === 1) {
      bytesServed += 50 * 1024;
      res.write(slice.subarray(0, 50 * 1024));
      /*
       * ⚠️ Destroyed on a later tick, because destroying in the SAME tick as the write means the
       * bytes never leave the socket buffer — the client then sees zero of them and this stops
       * being a test of resuming at all. A real link drop does not un-send what already arrived.
       */
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    bytesServed += slice.length;
    res.end(slice);
  };

  const staged = path.join(contentDir, `mesh-${id()}.part`);
  const r = await downloadResumable({
    url: `${origin}/f`, stagedPath: staged, expectedBytes: body.length, sleep: async () => {},
  });

  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(fs.readFileSync(staged), body, 'the two halves must reassemble exactly');
  assert.equal(served, 2);
  assert.match(ranges[1] || '', /^bytes=\d+-/, 'the second attempt must ASK for a range');
  assert.ok(bytesServed < body.length * 1.2,
    `restarting from zero would have moved ~${body.length * 2} bytes; this moved ${bytesServed}`);
});

test('⚠️ resuming carries If-Range, so two different files cannot be stitched together', async () => {
  /*
   * A byte offset alone assumes the file did not change between attempts. If it did, the halves
   * come from different files and the result can have a plausible length and be garbage. The
   * validator is what makes resuming safe, so its ABSENCE is the thing worth asserting.
   */
  const body = crypto.randomBytes(80 * 1024);
  let served = 0;
  const ifRanges = [];
  serve = (req, res) => {
    served += 1;
    ifRanges.push(req.headers['if-range'] || null);
    const m = /^bytes=(\d+)-/.exec(req.headers.range || '');
    const from = m ? Number(m[1]) : 0;
    const slice = body.subarray(from);
    res.writeHead(from > 0 ? 206 : 200, { 'Content-Length': String(slice.length), ETag: '"v1"' });
    // Same reason as above: let the bytes reach the client before the connection dies.
    if (served === 1) { res.write(slice.subarray(0, 20 * 1024)); setTimeout(() => res.socket.destroy(), 20); return; }
    res.end(slice);
  };

  const staged = path.join(contentDir, `mesh-${id()}.part`);
  const r = await downloadResumable({
    url: `${origin}/f`, stagedPath: staged, expectedBytes: body.length, sleep: async () => {},
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(ifRanges[0], null, 'nothing to validate against on the first attempt');
  assert.equal(ifRanges[1], '"v1"',
    'the resume must name the representation it is continuing, or the server cannot refuse it');
});

test('⚠️ a server that ignores Range is handled by TRUNCATING, not appending', async () => {
  /*
   * A 200 in answer to a Range request means "here is the whole thing again". Appending that to a
   * partial file is precisely how two halves of different files get stitched into something with a
   * plausible length — so the partial is discarded first.
   */
  const body = crypto.randomBytes(120 * 1024);
  let served = 0;
  serve = (req, res) => {
    served += 1;
    if (served === 1) return fileServer(body, { breakAfter: 40 * 1024 })(req, res);
    // Ignores Range entirely: always 200, always the whole body.
    res.writeHead(200, { 'Content-Length': String(body.length) });
    res.end(body);
  };

  const staged = path.join(contentDir, `mesh-${id()}.part`);
  const r = await downloadResumable({
    url: `${origin}/f`, stagedPath: staged, expectedBytes: body.length, sleep: async () => {},
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(fs.statSync(staged).size, body.length, 'never longer than the file itself');
  assert.deepEqual(fs.readFileSync(staged), body);
  /*
   * ⚠️ AND IT COST EXACTLY TWO ATTEMPTS. Appending the 200 body to the partial instead would still
   * arrive at the right file — the oversize check further up catches it and starts clean — but only
   * after a THIRD round trip, re-sending the whole file over a link that just proved it drops. The
   * byte count is the difference between "correct" and "correct without punishing a bad link", so
   * it is asserted rather than left to the outer guard.
   */
  assert.equal(served, 2, 'truncating on a 200 must not cost an extra full transfer');
});

test('⚠️ a stale .part LARGER than the file is discarded rather than reconciled', async () => {
  const body = crypto.randomBytes(30 * 1024);
  serve = fileServer(body);
  const staged = path.join(contentDir, `mesh-${id()}.part`);
  fs.writeFileSync(staged, crypto.randomBytes(90 * 1024));   // left by a different asset

  const r = await downloadResumable({ url: `${origin}/f`, stagedPath: staged, expectedBytes: body.length, sleep: async () => {} });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(fs.readFileSync(staged), body);
});

test('a file that is gone is reported as gone, not retried forever', async () => {
  serve = (req, res) => { res.writeHead(404); res.end(); };
  const staged = path.join(contentDir, `mesh-${id()}.part`);
  const r = await downloadResumable({ url: `${origin}/f`, stagedPath: staged, expectedBytes: 10, sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no longer available/i);
});

/* ============ the whole path: offer -> evaluate -> admit -> transfer -> commit ============ */

test('⚠️ a push lands: verified, named by digest, charged to the allowance', async () => {
  const body = Buffer.from('a real asset, pushed from a hub');
  serve = fileServer(body);
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const oid = 'origin-content-1';

  const r = await receiveContentOffer(db, theEdge(), {
    workspaceId: wsA,
    manifest: { content: [{ oid, kind: 'local', sz: body.length, dg: digest, fn: 'Clip.mp4', mt: 'video/mp4' }] },
    tickets: { [oid]: 'ticket-secret' },
  }, {
    contentDir, userId,
    sniff: () => ({ mime: 'video/mp4', ext: '.mp4' }),
  });

  assert.equal(r.ok, true, r.reason || JSON.stringify(r.failed));
  assert.equal(r.stored.length, 1);

  const row = db.prepare('SELECT * FROM content WHERE id = ?').get(r.stored[0].localId);
  assert.equal(row.workspace_id, wsA);
  assert.equal(row.byte_digest, digest);
  assert.equal(row.filepath, `${digest}.mp4`, 'stored under its own digest');
  assert.equal(await digestFile(path.join(contentDir, row.filepath)), digest, 'and the bytes are right');

  const used = db.prepare('SELECT write_bytes_used AS u FROM mesh_edges WHERE id = ?').get(edge).u;
  assert.equal(used, body.length);

  // Provenance is what makes a later playlist write resolvable.
  const prov = db.prepare(`SELECT local_content_id FROM mesh_content_provenance
                            WHERE origin_node_id = ? AND origin_content_id = ?`).get('parent-1', oid);
  assert.equal(prov.local_content_id, r.stored[0].localId);
});

test('⚠️ the SAME push again transfers nothing', async () => {
  const body = Buffer.from('a real asset, pushed from a hub');   // identical to the test above
  let requests = 0;
  serve = (req, res) => { requests += 1; fileServer(body)(req, res); };
  const digest = crypto.createHash('sha256').update(body).digest('hex');

  const r = await receiveContentOffer(db, theEdge(), {
    workspaceId: wsA,
    manifest: { content: [{ oid: 'origin-content-1', kind: 'local', sz: body.length, dg: digest, fn: 'Clip.mp4', mt: 'video/mp4' }] },
    tickets: { 'origin-content-1': 'ticket-secret' },
  }, { contentDir, userId, sniff: () => ({ mime: 'video/mp4', ext: '.mp4' }) });

  assert.equal(r.ok, true, r.reason);
  assert.equal(requests, 0, 'an unchanged re-push must not move a single byte');
  assert.equal(r.stored.length, 0);
  assert.equal(r.alreadyHeld.length, 1);
});

test('⚠️ bytes that do not match their digest are REFUSED and leave nothing behind', async () => {
  const claimed = crypto.randomBytes(1024);
  const actual = crypto.randomBytes(1024);          // the server sends something else entirely
  serve = fileServer(actual);
  const before = fs.readdirSync(contentDir).length;

  const r = await receiveContentOffer(db, theEdge(), {
    workspaceId: wsA,
    manifest: { content: [{
      oid: 'origin-content-bad', kind: 'local', sz: actual.length,
      dg: crypto.createHash('sha256').update(claimed).digest('hex'), fn: 'Bad.mp4', mt: 'video/mp4',
    }] },
    tickets: { 'origin-content-bad': 't' },
  }, { contentDir, userId, sniff: () => ({ mime: 'video/mp4', ext: '.mp4' }) });

  assert.equal(r.ok, false);
  assert.match(r.failed[0].reason, /checksum/i);
  assert.equal(fs.readdirSync(contentDir).length, before, 'no staged file may survive a refusal');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content WHERE filename = 'Bad.mp4'").get().n, 0);
});

test('⚠️ a push to a workspace outside the grant is refused before anything is fetched', async () => {
  let requests = 0;
  serve = (req, res) => { requests += 1; res.writeHead(200); res.end(); };
  const other = id();
  db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`)
    .run(other, db.prepare('SELECT organization_id AS o FROM workspaces WHERE id = ?').get(wsA).o, 'B');

  const r = await receiveContentOffer(db, theEdge(), {
    workspaceId: other,
    manifest: { content: [{ oid: 'x', kind: 'local', sz: 10, fn: 'a.mp4', mt: 'video/mp4' }] },
    tickets: { x: 't' },
  }, { contentDir, userId, sniff: () => ({ mime: 'video/mp4', ext: '.mp4' }) });

  assert.equal(r.ok, false);
  assert.equal(requests, 0, 'the grant is checked before a byte is requested');
});

test('⚠️ a transfer over the allowance is refused BEFORE any bytes move', async () => {
  let requests = 0;
  serve = (req, res) => { requests += 1; res.writeHead(200); res.end(); };
  db.prepare('UPDATE mesh_edges SET write_bytes_budget = 100, write_bytes_used = 90 WHERE id = ?').run(edge);

  const r = await receiveContentOffer(db, theEdge(), {
    workspaceId: wsA,
    manifest: { content: [{ oid: 'big', kind: 'local', sz: 5000, fn: 'big.mp4', mt: 'video/mp4' }] },
    tickets: { big: 't' },
  }, { contentDir, userId, sniff: () => ({ mime: 'video/mp4', ext: '.mp4' }) });

  assert.equal(r.ok, false);
  assert.match(r.reason, /allowance is left|does not have room/i);
  assert.equal(requests, 0, 'a transfer that discovers the limit halfway has already spent the disk');
  db.prepare('UPDATE mesh_edges SET write_bytes_budget = ?, write_bytes_used = 0 WHERE id = ?').run(20 * GB, edge);
});

test('stale staged files are swept; fresh ones and other files are left alone', () => {
  const stale = path.join(contentDir, `mesh-${id()}.part`);
  const fresh = path.join(contentDir, `mesh-${id()}.part`);
  const foreign = path.join(contentDir, `${id()}.part`);      // an ordinary upload in flight
  for (const p of [stale, fresh, foreign]) fs.writeFileSync(p, 'x');
  const old = Date.now() - 48 * 3600 * 1000;
  fs.utimesSync(stale, old / 1000, old / 1000);

  const r = sweepStagedParts(contentDir);
  assert.equal(r.removed, 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true, 'a slow transfer is not an abandoned one');
  assert.equal(fs.existsSync(foreign), true, 'an ordinary upload is not ours to delete');
});
