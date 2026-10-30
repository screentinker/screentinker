// v28: guard the SW-activated auto-reload so a FOREIGN root-scoped worker (the dashboard's
// sw-admin.js sharing the origin) never reloads the player; plus reason-logging on every reload
// path. v27: web-player live capture now prefers direct video.captureStream (RFP-safe, no canvas) with
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
// v29: shells for 2.1.1-2.1.4 shipped without a cache-name bump, so warm web players kept serving the
// v28-cached (pre-2.1.1) shell. Bumping purges it on activate; the index.html version-mismatch
// self-heal is the durable fix, this just gives already-warm players a second, immediate nudge.
// v30: 3.0 site cache — the worker can fetch media from the site's LAN cache box (verified by sha256,
// origin fallback) and the page posts it st-site-cache. Bumped so warm players take the new shell.
// v31: chunked downloads are no longer joined into a second copy (twice the quota, which an LG webOS
// panel did not have), cached media is served by Blob.slice, and the page can ask how offline-ready
// it is (st-cache-status). Bumped so warm players take the new shell.
const CACHE_NAME = 'rd-player-v31';
// Content lives in its own cache so the shell can be re-versioned (the activate handler deletes
// every cache that is not CACHE_NAME) WITHOUT throwing away megabytes of media that are still
// perfectly valid. Rolling the shell used to mean a player re-downloaded its entire playlist.
const CONTENT_CACHE = 'rd-content-v1';
// 3.0 site cache: where this screen's LAN cache box is (docs/site-cache.md). Its own cache name so a
// shell version bump does not forget it, and spared by activate for the same reason as content.
const SITE_CACHE_STORE = 'rd-site-cache-v1';
const SITE_CACHE_KEY = '/__st_site_cache__';

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
      keys.filter(k => k !== CACHE_NAME && k !== CONTENT_CACHE && k !== SITE_CACHE_STORE).map(k => caches.delete(k))
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
  /*
   * The display was DELETED on the dashboard (device:unpaired {reason: 'deleted'}), so nothing it
   * cached belongs to a screen any more — except trigger media, which the page lists in `keep`.
   * A separate message on purpose: st-cache-playlist's "an empty list never prunes" guard below is
   * right for a payload and must stay; this one is an explicit operator delete, where empty means
   * empty. Never sent for reason 'not_found', which a restored backup also produces.
   */
  if (data && data.type === 'st-device-deleted' && Array.isArray(data.keep)) {
    prefetchChain = prefetchChain.then(() => pruneToPlaylist(data.keep, data.scope)).catch(() => {});
    return;
  }
  // How ready this display is to run offline (the page reports it to the server, device page "Offline
  // cache"). Answered on the MessageChannel port the page sends; read-only, so it is never queued
  // behind the prefetch chain.
  if (data && data.type === 'st-cache-status' && Array.isArray(data.urls) && event.ports && event.ports[0]) {
    const port = event.ports[0];
    cacheStatus(data.urls).then((s) => port.postMessage(s), (e) => port.postMessage({ error: String(e && e.message || e) }));
    return;
  }
  if (data && data.type === 'st-site-cache') {
    setSiteCache(data.config, data.scope);
    return;
  }
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
    prefetchChain = prefetchChain.then(() => pruneToPlaylist(data.urls, data.scope)).catch(() => {});
  }

  for (const url of data.urls) {
    if (typeof url !== 'string' || !POLICY || !POLICY.isCacheableContent(url, 'GET')) continue;
    if (prefetching.has(url)) continue;   // single-flight: a 60s playlist sweep must not restart it
    prefetching.add(url);
    // Serialised. Three concurrent chunk streams on a link that cannot finish one is how you get
    // three unfinished downloads instead of one finished one.
    prefetchChain = prefetchChain
      .then(() => ensureCached(url))
      .catch(noteCacheError)
      .then(() => { prefetching.delete(url); });
  }
});

/*
 * The last thing that stopped the cache from filling (QuotaExceededError above all), for the page's
 * status report. Before this every such failure was swallowed: playback carried on from the network
 * and nobody could tell that the screen would go dark the moment the network did.
 */
let lastCacheError = null;
function noteCacheError(e) {
  if (!e) return;
  lastCacheError = { name: String(e.name || 'Error').slice(0, 40), message: String(e.message || '').slice(0, 160), at: Date.now() };
}

