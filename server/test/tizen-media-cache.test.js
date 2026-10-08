'use strict';

// Tizen was the one player that cached nothing but the playlist: a panel came back from a reboot
// knowing exactly what to show and fetched every frame of it from a server that was not there.
// tizen/js/media-cache.js fixes that, and none of it can be exercised on hardware without a TV — so
// the decisions are all in injected-backend form and driven here against a fake one.
//
// The backend (resolve wgt-private, append to a stream, turn a file into a URI) is the only part
// that needs a device, and it is the part with no logic in it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MediaCache = require(path.join(__dirname, '..', '..', 'tizen', 'js', 'media-cache.js'));
const CHUNK = MediaCache.CHUNK_BYTES;

/**
 * A fake TV. `failEvery` drops every Nth request — a marginal link, which is the condition the
 * whole resumable design exists for.
 */
function fakeBackend(asset, opts = {}) {
  const b = {
    asset,                      // { bytes: number[], etag, total }
    files: new Map(),           // name -> number[]
    index: {},
    requests: 0,
    failEvery: opts.failEvery || 0,
    rangeSupport: opts.rangeSupport !== false,
    available: () => true,
    loadIndex: () => b.index,
    saveIndex: (i) => { b.index = JSON.parse(JSON.stringify(i)); },
    httpRange(url, start, end, validator) {
      b.requests++;
      if (b.failEvery && b.requests % b.failEvery === 0) throw new Error('link dropped');
      const body = b.asset.bytes;
      if (!b.rangeSupport) {
        return { status: 200, start: 0, total: body.length, validator: b.asset.etag, body: body.slice() };
      }
      // If-Range with a stale validator: the server sends the WHOLE asset, which is the signal to
      // start over rather than append a tail from a different file.
      if (validator && validator !== b.asset.etag) {
        return { status: 200, start: 0, total: body.length, validator: b.asset.etag, body: body.slice() };
      }
      if (start >= body.length) return { status: 416, start, total: body.length, validator: b.asset.etag, body: null };
      const stop = Math.min(end, body.length - 1);
      return {
        status: 206, start, total: body.length, validator: b.asset.etag,
        body: body.slice(start, stop + 1)
      };
    },
    appendPart(contentId, body, offset) {
      const name = contentId + '.part';
      const cur = b.files.get(name) || [];
      if (offset === 0) b.files.set(name, body.slice());
      else {
        if (cur.length !== offset) return 0;   // a real append cannot write into a hole
        b.files.set(name, cur.concat(body));
      }
      return body.length;
    },
    promotePart(contentId) {
      const part = b.files.get(contentId + '.part');
      if (!part) return null;
      b.files.set(contentId, part);
      b.files.delete(contentId + '.part');
      return { path: '/wgt-private/' + contentId, uri: 'file:///wgt-private/' + contentId };
    },
    remove(contentId) { b.files.delete(contentId); b.files.delete(contentId + '.part'); }
  };
  return b;
}

const asset = (n, fill, etag = '"v1"') => ({ bytes: new Array(n).fill(fill), etag });
const urlFor = (it) => 'http://s/api/content/' + it.content_id + '/file?rev=' + it.content_rev;

test('THE GAP: media is cached at all, and resolves to a local file the player can open', async () => {
  const b = fakeBackend(asset(CHUNK, 7));
  const mc = new MediaCache(b);

  assert.equal(mc.localUrl('c1', 5), null, 'nothing cached yet');
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  assert.equal(mc.localUrl('c1', 5), 'file:///wgt-private/c1');
  assert.deepEqual(b.files.get('c1'), new Array(CHUNK).fill(7));
});

