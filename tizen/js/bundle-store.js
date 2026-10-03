/*
 * BundleStore — offline storage for the server's flattened HTML-bundle renders, on Tizen.
 *
 * ⚠️ WHY THIS EXISTS SEPARATELY FROM MediaCache. That cache downloads a bundle's `.zip` like any
 * other asset, and nothing in this runtime can open one. What goes on screen is the server's single
 * self-contained document at /api/content/:id/bundle — a different URL the media cache has never
 * heard of. Without this, a bundle plays only while the server is reachable, which is the one thing
 * a signage player is not allowed to require.
 *
 * ⚠️ AND THERE IS NO SERVICE WORKER HERE. The web player gets offline bundles for free by fetching
 * the render same-origin and letting sw.js cache it; this widget runs from an app:// origin where
 * a worker is unavailable (see media-cache.js). So the storage has to be explicit, and it is the
 * same tizen.filesystem surface MediaCache already depends on — probed the same way, because a
 * runtime that half-supports it produces a cache that half works.
 *
 * ⚠️ UNVERIFIED ON A PANEL. Written against the same API MediaCache uses successfully, but nobody
 * has run it on real Samsung hardware — consistent with tizen/README.md's own note that the player
 * has never been on a real panel. The caller treats every method here as best-effort and falls back
 * to the network path, so a total failure of this file costs the offline case and nothing else.
 *
 * ES5 only, no build step, and deliberately NOT a UMD module: on a runtime that exposes `module`
 * to classic scripts, a `typeof module === 'object'` export takes the CommonJS branch and never
 * assigns the browser global — which has silently broken shared modules in this project before.
 */
(function (root) {
  'use strict';

  var DIR = 'wgt-private/st-bundles';
  /* A single document, generously bounded. The server caps its own inlining well below this, so
   * reaching it means something is wrong rather than merely large. */
  var MAX_BYTES = 24 * 1024 * 1024;

  function fsm() {
    try {
      return (typeof tizen !== 'undefined' && tizen.filesystem) ? tizen.filesystem : null;
    } catch (e) { return null; }
  }

  function usable() {
    var f = fsm();
    return !!(f && typeof f.openFile === 'function' && typeof f.pathExists === 'function');
  }

  /** The one place the on-disk name is decided, so reader and pruner cannot disagree. */
  function nameFor(contentId, rev) { return contentId + '.' + (rev || 0) + '.html'; }
  function pathFor(contentId, rev) { return DIR + '/' + nameFor(contentId, rev); }

  /**
   * The cached document for this EXACT revision, or null.
   *
   * Keyed on rev because a replaced archive keeps its id, its filename and its URL — the revision
   * is the only thing that can tell a panel its copy is out of date.
   */
  function load(contentId, rev) {
    if (!usable() || !contentId) return null;
    var f = fsm(), fh = null;
    try {
      var p = pathFor(contentId, rev);
      if (!f.pathExists(p)) return null;
      fh = f.openFile(p, 'r', false);
      if (!fh || typeof fh.readString !== 'function') return null;
      var s = fh.readString();
      return (s && s.length) ? s : null;
    } catch (e) {
      return null;
    } finally {
      if (fh) { try { fh.close(); } catch (e2) { /* already gone */ } }
    }
  }

  /** Store a render. Returns true only when it is really on disk. */
  function save(contentId, rev, html) {
    if (!usable() || !contentId || !html || html.length > MAX_BYTES) return false;
    var f = fsm(), fh = null;
    try {
      // makeParents:true creates wgt-private/st-bundles on first use, exactly as MediaCache does.
      fh = f.openFile(pathFor(contentId, rev), 'w', true);
      if (!fh || typeof fh.writeString !== 'function') return false;
      fh.writeString(html);
      if (typeof fh.flush === 'function') fh.flush();
      return true;
    } catch (e) {
      return false;                        // no space, no permission — all "did not store"
    } finally {
      if (fh) { try { fh.close(); } catch (e2) { /* already gone */ } }
    }
  }

  /* Which stored names are superseded copies of this bundle. Pure, so it can be tested in Node. */
  function isSupersededName(name, contentId, keepRev) {
    if (!name || name.indexOf(contentId + '.') !== 0) return false;
    if (name.length < 6 || name.slice(-5) !== '.html') return false;
    return name !== nameFor(contentId, keepRev);
  }

  /** Delete every other revision of this bundle, and optionally everything not in the playlist. */
  function prune(liveIds, currentRevs) {
    if (!usable()) return;
    var f = fsm();
    try {
      if (typeof f.listDirectory !== 'function' && typeof f.resolve !== 'function') return;
      f.resolve(DIR, function (d) {
        var entries;
        try { entries = d.listFiles(); } catch (e) { return; }
        for (var i = 0; i < entries.length; i++) {
          var n = entries[i].name;
          var id = n.split('.')[0];
          var stale = false;
          if (liveIds && liveIds.indexOf(id) === -1) stale = true;
          else if (currentRevs && currentRevs[id] !== undefined && isSupersededName(n, id, currentRevs[id])) stale = true;
          if (stale) { try { f.deleteFile(DIR + '/' + n, function () {}, function () {}); } catch (e2) { /* best effort */ } }
        }
      }, function () { /* directory not there yet */ }, 'rw');
    } catch (e) { /* reclaim is best-effort */ }
  }

  root.BundleStore = {
    available: usable,
    load: load,
    save: save,
    prune: prune,
    nameFor: nameFor,
    isSupersededName: isSupersededName,
    DIR: DIR,
    MAX_BYTES: MAX_BYTES
  };
}(typeof self !== 'undefined' ? self : this));
