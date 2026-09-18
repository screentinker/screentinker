var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};
const CACHE_NAME = "rd-player-v29";
const CONTENT_CACHE = "rd-content-v1";
importScripts("/player/cache-policy.js");
const POLICY = self.PlayerCachePolicy;
self.addEventListener("install", (event) => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      // CONTENT_CACHE is spared deliberately: it holds media, not code, and dropping it on every
      // shell version bump would make each deploy re-download the whole playlist — over a link
      // that may be exactly what is broken.
      keys.filter((k) => k !== CACHE_NAME && k !== CONTENT_CACHE).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const isRevPinnedRender = url.searchParams.has("rev") && (url.pathname.startsWith("/api/widgets/") && url.pathname.endsWith("/render") || url.pathname.startsWith("/api/content/") && url.pathname.endsWith("/bundle"));
  if (isRevPinnedRender) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok && response.type !== "opaque") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => new Response(
          '<!DOCTYPE html><body style="margin:0;background:#000"></body>',
          { status: 200, headers: { "Content-Type": "text/html" } }
        ));
      })
    );
    return;
  }
  if (url.pathname.startsWith("/player") || url.pathname === "/socket.io/socket.io.js") {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response.ok && response.type !== "opaque") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(
        () => caches.match(event.request, { ignoreSearch: true }).then(
          (cached) => cached || new Response("Offline", {
            status: 503,
            statusText: "Service Unavailable",
            headers: { "Content-Type": "text/plain" }
          })
        )
      )
    );
    return;
  }
  if (POLICY && POLICY.isCacheableContent(url, event.request.method)) {
    event.respondWith(handleContent(event.request));
    return;
  }
});
const prefetching = /* @__PURE__ */ new Set();
let prefetchChain = Promise.resolve();
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "st-cache-playlist" || !Array.isArray(data.urls)) return;
  if (data.prune && data.urls.length > 0) {
    prefetchChain = prefetchChain.then(() => pruneToPlaylist(data.urls)).catch(() => {
    });
  }
  for (const url of data.urls) {
    if (typeof url !== "string" || !POLICY || !POLICY.isCacheableContent(url, "GET")) continue;
    if (prefetching.has(url)) continue;
    prefetching.add(url);
    prefetchChain = prefetchChain.then(() => ensureCached(url)).catch(() => {
    }).then(() => {
      prefetching.delete(url);
    });
  }
});
function ensureCached(url) {
  return __async(this, null, function* () {
    const cache = yield caches.open(CONTENT_CACHE);
    if (yield cache.match(url, { ignoreVary: true })) {
      yield sweepOldRevisions(cache, url);
      return;
    }
    const metaKey = POLICY.chunkKey(url, "meta");
    let meta = null;
    const metaHit = yield cache.match(metaKey);
    if (metaHit) {
      try {
        meta = yield metaHit.json();
      } catch (e) {
        meta = null;
      }
    }
    if (!meta) {
      const probe = yield fetch(new Request(url, { headers: { Range: "bytes=0-" + (POLICY.CHUNK_BYTES - 1) } }));
      if (probe.status === 200) {
        if (POLICY.isStorable(probe)) yield storeContent(cache, new Request(url), probe);
        return;
      }
      const cr = POLICY.parseContentRange(probe.headers.get("Content-Range"));
      if (probe.status !== 206 || !cr || !(cr.total > 0)) return;
      meta = { total: cr.total, validator: POLICY.validatorOf(probe.headers), type: probe.headers.get("Content-Type") || "" };
      if (!meta.validator) {
        if (cr.total <= POLICY.CHUNK_BYTES) {
          yield cache.put(new Request(url), new Response(yield probe.blob(), {
            status: 200,
            headers: { "Content-Type": meta.type, "Content-Length": String(cr.total) }
          }));
          yield sweepOldRevisions(cache, url);
        }
        return;
      }
      yield cache.put(metaKey, new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
      yield cache.put(POLICY.chunkKey(url, 0), new Response(yield probe.blob()));
    }
    const ranges = POLICY.chunkRanges(meta.total, POLICY.CHUNK_BYTES);
    for (const r of ranges) {
      const key = POLICY.chunkKey(url, r.start);
      if (yield cache.match(key)) continue;
      let response;
      try {
        response = yield fetch(new Request(url, {
          headers: { Range: "bytes=" + r.start + "-" + r.end, "If-Range": meta.validator }
        }));
      } catch (e) {
        return;
      }
      const verdict = POLICY.resumeVerdict(
        response.status,
        response.headers.get("Content-Range"),
        r.start,
        meta.total,
        meta.validator,
        POLICY.validatorOf(response.headers)
      );
      if (verdict !== "continue") {
        yield dropChunks(cache, url);
        return;
      }
      yield cache.put(key, new Response(yield response.blob()));
    }
    const parts = [];
    for (const r of ranges) {
      const hit = yield cache.match(POLICY.chunkKey(url, r.start));
      if (!hit) return;
      parts.push(yield hit.blob());
    }
    const whole = new Blob(parts, { type: meta.type || "application/octet-stream" });
    if (whole.size !== meta.total) {
      yield dropChunks(cache, url);
      return;
    }
    yield cache.put(new Request(url), new Response(whole, {
      status: 200,
      headers: { "Content-Type": meta.type || "application/octet-stream", "Content-Length": String(meta.total) }
    }));
    yield dropChunks(cache, url);
    yield sweepOldRevisions(cache, url);
  });
}
function pruneToPlaylist(urls) {
  return __async(this, null, function* () {
    const cache = yield caches.open(CONTENT_CACHE);
    const keep = new Set(urls);
    for (const key of yield cache.keys()) {
      if (keep.has(key.url)) continue;
      if (POLICY.isInternalKey(key.url) && [...keep].some((u) => POLICY.assetKey(u) === POLICY.assetKey(key.url))) continue;
      yield cache.delete(key);
    }
  });
}
function dropChunks(cache, url) {
  return __async(this, null, function* () {
    for (const key of yield cache.keys()) {
      if (POLICY.isInternalKey(key.url) && POLICY.assetKey(key.url) === POLICY.assetKey(url) && key.url.indexOf(revOf(url)) !== -1) {
        yield cache.delete(key);
      }
    }
  });
}
function sweepOldRevisions(cache, url) {
  return __async(this, null, function* () {
    const asset = POLICY.assetKey(url);
    const rev = revOf(url);
    for (const key of yield cache.keys()) {
      if (POLICY.assetKey(key.url) !== asset) continue;
      if (revOf(key.url) === rev) continue;
      yield cache.delete(key);
    }
  });
}
function revOf(url) {
  try {
    return new URL(url, self.location.href).searchParams.get("rev") || "";
  } catch (e) {
    return "";
  }
}
function handleContent(request) {
  return __async(this, null, function* () {
    const range = request.headers.get("range");
    const cache = yield caches.open(CONTENT_CACHE);
    const cached = yield cache.match(request, { ignoreVary: true });
    if (cached) {
      if (!range) return cached;
      const sliced = yield sliceCached(cached, range);
      if (sliced) return sliced;
    }
    try {
      const response = yield fetch(request);
      if (!range && POLICY.isStorable(response)) {
        const clone = response.clone();
        storeContent(cache, request, clone).catch(() => {
        });
      }
      return response;
    } catch (err) {
      if (cached) return cached;
      return new Response("", { status: 504, statusText: "Offline and not cached" });
    }
  });
}
function sliceCached(cached, rangeHeader) {
  return __async(this, null, function* () {
    const buf = yield cached.arrayBuffer();
    const parsed = POLICY.parseRange(rangeHeader, buf.byteLength);
    if (parsed === null) return new Response(buf, { status: 200, headers: cached.headers });
    if (parsed === "unsatisfiable") return null;
    const body = buf.slice(parsed.start, parsed.end + 1);
    return new Response(body, {
      status: 206,
      statusText: "Partial Content",
      headers: POLICY.partialHeaders(
        parsed.start,
        parsed.end,
        buf.byteLength,
        cached.headers.get("content-type")
      )
    });
  });
}
function storeContent(cache, request, response) {
  return __async(this, null, function* () {
    const len = Number(response.headers.get("content-length")) || 0;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const { usage, quota } = yield navigator.storage.estimate();
        if (POLICY.needsEviction(usage || 0, len, quota || 0)) yield evictOldest(cache, len);
      }
    } catch (e) {
    }
    try {
      yield cache.put(request, response);
    } catch (e) {
      yield evictOldest(cache, len);
      try {
        yield cache.put(request, response);
      } catch (e2) {
      }
    }
  });
}
function evictOldest(cache, needBytes) {
  return __async(this, null, function* () {
    const keys = yield cache.keys();
    let freed = 0;
    for (const key of keys) {
      const hit = yield cache.match(key);
      const size = hit ? Number(hit.headers.get("content-length")) || 0 : 0;
      yield cache.delete(key);
      freed += size;
      if (freed >= needBytes) break;
    }
  });
}