test('a link that drops every other request still completes the asset', async () => {
  // Without accumulation this never finishes: each attempt restarts from zero, so an asset larger
  // than one uninterrupted transfer is never cached and the panel has nothing to fall back on.
  const b = fakeBackend(asset(CHUNK * 4, 3), { failEvery: 2 });
  const mc = new MediaCache(b);
  const items = [{ content_id: 'c1', content_rev: 5 }];

  for (let pass = 0; pass < 30 && !mc.localUrl('c1', 5); pass++) await mc.sync(items, urlFor);

  assert.ok(mc.localUrl('c1', 5), 'the asset must eventually be cached');
  assert.equal(b.files.get('c1').length, CHUNK * 4);
});

test('a partial is never promoted — an incomplete file is not offered to the player', async () => {
  const b = fakeBackend(asset(CHUNK * 3, 9), { failEvery: 1 });   // every request fails
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  assert.equal(mc.localUrl('c1', 5), null);
  assert.equal(b.files.get('c1'), undefined, 'no whole file exists');
});

test('progress accumulates across passes rather than restarting', async () => {
  const b = fakeBackend(asset(CHUNK * 3, 4));
  const mc = new MediaCache(b);
  // One step at a time, so the resume offset is observable.
  assert.equal(await mc.fetchStep('c1', 5, 'http://s/x'), 'progress');
  assert.equal(mc.index.c1.bytes, CHUNK);
  assert.equal(await mc.fetchStep('c1', 5, 'http://s/x'), 'progress');
  assert.equal(mc.index.c1.bytes, CHUNK * 2, 'the second attempt appended, it did not restart');
  assert.equal(await mc.fetchStep('c1', 5, 'http://s/x'), 'done');
});

test('THE UPDATE HALF: a replaced asset is a miss, and the old bytes are deleted', async () => {
  // The trap that offline caching creates. Same content id, same URL path, different bytes — a
  // cache that cannot tell would keep playing last month's video forever.
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  assert.ok(mc.localUrl('c1', 5));

  b.asset = asset(CHUNK, 2, '"v2"');
  assert.equal(mc.localUrl('c1', 6), null, 'a new revision must not match the cached copy');

  await mc.sync([{ content_id: 'c1', content_rev: 6 }], urlFor);
  assert.ok(mc.localUrl('c1', 6), 'the new revision is cached');
  assert.deepEqual(b.files.get('c1'), new Array(CHUNK).fill(2), 'and it is the NEW bytes');
});

test('an asset replaced MID-transfer is discarded, not spliced', async () => {
  // Appending the tail of the new asset to the head of the old one produces a file of exactly the
  // right length that is wrong throughout — it would pass every completeness check there is.
  const b = fakeBackend(asset(CHUNK * 4, 0x61));
  const mc = new MediaCache(b);
  assert.equal(await mc.fetchStep('c1', 5, 'http://s/x'), 'progress');
  assert.equal(mc.index.c1.bytes, CHUNK);

  b.asset = asset(CHUNK * 4, 0x62, '"v2"');           // replaced underneath us, same revision claim
  assert.equal(await mc.fetchStep('c1', 5, 'http://s/x'), 'done', 'a 200 carries the whole new asset');

  const cached = b.files.get('c1');
  assert.equal(cached.length, CHUNK * 4);
  assert.ok(cached.every((v) => v === 0x62), 'not one byte of the superseded asset may survive');
});

test('items dropped from the playlist have their bytes deleted', async () => {
  // Otherwise the cache only grows, and the failure eventually lands as a write error on whatever
  // happens to be downloading at the time.
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  assert.ok(b.files.get('c1'));

  await mc.sync([{ content_id: 'c2', content_rev: 1 }], urlFor);
  assert.equal(b.files.get('c1'), undefined, 'an unreferenced asset must not linger');
  assert.equal(mc.index.c1, undefined);
});

test('THE EMPTY PAYLOAD: a playlist update with no media never wipes the cache', async () => {
  // assignments: [] also arrives when a published snapshot fails to parse on the server, which is
  // the same message as "this screen needs nothing". Pruning on it emptied the panel's cache.
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  assert.ok(b.files.get('c1'));

  await mc.sync([], urlFor);
  await mc.sync(null, urlFor);
  await mc.sync([{ widget_id: 'w1' }], urlFor);     // widgets only: still no media referenced
  assert.ok(b.files.get('c1'), 'the cached asset must survive an update that references no media');
  assert.ok(mc.index.c1);
});

