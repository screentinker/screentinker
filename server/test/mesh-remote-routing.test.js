'use strict';

/*
 * WHICH SERVER DOES A CLICK LAND ON?
 *
 * frontend/js/api.js decides, for every call, whether it goes to this server, to the customer's
 * server, or nowhere. Getting that wrong is not a rendering bug: before these tests, selecting a
 * customer and pressing "New folder" created a folder on YOUR OWN server, and "Delete folder"
 * deleted one — silently, under a heading that said you were looking at someone else's estate.
 *
 * ⚠️ THESE RUN THE REAL MODULE, NOT A GREP OF IT. The sibling view tests assert on source text and
 * say so in their own caveat; that is the right tool for absence, and the wrong one here. Routing
 * is behaviour — the previous rules READ correctly and still sent writes to the wrong host, because
 * the bug was in the ORDER of two checks, which no amount of source-matching would have caught.
 * So: stub localStorage and fetch, import api.js, and look at the URL that actually gets requested.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const API_PATH = path.join(__dirname, '..', '..', 'frontend', 'js', 'api.js');

/** Load api.js fresh with a controlled localStorage; returns the module plus a call log. */
async function loadApi({ remoteOrg, capture, respond } = {}) {
  const store = new Map([['token', 'test-token']]);
  if (remoteOrg) store.set('st_remote_org', JSON.stringify(remoteOrg));
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const calls = [];
  global.fetch = async (url, opts) => {
    const call = { url, method: (opts && opts.method) || 'GET', body: opts && opts.body };
    calls.push(call);
    if (capture) capture.push(call);
    if (respond) return respond(url, opts || {});
    return { ok: true, status: 200, json: async () => ({ rows: [] }) };
  };
  // Cache-bust so each case gets its own module instance and its own localStorage.
  const mod = await import(`${pathToFileURL(API_PATH).href}?case=${calls.length}-${Math.random()}`);
  return { mod, calls };
}

const CUSTOMER = { nodeId: 'node-customer-1', name: 'Customer A' };

test('with no customer selected, a write goes to this server as it always did', async () => {
  const { mod, calls } = await loadApi();
  await mod.api.createFolder('Promos', null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/folders');
  assert.equal(calls[0].method, 'POST');
});

test('⚠️ creating a folder while viewing a customer no longer creates it HERE', async () => {
  const { mod, calls } = await loadApi({ remoteOrg: CUSTOMER });
  await assert.rejects(() => mod.api.createFolder('Promos', null), /read-only/i);
  assert.equal(calls.length, 0, 'it must not reach the network at all');
});

test('⚠️ deleting a folder while viewing a customer no longer deletes one HERE', async () => {
  const { mod, calls } = await loadApi({ remoteOrg: CUSTOMER });
  await assert.rejects(() => mod.api.deleteFolder('folder-on-my-own-server'), /read-only/i);
  assert.equal(calls.length, 0);
});

test('⚠️ the folder TREE is no longer served from this server under their heading', async () => {
  const { mod, calls } = await loadApi({ remoteOrg: CUSTOMER });
  const rows = await mod.api.getFolders();
  assert.deepEqual(rows, [], 'unrouted reads resolve empty, never from the local server');
  assert.equal(calls.length, 0);
});

test('⚠️ a write to an unavailable path REJECTS instead of reporting success', async () => {
  // The old order returned {empty:true} before looking at the method, so this resolved as []
  // and every caller displayed "Deleted" for something that happened on no server at all.
  const { mod } = await loadApi({ remoteOrg: CUSTOMER });
  await assert.rejects(() => mod.api.deleteContent('c1'), /read-only/i);
  await assert.rejects(() => mod.api.batchDeleteContent(['c1', 'c2']), /read-only/i);
});

test('⚠️ uploads do not land in your own library — the raw XHR is guarded too', async () => {
  const { mod } = await loadApi({ remoteOrg: CUSTOMER });
  await assert.rejects(
    () => mod.api.uploadContent(new (class File {})(), null, null),
    /read-only/i,
  );
});

test('reads that CAN be served remotely still are', async () => {
  const { mod, calls } = await loadApi({ remoteOrg: CUSTOMER });
  await mod.api.getDevices();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^\/api\/mesh\/read\/node-customer-1\?path=/);
  assert.match(decodeURIComponent(calls[0].url), /path=\/api\/devices/);
});

test('session and account routes stay local, including their writes', async () => {
  const { mod, calls } = await loadApi({ remoteOrg: CUSTOMER });
  // Signing out, switching workspace, minting a token: about THIS session, never the customer's.
  await mod.api.post('/auth/switch-workspace', { workspace_id: 'w1' });
  assert.equal(calls[0].url, '/api/auth/switch-workspace');
  assert.equal(calls[0].method, 'POST');
});

test('the mesh routes themselves stay local — otherwise revoking is impossible', async () => {
  // If /mesh were refused while viewing a customer, an operator could never sever the very link
  // they are looking at. This is why ALWAYS_LOCAL exists rather than a bare "refuse everything".
  const { mod, calls } = await loadApi({ remoteOrg: CUSTOMER });
  await mod.api.post('/mesh/uplink/e1/write-grant', { categories: [] });
  assert.equal(calls[0].url, '/api/mesh/uplink/e1/write-grant');
  assert.equal(calls[0].method, 'POST');
});

