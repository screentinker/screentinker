(function (global) {
  'use strict';
  var bridge = global.__STNative = global.__STNative || {};
  var directory = '/mtd_down/common/screentinker_media';
  var queue = [], current = null, desired = null, apply = null, timer = null, downloadedForUpdate = false;
  var index = {}, fs, downloader, stateGeneration = 0, videoGeneration = 0, videoTimer = null, videoActive = false, gaplessPlugin = null, gaplessSession = null, gaplessGeneration = 0;
  var statePrefix = '/mtd_down/common/screentinker/state-', bootEventPath = '/mtd_down/common/screentinker/boot-event.json', reportTimes = {}, captureSequence = 0, heldFrame = null;
  var currentBuild = parseInt('__ST_BUILD__', 10) || 0;
  var videoBackgrounds = null;
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
  function evenPx(n) {
    n = Math.round(Number(n) || 0);
    if (n < 2) return 0;
    return n % 2 ? n - 1 : n;
  }
  function fitName(filepath, fit, width, height) {
    var file = String(filepath || '');
    if (!(width > 0 && height > 0) || (fit !== 'fill' && fit !== 'contain' && fit !== 'cover')) return file;
    return /\.svg$/i.test(file) ? file.replace(/\.svg$/i, '.svg.' + fit + '-' + width + 'x' + height + '.png') : file.replace(/(\.[A-Za-z0-9]{1,8})$/, '.' + fit + '-' + width + 'x' + height + '$1');
  }
  function fillName(filepath, width, height) {
    return fitName(filepath, 'fill', width, height);
  }
  function stampFit(payload) {
    var SCREEN_W = 1920, SCREEN_H = 1080;
    var layout = payload && payload.layout, zones, map = {}, i, z, a, fit, items, w, h, isVideo, isImage, zoned;
    zones = (layout && layout.zones) || [];
    zoned = zones.length >= 2;
    for (i = 0; i < zones.length; i++) {
      z = zones[i];
      if (z && z.id) map[z.id] = z;
    }
    items = payloadItems(payload);
    for (i = 0; i < items.length; i++) {
      a = items[i];
      if (!a || a.widget_id) continue;
      isVideo = /^video\//.test(a.mime_type || '');
      isImage = /^image\//.test(a.mime_type || '');
      if (!isVideo && !isImage) continue;
      /* The server generates fitted JPEG, PNG, WebP and SVG derivatives. All
         other image encodings must retain their original URL: requesting a
         fabricated rendition gives the Samsung downloader a 404. */
      if (isImage && !/^image\/(jpeg|png|webp|svg\+xml)$/i.test(a.mime_type || '')) continue;
      /* Fullscreen native LFD video keeps the original encoded file. */
      if (isVideo && !zoned) continue;
      z = map[a.zone_id];
      if (isVideo && !z) continue;
      fit = a.fit_mode || (z && z.fit_mode) || 'contain';
      if (fit !== 'fill' && fit !== 'contain' && fit !== 'cover') fit = 'contain';
      if (z) {
        w = evenPx(SCREEN_W * Number(z.width_percent) / 100);
        h = evenPx(SCREEN_H * Number(z.height_percent) / 100);
      } else {
        w = SCREEN_W;
        h = SCREEN_H;
      }
      if (!w || !h) continue;
      a.fill_fit = fit;
      a.fill_width = w;
      a.fill_height = h;
    }
  }
  function stampFill(payload) { return stampFit(payload); }
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
    var file = fitName(item.filepath, item.fill_fit, item.fill_width, item.fill_height);
    var url = bridge.base + '/uploads/content/' + encodeURIComponent(file) + '?rev=' + encodeURIComponent(item.content_rev || 0);
    if (item.fill_width > 0 && item.fill_height > 0) url += '&fit=' + encodeURIComponent(item.fill_fit || 'fill') + '&w=' + item.fill_width + '&h=' + item.fill_height;
    return url;
  }
  function supported(item) {
    var mime = String(item && item.mime_type || '').toLowerCase();
    return item && (item.widget_id
      ? /^(clock|text|weather|rss|social|directory-board|directory-search|menu-board|room-display)$/.test(String(item.widget_type || ''))
      : !item.remote_url && item.filepath && (/^image\/(jpeg|png|gif|bmp|webp|svg\+xml)$/.test(mime) || mime === 'video/mp4'));
  }
  /* A widget can be safe to paint while still being unsuitable for offline
     caching. Keep that distinction explicit: the list below is the runtime
     surface proven on the DB48E, while supported() remains the cache gate. */
  bridge.canRender = function (item) {
    if (!item || !item.widget_id) return supported(item);
    return /^(clock|text|weather|rss|social|directory-board|directory-search|menu-board|room-display|radar|webpage|diag-smoothness)$/.test(String(item.widget_type || ''));
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
      bridge.persistStorage();
    } catch (ignore) {}
    if (downloadedForUpdate) { payload.__nativeMediaChanged = true; status('Media cached. Starting playback...'); } downloadedForUpdate = false; callback(payload);
  }
  function next() {
    if (current) return;
    if (!queue.length) { finish(); return; }
    current = queue.shift();
    status('Downloading: ' + (current.item.filename || current.item.filepath || 'media'));
    try {
      downloader.StartDownFile(source(current.item), path(current.item));
      timer = setTimeout(function () { bridge.error = 'Download timed out; waiting for Samsung downloader.'; status(bridge.error); reportPlaylist(bridge.error); try { if (downloader.CancelDownload) downloader.CancelDownload(); } catch (ignore) {} }, 120000);
    } catch (e) { fail(String(e)); }
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
    if (fields[0] !== '1000' || fields[1] !== '1') return fail('download failed: ' + String(result));
    if (!exists(path(done.item))) return fail('download completed, but the local file was not found: ' + path(done.item));
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
    try { fs.createCommonDir('screentinker_media'); } catch (ignore2) {}
    downloader = document.getElementById('NativeDownloader');
    if (!downloader || !downloader.StartDownFile) throw new Error('Samsung downloader unavailable');
    downloader.OnComplete = 'STNativeDownloadComplete';
  };
  bridge.persistStorage = function () {
    var keys = ['rd_web_player', 'rd_playlist_cache', 'rd_layout_cache', 'st_group_sync', 'st_install_id', 'st_schedule_timezone', 'st_schedule_timezone_table', 'st_clock_offset', 'st_active_schedule', 'st_offline_plan', 'st_native_gapless'], saved = {}, i;
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
    var items = payload && payload.assignments ? payload.assignments.slice() : [], future, i;
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
    stampFit(payload);
    var missing = bridge.missing(payload), i, known = {}, wanted = {};
    desired = payload; apply = callback;
    for (i = 0; i < missing.length; i++) wanted[key(missing[i])] = true;
    queue = queue.filter(function (entry) { return wanted[key(entry.item)]; });
    reportPlaylist('Received playlist with ' + (payload.assignments || []).length + ' items; ' + missing.length + ' downloads needed' + (current ? '; downloader busy' : ''));
    if (!missing.length) { finish(); return; }
    if (current) known[key(current.item)] = true;
    for (i = 0; i < queue.length; i++) known[key(queue[i].item)] = true;
    for (i = 0; i < missing.length; i++) if (!known[key(missing[i])]) { known[key(missing[i])] = true; queue.push({ item: missing[i], tries: 0 }); }
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
  bridge._test = { key: key, path: path, source: source, fillName: fillName, fitName: fitName, stampFill: stampFill, stampFit: stampFit, bootEventPath: bootEventPath, pendingReports: function () { return pendingReports.slice(); } };
})(window);