test('...but an explicit prune([]) (a delete from the dashboard) still empties it', async () => {
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  mc.prune([]);
  assert.equal(b.files.get('c1'), undefined);
  assert.equal(mc.index.c1, undefined);
});

test('a cached asset costs no requests on later sweeps', async () => {
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  const items = [{ content_id: 'c1', content_rev: 5 }];
  await mc.sync(items, urlFor);
  const after = b.requests;
  await mc.sync(items, urlFor);
  await mc.sync(items, urlFor);
  assert.equal(b.requests, after, 'a cached asset must not be re-fetched every 60s');
});

test('remote-url items are never downloaded', async () => {
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1', content_rev: 5, remote_url: 'https://example.com/live' }], urlFor);
  assert.equal(b.requests, 0);
});

test('a server with no range support still caches the asset whole', async () => {
  const b = fakeBackend(asset(CHUNK * 2, 6), { rangeSupport: false });
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  assert.ok(mc.localUrl('c1', 5));
  assert.equal(b.files.get('c1').length, CHUNK * 2);
});

test('a 416 discards a partial that is longer than the asset', async () => {
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  // Pretend a previous life left a longer partial behind.
  mc.index.c1 = { rev: 5, bytes: CHUNK * 9, total: CHUNK * 9, validator: '"v1"', complete: false };
  b.files.set('c1.part', new Array(CHUNK * 9).fill(0));
  assert.equal(await mc.fetchStep('c1', 5, 'http://s/x'), 'restart');
  assert.equal(b.files.get('c1.part'), undefined, 'the stale partial must be gone');
});

test('the index survives a restart — progress is not lost with the process', async () => {
  // A signage panel reboots. If the index lived only in memory, every reboot during a slow
  // download would throw the transfer away, which on a bad link means it never finishes.
  const b = fakeBackend(asset(CHUNK * 3, 8));
  const first = new MediaCache(b);
  assert.equal(await first.fetchStep('c1', 5, 'http://s/x'), 'progress');

  const reborn = new MediaCache(b);              // same backend = same persisted index + files
  assert.equal(reborn.index.c1.bytes, CHUNK, 'the resume offset survived');
  assert.equal(await reborn.fetchStep('c1', 5, 'http://s/x'), 'progress');
  assert.equal(reborn.index.c1.bytes, CHUNK * 2);
});

test('an item with no revision still caches, and matches a copy stored without one', async () => {
  // Older servers do not send content_rev. Treating absent-vs-absent as a mismatch would re-download
  // the entire playlist on every sweep.
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1' }], () => 'http://s/x');
  assert.ok(mc.localUrl('c1', undefined));
  const after = b.requests;
  await mc.sync([{ content_id: 'c1' }], () => 'http://s/x');
  assert.equal(b.requests, after);
});

/* ================================================================================================
 * THE ADAPTER ITSELF.
 *
 * Everything above drives the DECISION layer against a fake backend, which is the right way to test
 * decisions — and it is also how the real adapter shipped unable to write a single byte without one
 * assertion noticing. The fake was correct; the platform calls underneath it were not:
 *
 *   - `var dir = tizen.filesystem.resolve(...)` — resolve() is declared `void`. dir was undefined,
 *     available() answered false, and MediaCache.create() returned null on every panel in the
 *     fleet. The offline cache did not exist. It failed CLOSED, which is the only reason this never
 *     showed up as corruption: the capability was correctly withheld and the feature was absent.
 *   - `f.openStream('a', cb)` — asynchronous. `written` was read on the next line, before any
 *     callback could have run, so appendPart returned 0 forever.
 *   - `part.moveTo(destPath, name, ...)` — asynchronous, belongs on the parent DIRECTORY, and takes
 *     (originFullPath, destinationFullPath). Called on a file handle with the arguments transposed:
 *     three documented errors in one call, each of which alone raises IOError.
 *
 * So the adapter is exercised here too, against a fake `tizen.filesystem` written from Samsung's
 * published IDL rather than from our code — including the deprecated calls, modelled with their
 * documented (useless-to-us) semantics, so reaching for them again fails here instead of in a shop.
 * ============================================================================================== */

