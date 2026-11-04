(function (global) {
  'use strict';
  var bridge = global.__STNative = global.__STNative || {};
  var directory = '/mtd_down/common/screentinker_media';
  var queue = [], current = null, desired = null, apply = null, timer = null, downloadedForUpdate = false;
  var index = {}, fs, downloader, stateGeneration = 0, videoGeneration = 0, videoTimer = null, videoActive = false, gaplessPlugin = null, gaplessSession = null, gaplessGeneration = 0;
  var statePrefix = '/mtd_down/common/screentinker/state-', bootEventPath = '/mtd_down/common/screentinker/boot-event.json', reportTimes = {}, captureSequence = 0, heldFrame = null;
  var currentBuild = parseInt('__ST_BUILD__', 10) || 0;
  var videoBackgrounds = null;
  /* Direct media cache (2026-11-04, builds 1300+): the 2012 SEF downloader was
   * proven against plain static servers, but this CMS answers /uploads/content
   * through a proxy layer that can redirect or stream — beyond the downloader,
   * which reports completion while nothing lands (the "download completed, but
   * the local file was not found" DB48E failure). Small media now rides the
   * panel's own XHR + verified write instead, the exact machinery the template
   * widget cache already proved on this hardware. Cap protects 2012 Maple RAM. */
  var SELF_MEDIA_MAX_BYTES = 4 * 1024 * 1024, lastDownResult = '';
  // Bump when the server's legacy widget envelope changes. Widget revision
  // tracks author content, not renderer compatibility, so it cannot invalidate
  // an old srcdoc-based file already cached on an SSSP3 panel.
  var widgetCacheVersion = '5';
  function hash(value) {
    var a = 2166136261, b = 5381, i;
    for (i = 0; i < value.length; i++) { a = ((a ^ value.charCodeAt(i)) * 16777619) >>> 0; b = (((b << 5) + b) ^ value.charCodeAt(i)) >>> 0; }
    return a.toString(36) + b.toString(36);
  }
  function key(item) { return hash(JSON.stringify(item.widget_id ? [item.widget_id, item.widget_rev, item.widget_type, widgetCacheVersion] : [item.content_id, item.filepath, item.content_rev, item.remote_url, item.file_size, item.fill_fit || '', item.fill_width || 0, item.fill_height || 0])); }
  function path(item) {
    if (item.widget_id) return directory + '/' + key(item) + '.html';
    var match = /\.([a-z0-9]{1,8})(?:$|\?)/i.exec(String(item.filepath || item.filename || ''));
    // SVG fitted into a zone is fetched as a raster PNG; preserving `.svg`
    // locally makes this legacy renderer parse PNG bytes as XML.
    var ext = match ? match[1].toLowerCase() : 'bin';
    if (ext === 'svg' && item.fill_width > 0 && item.fill_height > 0) ext = 'png';
    return directory + '/' + key(item) + '.' + ext;
  }
  function exists(name) {
    var f;
    try { f = fs.openCommonFile(name.replace(/^\/mtd_down\/common\//, ''), 'r'); if (f) { fs.closeCommonFile(f); return true; } } catch (ignore) {}
    try { f = fs.openCommonFile(name, 'r'); if (!f) return false; fs.closeCommonFile(f); return true; } catch (ignore2) { return false; }
  }
  function cached(item) { var name = path(item); return index[key(item)] === name && exists(name); }
  function source(item) {
    if (item.widget_id) {
      var cfg = {}; try { cfg = JSON.parse(global.localStorage.getItem('rd_web_player') || '{}'); } catch (ignore) {}
      return bridge.base + '/api/widgets/' + encodeURIComponent(item.widget_id) + '/render?device=' + encodeURIComponent(cfg.deviceId || '') + '&rev=' + encodeURIComponent(item.widget_rev || 0) + '&compat=sssp1228';
    }
    if (item.remote_url) return item.remote_url;
    if (item.sssp3_rendition_url) return bridge.base + item.sssp3_rendition_url;
    /* 1302: the 2012 transports fail against the wrapped /uploads/content chain
     * (SEF call 3246 + phantom completion; XHR empty at ~190 KB) while the same
     * panel lands the launcher ZIP from plain static every time. Media rides
     * the bare mirror route mounted beside the launcher static instead. */
    return bridge.base + '/player/sssp3-native-candidate/media/' + encodeURIComponent(item.filepath);
  }
  function supported(item) {
    var mime = String(item && item.mime_type || '').toLowerCase();
    return item && (item.widget_id
      /* 'template' joined 2026-11-04 (cache gate, NOT the paint gate): template widgets
       * cache through the self-contained pipeline below, not the plain downloader. The
       * server renders the slide with editable values BAKED INTO one HTML document,
       * and its packaged assets (tpl: images) already arrive as data URIs — so the
       * only things the panel itself must inline are operator-uploaded content
       * images (<512 KB each), or the offline frame degrades to text+layout only.
       * Validated offline on the DB48E before any fleet wave. */
      ? /^(clock|text|weather|rss|social|directory-board|directory-search|menu-board|room-display|template)$/.test(String(item.widget_type || ''))
      : !item.remote_url && item.filepath && (/^image\/(jpeg|png|gif|bmp|webp|svg\+xml)$/.test(mime) || mime === 'video/mp4'));
  }
  /* A widget can be safe to paint while still being unsuitable for offline
     caching. Keep that distinction explicit: the list below is the runtime
     surface proven on the DB48E, while supported() remains the cache gate. */
  bridge.canRender = function (item) {
    if (!item || !item.widget_id) return supported(item);
    // 'template' joined 2026-11-03: the CMS template gallery publishes editable
    // template widgets (widget_type 'template', config {template, values}) — a
    // plain iframe render, same engine as text/webpage. Hardware-validated on a
    // DB48E running this build: the Arabic clinic directory template renders
    // correctly (RTL shaping, colors, layout) from the device's own playlist.
    // Failure mode analysis: a template whose CSS is too modern for the 2012
    // Maple browser degrades to a still frame at worst — the widget is gated
    // server-side, not here — never a broken screen. Validate on hardware
    // before widening further.
    return /^(clock|text|weather|rss|social|directory-board|directory-search|menu-board|room-display|radar|webpage|diag-smoothness|template)$/.test(String(item.widget_type || ''));
  };
  function reportPlaylist(message) {
    try { var cfg = JSON.parse(global.localStorage.getItem('rd_web_player') || '{}'); if (cfg.deviceId) bridge.report('playlist', message, cfg.deviceId); } catch (ignore) {}
  }
  function deviceId() {
    try { return JSON.parse(global.localStorage.getItem('rd_web_player') || '{}').deviceId || ''; } catch (ignore) { return ''; }
  }
  function traceVideo(event, session, extra) {
    var data = { event: event, at_utc_ms: Date.now(), generation: session ? session.generation : null };
    var k;
    if (session) {
      data.started_at_utc_ms = session.startedAt;
      data.rendered_at_utc_ms = session.renderedAt || null;
      data.gap_ms = session.renderedAt ? session.renderedAt - session.startedAt : null;
    }
    if (extra) for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) data[k] = extra[k];
    bridge.report('video-lifecycle', JSON.stringify(data), deviceId());
  }
  function status(message) {
    var el = document.getElementById('st-media-diagnostic');
    if (!el) { el = document.createElement('div'); el.id = 'st-media-diagnostic'; el.style.cssText = 'position:fixed;left:20px;top:20px;z-index:2147483647;background:#111;color:#fff;font:24px Arial;padding:12px;max-width:90%'; document.body.appendChild(el); }
    el.textContent = message; el.style.display = 'block';
  }
  bridge.frameReady = function () { var el = document.getElementById('st-media-diagnostic'); if (el) el.style.display = 'none'; };
  function finish() {
    var callback = apply, payload = desired;
    if (!callback || !payload) return;
    if (bridge.missing(payload).length) { bridge.error = 'Some media could not be cached; retaining previous playlist.'; status(bridge.error); reportPlaylist(bridge.error); return; }
    reportPlaylist('Applying playlist with ' + (payload.assignments || []).length + ' items');
    desired = null; apply = null;
    /* Commit a plan only after every supported dependency is locally verified.
       A power loss during preparation therefore leaves the prior complete plan
       and never an interval pointing at a partial cache. */
    try {
      if (Object.prototype.hasOwnProperty.call(payload, 'offline_plan')) global.localStorage.setItem('st_offline_plan', JSON.stringify(payload.offline_plan || null));
      /* The renderer keeps an assigned playlist ahead of this image, but the
       * standby choice is still part of the durable offline state.  Save it
       * before the cache journal so a restart cannot observe a new index with
       * an old (or absent) default. */
      if (Object.prototype.hasOwnProperty.call(payload, 'default_content')) global.localStorage.setItem('st_default_content', JSON.stringify(payload.default_content || null));
      bridge.persistStorage();
    } catch (ignore) {}
    if (downloadedForUpdate) { payload.__nativeMediaChanged = true; status('Media cached. Starting playback...'); } downloadedForUpdate = false; callback(payload);
  }
  function queueDownload(entry) {
    try {
      lastDownResult = String(downloader.StartDownFile(source(entry.item), path(entry.item)));
      timer = setTimeout(function () { bridge.error = 'Download timed out; waiting for Samsung downloader.'; status(bridge.error); reportPlaylist(bridge.error); try { if (downloader.CancelDownload) downloader.CancelDownload(); } catch (ignore) {} }, 120000);
    } catch (e) { fail(String(e)); }
  }
  function selfFetchable(item) {
    return !!item && !item.widget_id && !item.remote_url
      && /^image\//.test(String(item.mime_type || '').toLowerCase())
      && Number(item.file_size) > 0 && Number(item.file_size) <= SELF_MEDIA_MAX_BYTES;
  }
  function directFetch(entry) {
    lastDownResult = 'direct';
    var url = source(entry.item);
    stXhr(url, true, function (bytes) {
      if (current !== entry) return; /* a newer accept() replaced this job */
      if (bytes.length > SELF_MEDIA_MAX_BYTES) {
        reportPlaylist('Direct cache skipped, ' + bytes.length + ' B exceeds cap; using Samsung downloader for ' + url);
        queueDownload(entry);
        return;
      }
      if (!bytes.length || !writeCommonFile(path(entry.item), String(bytes))) {
        reportPlaylist('Direct cache not possible (' + (!bytes.length ? 'empty response' : 'write verification failed') + '); using Samsung downloader for ' + url);
        queueDownload(entry);
        return;
      }
      index[key(entry.item)] = path(entry.item); downloadedForUpdate = true;
      try { bridge.persistStorage(); } catch (ignore) {}
      reportPlaylist('Media cached directly (' + String(bytes).length + ' B verified write): ' + url);
      status('Media cached.');
      current = null; next();
    }, function (why) {
      if (current !== entry) return;
      /* The template pipeline is allowed three XHR tries; media fetches get the
       * same courtesy, and every attempt leaves the URL + cause in the debug
       * rows so the next hardware leg is a verdict row, not a guess. */
      entry.directTries = (entry.directTries || 0) + 1;
      if (entry.directTries < 3) {
        reportPlaylist('Direct fetch ' + url + ' failed (' + why + '), retry ' + entry.directTries + '/3');
        setTimeout(function () { if (current === entry) directFetch(entry); }, entry.directTries * 1500);
        return;
      }
      reportPlaylist('Direct fetch gave up after 3 tries (' + why + '); using Samsung downloader for ' + url);
      queueDownload(entry);
    });
  }
  function next() {
    if (current) return;
    if (!queue.length) { if (selfBusy()) return; finish(); return; }
    current = queue.shift();
    status('Downloading: ' + (current.item.filename || current.item.filepath || 'media'));
    if (selfFetchable(current.item)) { directFetch(current); return; }
    queueDownload(current);
  }
  function fail(reason) {
    var failed = current;
    clearTimeout(timer); current = null;
    if (failed && failed.cancelRequested) { next(); return; }
    bridge.error = reason; status('Download error: ' + reason); reportPlaylist('Download error: ' + reason);
    if (failed && failed.tries < 3) { failed.tries++; setTimeout(function () { if (desired && bridge.missing(desired).some(function (item) { return key(item) === key(failed.item); })) queue.push(failed); next(); }, failed.tries * 2000); }
    else next();
  }
  global.STNativeDownloadComplete = function (result) {
    var done = current;
    if (!done) return;
    var fields = String(result).split('?');
    if (fields[0] === '1001' || fields[0] === '1002') return;
    clearTimeout(timer);
    /* The DB48E completes with 1000?9 as well as 1000?1.  Keep ?0 as a
     * failure; existence below remains the final file gate. */
    if (fields[0] !== '1000' || (fields[1] !== '1' && fields[1] !== '9')) return fail('download failed: ' + String(result));
    if (!exists(path(done.item))) {
      /* Gate stays final, but before failing, probe the source with the panel's
       * own browser engine (template-cache proven) and heal the item locally
       * when the bytes are direct-cache sized. This turns the firmware's lying
       * completion into a working cache instead of another dead boot. */
      var healUrl = source(done.item);
      stXhr(healUrl, true, function (bytes) {
        if (current !== done) return;
        if (bytes.length && bytes.length <= SELF_MEDIA_MAX_BYTES && writeCommonFile(path(done.item), String(bytes))) {
          index[key(done.item)] = path(done.item); downloadedForUpdate = true; current = null;
          try { bridge.persistStorage(); } catch (ignore) {}
          reportPlaylist('Media healed by direct cache after Samsung completion without file (' + String(bytes).length + ' B verified write): ' + healUrl);
          return next();
        }
        fail('download completed, but the local file was not found: ' + path(done.item) + ' for ' + healUrl + ' (downloader call=' + lastDownResult + ', direct heal refused: ' + (bytes.length > SELF_MEDIA_MAX_BYTES ? bytes.length + ' B exceeds the 4 MB direct-cache cap' : 'verify read-back mismatch') + ')');
      }, function (why) {
        fail('download completed, but the local file was not found: ' + path(done.item) + ' for ' + healUrl + ' (downloader call=' + lastDownResult + ', source probe: ' + why + ')');
      });
      return;
    }
    index[key(done.item)] = path(done.item); downloadedForUpdate = true; current = null; bridge.persistStorage(); next();
  };
  function readStateSlot(slot) {
    var f, envelope;
    try {
      f = fs.openCommonFile(statePrefix + slot + '.json', 'r');
      if (!f) return null;
      envelope = JSON.parse(f.readAll()); fs.closeCommonFile(f);
      if (!envelope || typeof envelope.generation !== 'number' || typeof envelope.data !== 'string' || envelope.checksum !== hash(envelope.data)) return null;
      JSON.parse(envelope.data);
      return envelope;
    } catch (ignore) { return null; }
  }
  bridge.readState = function () {
    var a = readStateSlot(0), b = readStateSlot(1), latest = !a ? b : !b ? a : a.generation >= b.generation ? a : b;
    if (!latest) return null;
    stateGeneration = latest.generation;
    return JSON.parse(latest.data);
  };
  bridge.writeState = function (state) {
    var data = JSON.stringify(state), generation = stateGeneration + 1, f, checked;
    try {
      f = fs.openCommonFile(statePrefix + (generation % 2) + '.json', 'w');
      if (!f) return false;
      f.writeAll(JSON.stringify({ generation: generation, data: data, checksum: hash(data) }));
      fs.closeCommonFile(f);
      checked = readStateSlot(generation % 2);
      if (!checked || checked.generation !== generation || checked.data !== data) return false;
      stateGeneration = generation;
      return true;
    } catch (ignore) { return false; }
  };
  bridge.init = function () {
    fs = new FileSystem();
    try { fs.createCommonDir('/mtd_down/common/screentinker'); } catch (ignore) {}
    /* The downloader writes an absolute common-filesystem path.  Creating a
     * relative directory here can succeed in a different plugin namespace,
     * then leave its actual destination absent on DB48E. */
    try { fs.createCommonDir(directory); } catch (ignore2) {}
    downloader = document.getElementById('NativeDownloader');
    if (!downloader || !downloader.StartDownFile) throw new Error('Samsung downloader unavailable');
    downloader.OnComplete = 'STNativeDownloadComplete';
  };
  bridge.persistStorage = function () {
    var keys = ['rd_web_player', 'rd_playlist_cache', 'rd_layout_cache', 'st_group_sync', 'st_install_id', 'st_schedule_timezone', 'st_schedule_timezone_table', 'st_clock_offset', 'st_active_schedule', 'st_offline_plan', 'st_default_content', 'st_native_gapless'], saved = {}, i;
    try { for (i = 0; i < keys.length; i++) saved[keys[i]] = global.localStorage.getItem(keys[i]); saved.__cacheIndex = index; return bridge.writeState(saved); } catch (ignore) { return false; }
  };
  bridge.restoreStorage = function () {
    var saved = bridge.readState(), key, file, previous, existing;
    if (!saved) {
      try {
        file = fs.openCommonFile('/mtd_down/common/screentinker/state.json', 'r');
        previous = JSON.parse(file.readAll()); fs.closeCommonFile(file);
        existing = JSON.parse(global.localStorage.getItem('rd_web_player') || '{}');
        if (previous.deviceId && previous.deviceToken && !existing.deviceId) {
          existing.deviceId = previous.deviceId; existing.deviceToken = previous.deviceToken;
          existing.pairingCode = previous.pairingCode; existing.paired = true;
          existing.serverUrl = existing.serverUrl || bridge.base;
          global.localStorage.setItem('rd_web_player', JSON.stringify(existing));
          bridge.persistStorage();
        }
      } catch (ignore) {}
      return;
    }
    if (saved.__cacheIndex && typeof saved.__cacheIndex === 'object') index = saved.__cacheIndex;
    try { for (key in saved) if (key !== '__cacheIndex' && Object.prototype.hasOwnProperty.call(saved, key) && saved[key] !== null) global.localStorage.setItem(key, saved[key]); } catch (ignore) {}
  };
  // Native playlists are opt-in until a panel has passed the controlled decoder test.
  // The strict item-level checks in playGapless remain mandatory even when this is enabled.
  bridge.gaplessEnabled = function () { return global.localStorage.getItem('st_native_gapless') === '1'; };
  function payloadItems(payload) {
    /* default_content is deliberately top-level so changing it does not restart
       active playback. It is still a dependency: without it a paired panel
       loses its configured standby image after an offline restart. */
    var items = payload && payload.assignments ? payload.assignments.slice() : [], future, i;
    if (payload && payload.default_content) items.push(payload.default_content);
    try { future = global.STOfflinePlan && global.STOfflinePlan.dependencies(payload && payload.offline_plan); } catch (ignore) { future = null; }
    if (future && future.length) for (i = 0; i < future.length; i++) items.push(future[i]);
    return items;
  }
  bridge.missing = function (payload) {
    var items = payloadItems(payload), missing = [], seen = {}, i, item, k;
    for (i = 0; i < items.length; i++) { item = items[i]; if (!supported(item)) continue; k = key(item); if (!seen[k] && !cached(item)) { seen[k] = true; missing.push(item); } }
    return missing;
  };
  bridge.mediaUrl = function (item, fallback) { return supported(item) && cached(item) ? 'file://' + path(item) : fallback; };
  bridge.supports = supported;
  bridge.widgetUrl = function (item, fallback) {
    if (!item || !item.widget_id || !supported(item) || !cached(item)) return fallback;
    reportPlaylist('Using cached ' + item.widget_type + ' widget');
    return 'file://' + path(item);
  };
  bridge.accept = function (payload, callback) {
    var pendingRenditions = payloadItems(payload).filter(function (item) { return item && item.sssp3_rendition_state && item.sssp3_rendition_state !== 'ready'; });
    if (pendingRenditions.length) { bridge.error = 'Media rendition is preparing; retaining previous playlist.'; status(bridge.error); reportPlaylist(bridge.error); return; }
    var missing = bridge.missing(payload), i, known = {}, wanted = {}, selfCount = 0;
    for (i = 0; i < missing.length; i++) wanted[key(missing[i])] = true;
    desired = payload; apply = callback;
    queue = queue.filter(function (entry) { return wanted[key(entry.item)]; });
    /* Template widgets divert to the self-contained pipeline (fetch -> inline
     * assets -> verified write); the plain queue keeps handling media and every
     * other cached widget type exactly as before. */
    for (i = 0; i < missing.length; i++) {
      if (selfType(missing[i])) { selfCount++; if (!selfJobs[key(missing[i])]) selfBegin(missing[i]); }
    }
    reportPlaylist('Received playlist with ' + (payload.assignments || []).length + ' items; ' + (missing.length - selfCount) + ' downloads needed, ' + selfCount + ' widget caches pending' + (current ? '; downloader busy' : ''));
    if (!missing.length) { finish(); return; }
    if (current) known[key(current.item)] = true;
    for (i = 0; i < queue.length; i++) known[key(queue[i].item)] = true;
    for (i = 0; i < missing.length; i++) { if (!selfType(missing[i]) && !known[key(missing[i])]) { known[key(missing[i])] = true; queue.push({ item: missing[i], tries: 0 }); } }
    if (current && !wanted[key(current.item)] && !current.cancelRequested && downloader.CancelDownload) {
      current.cancelRequested = true;
      try { downloader.CancelDownload(); } catch (ignore) {}
    }
    next();
  };
  bridge.playVideo = function (item, rect, finished) {
    var player = document.getElementById('NativePlayer'), url = bridge.mediaUrl(item, source(item)), ended = false, generation = ++videoGeneration;
    clearTimeout(videoTimer);
    function end(reason) { if (ended || generation !== videoGeneration) return; ended = true; clearTimeout(videoTimer); if (reason) { bridge.error = reason; status(reason); } bridge.stopVideo(); if (finished) finished(); }
    if (url.indexOf('file://') !== 0) { bridge.error = 'Video is not cached'; return false; }
    try {
      var stage = document.getElementById('playerContainer');
      if (!videoBackgrounds && stage && stage.style && document.body && document.documentElement) {
        videoBackgrounds = [stage.style.background, document.body.style.background, document.documentElement.style.background];
        stage.style.background = document.body.style.background = document.documentElement.style.background = 'transparent';
      }
      player.style.visibility = 'visible'; player.style.left = rect.left + 'px'; player.style.top = rect.top + 'px'; player.style.width = rect.width + 'px'; player.style.height = rect.height + 'px';
      if (videoActive) { try { player.Stop(); } catch (ignore) {} videoActive = false; }
      player.OnBufferingComplete = function () { bridge.frameReady(); };
      player.OnRenderingComplete = function () { end(); };
      player.OnRenderError = function (code) { end('Video error: ' + code); };
      videoActive = true; player.InitPlayer(url);
      // SetDisplayArea clips the LFD rectangle. It does not punch a hole for
      // sibling HTML: a 100% z-pip-1 rect still covers z-pip-2 (1262). Zoned
      // / PiP playback must not call playVideo unless a clipped rect that
      // leaves overlay HTML uncovered is proven.
      player.SetDisplayArea(rect.left, rect.top, rect.width, rect.height); player.SetInitialBuffer(400 * 1024); player.StartPlayback(); bridge.activeRect = rect;
      if (Number(item.duration_sec) > 0) videoTimer = setTimeout(function () { end(); }, Number(item.duration_sec) * 1000);
      return true;
    } catch (error) { end(String(error)); return false; }
  };
  function closeGapless(session, reason) {
    if (!session) return;
    if (session.startTimer) clearTimeout(session.startTimer);
    if (gaplessSession === session) { gaplessSession = null; gaplessPlugin = null; }
    try { session.plugin.Execute('stopplaylist'); } catch (ignore) {}
    try { session.plugin.Close(); } catch (ignore2) {}
    try { if (session.plugin.parentNode) session.plugin.parentNode.removeChild(session.plugin); } catch (ignore3) {}
    traceVideo('gapless.stopped', session, { reason: reason || 'stop' });
  }
  bridge.playGapless = function (items, rect, onItemEnd, onFallback) {
    var plugin, i, result, names = [], muted = null, signature = null, session;
    if (!items || items.length < 2) return false;
    for (i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || item.mime_type !== 'video/mp4' || item.widget_id || item.remote_url || item.transition || item.play_when || item.play_from || item.play_until || (item.schedules && item.schedules.length) || !cached(item)) return false;
      if (item.play_to_end !== true && item.play_to_end !== 1 && (!(Number(item.content_duration) > 0) || !(Number(item.duration_sec) > 0) || Math.abs(Number(item.duration_sec) - Number(item.content_duration)) > 1)) return false;
      if (!item.native_gapless_signature || (signature !== null && signature !== item.native_gapless_signature)) return false;
      signature = item.native_gapless_signature;
      var isMuted = !!item.muted;
      if (muted !== null && muted !== isMuted) return false;
      muted = isMuted; names.push(path(item));
    }
    try {
      plugin = document.createElement('object'); plugin.setAttribute('classid', 'clsid:SAMSUNG-INFOLINK-SEF');
      plugin.style.visibility = 'hidden'; document.body.appendChild(plugin);
      plugin.Open('LFD', '1.000', 'LFD'); plugin.Execute('clearplaylist');
      for (i = 0; i < names.length; i++) plugin.Execute('pushplaylist', names[i]);
      session = { plugin: plugin, generation: ++gaplessGeneration, startedAt: Date.now(), renderedAt: 0, ended: false, fallback: false };
      var current = function () { return gaplessSession === session && session.generation === gaplessGeneration; };
      var rendered = function (source) {
        if (!current() || session.renderedAt) return;
        session.renderedAt = Date.now(); bridge.activeRect = rect; bridge.frameReady();
        traceVideo('gapless.first_frame', session, { source: source });
      };
      var failed = function (reason) {
        if (!current() || session.fallback) return;
        session.fallback = true;
        traceVideo('gapless.start_failed', session, { reason: reason });
        closeGapless(session, reason);
        if (onFallback) onFallback(reason);
      };
      plugin.OnRenderingStart = function () { rendered('OnRenderingStart'); };
      plugin.OnBufferingComplete = function () { traceVideo('gapless.buffering_complete', session); };
      plugin.OnCurrentPlayTime = function (time) { traceVideo('gapless.play_time', session, { time: time }); if (Number(time) > 0) rendered('OnCurrentPlayTime'); };
      plugin.OnRenderingComplete = function () { if (!current()) return; traceVideo('gapless.rendering_complete', session); };
      plugin.OnRenderError = function (code) { failed('OnRenderError:' + code); };
      plugin.OnEvent = function (type, first, second) {
        var label = String(type) + '|' + String(first) + '|' + String(second);
        if (!current()) return;
        traceVideo('gapless.event', session, { value: label });
        if (Number(type) === 7 || /renderingstart/i.test(label)) rendered('OnEvent:' + label);
        if (/error|fail/i.test(label)) failed('OnEvent:' + label);
        if (String(second) === 'Stop') { traceVideo('gapless.complete', session, { source: 'OnEvent:' + label }); if (onItemEnd) onItemEnd(); }
      };
      // Some firmware delivers the first native callback while Execute is
      // still on the stack. Register the session before startplaylist so that
      // callback proves rendering rather than being discarded as stale.
      gaplessPlugin = plugin; gaplessSession = session;
      result = plugin.Execute('startplaylist', rect.left, rect.top, rect.width, rect.height, '4', '0', muted ? '0' : '1');
      if (result !== 1) { closeGapless(session, 'startplaylist returned ' + result); return false; }
      traceVideo('gapless.start_requested', session, { count: names.length, signature: signature });
      session.startTimer = setTimeout(function () { if (current() && !session.renderedAt) failed('no rendering callback within 3000ms'); }, 3000);
      return true;
    } catch (error) {
      try { if (plugin) plugin.Close(); if (plugin && plugin.parentNode) plugin.parentNode.removeChild(plugin); } catch (ignore) {}
      bridge.error = 'Gapless start failed: ' + error; return false;
    }
  };
  bridge.gaplessActive = function () { return !!gaplessPlugin; };
  bridge.showHeldFrame = function (data) {
    var container = document.getElementById('playerContainer');
    if (!container || !data) return;
    bridge.clearHeldFrame(); heldFrame = document.createElement('img');
    heldFrame.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill';
    heldFrame.src = 'data:image/jpeg;base64,' + data; container.appendChild(heldFrame);
  };
  bridge.visibleHeldFrame = function () { return heldFrame && heldFrame.parentNode ? heldFrame : null; };
  bridge.restoreHeldFrame = function (frame) { var container = document.getElementById('playerContainer'); if (frame && container) { heldFrame = frame; container.appendChild(frame); } };
  bridge.clearHeldFrame = function () { if (heldFrame && heldFrame.parentNode) heldFrame.parentNode.removeChild(heldFrame); heldFrame = null; };
  bridge.markCapture = function (ctx, bounds, width, height) {
    var rect = bridge.activeRect, x, y, w, h;
    if (!rect || !bounds || !bounds.width || !bounds.height) return;
    x = (rect.left - bounds.left) / bounds.width * width; y = (rect.top - bounds.top) / bounds.height * height;
    w = rect.width / bounds.width * width; h = rect.height / bounds.height * height;
    ctx.save(); ctx.fillStyle = '#1f2937'; ctx.fillRect(x, y, w, h); ctx.fillStyle = '#fff';
    ctx.font = '16px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Native video: screen capture unavailable', x + w / 2, y + h / 2, Math.max(1, w - 12)); ctx.restore();
  };
  bridge.captureScreen = function (done) {
    var plugin, image, finished = false, capturePath = null;
    function finish(error, data) { if (finished) return; finished = true; clearTimeout(timeout); if (plugin && plugin.parentNode) plugin.parentNode.removeChild(plugin); if (capturePath) { try { fs.deleteCommonFile(capturePath.replace(/^\/mtd_down\/common\//, '')); } catch (ignore) {} } done(error, data); }
    var timeout = setTimeout(function () { finish('Samsung screen capture timed out'); }, 10000);
    try {
      plugin = document.createElement('object');
      plugin.setAttribute('classid', 'clsid:SAMSUNG-INFOLINK-SEF');
      plugin.style.cssText = 'position:absolute;width:0;height:0;';
      document.body.appendChild(plugin);
      setTimeout(function () {
        try {
          var opened = plugin.Open('LFD', '1.000', 'LFD');
          var filename = plugin.Execute('GetScreenCapture');
          plugin.Close();
          if (!filename || typeof filename !== 'string') throw new Error('GetScreenCapture failed: ' + filename + ' (open: ' + opened + ')');
          if (filename.indexOf('/tmp/') === 0) {
            var destination = '/mtd_down/common/screentinker/capture-' + Date.now() + '-' + (++captureSequence) + '.jpg';
            plugin.Open('FileSystem', '1.000', 'FileSystem');
            plugin.Execute('SetWidgetInfo', 2, '/mtd_down/common/');
            plugin.Execute('SetWidgetInfo', 2, '/tmp/');
            var moved = plugin.Execute('Move', filename, destination);
            plugin.Close();
            if (!exists(destination)) throw new Error('Cannot move Samsung capture to common storage: ' + moved);
            filename = destination; capturePath = destination;
          }
          image = new Image();
          image.onload = function () {
            try {
              var canvas = document.createElement('canvas');
              canvas.width = image.naturalWidth || image.width; canvas.height = image.naturalHeight || image.height;
              canvas.getContext('2d').drawImage(image, 0, 0);
              var data = canvas.toDataURL('image/jpeg', 0.8);
              if (data.indexOf('data:image/') !== 0 || data.length < 100) throw new Error('Empty captured image');
              finish(null, data.split(',')[1]);
            } catch (e) { finish(String(e)); }
          };
          image.onerror = function () { finish('Cannot read Samsung capture file: ' + filename); };
          image.src = filename.charAt(0) === '/' ? 'file://' + filename : filename;
        } catch (e) { finish(String(e)); }
      }, 100);
    } catch (e) { finish(String(e)); }
  };
  /* ---- self-contained template widget cache (2026-11-04) ----
   *
   * WHY: template widgets are server-rendered slides with editable values baked
   * into one HTML document. A screen that loses the network keeps only whatever
   * the panel cached — and without this pipeline the template is the ONE widget
   * class the cache gate refused, so an offline clinic sign (or any template)
   * degrades to nothing the moment Wi-Fi drops. Zero CMS changes: everything
   * happens inside the panel.
   *
   * HOW: supported() admitting 'template' routes the item here instead of the
   * plain Samsung downloader, because the downloaded bytes need a rewrite to be
   * offline-usable. The pipeline:
   *   1. XHR-fetch the rendered HTML from source(item). The browser engine
   *      decodes the UTF-8 text (Arabic survives) — never readAll() bytes.
   *   2. Find every operator-uploaded content image the slide references
   *      (/uploads/content/<file>; packaged tpl: assets arrive pre-inlined as
   *      data URIs) and fetch each as raw bytes via the charset=x-user-defined
   *      trick, then inline as a data URI. Anything >512 KB or unfetchable
   *      stays an absolute URL: that image degrades offline, layout survives.
   *   3. writeCommonFile() the single self-contained HTML — with a read-back
   *      verification, so a firmware that cannot round-trip UTF-8 fails loudly
   *      here and the pipeline falls back to the plain downloader (raw bytes,
   *      text offline, images degraded) instead of ever marking a corrupt file
   *      as a cache hit.
   *   4. Only after the verified write does the item join the cache index and
   *      persistStorage() — the same "never apply a partial cache" invariant
   *      the media queue keeps for video.
   * The cache key already contains widget_rev, so re-editing the template in
   * the CMS republishes with a new rev and this pipeline re-runs naturally.
   *
   * FAILURE DIRECTION is deliberately bounded: if the XHR layer is refused
   * (3 tries) the item is pushed into the ordinary queue, which the pre-fix
   * code would have used anyway — the panel is never left worse than before
   * this pipeline existed. */
  var SELF_ASSET_MAX_BYTES = 512 * 1024;
  var selfJobs = {};
  function selfType(item) { return !!(item && item.widget_id && item.widget_type === 'template'); }
  function selfBusy() {
    for (var k in selfJobs) {
      var st = selfJobs[k].state;
      if (st === 'fetch' || st === 'inflight' || st === 'assets' || st === 'inflight-asset') return true;
    }
    return false;
  }
  function stMime(ext) {
    var map = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
    return map[ext] || 'application/octet-stream';
  }
  function stBase64(bytes) {
    var T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', out = [], i, a, b, c, d, n = bytes.length;
    for (i = 0; i < n; i += 3) {
      a = bytes.charCodeAt(i) & 255;
      b = i + 1 < n ? bytes.charCodeAt(i + 1) & 255 : 0;
      c = i + 2 < n ? bytes.charCodeAt(i + 2) & 255 : 0;
      d = (a << 16) | (b << 8) | c;
      out.push(T.charAt((d >> 18) & 63), T.charAt((d >> 12) & 63), i + 1 < n ? T.charAt((d >> 6) & 63) : '=', i + 2 < n ? T.charAt(d & 63) : '=');
    }
    return out.join('');
  }
  function stXhr(url, wantBytes, ok, err) {
    var x, settled = false, guard;
    try {
      x = new XMLHttpRequest();
    } catch (e) { err('XHR unavailable: ' + String(e)); return; }
    guard = setTimeout(function () { if (!settled) { settled = true; try { x.abort(); } catch (ignore) {} err('XHR timeout'); } }, 30000);
    function settle(good, value) {
      if (settled) return; settled = true; clearTimeout(guard);
      if (good) ok(value); else err(value);
    }
    try {
      x.open('GET', url, true);
      if (x.overrideMimeType) x.overrideMimeType(wantBytes ? 'text/plain; charset=x-user-defined' : 'text/plain; charset=utf-8');
      x.onreadystatechange = function () {
        if (settled || x.readyState !== 4) return;
        var s = Number(x.status);
        if (!x.responseText || (s !== 0 && s !== 200)) { settle(false, 'HTTP ' + s); return; }
        settle(true, String(x.responseText));
      };
      x.send(null);
    } catch (e) { settle(false, String(e && e.message || e)); }
  }
  function selfBegin(item) {
    var k = key(item);
    if (!selfJobs[k]) {
      selfJobs[k] = { item: item, state: 'fetch', tries: 0 };
      status('Caching template widget (rev ' + (item.widget_rev || 0) + ')...');
      reportPlaylist('Template widget queued for offline caching (rev ' + (item.widget_rev || 0) + ')');
    }
    selfJobs[k].item = item; /* freshest fill-stamped copy; key() already fixed */
    selfPump();
  }
  function selfPump() {
    var k, job;
    for (k in selfJobs) {
      job = selfJobs[k];
      if (job && job.state === 'fetch') {
        job.state = 'inflight';
        stXhr(source(job.item), false, function (html) { job.html = String(html); selfScanAssets(job); },
          function (why) {
            job.state = 'fetch'; job.tries++;
            reportPlaylist('Template widget fetch ' + why + ' (try ' + job.tries + '/3)');
            if (job.tries >= 3) {
              /* The XHR layer is refusing (likely a firmware that forbids cross-origin
               * reads from file://). Fall through to the ordinary downloader, which is
               * exactly what the pre-pipeline behavior would have done with this item:
               * raw bytes cached, text/layout alive offline, asset images degraded. */
              job.state = 'passthrough';
              queue.push({ item: job.item, tries: 0 });
              delete selfJobs[key(job.item)];
              next();
            } else { setTimeout(selfPump, job.tries * 2000); }
          });
        return;
      }
    }
  }
  function selfScanAssets(job) {
    var re = /\/uploads\/content\/[^"'`\s?)]+/g, m, seen = {}, urls = [];
    while ((m = re.exec(job.html)) !== null) { if (!seen[m[0]]) { seen[m[0]] = true; urls.push(m[0]); } }
    job.assets = urls;
    // The html is rewritten FIRST with data-URI placeholders resolved below — but
    // only commit once every inlineable asset has resolved.
    selfFetchAsset(job, 0);
  }
  function selfFetchAsset(job, i) {
    job.state = i < job.assets.length ? 'inflight-asset' : 'assets';
    if (i >= job.assets.length) { selfCommit(job); return; }
    var url = job.assets[i], ref = url.slice('/uploads/content/'.length), file = ref;
    try { file = decodeURIComponent(ref); } catch (ignore) {}
    stXhr(bridge.base + url, true, function (bytes) {
      if (bytes.length > SELF_ASSET_MAX_BYTES) { /* stays an absolute URL: degraded offline, layout survives */ }
      else {
        var dataUri = 'data:' + stMime(file.replace(/.*\.([^.]*)$/, '$1')) + ';base64,' + stBase64(bytes);
        job.html = job.html.split(url).join(dataUri);
      }
      selfFetchAsset(job, i + 1);
    }, function () { /* unfetchable: keep the absolute URL */ selfFetchAsset(job, i + 1); });
  }
  function selfCommit(job) {
    var size = job.html.length;
    if (!writeCommonFile(path(job.item), job.html)) {
      reportPlaylist('Template widget cache write failed verification; falling back to plain download');
      job.state = 'passthrough';
      queue.push({ item: job.item, tries: 0 });
      delete selfJobs[key(job.item)];
      next();
      return;
    }
    index[key(job.item)] = path(job.item);
    job.state = 'done';
    delete selfJobs[key(job.item)];
    try { bridge.persistStorage(); } catch (ignore) {}
    reportPlaylist('Template widget cached (' + size + ' B html, ' + (job.assets || []).length + ' assets inlined)');
    status('Template widget cached.');
    next();
  }

  function writeCommonFile(name, data) {
    var f, read, stripped = String(name).replace(/^\/mtd_down\/common\//, '');
    function put(path) {
      f = fs.openCommonFile(path, 'w');
      if (!f) return false;
      f.writeAll(data);
      fs.closeCommonFile(f);
      return true;
    }
    function get(path) {
      f = fs.openCommonFile(path, 'r');
      if (!f) return null;
      read = f.readAll();
      fs.closeCommonFile(f);
      return read;
    }
    try { if (put(stripped) && get(stripped) === data) return true; } catch (ignore) {}
    try { if (put(name) && get(name) === data) return true; } catch (ignore2) {}
    return false;
  }
  function readCommonFile(name) {
    var f, raw, stripped = String(name).replace(/^\/mtd_down\/common\//, '');
    try {
      f = fs.openCommonFile(stripped, 'r');
      if (f) { raw = f.readAll(); fs.closeCommonFile(f); return raw; }
    } catch (ignore) {}
    try {
      f = fs.openCommonFile(name, 'r');
      if (!f) return null;
      raw = f.readAll();
      fs.closeCommonFile(f);
      return raw;
    } catch (ignore2) { return null; }
  }
  bridge.recordBootEvent = function (event) {
    var payload = {}, k;
    if (!event || typeof event !== 'object') event = {};
    for (k in event) if (Object.prototype.hasOwnProperty.call(event, k)) payload[k] = event[k];
    if (!payload.written_at_utc_ms) payload.written_at_utc_ms = Date.now();
    payload.build = String(currentBuild || payload.build || '');
    payload.nv = true;
    payload.flushed = true;
    try {
      if (!writeCommonFile(bootEventPath, JSON.stringify(payload))) payload.flushed = false;
    } catch (ignore) { payload.flushed = false; }
    return payload;
  };
  bridge.readBootEvent = function () {
    var raw;
    try {
      raw = readCommonFile(bootEventPath);
      return raw ? JSON.parse(raw) : null;
    } catch (ignore) { return null; }
  };
  bridge.pollLauncherManifest = function (done) {
    var xhr, url, launcher = bridge.launcherUrl || (bridge.base + '/sssp3/');
    function finish(info) { if (done) done(null, info); }
    if (launcher.charAt(launcher.length - 1) !== '/') launcher += '/';
    url = launcher + 'sssp_config.xml';
    try {
      xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = 4000;
      xhr.onload = function () {
        var xml = String(xhr.responseText || ''), ver, size, ok = xhr.status >= 200 && xhr.status < 300;
        ver = parseInt((/<ver>(\d+)<\/ver>/.exec(xml) || [])[1] || '0', 10) || 0;
        size = parseInt((/<size>(\d+)<\/size>/.exec(xml) || [])[1] || '0', 10) || 0;
        finish({ reachable: ok, version: ver, size: size, current: currentBuild, update: ok && ver > currentBuild });
      };
      xhr.onerror = xhr.ontimeout = function () {
        finish({ reachable: false, version: 0, size: 0, current: currentBuild, update: false });
      };
      xhr.send();
    } catch (e) {
      finish({ reachable: false, version: 0, size: 0, current: currentBuild, update: false, error: String(e) });
    }
  };
  var pendingReports = [];
  function sendReport(kind, message, deviceId, retry) {
    var xhr, body;
    try {
      xhr = new XMLHttpRequest();
      xhr.open('POST', bridge.base + '/api/player-debug', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      body = JSON.stringify({ deviceId: deviceId, error_fingerprint: 'sssp3-' + kind, errors: [{ message: message }], context: { build: '__ST_BUILD__' } });
      if (retry) {
        xhr.timeout = 8000;
        xhr.onerror = xhr.ontimeout = function () { pendingReports.push({ kind: kind, message: message, deviceId: deviceId }); };
        xhr.onload = function () {
          if (xhr.status < 200 || xhr.status >= 300) pendingReports.push({ kind: kind, message: message, deviceId: deviceId });
          else if (kind === 'boot') bridge._bootEventPosted = true;
        };
      }
      xhr.send(body);
    } catch (ignore) {
      if (retry) pendingReports.push({ kind: kind, message: message, deviceId: deviceId });
    }
  }
  bridge.report = function (kind, message, deviceId) {
    try {
      var reportKey = kind + ':' + message, now = Date.now();
      if (kind !== 'boot' && reportTimes[reportKey] && now - reportTimes[reportKey] < 60000) return;
      if (kind !== 'boot') reportTimes[reportKey] = now;
      sendReport(kind, message, deviceId, kind === 'boot');
    } catch (ignore) {}
  };
  bridge.flushReports = function () {
    var queued = pendingReports, i, stored;
    pendingReports = [];
    if (!queued.length && !bridge._bootEventPosted) {
      try {
        stored = bridge.readBootEvent();
        if (stored && stored.nv && stored.written_at_utc_ms) {
          queued.push({ kind: 'boot', message: JSON.stringify(stored), deviceId: deviceId() });
        }
      } catch (ignore) {}
    }
    for (i = 0; i < queued.length; i++) sendReport(queued[i].kind, queued[i].message, queued[i].deviceId, true);
  };
  bridge.stopVideo = function () { var player = document.getElementById('NativePlayer'), session = gaplessSession, stage = document.getElementById('playerContainer'); gaplessGeneration++; closeGapless(session, 'teardown'); videoGeneration++; clearTimeout(videoTimer); bridge.activeRect = null; if (videoBackgrounds && stage && stage.style && document.body && document.documentElement) { stage.style.background = videoBackgrounds[0]; document.body.style.background = videoBackgrounds[1]; document.documentElement.style.background = videoBackgrounds[2]; videoBackgrounds = null; } if (!player) return; if (videoActive) { videoActive = false; try { player.Stop(); } catch (ignore2) {} } player.style.visibility = 'hidden'; };
  bridge._test = { key: key, path: path, source: source, bootEventPath: bootEventPath, pendingReports: function () { return pendingReports.slice(); } };
})(window);
