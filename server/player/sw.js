// v27: web-player live capture now prefers direct video.captureStream (RFP-safe, no canvas) with
// the canvas mirror as an image fallback. Bumped so cache-first players re-fetch.
// v26: shipped the web-player live self-capture (index.html device:live-publish handler +
// /player/live-publish.js). Bumped so cache-first players pick up the new code on next load.
// v25: the rev-pinned cache-first branch now also covers /api/content/:id/bundle, and the player
// fetches that URL SAME-ORIGIN and mounts it as srcdoc — so unlike widgets, this branch is actually
// reachable for bundles and their offline story is the Cache API rather than the HTTP cache.
// v24: an empty playlist payload no longer prunes. `assignments: []` is what the server sends for a
// device between playlists AND for a snapshot that failed to parse, and treating it as "keep
// nothing" wiped the panel's entire offline library on a message that means nothing of the sort.
// v23: offline.cache is claimed only when a worker is actually IN CONTROL — a real BrightSign
// widget exposes navigator.serviceWorker, refuses to register one, and was advertising the
// capability to the fleet regardless.
// v22: worker scope widened to '/' (it never controlled /player before) + prune-to-playlist, so a
// replaced asset's superseded copy is reclaimed rather than waiting on the quota.
// v21: chunked resumable content prefetch + revision-keyed media URLs — index.html gained
// mediaUrl()/requestOfflineCache() and this worker gained the message handler, so an old shell
// cache would pair a new worker with a player that never posts it a playlist.
// v20: rc3 changed the fetch strategy AND the shipped player assets. The activate handler deletes
// every cache whose name does not match, so leaving this at v19 kept the previous shell cache alive
// — a player then ran a new index.html against a stale st-bridge.js and threw on every heartbeat.
// Bump whenever a shipped /player asset changes shape; content lives in its own cache, so this
// costs a small re-download and never re-fetches the playlist.
const CACHE_NAME = 'rd-player-v27';
// Content lives in its own cache so the shell can be re-versioned (the activate handler deletes
// every cache that is not CACHE_NAME) WITHOUT throwing away megabytes of media that are still
// perfectly valid. Rolling the shell used to mean a player re-downloaded its entire playlist.
const CONTENT_CACHE = 'rd-content-v1';

// Single source, shared with server/lib/player-cache-policy.js and its Node tests. A service worker
// cannot require(), so this is importScripts against the route that serves that same file.
importScripts('/player/cache-policy.js');
const POLICY = self.PlayerCachePolicy;

// Install: skip waiting to activate immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate: clean old caches (including old content cache), claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      // CONTENT_CACHE is spared deliberately: it holds media, not code, and dropping it on every
      // shell version bump would make each deploy re-download the whole playlist — over a link
      // that may be exactly what is broken.
      keys.filter(k => k !== CACHE_NAME && k !== CONTENT_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Fetch handler — ONLY cache player page and static assets.
// Content files (/uploads/content/) are NOT intercepted — the server sets
// Cache-Control: public, max-age=2592000, immutable which lets the browser
// cache them natively without SW complications (range requests, opaque
// responses, video seeking, etc.)
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Widget renders pinned to a revision: cache-FIRST, because those exact bytes cannot change
  // without the rev changing. ignoreSearch is deliberately NOT used here: the query string carries
  // the rev, and ignoring it would match a different revision's entry, which is the staleness we
  // are trying to remove.
  //
  // MEASURED LIMIT, do not read more into this branch than it delivers. The player mounts widgets in
  // an iframe sandboxed to `allow-scripts` with NO allow-same-origin (index.html,
  // renderWidgetBuffered), so that frame is an OPAQUE-origin client — and a service worker does not
  // control opaque-origin clients. Its navigation request never reaches this handler. Driven in
  // Chrome against a live server: a clock widget mounted five times over 25s and the shell cache
  // held zero widget entries, while a plain fetch() of the identical URL from the controlled page
  // was intercepted and stored. So this branch serves anything that reaches it — a same-origin
  // fetch, a future non-sandboxed mount — and today the player's own widgets are not that.
  //
  // What actually keeps widgets rendering offline right now is the HTTP cache plus the server's
  // `max-age=31536000, immutable` on a rev-pinned render (routes/widgets.js). That is sound in a
  // desktop browser and is NOT a documented-persistent store on BrightSign, which guarantees
  // survival across reboots for IndexedDB, localStorage and SQLite only — the same gap that made
  // content caching necessary. Closing it properly means routing the render through a same-origin
  // fetch and mounting it as srcdoc; granting the frame allow-same-origin instead would hand widget
  // scripts the player's origin, which is not a trade worth making for an offline nicety.
  //
  // ⚠️ AND THIS IS WHY BUNDLES TAKE THE PRESCRIPTION ABOVE. A widget is mounted by URL into a
  // sandboxed frame, so the branch below cannot see it. An HTML bundle is fetched by the PLAYER
  // PAGE — a controlled, same-origin client — and mounted as srcdoc, so its render request DOES
  // reach this handler and DOES land in the Cache API. Bundles therefore get the persistent store
  // widgets still cannot, on the platform (BrightSign) where the HTTP cache guarantees nothing.
  const isRevPinnedRender = url.searchParams.has('rev') && (
    (url.pathname.startsWith('/api/widgets/') && url.pathname.endsWith('/render')) ||
    (url.pathname.startsWith('/api/content/') && url.pathname.endsWith('/bundle'))
  );
  if (isRevPinnedRender) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok && response.type !== 'opaque') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => new Response(
          '<!DOCTYPE html><body style="margin:0;background:#000"></body>',
          { status: 200, headers: { 'Content-Type': 'text/html' } }
        ));
      })
    );
    return;
  }

  // Player page and static assets: network-first, fall back to cache
  if (url.pathname.startsWith('/player') || url.pathname === '/socket.io/socket.io.js') {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() =>
        caches.match(event.request, { ignoreSearch: true }).then(cached =>
          cached || new Response('Offline', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain' }
          })
        )
      )
    );
    return;
  }

  // Content files: cache the bytes so a player that loses its server keeps playing.
  //
  // This used to be left to the browser's HTTP cache (the server sends
  // `Cache-Control: public, max-age=2592000, immutable`). That is fine on a desktop and is NOT a
  // documented-persistent store on BrightSign, which guarantees survival across reboots for
  // IndexedDB, localStorage and SQLite only. A panel could come back from a power cut with its
  // playlist intact (localStorage) and no media to play.
  //
  // Range requests are the reason this was avoided, and POLICY is what makes it safe: we only ever
  // STORE complete 200s, and slice them ourselves when a seeking video asks for a range.
  if (POLICY && POLICY.isCacheableContent(url, event.request.method)) {
    event.respondWith(handleContent(event.request));
    return;
  }

  // Everything else (API calls, sockets, etc.): don't intercept.
  // Returning without event.respondWith lets the browser handle it natively.
});