/** A fake Samsung TV, per developer.samsung.com/smarttv Filesystem API. */
function fakeTizen({ version = 5.0 } = {}) {
  const files = new Map();        // full virtual path -> number[]
  const calls = [];

  function makeFile(p) {
    return {
      fullPath: p,
      isDirectory: false,
      get fileSize() { return (files.get(p) || []).length; },
      toURI: () => 'file:///opt/usr/apps/priv/' + p,
      // "This operation is performed asynchronously."
      openStream(mode, onsuccess) {
        calls.push('openStream');
        const stream = {
          writeBytes(bytes) {
            const cur = files.get(p) || [];
            files.set(p, mode === 'a' ? cur.concat(Array.from(bytes)) : Array.from(bytes));
          },
          close() {},
        };
        if (onsuccess) setTimeout(() => onsuccess(stream), 0);
      },
      // "IOError - If the File in which the moveTo() method is invoked is a file (not a directory)"
      moveTo() { const e = new Error('IOError'); e.name = 'IOError'; throw e; },
    };
  }

  // --- deprecated 1.0 surface, with its REAL semantics ---------------------------------------
  const deprecated = {
    // "void resolve(...)" — the File arrives only via the callback; the return value is undefined.
    resolve(location, onsuccess) {
      calls.push('resolve');
      const dir = {
        isDirectory: true,
        fullPath: location,
        resolve(name) {
          const p = location + '/' + name;
          if (!files.has(p)) { const e = new Error('NotFoundError'); e.name = 'NotFoundError'; throw e; }
          return makeFile(p);
        },
        createFile(name) { const p = location + '/' + name; files.set(p, []); return makeFile(p); },
        deleteFile(p, ok) { files.delete(p); if (ok) setTimeout(ok, 0); },
        moveTo(origin, dest, overwrite, ok) {
          if (!files.has(origin)) { const e = new Error('NotFoundError'); e.name = 'NotFoundError'; throw e; }
          files.set(dest, files.get(origin)); files.delete(origin);
          if (ok) setTimeout(ok, 0);
        },
      };
      if (onsuccess) setTimeout(() => onsuccess(dir), 0);
      return undefined;
    },
  };

  if (version < 5) return { filesystem: deprecated, __files: files, __calls: calls };

  // --- 5.0 synchronous FileSystemManager -----------------------------------------------------
  const modern = Object.assign({}, deprecated, {
    pathExists(p) { return files.has(p); },
    toURI(p) { return 'file:///opt/usr/apps/priv/' + p; },
    deleteFile(p, ok) { files.delete(p); if (ok) setTimeout(ok, 0); },
    // "FileHandle openFile(Path path, FileMode openMode, optional boolean makeParents)" — RETURNS.
    openFile(p, mode, makeParents) {
      calls.push('openFile:' + mode);
      if (!files.has(p)) {
        if (mode === 'r') { const e = new Error('NotFoundError'); e.name = 'NotFoundError'; throw e; }
        files.set(p, []);
      }
      if (mode === 'w') files.set(p, []);        // 'w' truncates
      let pos = 0;
      return {
        path: p,
        seek(offset) { pos = offset; return this; },
        writeData(u8) {
          const cur = files.get(p).slice();
          // A positioned write: pad any gap, then overwrite in place — what seek+write really does.
          while (cur.length < pos) cur.push(0);
          for (let i = 0; i < u8.length; i++) cur[pos + i] = u8[i];
          pos += u8.length;
          files.set(p, cur);
        },
        flush() {}, close() {},
      };
    },
  });
  return { filesystem: modern, __files: files, __calls: calls };
}