/*
 * { wanted, ready, ready_bytes, partial, partial_bytes, usage, quota, error } for the media URLs
 * the page needs. "ready" is exactly what handleContent would serve with the network gone.
 */
async function cacheStatus(urls) {
  const cache = await caches.open(CONTENT_CACHE);
  const out = { wanted: 0, ready: 0, ready_bytes: 0, partial: 0, partial_bytes: 0, usage: null, quota: null, error: lastCacheError };
  const seen = new Set();
  for (const url of urls.slice(0, 500)) {
    if (typeof url !== 'string' || seen.has(url) || !POLICY || !POLICY.isCacheableContent(url, 'GET')) continue;
    seen.add(url);
    out.wanted++;
    const asset = await cachedAsset(cache, url);
    if (asset) { out.ready++; out.ready_bytes += asset.blob.size; continue; }
    const metaHit = await cache.match(POLICY.chunkKey(url, 'meta'));
    if (!metaHit) continue;
    let meta = null;
    try { meta = await metaHit.json(); } catch (e) { meta = null; }
    if (!meta || !(meta.total > 0)) continue;
    let have = 0;
    for (const r of POLICY.chunkRanges(meta.total, meta.chunk > 0 ? meta.chunk : POLICY.CHUNK_BYTES)) {
      const hit = await cache.match(POLICY.chunkKey(url, r.start));
      if (hit) have += Number(hit.headers.get('content-length')) || (r.end - r.start + 1);
    }
    if (have > 0) { out.partial++; out.partial_bytes += have; }
  }
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      out.usage = Number(est.usage) || 0;
      out.quota = Number(est.quota) || 0;
    }
  } catch (e) { /* not on every build */ }
  return out;
}

/* A chunk, with its size on it: evictOldest frees by Content-Length, and a chunk without one counts as 0. */
async function putChunk(cache, key, blob) {
  await cache.put(key, new Response(blob, { headers: { 'Content-Length': String(blob.size) } }));
}

/*
 * Fetch [url] into the content cache, one chunk at a time, resuming across calls.
 *
 * Returns when the asset is whole OR when a chunk fails — the caller does not retry, because the
 * player will ask again on its next playlist sweep and whatever landed is still on disk. That is
 * the entire point: attempts accumulate instead of restarting.
 */
async function ensureCached(url) {
  const cache = await caches.open(CONTENT_CACHE);
  if (await cachedAsset(cache, url)) { await sweepOldRevisions(cache, url); return; }

  // 3.0: the site's LAN cache first. Only ever a VERIFIED whole body; anything else falls through
  // to the origin below exactly as before.
  const fromSite = await siteCacheFetch(url, { wait: true });
  if (fromSite) {
    await storeContent(cache, new Request(url), fromSite);
    await sweepOldRevisions(cache, url);
    return;
  }

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
    // chunk: the size these pieces were cut at, so a later CHUNK_BYTES change still finds them.
    meta = { total: cr.total, validator: POLICY.validatorOf(probe.headers), type: probe.headers.get('Content-Type') || '', chunk: POLICY.CHUNK_BYTES };
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
    await putChunk(cache, POLICY.chunkKey(url, 0), await probe.blob());
  }

  // A transfer started before meta recorded its chunk size was cut at the size of the day.
  const chunkSize = meta.chunk > 0 ? meta.chunk : POLICY.CHUNK_BYTES;
  const ranges = POLICY.chunkRanges(meta.total, chunkSize);
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
    await putChunk(cache, key, await response.blob());
  }

  // Every piece present: mark the copy complete. NOT joined into a whole entry (see cachedAsset):
  // the marker is what makes these chunks playable, and it is written only once all of them are
  // here and add up to the size the server announced, so a cache hit is never a fragment.
  let size = 0;
  for (const r of ranges) {
    const hit = await cache.match(POLICY.chunkKey(url, r.start));
    if (!hit) return;                                        // evicted meanwhile; try again later
    size += (await hit.blob()).size;
  }
  if (size !== meta.total) { await dropChunks(cache, url); return; }
  await cache.put(POLICY.chunkKey(url, 'done'), new Response(JSON.stringify({
    total: meta.total, type: meta.type || '', chunk: chunkSize,
  }), { headers: { 'Content-Type': 'application/json' } }));
  await sweepOldRevisions(cache, url);
}