/*
 * PREFETCH — the half that makes the cache fill on a link that cannot carry a whole asset.
 *
 * handleContent below stores an asset when a single fetch() of it happens to succeed. On a good
 * link that is everything. On a marginal one (the one-bar 5G site this came from) a 200MB fetch
 * never completes, every retry starts from nothing, and the cache stays empty — so the panel has
 * nothing to fall back on the moment the uplink drops. The Android player had the identical bug and
 * was fixed by resuming; a service worker has no file handle to append to, so progress accumulates
 * as separate cache entries and is assembled once every piece is present.
 *
 * Driven by the player rather than by playback: it posts its current media URLs after each playlist
 * update, and this works through them ONE AT A TIME. Deliberately not started from the fetch
 * handler — that would put the accumulator in competition with the playing video for the same
 * scarce bandwidth, which is worse than either alone.
 */
const prefetching = new Set();
let prefetchChain = Promise.resolve();

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'st-cache-playlist' || !Array.isArray(data.urls)) return;

  // The player sends the COMPLETE set of media this display needs, so anything else in the content
  // cache is superseded and can go. Revision-keyed sweeping alone is not enough: replacing an asset
  // writes a new randomly-named file, so the old copy lives at a different PATH and nothing keyed
  // on the asset path can find it. Without this the cache only grows, and on a panel with a 1GB
  // widget quota a handful of replaced videos is the entire budget.
  //
  // An EMPTY list is never a prune instruction, and that distinction is the whole guard. "This
  // display needs nothing" and "the payload did not arrive intact" are the same message on the
  // wire, and the second one is not rare: buildPlaylistPayload() yields `assignments: []` for a
  // device between playlists, for a playlist that has never been published, AND for a
  // published_snapshot that fails to JSON.parse. Honouring it deleted every byte of media the panel
  // held — reproduced here: three cached assets, one empty payload, cache emptied — which is only
  // survivable while the uplink is up, i.e. exactly when this cache does not matter. A cache that is
  // kept too long costs disk the quota reclaims anyway; one dropped at the wrong moment is a dark
  // screen with no way back.
  if (data.prune && data.urls.length > 0) {
    prefetchChain = prefetchChain.then(() => pruneToPlaylist(data.urls)).catch(() => {});
  }

  for (const url of data.urls) {
    if (typeof url !== 'string' || !POLICY || !POLICY.isCacheableContent(url, 'GET')) continue;
    if (prefetching.has(url)) continue;   // single-flight: a 60s playlist sweep must not restart it
    prefetching.add(url);
    // Serialised. Three concurrent chunk streams on a link that cannot finish one is how you get
    // three unfinished downloads instead of one finished one.
    prefetchChain = prefetchChain
      .then(() => ensureCached(url))
      .catch(() => {})
      .then(() => { prefetching.delete(url); });
  }
});