function withTizen(fake, fn) {
  const hadT = 'tizen' in global; const oldT = global.tizen;
  const hadL = 'localStorage' in global; const oldL = global.localStorage;
  const store = new Map();
  global.tizen = fake;
  global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  try { return fn(); } finally {
    if (hadT) global.tizen = oldT; else delete global.tizen;
    if (hadL) global.localStorage = oldL; else delete global.localStorage;
  }
}

const MEDIA_DIR = 'wgt-private/st-media/';

test('ADAPTER: a Tizen 5.0 panel really can write, resume and hand back a URI', () => {
  const fake = fakeTizen({ version: 5.0 });
  withTizen(fake, () => {
    const b = MediaCache.tizenBackend();
    assert.equal(b.available(), true, 'the 5.0 synchronous filesystem must be usable');

    // The contract the decision layer depends on: appendPart returns the number of bytes WRITTEN,
    // synchronously. Returning 0 here is what made every download stall forever.
    assert.equal(b.appendPart('c1', [1, 2, 3], 0), 3, 'a first write must report what it wrote');
    assert.equal(b.appendPart('c1', [4, 5], 3), 2, 'and so must a resumed one');
    assert.deepEqual(fake.__files.get(MEDIA_DIR + 'c1'), [1, 2, 3, 4, 5]);

    const p = b.promotePart('c1');
    assert.ok(p && p.uri.startsWith('file://'), 'a finished asset must resolve to a playable URI');

    b.remove('c1');
    assert.equal(fake.__files.has(MEDIA_DIR + 'c1'), false);
    assert.equal(b.promotePart('c1'), null, 'and must not claim a file that is gone');
  });
});

test('ADAPTER: writes are POSITIONED, so replaying a chunk cannot corrupt the file', () => {
  // The crash window is real and is exactly the event this feature exists for: power is cut between
  // the write and the index save, so the next boot replays the last chunk. An append lands it a
  // second time and the panel promotes a silently corrupt video that plays as garbage. A positioned
  // write overwrites the same bytes with the same bytes, and the window stops mattering.
  const fake = fakeTizen({ version: 5.0 });
  withTizen(fake, () => {
    const b = MediaCache.tizenBackend();
    b.appendPart('c1', [1, 2, 3, 4], 0);
    b.appendPart('c1', [5, 6], 4);
    b.appendPart('c1', [5, 6], 4);              // the replay
    assert.deepEqual(fake.__files.get(MEDIA_DIR + 'c1'), [1, 2, 3, 4, 5, 6],
      'a replayed chunk must overwrite, not append');
  });
});

test('ADAPTER: offset 0 truncates, so a lost index restarts cleanly instead of prepending', () => {
  const fake = fakeTizen({ version: 5.0 });
  withTizen(fake, () => {
    const b = MediaCache.tizenBackend();
    b.appendPart('c1', [9, 9, 9, 9, 9, 9], 0);
    b.appendPart('c1', [1, 2], 0);
    assert.deepEqual(fake.__files.get(MEDIA_DIR + 'c1'), [1, 2]);
  });
});

test('ADAPTER: a panel without the synchronous filesystem says so instead of writing nothing', () => {
  // Tizen 4.0 (2018 models). The deprecated resolve()/openStream() pair cannot serve a synchronous
  // backend at all, and a cache that reports itself available and then silently writes zero bytes is
  // worse than no cache — capabilities.js declares offline.cache on the strength of create().
  for (const fake of [fakeTizen({ version: 4.0 }), { filesystem: null }, {}]) {
    withTizen(fake, () => {
      const b = MediaCache.tizenBackend();
      assert.equal(b.available(), false);
      assert.equal(b.appendPart('c1', [1, 2, 3], 0), 0, 'and must not pretend to have written');
      assert.equal(b.promotePart('c1'), null);
      assert.equal(MediaCache.create(), null, 'so no cache is created, and no capability claimed');
    });
  }
});

