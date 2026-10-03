'use strict';

// Two things made a working upload look like a broken one, and they had to change together.
//
// 1. THE BAR ONLY MOVES ONCE PER CHUNK. The client can only report what the server has confirmed,
//    so nothing moves between chunk boundaries. At 5 MiB on a 2 Mbps link that is one movement
//    every twenty seconds: an operator uploading a 47 MB file watched 0% while 10 MB had already
//    landed and reported it as stuck. It happened twice, and once caused a rollback to 2.1.0.
//
// 2. 5 MiB DID NOT FIT THE WORST LINK. Against the 125s proxy ceiling this feature exists for, a
//    5 MiB chunk on a 0.3 Mbps uplink needs ~133s — it could never complete a single chunk, so the
//    upload could not progress at all.
//
// Shrinking the chunk alone would have traded a slow-link failure for a fast-link one, because
// chunk PATCHes are rate limited and a large file now sends many more of them per minute. So the
// session endpoints get their own budget, and their bucket is made canonical: the session id is a
// caller-chosen path segment, and while it was in the key every session minted a fresh bucket.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-chunksz-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const uploadSession = require('../lib/upload-session');

const MiB = 1024 * 1024;
const PROXY_CEILING_SEC = 125;
const secondsFor = (bytes, mbps) => (bytes * 8) / (mbps * 1_000_000);

test('a chunk fits the worst link this feature exists for', () => {
  // 0.3 Mbps is the case the old 5 MiB size could not serve at all (~133s > 125s).
  const worst = secondsFor(uploadSession.CHUNK_SIZE, 0.3);
  assert.ok(worst < PROXY_CEILING_SEC / 2,
    `a chunk takes ${worst.toFixed(0)}s on a 0.3 Mbps link; it must keep a wide margin under ${PROXY_CEILING_SEC}s`);
});

test('the bar moves often enough to look alive on a slow link', () => {
  // The whole point of the change: progress is emitted once per chunk, so chunk duration IS the
  // refresh interval the operator sees.
  const perChunk = secondsFor(uploadSession.CHUNK_SIZE, 2);
  assert.ok(perChunk <= 5,
    `progress would move only every ${perChunk.toFixed(0)}s on a 2 Mbps link, which reads as stuck`);
});

test('the accepted body cap is NOT derived from the chunk size', () => {
  /*
   * A browser caches the dashboard bundle. If the cap tracked CHUNK_SIZE, shrinking the chunk
   * would 413 every tab still sending the old size the moment the server restarted. The cap must
   * stay above any size previously shipped (5 MiB).
   */
  assert.ok(uploadSession.MAX_CHUNK_BYTES >= 5 * MiB,
    'a stale client still sending 5 MiB chunks must not be refused');
  assert.ok(uploadSession.MAX_CHUNK_BYTES > uploadSession.CHUNK_SIZE,
    'the cap is a memory bound on one request, not the chunk size');
});

test('a big file on a fast link stays inside the session rate budget', () => {
  // 500 MB is an ordinary video. On a fast uplink its chunks all arrive inside one minute, so the
  // per-minute budget for session traffic has to cover them.
  const chunks = Math.ceil((500 * MiB) / uploadSession.CHUNK_SIZE);
  const SESSION_BUDGET_PER_MIN = 1200;   // server.js uploadSessionLimiter
  const GENERAL_BUDGET_PER_MIN = 30;     // server.js contentLimiter
  assert.ok(chunks > GENERAL_BUDGET_PER_MIN,
    'if this ever stops being true the dedicated budget is no longer load-bearing and can go');
  assert.ok(chunks <= SESSION_BUDGET_PER_MIN,
    `${chunks} chunks would exceed the ${SESSION_BUDGET_PER_MIN}/min session budget`);
});

test('the client fallback chunk size agrees with the server', () => {
  // The server dictates chunk_size; the client constant is only a fallback. A fallback that
  // disagreed would produce chunks the server answers with a 409 on every single request.
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'lib', 'chunked-upload.js'), 'utf8');
  const m = src.match(/session\.chunk_size\s*\|\|\s*([^;]+);/);
  assert.ok(m, 'the fallback must still be there to check');
  // eslint-disable-next-line no-eval
  assert.equal(eval(m[1]), uploadSession.CHUNK_SIZE, 'client fallback drifted from server CHUNK_SIZE');
});

/*
 * The limiter keys on IP + canonicalLimitPath(path). The upload session id is a caller-chosen
 * segment, so while it stayed in the key every session minted a fresh bucket — the same defect
 * lib/limit-paths warns about for the login routes, one mount over. These pin the buckets the
 * dedicated upload budget depends on.
 */
const { canonicalLimitPath } = require('../lib/limit-paths');

test('every upload session shares ONE bucket, not one per session id', () => {
  const a = canonicalLimitPath('/api/content/uploads/' + crypto.randomUUID());
  const b = canonicalLimitPath('/api/content/uploads/' + crypto.randomUUID());
  assert.equal(a, b, 'a caller-chosen id in the key makes the limit decorative');
  assert.equal(a, '/api/content/uploads/:id');
  assert.ok(!a.includes('uuid') && !/[0-9a-f]{8}-/.test(a), 'no id may survive into the bucket name');
});

test('session creation has its own bucket, apart from chunk traffic', () => {
  // Creation is what allocates disk and keeps the tight budget; chunk traffic gets the loose one.
  // Sharing a bucket would apply whichever limit ran first to both.
  const create = canonicalLimitPath('/api/content/uploads');
  assert.equal(create, '/api/content/uploads');
  assert.notEqual(create, canonicalLimitPath('/api/content/uploads/' + crypto.randomUUID()));
  assert.notEqual(create, canonicalLimitPath('/api/content/some-content-id'),
    'and it no longer shares the generic /api/content/:id bucket');
});

test('finalize is not counted as chunk traffic', () => {
  assert.equal(canonicalLimitPath('/api/content/uploads/x/finalize'), '/api/content/uploads/:id/finalize');
});

test('bucket naming still ignores spelling', () => {
  // Trailing slash / doubled separator / case were all a fresh bucket before normalisation.
  const canon = '/api/content/uploads/:id';
  assert.equal(canonicalLimitPath('/api/content/uploads/ABC/'), canon);
  assert.equal(canonicalLimitPath('//api//content//uploads//ABC'), canon);
});
