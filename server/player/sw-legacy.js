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
const CACHE_NAME = "rd-player-v31";
const CONTENT_CACHE = "rd-content-v1";
const SITE_CACHE_STORE = "rd-site-cache-v1";
const SITE_CACHE_KEY = "/__st_site_cache__";
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
      keys.filter((k) => k !== CACHE_NAME && k !== CONTENT_CACHE && k !== SITE_CACHE_STORE).map((k) => caches.delete(k))
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
  if (data && data.type === "st-device-deleted" && Array.isArray(data.keep)) {
    prefetchChain = prefetchChain.then(() => pruneToPlaylist(data.keep, data.scope)).catch(() => {
    });
    return;
  }
  if (data && data.type === "st-cache-status" && Array.isArray(data.urls) && event.ports && event.ports[0]) {
    const port = event.ports[0];
    cacheStatus(data.urls).then((s) => port.postMessage(s), (e) => port.postMessage({ error: String(e && e.message || e) }));
    return;
  }
  if (data && data.type === "st-site-cache") {
    setSiteCache(data.config, data.scope);
    return;
  }
  if (!data || data.type !== "st-cache-playlist" || !Array.isArray(data.urls)) return;
  if (data.prune && data.urls.length > 0) {
    prefetchChain = prefetchChain.then(() => pruneToPlaylist(data.urls, data.scope)).catch(() => {
    });
  }
  for (const url of data.urls) {
    if (typeof url !== "string" || !POLICY || !POLICY.isCacheableContent(url, "GET")) continue;
    if (prefetching.has(url)) continue;
    prefetching.add(url);
    prefetchChain = prefetchChain.then(() => ensureCached(url)).catch(noteCacheError).then(() => {
      prefetching.delete(url);
    });
  }
});
let lastCacheError = null;
function noteCacheError(e) {
  if (!e) return;
  lastCacheError = { name: String(e.name || "Error").slice(0, 40), message: String(e.message || "").slice(0, 160), at: Date.now() };
}
function cacheStatus(urls) {
  return __async(this, null, function* () {
    const cache = yield caches.open(CONTENT_CACHE);
    const out = { wanted: 0, ready: 0, ready_bytes: 0, partial: 0, partial_bytes: 0, usage: null, quota: null, error: lastCacheError };
    const seen = /* @__PURE__ */ new Set();
    for (const url of urls.slice(0, 500)) {
      if (typeof url !== "string" || seen.has(url) || !POLICY || !POLICY.isCacheableContent(url, "GET")) continue;
      seen.add(url);
      out.wanted++;
      const asset = yield cachedAsset(cache, url);
      if (asset) {
        out.ready++;
        out.ready_bytes += asset.blob.size;
        continue;
      }
      const metaHit = yield cache.match(POLICY.chunkKey(url, "meta"));
      if (!metaHit) continue;
      let meta = null;
      try {
        meta = yield metaHit.json();
      } catch (e) {
        meta = null;
      }
      if (!meta || !(meta.total > 0)) continue;
      let have = 0;
      for (const r of POLICY.chunkRanges(meta.total, meta.chunk > 0 ? meta.chunk : POLICY.CHUNK_BYTES)) {
        const hit = yield cache.match(POLICY.chunkKey(url, r.start));
        if (hit) have += Number(hit.headers.get("content-length")) || r.end - r.start + 1;
      }
      if (have > 0) {
        out.partial++;
        out.partial_bytes += have;
      }
    }
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = yield navigator.storage.estimate();
        out.usage = Number(est.usage) || 0;
        out.quota = Number(est.quota) || 0;
      }
    } catch (e) {
    }
    return out;
  });
}
function putChunk(cache, key, blob) {
  return __async(this, null, function* () {
    yield cache.put(key, new Response(blob, { headers: { "Content-Length": String(blob.size) } }));
  });
}
function ensureCached(url) {
  return __async(this, null, function* () {
    const cache = yield caches.open(CONTENT_CACHE);
    if (yield cachedAsset(cache, url)) {
      yield sweepOldRevisions(cache, url);
      return;
    }
    const fromSite = yield siteCacheFetch(url, { wait: true });
    if (fromSite) {
      yield storeContent(cache, new Request(url), fromSite);
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
      meta = { total: cr.total, validator: POLICY.validatorOf(probe.headers), type: probe.headers.get("Content-Type") || "", chunk: POLICY.CHUNK_BYTES };
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
      yield putChunk(cache, POLICY.chunkKey(url, 0), yield probe.blob());
    }
    const chunkSize = meta.chunk > 0 ? meta.chunk : POLICY.CHUNK_BYTES;
    const ranges = POLICY.chunkRanges(meta.total, chunkSize);
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
      yield putChunk(cache, key, yield response.blob());
    }
    let size = 0;
    for (const r of ranges) {
      const hit = yield cache.match(POLICY.chunkKey(url, r.start));
      if (!hit) return;
      size += (yield hit.blob()).size;
    }
    if (size !== meta.total) {
      yield dropChunks(cache, url);
      return;
    }
    yield cache.put(POLICY.chunkKey(url, "done"), new Response(JSON.stringify({
      total: meta.total,
      type: meta.type || "",
      chunk: chunkSize
    }), { headers: { "Content-Type": "application/json" } }));
    yield sweepOldRevisions(cache, url);
  });
}
const KEEP_SCOPES_KEY = "/__st_keep_scopes__";
const KEEP_SCOPE_DAYS = 14;
function keepSetFor(urls, scope) {
  return __async(this, null, function* () {
    const key = typeof scope === "string" ? scope.slice(0, 64) : "";
    let scopes = {};
    try {
      const store = yield caches.open(SITE_CACHE_STORE);
      const hit = yield store.match(KEEP_SCOPES_KEY);
      if (hit) scopes = (yield hit.json()) || {};
      scopes[key] = { urls, at: Date.now() };
      for (const k of Object.keys(scopes)) {
        if (!scopes[k] || !Array.isArray(scopes[k].urls) || Date.now() - (scopes[k].at || 0) > KEEP_SCOPE_DAYS * 864e5) delete scopes[k];
      }
      yield store.put(KEEP_SCOPES_KEY, new Response(JSON.stringify(scopes), { headers: { "Content-Type": "application/json" } }));
    } catch (e) {
      scopes = { [key]: { urls } };
    }
    const all = /* @__PURE__ */ new Set();
    for (const k of Object.keys(scopes)) for (const u of scopes[k].urls) all.add(u);
    return all;
  });
}
function pruneToPlaylist(urls, scope) {
  return __async(this, null, function* () {
    const cache = yield caches.open(CONTENT_CACHE);
    const keep = yield keepSetFor(urls, scope);
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
function cachedAsset(cache, url) {
  return __async(this, null, function* () {
    const whole = yield cache.match(url, { ignoreVary: true });
    if (whole) {
      const blob2 = yield whole.blob();
      return { blob: blob2, type: whole.headers.get("content-type") || blob2.type || "" };
    }
    const doneKey = POLICY.chunkKey(url, "done");
    const done = yield cache.match(doneKey);
    if (!done) return null;
    let meta = null;
    try {
      meta = yield done.json();
    } catch (e) {
      meta = null;
    }
    if (!meta || !(meta.total > 0) || !(meta.chunk > 0)) {
      yield cache.delete(doneKey);
      return null;
    }
    const parts = [];
    for (const r of POLICY.chunkRanges(meta.total, meta.chunk)) {
      const hit = yield cache.match(POLICY.chunkKey(url, r.start));
      if (!hit) {
        yield cache.delete(doneKey);
        return null;
      }
      parts.push(yield hit.blob());
    }
    const blob = new Blob(parts, { type: meta.type || "application/octet-stream" });
    if (blob.size !== meta.total) {
      yield dropChunks(cache, url);
      return null;
    }
    return { blob, type: meta.type || "" };
  });
}
function respondFromBlob(asset, range) {
  const size = asset.blob.size;
  const parsed = range ? POLICY.parseRange(range, size) : null;
  if (parsed === "unsatisfiable") return null;
  if (parsed === null) {
    const headers = { "Content-Length": String(size), "Accept-Ranges": "bytes" };
    if (asset.type) headers["Content-Type"] = asset.type;
    return new Response(asset.blob, { status: 200, headers });
  }
  return new Response(asset.blob.slice(parsed.start, parsed.end + 1), {
    status: 206,
    statusText: "Partial Content",
    headers: POLICY.partialHeaders(parsed.start, parsed.end, size, asset.type)
  });
}
function handleContent(request) {
  return __async(this, null, function* () {
    const range = request.headers.get("range");
    const cache = yield caches.open(CONTENT_CACHE);
    const cached = yield cachedAsset(cache, request.url);
    if (cached) {
      const served = respondFromBlob(cached, range);
      if (served) return served;
    }
    yield loadSiteCache();
    const siteEntry = siteEntryFor(request.url);
    if (siteEntry && siteEntry.size <= SITE_INLINE_MAX_BYTES) {
      const fromSite = yield siteCacheFetch(request.url, { wait: false });
      if (fromSite) {
        try {
          yield storeContent(cache, new Request(request.url), fromSite.clone());
          const stored = yield cachedAsset(cache, request.url);
          if (stored) {
            const served = respondFromBlob(stored, range);
            if (served) return served;
          }
        } catch (e) {
        }
        if (!range) return fromSite;
      }
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
      if (cached) return respondFromBlob(cached, null);
      return new Response("", { status: 504, statusText: "Offline and not cached" });
    }
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
        noteCacheError(e2);
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
const SITE_MAX_BYTES = 768 * 1024 * 1024;
const SITE_INLINE_MAX_BYTES = 64 * 1024 * 1024;
const SITE_FIRST_BYTE_MS = 4e3;
const SITE_DOWN_MS = 60 * 1e3;
const SITE_WARM_WAIT_MS = 3 * 60 * 1e3;
let siteCaches = {};
let siteCacheLoaded = null;
let siteDownUntil = 0;
function validSiteConfig(c) {
  if (!c || typeof c !== "object" || typeof c.url !== "string" || typeof c.token !== "string") return null;
  if (!/^https?:\/\/[^/?#]+$/.test(c.url)) return null;
  const files = {};
  for (const k of Object.keys(c.files || {})) {
    const f = c.files[k];
    if (f && /^[0-9a-f]{64}$/.test(f.sha256) && f.size >= 0) files[k] = { sha256: f.sha256, size: Number(f.size) };
  }
  return { url: c.url, token: c.token, expires_at: Number(c.expires_at) || 0, files };
}
function setSiteCache(config, scope) {
  const sc = validSiteConfig(config);
  const key = typeof scope === "string" ? scope.slice(0, 64) : "";
  const apply = () => {
    if (sc) siteCaches[key] = sc;
    else delete siteCaches[key];
    siteDownUntil = 0;
    return caches.open(SITE_CACHE_STORE).then((c) => Object.keys(siteCaches).length ? c.put(SITE_CACHE_KEY, new Response(JSON.stringify({ scopes: siteCaches }), { headers: { "Content-Type": "application/json" } })) : c.delete(SITE_CACHE_KEY)).catch(() => {
    });
  };
  siteCacheLoaded = loadSiteCache().then(apply);
}
function loadSiteCache() {
  if (!siteCacheLoaded) {
    siteCacheLoaded = caches.open(SITE_CACHE_STORE).then((c) => c.match(SITE_CACHE_KEY)).then((r) => r ? r.json() : null).then((j) => {
      const stored = j && j.scopes && typeof j.scopes === "object" ? j.scopes : j ? { "": j } : {};
      for (const k of Object.keys(stored)) {
        const v = validSiteConfig(stored[k]);
        if (v && !(k in siteCaches)) siteCaches[k] = v;
      }
    }).catch(() => {
    });
  }
  return siteCacheLoaded;
}
function siteEntryFor(url) {
  let p;
  try {
    p = new URL(url, self.location.href).pathname;
  } catch (e) {
    return null;
  }
  for (const k of Object.keys(siteCaches)) {
    const sc = siteCaches[k];
    if (!sc || sc.expires_at && sc.expires_at * 1e3 < Date.now()) continue;
    const f = sc.files[p];
    if (f) return { sha256: f.sha256, size: f.size, box: sc.url, token: sc.token };
  }
  return null;
}
function hexOf(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return s;
}
function siteCacheOnce(entry) {
  return __async(this, null, function* () {
    if (Date.now() < siteDownUntil) return null;
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), SITE_FIRST_BYTE_MS);
    let res;
    try {
      res = yield fetch(entry.box + "/cache/" + entry.sha256, {
        headers: { Authorization: "Bearer " + entry.token },
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      siteDownUntil = Date.now() + SITE_DOWN_MS;
      return null;
    }
    clearTimeout(timer);
    if (res.status === 503) {
      const ra = parseInt(res.headers.get("Retry-After") || "15", 10);
      return { warming: true, retryMs: Math.min(30, Math.max(2, ra || 15)) * 1e3 };
    }
    if (res.status === 404) return { missing: true };
    if (res.status !== 200) return null;
    timer = setTimeout(() => ctrl.abort(), 1e4 + Math.ceil(entry.size / (512 * 1024)) * 1e3);
    let buf;
    try {
      buf = yield res.arrayBuffer();
    } catch (e) {
      clearTimeout(timer);
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (buf.byteLength !== entry.size) return null;
    let hex = null;
    try {
      hex = hexOf(yield crypto.subtle.digest("SHA-256", buf));
    } catch (e) {
      hex = null;
    }
    if (hex !== entry.sha256) {
      console.warn("[site-cache] bytes from the cache did not match their sha256; using the origin");
      return null;
    }
    return { response: new Response(buf, { status: 200, headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/octet-stream",
      "Content-Length": String(entry.size),
      "X-ST-Source": "site-cache"
    } }) };
  });
}
function siteCacheFetch(_0, _1) {
  return __async(this, arguments, function* (url, { wait }) {
    try {
      yield loadSiteCache();
      const entry = siteEntryFor(url);
      if (!entry || entry.size > SITE_MAX_BYTES) return null;
      const until = Date.now() + SITE_WARM_WAIT_MS;
      let askedAgain = false;
      for (; ; ) {
        const r = yield siteCacheOnce(entry);
        if (!r) return null;
        if (r.response) return r.response;
        if (!wait) return null;
        let pause;
        if (r.warming) pause = r.retryMs;
        else if (r.missing && !askedAgain) {
          askedAgain = true;
          pause = 12e3;
        } else return null;
        if (Date.now() + pause > until) return null;
        yield new Promise((resolve) => setTimeout(resolve, pause));
        if (!siteEntryFor(url)) return null;
      }
    } catch (e) {
      return null;
    }
  });
}