test('ADAPTER: no deprecated asynchronous call is on the write path', () => {
  // Belt and braces against the exact regression: resolve(), openStream() and moveTo() all hand
  // their result to a callback, so any backend built on them returns before it has done anything.
  const fake = fakeTizen({ version: 5.0 });
  withTizen(fake, () => {
    const b = MediaCache.tizenBackend();
    b.appendPart('c1', [1], 0);
    b.promotePart('c1');
    b.remove('c1');
    assert.deepEqual(fake.__calls.filter((c) => c === 'resolve' || c === 'openStream'), [],
      'resolve() returns void and openStream() is async — neither can serve a synchronous backend');
  });
});

test('a 206 with no readable Content-Range is a stall, never a completed asset', async () => {
  // Content-Length on a 206 is the length of the CHUNK. Trusting it reports the first 1MB of a 50MB
  // video as a 1MB asset — complete, promoted, and truncated on screen. A proxy that strips
  // Content-Range, or a CORS context where the header simply is not readable, produces exactly it.
  const b = fakeBackend(asset(CHUNK * 4, 2));
  const mc = new MediaCache(b);
  // The entry fetchStep would have created before the first request.
  mc.index.c1 = { rev: 5, bytes: 0, total: 0, validator: null, complete: false, path: null, uri: null };
  const verdict = await mc.applyChunk('c1', 5, {
    status: 206, start: 0, total: 0, validator: '"v1"', body: new Array(CHUNK).fill(2),
  });
  assert.equal(verdict, 'stalled');
  assert.equal(mc.localUrl('c1', 5), null, 'a truncated file must never be handed to the player');
});

test('a 200 whose body is short of its own length is progress, not done', async () => {
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  mc.index.c1 = { rev: 5, bytes: 0, total: 0, validator: null, complete: false, path: null, uri: null };
  const verdict = await mc.applyChunk('c1', 5, {
    status: 200, start: 0, total: CHUNK * 3, validator: '"v1"', body: new Array(CHUNK).fill(1),
  });
  assert.equal(verdict, 'progress', "'done' would stop the sweep on an asset with more to fetch");
  assert.equal(mc.localUrl('c1', 5), null);
});

test('a server with no validator is given up on, not re-fetched forever', async () => {
  // A big asset from a server that sends neither ETag nor Last-Modified can never be resumed, so the
  // partial is correctly discarded. Dropping alone meant the next sweep started from zero, pulled
  // the same megabyte and discarded it again — every sweep, forever, on precisely the marginal link
  // this whole feature exists to be gentle on.
  const b = fakeBackend(asset(CHUNK * 4, 3));
  b.asset.etag = null;
  const mc = new MediaCache(b);

  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  const afterFirst = b.requests;
  assert.ok(afterFirst > 0, 'it must at least try once');

  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  assert.equal(b.requests, afterFirst, 'and then stop asking');
  assert.equal(mc.localUrl('c1', 5), null, 'while never claiming to hold it');
});

test('...and a new revision clears that verdict rather than blacklisting the asset forever', async () => {
  const b = fakeBackend(asset(CHUNK * 4, 3));
  b.asset.etag = null;
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  const afterFirst = b.requests;

  b.asset.etag = '"v2"';                                   // the server grew validators
  await mc.sync([{ content_id: 'c1', content_rev: 6 }], urlFor);
  assert.ok(b.requests > afterFirst, 'a fresh revision must be tried again');
  assert.equal(mc.localUrl('c1', 6), 'file:///wgt-private/c1');
});

test('a small asset from a validator-less server still caches — it never needs a resume', async () => {
  const b = fakeBackend(asset(Math.floor(CHUNK / 2), 4));
  b.asset.etag = null;
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  assert.equal(mc.localUrl('c1', 5), 'file:///wgt-private/c1');
});