/*
 * 3.0: the content cache is shared by every display open in this browser (two display links in two
 * tabs), and "everything not in MY list can go" deleted the other display's media on every sweep —
 * then its offline cold start had nothing to play. Each page names its storage scope ('' for plain
 * /player), the worker remembers the latest list per scope, and prunes to the UNION. A scope not
 * heard from in KEEP_SCOPE_DAYS is forgotten, so a link closed for good stops pinning its media.
 * With one scope this is exactly the old behaviour.
 */
const KEEP_SCOPES_KEY = '/__st_keep_scopes__';
const KEEP_SCOPE_DAYS = 14;
async function keepSetFor(urls, scope) {
  const key = typeof scope === 'string' ? scope.slice(0, 64) : '';
  let scopes = {};
  try {
    const store = await caches.open(SITE_CACHE_STORE);
    const hit = await store.match(KEEP_SCOPES_KEY);
    if (hit) scopes = (await hit.json()) || {};
    scopes[key] = { urls, at: Date.now() };
    for (const k of Object.keys(scopes)) {
      if (!scopes[k] || !Array.isArray(scopes[k].urls) || Date.now() - (scopes[k].at || 0) > KEEP_SCOPE_DAYS * 86400000) delete scopes[k];
    }
    await store.put(KEEP_SCOPES_KEY, new Response(JSON.stringify(scopes), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) { scopes = { [key]: { urls } }; }
  const all = new Set();
  for (const k of Object.keys(scopes)) for (const u of scopes[k].urls) all.add(u);
  return all;
}

async function pruneToPlaylist(urls, scope) {
  const cache = await caches.open(CONTENT_CACHE);
  const keep = await keepSetFor(urls, scope);
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

/*
 * The cached copy of [url] as one Blob, or null. Two shapes count as cached:
 *
 *   - a whole entry under the URL itself (a single fetch that completed, or the site cache);
 *   - a CHUNKED copy: every chunk of a resumable transfer plus its 'done' marker.
 *
 * ⚠️ CHUNKS ARE THE FINAL FORM, they are not joined into a whole entry any more. Joining needed
 * the chunks AND the joined copy on disk at once, twice the asset's size, and on an LG webOS panel
 * with a small storage quota that second copy never fit: the join failed silently on every sweep,
 * nothing was ever cached, and the screen went black the moment its network did (NCH, 2026-10-30).
 * new Blob(parts) only references the stored chunks, so serving from them costs no extra space.
 *
 * A chunk the quota evicted makes the copy incomplete: the marker goes, so this reads as a miss
 * and the next sweep fetches only the missing piece.
 */
async function cachedAsset(cache, url) {
  const whole = await cache.match(url, { ignoreVary: true });
  if (whole) {
    const blob = await whole.blob();
    return { blob, type: whole.headers.get('content-type') || blob.type || '' };
  }
  const doneKey = POLICY.chunkKey(url, 'done');
  const done = await cache.match(doneKey);
  if (!done) return null;
  let meta = null;
  try { meta = await done.json(); } catch (e) { meta = null; }
  if (!meta || !(meta.total > 0) || !(meta.chunk > 0)) { await cache.delete(doneKey); return null; }
  const parts = [];
  for (const r of POLICY.chunkRanges(meta.total, meta.chunk)) {
    const hit = await cache.match(POLICY.chunkKey(url, r.start));
    if (!hit) { await cache.delete(doneKey); return null; }
    parts.push(await hit.blob());
  }
  const blob = new Blob(parts, { type: meta.type || 'application/octet-stream' });
  if (blob.size !== meta.total) { await dropChunks(cache, url); return null; }
  return { blob, type: meta.type || '' };
}

/* A 200, or a 206 for [range], built from a cached asset. Null when the range cannot be served. */
function respondFromBlob(asset, range) {
  const size = asset.blob.size;
  const parsed = range ? POLICY.parseRange(range, size) : null;
  if (parsed === 'unsatisfiable') return null;
  if (parsed === null) {
    const headers = { 'Content-Length': String(size), 'Accept-Ranges': 'bytes' };
    if (asset.type) headers['Content-Type'] = asset.type;
    return new Response(asset.blob, { status: 200, headers });
  }
  // Blob.slice references the stored bytes; nothing is read into memory until the media element
  // consumes the body. The old arrayBuffer() read the WHOLE file per range request, which on a TV's
  // SoC meant 40MB+ copied for every seek and every buffer refill.
  return new Response(asset.blob.slice(parsed.start, parsed.end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: POLICY.partialHeaders(parsed.start, parsed.end, size, asset.type),
  });
}

async function handleContent(request) {
  const range = request.headers.get('range');
  const cache = await caches.open(CONTENT_CACHE);

  // Keyed WITHOUT the range header (Cache API ignores request headers by default), so one stored
  // copy serves every range of that file rather than one entry per seek position.
  const cached = await cachedAsset(cache, request.url);

  if (cached) {
    const served = respondFromBlob(cached, range);
    if (served) return served;
    // Unsatisfiable against the cached copy: fall through to the network rather than inventing a
    // 416 that might be wrong if the cached copy is somehow stale.
  }

  // 3.0: a miss the site's LAN cache can fill. Bounded to what is quick to pull across a LAN in one
  // go; a bigger asset streams from the origin this time while the prefetch fills it from the box.
  await loadSiteCache();
  const siteEntry = siteEntryFor(request.url);
  if (siteEntry && siteEntry.size <= SITE_INLINE_MAX_BYTES) {
    const fromSite = await siteCacheFetch(request.url, { wait: false });
    if (fromSite) {
      try {
        await storeContent(cache, new Request(request.url), fromSite.clone());
        const stored = await cachedAsset(cache, request.url);
        if (stored) {
          const served = respondFromBlob(stored, range);
          if (served) return served;
        }
      } catch (e) { /* fall through to the origin */ }
      if (!range) return fromSite;
    }
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
    if (cached) return respondFromBlob(cached, null);
    return new Response('', { status: 504, statusText: 'Offline and not cached' });
  }
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
    try { await cache.put(request, response); } catch (e2) { noteCacheError(e2); /* playback still works live */ }
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

/*
 * ---------------------------------------------------------------------------------------------
 * 3.0 SITE CACHE (docs/site-cache.md)
 *
 * A box on this screen's LAN holds the site's media by sha256. The page hands us its address, a
 * token minted for this screen, and the digest of each media path. We fetch from the box, check the
 * bytes hash to the digest the ORIGIN gave us (never one the box gives us), and only then keep them.
 * Every failure — no box, a timeout, a 401/404, a wrong byte — returns null and the caller goes to
 * the origin as it always did. The box is an optimisation; it is never on the path to a dark screen.
 * ---------------------------------------------------------------------------------------------
 */

// Bodies are hashed in memory (WebCrypto has no streaming digest), so very large assets skip the box.
const SITE_MAX_BYTES = 768 * 1024 * 1024;
// The playback path waits for the box only for assets this small; prefetch handles the rest.
const SITE_INLINE_MAX_BYTES = 64 * 1024 * 1024;
// No answer at all for this long and the box is treated as down for a minute.
const SITE_FIRST_BYTE_MS = 4000;
const SITE_DOWN_MS = 60 * 1000;
// A box that is still downloading an asset says so (503 warming). Prefetch waits for it this long
// before giving up and taking the asset from the origin — the whole point is one WAN download.
const SITE_WARM_WAIT_MS = 3 * 60 * 1000;

/*
 * Keyed by the page's storage SCOPE (3.0: one per display link open in this browser; '' for plain
 * /player). Two displays in two tabs each hand over their own box config, and a single global used
 * to let the last tab to speak replace the other's — its media then always went to the origin.
 */
let siteCaches = {};
let siteCacheLoaded = null;
let siteDownUntil = 0;

function validSiteConfig(c) {
  if (!c || typeof c !== 'object' || typeof c.url !== 'string' || typeof c.token !== 'string') return null;
  if (!/^https?:\/\/[^/?#]+$/.test(c.url)) return null;
  const files = {};
  for (const k of Object.keys(c.files || {})) {
    const f = c.files[k];
    if (f && /^[0-9a-f]{64}$/.test(f.sha256) && f.size >= 0) files[k] = { sha256: f.sha256, size: Number(f.size) };
  }
  return { url: c.url, token: c.token, expires_at: Number(c.expires_at) || 0, files: files };
}

function setSiteCache(config, scope) {
  const sc = validSiteConfig(config);
  const key = typeof scope === 'string' ? scope.slice(0, 64) : '';
  const apply = () => {
    if (sc) siteCaches[key] = sc; else delete siteCaches[key];
    siteDownUntil = 0;
    // Persisted so a worker the browser stopped and restarted still knows where the box is.
    return caches.open(SITE_CACHE_STORE).then((c) => Object.keys(siteCaches).length
      ? c.put(SITE_CACHE_KEY, new Response(JSON.stringify({ scopes: siteCaches }), { headers: { 'Content-Type': 'application/json' } }))
      : c.delete(SITE_CACHE_KEY)).catch(() => {});
  };
  // After the persisted map is in, or a fresh worker's first message would drop the other scopes.
  siteCacheLoaded = loadSiteCache().then(apply);
}

function loadSiteCache() {
  if (!siteCacheLoaded) {
    siteCacheLoaded = caches.open(SITE_CACHE_STORE)
      .then((c) => c.match(SITE_CACHE_KEY))
      .then((r) => (r ? r.json() : null))
      .then((j) => {
        // Before 3.0 this held ONE config, the shape plain /player still means by scope ''.
        const stored = j && j.scopes && typeof j.scopes === 'object' ? j.scopes : (j ? { '': j } : {});
        for (const k of Object.keys(stored)) {
          const v = validSiteConfig(stored[k]);
          if (v && !(k in siteCaches)) siteCaches[k] = v;
        }
      })
      .catch(() => {});
  }
  return siteCacheLoaded;
}

function siteEntryFor(url) {
  let p;
  try { p = new URL(url, self.location.href).pathname; } catch (e) { return null; }
  for (const k of Object.keys(siteCaches)) {
    const sc = siteCaches[k];
    if (!sc || (sc.expires_at && sc.expires_at * 1000 < Date.now())) continue;
    const f = sc.files[p];
    // The box and token that vouched for this path travel with the entry.
    if (f) return { sha256: f.sha256, size: f.size, box: sc.url, token: sc.token };
  }
  return null;
}

function hexOf(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

/* One attempt. Resolves { response } | { warming, retryMs } | { missing } | null. Never throws. */
async function siteCacheOnce(entry) {
  if (Date.now() < siteDownUntil) return null;
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), SITE_FIRST_BYTE_MS);
  let res;
  try {
    res = await fetch(entry.box + '/cache/' + entry.sha256, {
      headers: { Authorization: 'Bearer ' + entry.token },
      mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    siteDownUntil = Date.now() + SITE_DOWN_MS;
    return null;
  }
  clearTimeout(timer);
  if (res.status === 503) {
    const ra = parseInt(res.headers.get('Retry-After') || '15', 10);
    return { warming: true, retryMs: Math.min(30, Math.max(2, ra || 15)) * 1000 };
  }
  if (res.status === 404) return { missing: true };
  if (res.status !== 200) return null;
  // A LAN moves a megabyte in well under this; the budget only exists so a stalled box cannot hold
  // the prefetch chain for ever.
  timer = setTimeout(() => ctrl.abort(), 10000 + Math.ceil(entry.size / (512 * 1024)) * 1000);
  let buf;
  try { buf = await res.arrayBuffer(); } catch (e) { clearTimeout(timer); return null; } finally { clearTimeout(timer); }
  if (buf.byteLength !== entry.size) return null;
  let hex = null;
  try { hex = hexOf(await crypto.subtle.digest('SHA-256', buf)); } catch (e) { hex = null; }
  if (hex !== entry.sha256) {
    console.warn('[site-cache] bytes from the cache did not match their sha256; using the origin');
    return null;
  }
  return { response: new Response(buf, { status: 200, headers: {
    'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
    'Content-Length': String(entry.size),
    'X-ST-Source': 'site-cache',
  } }) };
}

/*
 * A verified whole body from the box, or null. With `wait`, a box still downloading the asset is
 * given time (that is one WAN download instead of one per screen), and a "not here" is asked once
 * more after the box has had a moment to refresh its manifest — a screen can learn about new media
 * a few seconds before its box does.
 */
async function siteCacheFetch(url, { wait }) {
  try {
    await loadSiteCache();
    const entry = siteEntryFor(url);
    if (!entry || entry.size > SITE_MAX_BYTES) return null;
    const until = Date.now() + SITE_WARM_WAIT_MS;
    let askedAgain = false;
    for (;;) {
      const r = await siteCacheOnce(entry);
      if (!r) return null;
      if (r.response) return r.response;
      if (!wait) return null;
      let pause;
      if (r.warming) pause = r.retryMs;
      else if (r.missing && !askedAgain) { askedAgain = true; pause = 12000; }
      else return null;
      if (Date.now() + pause > until) return null;
      await new Promise((resolve) => setTimeout(resolve, pause));
      if (!siteEntryFor(url)) return null;   // the screen was taken off the cache meanwhile
    }
  } catch (e) {
    return null;
  }
}