/*
 * Fetch [url] into the content cache, one chunk at a time, resuming across calls.
 *
 * Returns when the asset is whole OR when a chunk fails — the caller does not retry, because the
 * player will ask again on its next playlist sweep and whatever landed is still on disk. That is
 * the entire point: attempts accumulate instead of restarting.
 */
async function ensureCached(url) {
  const cache = await caches.open(CONTENT_CACHE);
  if (await cache.match(url, { ignoreVary: true })) { await sweepOldRevisions(cache, url); return; }

  const metaKey = POLICY.chunkKey(url, 'meta');
  let meta = null;
  const metaHit = await cache.match(metaKey);
  if (metaHit) { try { meta = await metaHit.json(); } catch (e) { meta = null; } }

  // Learn the size and validator from the first ranged request, or trust what a previous call
  // already learned. A server that answers 200 here has no range support: fall back to storing it
  // whole, which is the pre-existing behaviour and is correct, just not resumable.
  if (!meta) {
    const probe = await fetch(new Request(url, { headers: { Range: 'bytes=0-' + (POLICY.CHUNK_BYTES - 1) } }));
    if (probe.status === 200) {
      if (POLICY.isStorable(probe)) await storeContent(cache, new Request(url), probe);
      return;
    }
    const cr = POLICY.parseContentRange(probe.headers.get('Content-Range'));
    if (probe.status !== 206 || !cr || !(cr.total > 0)) return;
    meta = { total: cr.total, validator: POLICY.validatorOf(probe.headers), type: probe.headers.get('Content-Type') || '' };
    if (!meta.validator) {
      // Nothing to detect a changed asset with, so a resume would be a guess. Store this one whole
      // if it happens to fit in a chunk; otherwise leave it to the fetch path.
      if (cr.total <= POLICY.CHUNK_BYTES) {
        await cache.put(new Request(url), new Response(await probe.blob(), {
          status: 200, headers: { 'Content-Type': meta.type, 'Content-Length': String(cr.total) }
        }));
        await sweepOldRevisions(cache, url);
      }
      return;
    }
    await cache.put(metaKey, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    await cache.put(POLICY.chunkKey(url, 0), new Response(await probe.blob()));
  }

  const ranges = POLICY.chunkRanges(meta.total, POLICY.CHUNK_BYTES);
  for (const r of ranges) {
    const key = POLICY.chunkKey(url, r.start);
    if (await cache.match(key)) continue;                    // already have it — this is the resume

    let response;
    try {
      response = await fetch(new Request(url, {
        headers: { Range: 'bytes=' + r.start + '-' + r.end, 'If-Range': meta.validator }
      }));
    } catch (e) {
      return;   // link died. Everything stored so far stays; the next sweep continues from here.
    }

    const verdict = POLICY.resumeVerdict(
      response.status, response.headers.get('Content-Range'),
      r.start, meta.total, meta.validator, POLICY.validatorOf(response.headers)
    );
    if (verdict !== 'continue') {
      // 'restart' means the asset changed under us (If-Range declined) and 'discard' means we
      // cannot trust what came back. Either way the accumulated chunks describe a file that no
      // longer exists, and appending to them is the corruption this check exists to prevent.
      await dropChunks(cache, url);
      return;
    }
    await cache.put(key, new Response(await response.blob()));
  }

  // Every piece present: assemble once, atomically as far as the player is concerned — the full
  // entry appears only when it is genuinely whole, so a cache hit can never be a fragment.
  const parts = [];
  for (const r of ranges) {
    const hit = await cache.match(POLICY.chunkKey(url, r.start));
    if (!hit) return;                                        // evicted mid-assembly; try again later
    parts.push(await hit.blob());
  }
  const whole = new Blob(parts, { type: meta.type || 'application/octet-stream' });
  if (whole.size !== meta.total) { await dropChunks(cache, url); return; }
  await cache.put(new Request(url), new Response(whole, {
    status: 200,
    headers: { 'Content-Type': meta.type || 'application/octet-stream', 'Content-Length': String(meta.total) }
  }));
  await dropChunks(cache, url);
  await sweepOldRevisions(cache, url);
}

async function pruneToPlaylist(urls) {
  const cache = await caches.open(CONTENT_CACHE);
  const keep = new Set(urls);
  for (const key of await cache.keys()) {
    if (keep.has(key.url)) continue;
    // An in-flight transfer's bookkeeping belongs to a URL that IS in the keep set; deleting it
    // because the chunk key itself is not listed would restart that download on every sweep.
    if (POLICY.isInternalKey(key.url) && [...keep].some((u) => POLICY.assetKey(u) === POLICY.assetKey(key.url))) continue;
    await cache.delete(key);
  }
}

async function dropChunks(cache, url) {
  for (const key of await cache.keys()) {
    if (POLICY.isInternalKey(key.url) && POLICY.assetKey(key.url) === POLICY.assetKey(url) &&
        key.url.indexOf(revOf(url)) !== -1) {
      await cache.delete(key);
    }
  }
}

/*
 * Delete entries for the SAME asset at a DIFFERENT revision.
 *
 * Replacing an asset changes the revision in its URL, which is what makes the new bytes a cache
 * miss everywhere — but it also means the superseded copy would sit there until the quota evicted
 * it. On a panel with a 1GB widget quota, a handful of replaced videos is the entire budget.
 */
async function sweepOldRevisions(cache, url) {
  const asset = POLICY.assetKey(url);
  const rev = revOf(url);
  for (const key of await cache.keys()) {
    if (POLICY.assetKey(key.url) !== asset) continue;
    if (revOf(key.url) === rev) continue;
    await cache.delete(key);
  }
}

function revOf(url) {
  try { return new URL(url, self.location.href).searchParams.get('rev') || ''; } catch (e) { return ''; }
}

async function handleContent(request) {
  const range = request.headers.get('range');
  const cache = await caches.open(CONTENT_CACHE);

  // Keyed WITHOUT the range header (Cache API ignores request headers by default), so one stored
  // full body serves every range of that file rather than one entry per seek position.
  const cached = await cache.match(request, { ignoreVary: true });

  if (cached) {
    if (!range) return cached;
    const sliced = await sliceCached(cached, range);
    if (sliced) return sliced;
    // Unsatisfiable against the cached copy: fall through to the network rather than inventing a
    // 416 that might be wrong if the cached copy is somehow stale.
  }

  try {
    // A ranged request goes to the network as-is; storing its 206 would corrupt the entry, so this
    // response is returned and deliberately NOT cached. The full copy arrives on a non-ranged
    // request (the player's preloader issues one) and that is what populates the cache.
    const response = await fetch(request);

    if (!range && POLICY.isStorable(response)) {
      const clone = response.clone();
      // Not awaited: a slow write must not delay first frame. Failures are swallowed because a
      // cache miss is a performance problem, and a thrown error here is a black screen.
      storeContent(cache, request, clone).catch(() => {});
    }
    return response;
  } catch (err) {
    // Offline with nothing cached. A 504 is more honest than a 200 with an empty body — the player
    // treats a failed media load as an item to skip, and an empty 200 would hang on a dead element.
    if (cached) return cached;
    return new Response('', { status: 504, statusText: 'Offline and not cached' });
  }
}

/* Build a correct 206 from a stored full body. */
async function sliceCached(cached, rangeHeader) {
  const buf = await cached.arrayBuffer();
  const parsed = POLICY.parseRange(rangeHeader, buf.byteLength);

  if (parsed === null) return new Response(buf, { status: 200, headers: cached.headers });
  if (parsed === 'unsatisfiable') return null;

  const body = buf.slice(parsed.start, parsed.end + 1);
  return new Response(body, {
    status: 206,
    statusText: 'Partial Content',
    headers: POLICY.partialHeaders(
      parsed.start, parsed.end, buf.byteLength, cached.headers.get('content-type')
    )
  });
}

/* Store a full response, evicting oldest-first when the quota is close rather than waiting for a
   QuotaExceededError to land on whichever item happened to be next. */
async function storeContent(cache, request, response) {
  const len = Number(response.headers.get('content-length')) || 0;

  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      if (POLICY.needsEviction(usage || 0, len, quota || 0)) await evictOldest(cache, len);
    }
  } catch (e) { /* estimate is unavailable on some builds; proceed and rely on the catch below */ }

  try {
    await cache.put(request, response);
  } catch (e) {
    // Quota exceeded despite the check (or no estimate available). Make room once and retry — but
    // only once, so a pathologically large item cannot spin evicting the whole cache.
    await evictOldest(cache, len);
    try { await cache.put(request, response); } catch (e2) { /* give up: playback still works live */ }
  }
}

/* Cache API preserves insertion order, so the front of keys() is the least recently ADDED. That is
   a rough proxy for least useful and is the only ordering the API exposes without tracking metadata
   ourselves. */
async function evictOldest(cache, needBytes) {
  const keys = await cache.keys();
  let freed = 0;
  for (const key of keys) {
    const hit = await cache.match(key);
    const size = hit ? Number(hit.headers.get('content-length')) || 0 : 0;
    await cache.delete(key);
    freed += size;
    if (freed >= needBytes) break;
  }
}