test('a prefix match cannot be fooled by a longer route name', async () => {
  // '/devices' must not match '/devices-archive'; the original used a bare startsWith.
  const { mod, calls } = await loadApi({ remoteOrg: CUSTOMER });
  const rows = await mod.api.get('/devices-archive');
  assert.deepEqual(rows, [], 'an unlisted lookalike is unavailable, not routed and not local');
  assert.equal(calls.length, 0);
});

/*
 * ⚠️ AND NOW THE OTHER HALF: A COMMAND FOR A REMOTE SYSTEM IS ROUTED REMOTELY.
 *
 * Everything above proves a write does not land on the WRONG server. These prove it lands on the
 * right one — which until now it never did, because POST /api/mesh/write/:nodeId had no caller
 * anywhere in the frontend. The transport, the opId replay machinery and the whole 503/504/403
 * triad were dead code from the UI's point of view.
 */
const WRITABLE_CUSTOMER = { nodeId: 'node-customer-1', name: 'Customer A', writable: true };

test('⚠️ editing a customer playlist goes to THEIR server, not ours', async () => {
  const { mod, calls } = await loadApi({ remoteOrg: WRITABLE_CUSTOMER });
  await mod.api.put('/playlists/p1', { name: 'Autumn' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/mesh/write/node-customer-1');
  assert.equal(calls[0].method, 'POST', 'the envelope is a POST; the CHANGE is the PUT inside it');
});

test('the change carries the real path and method for the child to check', async () => {
  const store = [];
  const { mod } = await loadApi({ remoteOrg: WRITABLE_CUSTOMER, capture: store });
  await mod.api.post('/playlists/p1/items', { content_id: 'c1' });

  const sent = JSON.parse(store[0].body);
  assert.equal(sent.path, '/api/playlists/p1/items');
  assert.equal(sent.method, 'POST');
  assert.deepEqual(sent.body, { content_id: 'c1' });
});

test('⚠️ a customer who granted nothing is still read-only', async () => {
  // writable comes from what the CHILD announced. Absent or false means refuse, which is the safe
  // way for this to be wrong — a hub must never decide for itself that it may write.
  const { mod, calls } = await loadApi({ remoteOrg: { ...WRITABLE_CUSTOMER, writable: false } });
  await assert.rejects(() => mod.api.put('/playlists/p1', { name: 'x' }), /read-only/i);
  assert.equal(calls.length, 0);
});

test('⚠️ a path outside the child allowlist is not sent, even when writable', async () => {
  // Not enforcement — the child re-checks and wins — but there is no point sending a request that
  // is certain to be refused, and /content is not something the mesh write channel carries.
  const { mod, calls } = await loadApi({ remoteOrg: WRITABLE_CUSTOMER });
  await assert.rejects(() => mod.api.delete('/content/c1'), /read-only/i);
  await assert.rejects(() => mod.api.post('/folders', { name: 'x' }), /read-only/i);
  assert.equal(calls.length, 0);
});

test('⚠️ the method is pinned per rule, exactly as the child pins it', async () => {
  const { mod, calls } = await loadApi({ remoteOrg: WRITABLE_CUSTOMER });
  // DELETE on an ITEM is allowlisted; DELETE on the whole playlist is not.
  await mod.api.delete('/playlists/p1/items/i1');
  assert.equal(calls.length, 1);
  await assert.rejects(() => mod.api.delete('/playlists/p1'), /read-only/i);
  assert.equal(calls.length, 1, 'the refused one must not reach the network');
});

test('⚠️ a 504 retries ONCE with the SAME opId, never a fresh one', async () => {
  /*
   * The child records an outcome against the op id and REPLAYS it rather than applying twice. So
   * re-issuing with a fresh id after a timeout is exactly how an operator ends up with the same
   * item in a playlist twice — the failure the whole idempotency ledger exists to prevent.
   */
  const seen = [];
  const { mod } = await loadApi({
    remoteOrg: WRITABLE_CUSTOMER,
    respond: (url, opts) => {
      const body = JSON.parse(opts.body);
      seen.push(body.opId);
      if (seen.length === 1) {
        return { ok: false, status: 504,
                 json: async () => ({ error: 'no ack', opId: 'op-from-server', retryWithSameOpId: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 'p1' } }) };
    },
  });

  const r = await mod.api.put('/playlists/p1', { name: 'Autumn' });
  assert.equal(seen.length, 2, 'exactly one retry');
  assert.equal(seen[0], undefined, 'the first attempt lets the server mint the id');
  assert.equal(seen[1], 'op-from-server', 'the retry reuses the id the server gave back');
  assert.deepEqual(r, { id: 'p1' });
});

test('a refusal is reported with the customer\'s own words, not a generic failure', async () => {
  const { mod } = await loadApi({
    remoteOrg: WRITABLE_CUSTOMER,
    respond: () => ({ ok: false, status: 403,
                      json: async () => ({ error: 'That is not something this connection may change.' }) }),
  });
  await assert.rejects(() => mod.api.put('/playlists/p1', { name: 'x' }),
    /not something this connection may change/);
});

test('an unacknowledged write is distinguishable from a refused one', async () => {
  // "It failed" and "it may have applied" are different things to tell somebody standing in front
  // of a screen, so the flag survives to the caller.
  const { mod } = await loadApi({
    remoteOrg: WRITABLE_CUSTOMER,
    respond: () => ({ ok: false, status: 504, json: async () => ({ error: 'no ack' }) }),
  });
  await mod.api.put('/playlists/p1', { name: 'x' }).then(
    () => assert.fail('should reject'),
    (e) => { assert.equal(e.status, 504); assert.equal(e.indeterminate, true); },
  );
});
