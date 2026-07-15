/* PlaylistPlayer — fullscreen single-zone renderer for the Tizen player.
 * Mirrors the Android player's content rules:
 *   image        -> shown for duration_sec (min 3s), then advance
 *   video        -> plays to end then advance; single item loops
 *   video/youtube-> iframe embed; single item loops, multi advances after duration
 *   remote_url   -> same as image/video but src = remote_url
 *   widget       -> iframe of {server}/api/widgets/{id}/render for duration_sec
 * Content file URL: {server}/api/content/{content_id}/file  (public)
 */
// Minimal i18n for the Tizen player (no shared i18n module here). Falls back to en.
var TIZEN_I18N = {
  en: { nothing_scheduled: 'Nothing scheduled right now', no_content: 'No content assigned yet', portrait_video_unsupported: 'Portrait video isn’t supported on this TV — use landscape, or pre-rotate the file and mark it Landscape.' },
  es: { nothing_scheduled: 'No hay nada programado en este momento', no_content: 'Aún no hay contenido asignado', portrait_video_unsupported: 'El vídeo en vertical no es compatible con este televisor: usa horizontal o rota el archivo y márcalo como Horizontal.' },
  fr: { nothing_scheduled: 'Rien de programmé pour le moment', no_content: 'Aucun contenu attribué pour l’instant', portrait_video_unsupported: 'La vidéo en portrait n’est pas prise en charge sur ce téléviseur — utilisez le paysage, ou faites pivoter le fichier et marquez-le Paysage.' },
  de: { nothing_scheduled: 'Derzeit ist nichts geplant', no_content: 'Noch kein Inhalt zugewiesen', portrait_video_unsupported: 'Hochformat-Video wird auf diesem TV nicht unterstützt – nutze Querformat oder drehe die Datei und markiere sie als Querformat.' },
  pt: { nothing_scheduled: 'Nada programado no momento', no_content: 'Nenhum conteúdo atribuído ainda', portrait_video_unsupported: 'Vídeo em retrato não é suportado nesta TV — use paisagem ou gire o arquivo e marque-o como Paisagem.' }
};
var TZ_LANG = (function () { try { return (localStorage.getItem('rd_lang') || navigator.language || 'en').split('-')[0]; } catch (e) { return 'en'; } })();
function tzt(k) { return (TIZEN_I18N[TZ_LANG] && TIZEN_I18N[TZ_LANG][k]) || TIZEN_I18N.en[k] || k; }

function PlaylistPlayer(stageEl, getBase) {
  this.stage = stageEl;
  this.getBase = getBase;
  this.items = [];
  this.index = 0;
  this.timer = null;
  this.sig = '';
  this.timezone = null; // #74/#75: device-effective IANA tz for schedule eval
  this.wallFollower = false;   // video-wall: a follower holds the leader's item, no auto-advance
  this.currentVideoEl = null;  // current <video> (wall leader reads position; follower drift-corrects)
  this.itemStartedAt = 0;      // wall position fallback for non-video items
  // #170: current device orientation. Portrait/flipped VIDEO must rotate the Tizen hardware video
  // plane via AVPlay (CSS rotate can't touch it -> black screen). Set by app.js applyOrientation.
  this.orientation = 'landscape';
  this.avActive = false;       // an AVPlay session is live (portrait video)
  this.DEFAULT_DURATION = 10;
  this.MIN_DURATION = 3;
  this.preloadEl = null;       // #group-sync double buffer: pre-buffered next <video>
  this.preloadIdx = -1;
  // #187 image double buffer: pre-DECODED next <img> (detached — decode() warms the bitmap without
  // the DOM, so clearStage can't wipe it). Mirrors preloadEl/preloadIdx. Swapped in decode-gated so
  // the image path never clears the stage to black before the new frame is paint-ready.
  this.preloadImgEl = null;
  this.preloadImgIdx = -1;
  // #157: schedule-driven (group-sync) mode — set by app.js. Group-sync advances via its own tick,
  // not the solo timer, and Tizen group-sync doesn't use wallFollower, so this gates the deferral.
  this.scheduleDriven = false;
  // #157 deferred rotation-out: when a removed-but-live item should finish before we swap in the list.
  this._deferredRotation = false;
  this._deferredSuccessorId = null;
}

// #157 continuity helpers (mirror the web/Android players).
PlaylistPlayer.prototype.setScheduleDriven = function (b) { this.scheduleDriven = !!b; };
PlaylistPlayer.prototype.itemIdentity = function (x) {
  return x ? [x.content_id || '', x.widget_id || '', x.remote_url || '', x.filepath || ''].join('|') : '';
};
PlaylistPlayer.prototype.indexOfIdentity = function (arr, id) {
  for (var i = 0; i < arr.length; i++) if (this.itemIdentity(arr[i]) === id) return i;
  return -1;
};
PlaylistPlayer.prototype.hasContentOnScreen = function () {
  return !!(this.stage && this.stage.querySelector &&
    (this.stage.querySelector('video') || this.stage.querySelector('img') || this.stage.querySelector('iframe')));
};

// Double buffer: build a hidden, buffering <video> for the next clip (in document.body so clearStage
// won't wipe it) so renderVideo can mount it instantly at the boundary (no black hold). Videos only.
PlaylistPlayer.prototype.preloadVideo = function (idx) {
  if (this.preloadIdx === idx) return;   // already handled this boundary
  var item = this.items[idx];
  if (!item) return;
  if ((item.mime_type || '').indexOf('video/') !== 0) { this.preloadIdx = idx; this.preloadEl = null; return; }
  try {
    if (this.preloadEl && this.preloadEl.parentNode) this.preloadEl.parentNode.removeChild(this.preloadEl);
    var v = document.createElement('video');
    v.muted = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
    v.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;left:-9999px';
    v.src = this.contentUrl(item);
    v.load();
    document.body.appendChild(v);
    this.preloadEl = v; this.preloadIdx = idx;
  } catch (e) { this.preloadEl = null; this.preloadIdx = -1; }
};
PlaylistPlayer.prototype._takePreload = function (idx) {
  if (this.preloadIdx === idx && this.preloadEl) {
    var el = this.preloadEl; this.preloadEl = null; this.preloadIdx = -1;
    if (el.parentNode) el.parentNode.removeChild(el);
    return el;
  }
  return null;
};

// #187 image double buffer (mirrors preloadVideo/_takePreload for the IMAGE path). Only the NEXT
// item, only when it's an image, ONE-ahead. Builds a DETACHED <img>, sets src, and warms the decoded
// bitmap via HTMLImageElement.decode() (feature-detected — Tizen 5.0 / SSSP6 may lack it, so the
// element still loads and the swap path falls back to onload/complete). At the boundary renderImage
// _takePreloadImage()s it and swaps it in with no black hold.
PlaylistPlayer.prototype.preloadImage = function (idx) {
  if (this.preloadImgIdx === idx) return;   // already handled this boundary
  this._releasePreloadImage();              // index moved off the warmed image -> drop the stale one
  var item = this.items[idx];
  if (!item) { this.preloadImgIdx = -1; return; }
  // One-ahead ONLY, images only. A non-image next: mark this boundary handled, nothing to warm.
  if ((item.mime_type || '').indexOf('image/') !== 0) { this.preloadImgIdx = idx; return; }
  try {
    var img = document.createElement('img');
    this.fit(img, item);
    img.src = this.contentUrl(item);
    // Warm the decoded bitmap. A decode() rejection (broken URL) is swallowed here and re-surfaces at
    // the swap (renderImage re-runs decode()/onerror -> skipSoon), so a bad image still skips.
    if (typeof img.decode === 'function') { img.decode().catch(function () {}); }
    this.preloadImgEl = img; this.preloadImgIdx = idx;
  } catch (e) { this._releasePreloadImage(); }
};
PlaylistPlayer.prototype._takePreloadImage = function (idx) {
  if (this.preloadImgIdx === idx && this.preloadImgEl) {
    var el = this.preloadImgEl; this.preloadImgEl = null; this.preloadImgIdx = -1;
    if (el.parentNode) el.parentNode.removeChild(el);   // detached in practice; defensive parity
    return el;
  }
  return null;
};
PlaylistPlayer.prototype._releasePreloadImage = function () {
  if (this.preloadImgEl) {
    try { this.preloadImgEl.onload = this.preloadImgEl.onerror = null; this.preloadImgEl.src = ''; } catch (e) {}
  }
  this.preloadImgEl = null; this.preloadImgIdx = -1;
};

PlaylistPlayer.prototype.load = function (assignments) {
  // B3: a malformed device:playlist-update with a non-array `assignments` used to throw
  // (.filter is not a function) out of the socket handler; coerce to [] instead.
  var items = (Array.isArray(assignments) ? assignments : []).filter(function (a) {
    return a && (a.content_id || a.widget_id || a.remote_url);
  });
  // Stable order
  items.sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });

  var sig = JSON.stringify(items.map(function (a) {
    // STRUCTURAL only. #74/#75: include schedules so a schedule edit (same content) re-renders.
    // duration_sec is EXCLUDED so a duration edit applies in place (below), not as a restart.
    return [a.content_id, a.widget_id, a.remote_url, a.mime_type, a.schedules || []];
  }));
  if (sig === this.sig && this.items.length) {
    // In-place duration refresh: patch duration_sec on the live items so a duration edit takes effect
    // (group schedule tick re-anchors; solo advance uses it next) WITHOUT restarting playback.
    for (var k = 0; k < this.items.length && k < items.length; k++) {
      if (this.items[k].duration_sec !== items[k].duration_sec) this.items[k].duration_sec = items[k].duration_sec;
    }
    return;
  }

  // Structural change. Preserve continuity like the web/Android players instead of always
  // restarting from the top: if the on-screen item survives, keep playing it; if it was removed
  // while live in SOLO playback (#157 e.g. an expiry), let it finish then rotate to the successor.
  var oldItems = this.items;
  var oldIndex = this.index;
  var curId = this.itemIdentity(oldItems[oldIndex]);
  this.sig = sig;
  this.items = items;
  // #187: the warmed image is cached BY INDEX; a structural change can repoint that index at a
  // different item, so drop it (the next dwell re-warms the correct successor).
  this._releasePreloadImage();
  this._deferredRotation = false;
  this._deferredSuccessorId = null;

  if (!items.length) { this.index = 0; this.startPlayback(); return; }

  // Current item survives -> keep playing it, just retarget the index (no restart).
  if (curId) {
    var stay = this.indexOfIdentity(items, curId);
    if (stay >= 0 && this.hasContentOnScreen()) { this.index = stay; return; }
  }

  // Anchor gone: walk forward from the OLD position to the first item that still exists.
  var nextIdx = 0;
  if (oldItems.length) {
    for (var w = 1; w <= oldItems.length; w++) {
      var pid = this.itemIdentity(oldItems[(oldIndex + w) % oldItems.length]);
      if (!pid || pid === curId) continue;
      var f = this.indexOfIdentity(items, pid);
      if (f >= 0) { nextIdx = f; break; }
    }
  }

  // #157: removed-but-live in solo playback -> don't interrupt; rotate out on the next advance
  // (the current item's video onended / image timer still fires advance()). Group-sync (schedule-
  // driven) and wall followers reconcile via their own tick, so play through immediately as before.
  if (this.hasContentOnScreen() && !this.wallFollower && !this.scheduleDriven) {
    this._deferredRotation = true;
    this._deferredSuccessorId = this.itemIdentity(items[nextIdx]);
    return;
  }

  this.startPlaybackAt(nextIdx);
};

PlaylistPlayer.prototype.stop = function () {
  if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  this._releasePreloadImage();   // #187: drop any warmed next-image bitmap on teardown
  this.clearStage();
};

PlaylistPlayer.prototype.clearStage = function () {
  if (this.avActive) this.avStop(); // #170: tear down any AVPlay session (portrait video)
  // Pause any video before removing so audio doesn't linger.
  var v = this.stage.querySelector('video');
  if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} }
  this.stage.innerHTML = '';
};

PlaylistPlayer.prototype.idle = function () {
  this.clearStage();
  this.stage.innerHTML =
    '<div class="card" style="position:relative"><h1>ScreenTinker</h1>' +
    '<p class="sub">' + tzt('no_content') + '</p></div>';
};

PlaylistPlayer.prototype.durationMs = function (item) {
  // B3: a non-numeric duration_sec ("abc") used to yield NaN -> schedule(NaN) -> fire-ASAP spin.
  // Coerce; any non-positive/NaN falls back to the default.
  var d = Number(item.duration_sec);
  if (!(d > 0)) d = this.DEFAULT_DURATION;
  if (d < this.MIN_DURATION) d = this.MIN_DURATION;
  return d * 1000;
};

PlaylistPlayer.prototype.contentUrl = function (item) {
  if (item.remote_url) return item.remote_url;
  if (item.content_id) return this.getBase() + '/api/content/' + item.content_id + '/file';
  return null;
};

PlaylistPlayer.prototype.advance = function () {
  // #157: apply a deferred rotation-out — the removed-but-live item just finished, so swap in the
  // stashed list and continue at the preserved successor instead of interrupting/restarting.
  if (this._deferredRotation) {
    this._deferredRotation = false;
    var sid = this._deferredSuccessorId; this._deferredSuccessorId = null;
    var to = sid ? this.indexOfIdentity(this.items, sid) : -1;
    this.startPlaybackAt(to >= 0 ? to : 0);
    return;
  }
  if (!this.items.length) return;
  // #74/#75: advance to the next schedule-active item; idle if none.
  var idx = this.nextActiveIndex(this.index);
  if (idx < 0) { this.nothingScheduled(); return; }
  this.index = idx;
  this.playCurrent();
};

// Play a specific index (schedule-permitting); mirrors the web player's startPlaybackAt.
PlaylistPlayer.prototype.startPlaybackAt = function (idx) {
  if (!this.items.length) { this.idle(); return; }
  if (idx < 0 || idx >= this.items.length) idx = 0;
  if (this.scheduleAllows(this.items[idx])) { this.index = idx; this.playCurrent(); return; }
  var a = this.nextActiveIndex(idx);
  if (a >= 0) { this.index = a; this.playCurrent(); } else this.nothingScheduled();
};

PlaylistPlayer.prototype.schedule = function (ms) {
  var self = this;
  if (this.timer) clearTimeout(this.timer);
  this.timer = setTimeout(function () { self.advance(); }, ms);
};

// #74/#75: per-item schedule gating (mirrors the web/Android players). No blocks =
// always on. Fails open: any evaluator error means the item plays.
PlaylistPlayer.prototype.setTimezone = function (tz) { this.timezone = tz || null; };

// ---- video-wall support (used by WallController) ----
// A follower holds the leader's current item and never auto-advances; entering or
// leaving wall mode (or a role flip) calls invalidate() so the next load re-renders
// with the right semantics instead of being de-duped by the unchanged signature.
PlaylistPlayer.prototype.setWallFollower = function (b) { this.wallFollower = !!b; };
PlaylistPlayer.prototype.invalidate = function () { this.sig = ''; };
PlaylistPlayer.prototype.getIndex = function () { return this.index; };
PlaylistPlayer.prototype.getCurrentItem = function () { return this.items[this.index] || null; };
PlaylistPlayer.prototype.getCurrentVideo = function () { return this.currentVideoEl; };
PlaylistPlayer.prototype.getItemStartedAt = function () { return this.itemStartedAt; };
// Follower jumps to the leader's index. No-op if already there (avoids a needless
// restart that would re-buffer the same item).
PlaylistPlayer.prototype.gotoIndex = function (idx) {
  if (!this.items.length) return;
  var n = this.items.length;
  idx = ((idx % n) + n) % n;
  if (idx === this.index) return;
  this.index = idx;
  this.playCurrent();
};

PlaylistPlayer.prototype.scheduleAllows = function (item) {
  if (!item || !item.schedules || !item.schedules.length) return true;
  try {
    return (typeof ScheduleEval !== 'undefined')
      ? ScheduleEval.isItemActiveNow(item.schedules, Date.now(), this.timezone) : true;
  } catch (e) { return true; }
};

PlaylistPlayer.prototype.anyScheduled = function () {
  for (var i = 0; i < this.items.length; i++) {
    if (this.items[i].schedules && this.items[i].schedules.length) return true;
  }
  return false;
};

PlaylistPlayer.prototype.firstActiveIndex = function () {
  for (var i = 0; i < this.items.length; i++) if (this.scheduleAllows(this.items[i])) return i;
  return -1;
};

PlaylistPlayer.prototype.nextActiveIndex = function (from) {
  if (!this.items.length) return -1;
  for (var i = 1; i <= this.items.length; i++) {
    var idx = (from + i) % this.items.length;
    if (this.scheduleAllows(this.items[idx])) return idx;
  }
  return -1;
};

PlaylistPlayer.prototype.startPlayback = function () {
  if (!this.items.length) { this.idle(); return; }
  var idx = this.firstActiveIndex();
  if (idx < 0) { this.nothingScheduled(); return; }
  this.index = idx;
  this.playCurrent();
};

// Every item filtered out: idle and re-check shortly (a daypart may open).
PlaylistPlayer.prototype.nothingScheduled = function () {
  if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  this.clearStage();
  this.stage.innerHTML =
    '<div class="card" style="position:relative"><h1>ScreenTinker</h1>' +
    '<p class="sub">' + tzt('nothing_scheduled') + '</p></div>';
  var self = this;
  this.timer = setTimeout(function () { self.startPlayback(); }, 30000);
};

PlaylistPlayer.prototype.playCurrent = function () {
  if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  if (!this.items.length) { this.idle(); return; }

  this.itemStartedAt = Date.now();   // wall position fallback for non-video items
  this.currentVideoEl = null;        // set by renderVideo when applicable

  var item = this.items[this.index];
  // Scheduled playlists cycle even with one active item so windows re-evaluate.
  // A wall FOLLOWER also behaves "single": it holds the leader's current item
  // (looping, no auto-advance) and only switches when wall:sync says the index moved.
  var single = this.wallFollower || (this.items.length === 1 && !this.anyScheduled());
  var mime = item.mime_type || '';
  // #187: the IMAGE path decode-gates and SWAPS (it clears the stage only after the new frame is
  // paint-ready, inside renderImage) so slow Tizen decode HW no longer black-flashes between images.
  // Every OTHER type keeps the pre-dispatch clearStage() exactly as before — this mirrors the same
  // branch order used in the dispatch below, so an item routed to renderImage is the only one skipped.
  var isImage = mime !== 'video/youtube'
    && !(item.widget_id && !item.content_id)
    && mime.indexOf('video/') !== 0
    && mime.indexOf('image/') === 0;
  if (!isImage) this.clearStage();

  try {
    if (mime === 'video/youtube') return this.renderYouTube(item, single);
    if (item.widget_id && !item.content_id) return this.renderWidget(item, single);
    if (mime.indexOf('video/') === 0) return this.renderVideo(item, single);
    if (mime.indexOf('image/') === 0) return this.renderImage(item, single);
    // Fallback: a remote_url with unknown mime -> try iframe
    if (item.remote_url) return this.renderFrame(item.remote_url, single ? 0 : this.durationMs(item));
  } catch (e) {
    this.skipSoon();
    return;
  }
  // Unknown item -> skip
  this.skipSoon();
};

// Give a broken item ~2s then move on so the loop never wedges.
PlaylistPlayer.prototype.skipSoon = function () {
  if (this.items.length > 1) { this.schedule(2000); return; }
  // A1: a SINGLE-item playlist used to WEDGE on a broken item — skipSoon did nothing, so a transient
  // failure (CDN blip, brief network loss, a 404 that later resolves) left a permanent black screen
  // while the heartbeat still reported the device online. Retry the SAME item after a backoff so it
  // self-heals instead of going dark forever.
  var self = this;
  if (this.timer) clearTimeout(this.timer);
  this.timer = setTimeout(function () { self.playCurrent(); }, 5000);
};

PlaylistPlayer.prototype.fit = function (el, item) {
  // assignment may carry a fit hint; default cover (matches Android default)
  var f = (item.fit || item.scale || 'cover').toLowerCase();
  if (f === 'contain' || f === 'fit') el.className = 'contain';
  else if (f === 'fill' || f === 'stretch') el.className = 'fill';
  else el.className = 'cover';
};

// #187: decode-gated one-ahead double buffer for images (mirrors the video preloader). The stage is
// NEVER cleared to black before the new image is paint-ready: we take the warmed pre-decoded <img>
// (or decode a fresh one), and ONLY THEN clearStage()+append — a swap, never clear-then-load.
PlaylistPlayer.prototype.renderImage = function (item, single) {
  var self = this;
  var targetIdx = this.index;
  var img = this._takePreloadImage(targetIdx);   // pre-decoded from the previous item's dwell?
  if (!img) {
    this._releasePreloadImage();                 // any warmed image is for a different index now — drop it
    img = document.createElement('img');
    this.fit(img, item);
    img.src = this.contentUrl(item);
  }
  var settled = false;
  var stale = function () {
    // A next()/gotoIndex/playlist change mid-decode must not mount a now-stale image over the current
    // item (mirrors how renderVideo's _takePreload only fires for the still-current index).
    return self.index !== targetIdx || self.items[targetIdx] !== item;
  };
  var mount = function () {
    if (settled) return; settled = true;
    if (stale()) { try { img.src = ''; } catch (e) {} return; }
    self.clearStage();                 // SWAP: clear only now, with the decoded image ready to paint
    self.stage.appendChild(img);
    if (!single) {
      self.schedule(self.durationMs(item));
      self.preloadImage(self.nextActiveIndex(targetIdx));   // warm the NEXT image while THIS one dwells
    }
  };
  var fail = function () {
    if (settled) return; settled = true;
    if (stale()) return;
    self.skipSoon();                   // broken URL / decode reject -> skip (A1 self-heals a single item)
  };
  img.onerror = fail;
  // Feature-detect decode() (Tizen 5.0 / SSSP6 may lack it) -> onload/complete fallback.
  if (typeof img.decode === 'function') {
    img.decode().then(mount).catch(fail);
  } else if (img.complete) {
    if (img.naturalWidth > 0) mount(); else fail();   // warmed element already loaded (ok) or errored
  } else {
    img.onload = mount;                // onerror set above routes a load error to fail
  }
};

PlaylistPlayer.prototype.setOrientation = function (o) { this.orientation = o || 'landscape'; };
PlaylistPlayer.prototype.avAvailable = function () { return !!(window.webapis && webapis.avplay); };

// #170: on Tizen the HTML5 <video> is composited on a hardware plane that ignores CSS rotate,
// so portrait/portrait-flipped orientation blacks the video out. AVPlay's setDisplayRotation
// rotates the hardware plane itself. We use it ONLY for portrait/flipped video — landscape keeps
// the proven <video> path (double-buffer + group-sync drift). Any AVPlay failure degrades to an
// honest note, never a silent black screen.
PlaylistPlayer.prototype.renderVideoAv = function (item, single) {
  var self = this;
  var url = this.contentUrl(item);
  if (!url) { this.skipSoon(); return; }
  var deg = this.orientation === 'portrait-flipped' ? 270 : 90;
  var rot = deg === 270 ? 'PLAYER_DISPLAY_ROTATION_270' : 'PLAYER_DISPLAY_ROTATION_90';
  var obj = document.getElementById('avPlayer');
  var w = window.innerWidth || (window.screen && screen.width) || 1920;
  var h = window.innerHeight || (window.screen && screen.height) || 1080;
  // currentVideoEl stays null: wall/group-sync per-frame drift needs an HTML5 element; portrait
  // signage is solo-first, and the schedule engine still drives index/position via gotoIndex.
  this.currentVideoEl = null;
  try { webapis.avplay.close(); } catch (e) {}            // reset any prior session
  try {
    webapis.avplay.open(url);
    if (obj) obj.style.display = 'block';
    webapis.avplay.setDisplayRect(0, 0, w, h);
    try { webapis.avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) {}
    webapis.avplay.setDisplayRotation(rot);
    webapis.avplay.setListener({
      onstreamcompleted: function () {
        if (single) { try { webapis.avplay.seekTo(0); webapis.avplay.play(); } catch (e) { self.avStop(); self.skipSoon(); } }
        else { self.advance(); }
      },
      onerror: function () { self.avFallback(item); }
    });
    this.avActive = true;
    webapis.avplay.prepareAsync(
      function () { try { webapis.avplay.play(); } catch (e) { self.avFallback(item); } },
      function () { self.avFallback(item); }
    );
    // Safety net (mirrors the <video> path): advance after the known duration if
    // onstreamcompleted never fires.
    if (!single) {
      var secs = Number(item.content_duration || item.duration_sec) || this.DEFAULT_DURATION;
      this.schedule((secs + 5) * 1000);
    }
  } catch (e) { this.avFallback(item); }
};

// AVPlay missing/failed on this device -> honest note (never a silent black), then move on.
PlaylistPlayer.prototype.avFallback = function (item) {
  this.avStop();
  this.stage.innerHTML =
    '<div class="card" style="position:relative"><h1>ScreenTinker</h1>' +
    '<p class="sub">' + tzt('portrait_video_unsupported') + '</p></div>';
  // Don't wedge on a single looping item; re-check after a beat (or the item's duration).
  this.schedule(Math.max(this.durationMs(item), 30000));
};

PlaylistPlayer.prototype.avStop = function () {
  if (!this.avActive) return;
  try { webapis.avplay.stop(); } catch (e) {}
  try { webapis.avplay.close(); } catch (e) {}
  var obj = document.getElementById('avPlayer');
  if (obj) obj.style.display = 'none';
  this.avActive = false;
};

PlaylistPlayer.prototype.renderVideo = function (item, single) {
  // #170: portrait/flipped video must rotate the Tizen HARDWARE video plane, which a CSS transform
  // on #stage can't do (black screen). Route it through AVPlay; landscape stays on <video>.
  if ((this.orientation === 'portrait' || this.orientation === 'portrait-flipped') && this.avAvailable()) {
    return this.renderVideoAv(item, single);
  }
  var self = this;
  // Double buffer: reuse the pre-buffered element for this index if warmed (no black hold); its src
  // is already set + buffering, so playback starts near-instantly.
  var pre = this._takePreload(this.index);
  var v = pre || document.createElement('video');
  this.currentVideoEl = v; // wall: leader reads currentTime; follower drift-corrects this
  this.fit(v, item);
  v.autoplay = true; v.muted = true; v.setAttribute('playsinline', '');
  v.loop = single; // single item loops; multi advances on end
  v.onended = function () { if (!single) self.advance(); };
  v.onerror = function () { self.skipSoon(); };
  if (!pre) v.src = this.contentUrl(item);
  v.style.cssText = ''; // clear the offscreen-hide style if reused
  this.stage.appendChild(v);
  var p = v.play(); if (p && p.catch) p.catch(function () {});
  // Safety net: if 'ended' never fires (rare), advance after the known
  // content duration (or the assignment duration) + a buffer.
  if (!single) {
    var secs = Number(item.content_duration || item.duration_sec) || this.DEFAULT_DURATION; // B3: numeric
    this.schedule((secs + 5) * 1000);
  }
};

PlaylistPlayer.prototype.renderYouTube = function (item, single) {
  var id = this.youtubeId(item.remote_url);
  if (!id) { this.skipSoon(); return; }
  var vertical = /st_aspect=vertical/.test(item.remote_url || '');
  var src = 'https://www.youtube.com/embed/' + id +
    '?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&loop=1&playlist=' + id + '&playsinline=1';
  this.renderFrame(src, single ? 0 : this.durationMs(item), 'autoplay; encrypted-media', vertical);
};

PlaylistPlayer.prototype.renderWidget = function (item, single) {
  var src = this.getBase() + '/api/widgets/' + item.widget_id + '/render';
  this.renderFrame(src, single ? 0 : this.durationMs(item));
};

PlaylistPlayer.prototype.renderFrame = function (src, advanceMs, allow, vertical) {
  var f = document.createElement('iframe');
  f.setAttribute('frameborder', '0');
  f.setAttribute('allowfullscreen', '');
  if (allow) f.setAttribute('allow', allow);
  // Vertical (Shorts): center a 9:16 iframe on the black stage instead of the
  // stylesheet's full-bleed 100%x100% (which pillarboxes vertical video badly).
  if (vertical) f.style.cssText = 'position:absolute;top:0;bottom:0;left:0;right:0;margin:auto;height:100%;width:auto;aspect-ratio:9/16;max-width:100%;border:0';
  f.src = src;
  this.stage.appendChild(f);
  if (advanceMs > 0) this.schedule(advanceMs);
};

PlaylistPlayer.prototype.youtubeId = function (url) {
  if (!url) return null;
  var m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url; // bare id
  return null;
};

/* ZoneRenderer — multi-zone layout renderer for the Tizen player.
 * Ports the Android player's ZoneManager (player/ZoneManager.kt). A layout is a set of
 * absolutely-positioned zones (percent geometry + z-index + fit_mode + background), and
 * EACH zone rotates its own list of assignments independently: images/widgets advance on
 * a duration timer, videos advance on 'ended' (a single-item zone loops). The same
 * per-item schedule gating (#74/#75) used in single-zone applies per zone. Assignments are
 * grouped by zone_id and sorted by sort_order; unassigned content (zone_id null) goes to
 * the FIRST zone only. Single-zone playback stays in PlaylistPlayer; app.js chooses the
 * renderer from payload.layout.
 */
function ZoneRenderer(stageEl, getBase) {
  this.stage = stageEl;
  this.getBase = getBase;
  this.timezone = null;
  this.zones = [];
  this.timers = {}; // zoneId -> timeout id
  this.videos = {}; // zoneId -> <video> (pause before removal)
  this.sig = '';
  this.DEFAULT_DURATION = 10;
  this.MIN_DURATION = 3;
}

ZoneRenderer.prototype.setTimezone = function (tz) { this.timezone = tz || null; };
ZoneRenderer.prototype.active = function () { return this.zones.length > 0; };
// #162: drop the cached signature so the next render() repaints even if the layout is
// unchanged — used when the shared #stage was blanked by the other (single-zone) renderer.
ZoneRenderer.prototype.invalidate = function () { this.sig = ''; };

ZoneRenderer.prototype.cancelAll = function () {
  for (var k in this.timers) { if (this.timers.hasOwnProperty(k) && this.timers[k]) clearTimeout(this.timers[k]); }
  this.timers = {};
};

ZoneRenderer.prototype.clear = function () {
  this.cancelAll();
  for (var k in this.videos) {
    if (this.videos.hasOwnProperty(k) && this.videos[k]) {
      try { this.videos[k].pause(); this.videos[k].removeAttribute('src'); this.videos[k].load(); } catch (e) {}
    }
  }
  this.videos = {};
  this.zones = [];
  this.sig = '';
  this.stage.innerHTML = '';
};

ZoneRenderer.prototype.signature = function (layout, assignments) {
  var zsig = (layout.zones || []).map(function (z) {
    return [z.id, z.x_percent, z.y_percent, z.width_percent, z.height_percent, z.z_index, z.fit_mode, z.background_color];
  });
  var asig = (assignments || []).map(function (a) {
    return [a.zone_id || '', a.content_id, a.widget_id, a.remote_url, a.duration_sec, a.mime_type, a.sort_order, a.schedules || []];
  });
  return JSON.stringify([layout.id || '', zsig, asig]);
};

ZoneRenderer.prototype.render = function (layout, assignments) {
  if (!layout || !layout.zones || !layout.zones.length) { this.clear(); return; }
  var sig = this.signature(layout, assignments);
  if (sig === this.sig && this.zones.length) return; // unchanged — keep zones playing
  this.clear();
  this.sig = sig;

  // The stage must be a positioned containing block so zone % geometry resolves against
  // it (applyOrientation leaves the stage static in landscape).
  if (!this.stage.style.position) this.stage.style.position = 'relative';

  this.zones = layout.zones.map(function (z) {
    return {
      id: z.id, name: z.name || 'Zone',
      x: zrNum(z.x_percent, 0), y: zrNum(z.y_percent, 0),
      w: zrNum(z.width_percent, 100), h: zrNum(z.height_percent, 100),
      z: zrNum(z.z_index, 0),
      fit: z.fit_mode || 'cover',
      bg: z.background_color || '#000000'
    };
  });

  // Group assignments by zone_id (sorted by sort_order); zone_id null -> first zone only.
  var byZone = {}, unassigned = [];
  (assignments || []).forEach(function (a) {
    if (!a || !(a.content_id || a.widget_id || a.remote_url)) return;
    if (a.zone_id == null || a.zone_id === '') unassigned.push(a);
    else (byZone[a.zone_id] = byZone[a.zone_id] || []).push(a);
  });
  function bySort(a, b) { return (a.sort_order || 0) - (b.sort_order || 0); }
  for (var zid in byZone) if (byZone.hasOwnProperty(zid)) byZone[zid].sort(bySort);
  unassigned.sort(bySort);

  var self = this, unassignedUsed = false;
  this.zones.slice().sort(function (a, b) { return a.z - b.z; }).forEach(function (zone) {
    var list = byZone[zone.id];
    if (!list && !unassignedUsed) { unassignedUsed = true; list = unassigned; }
    list = list || [];

    var div = document.createElement('div');
    div.style.position = 'absolute';
    div.style.left = zone.x + '%'; div.style.top = zone.y + '%';
    div.style.width = zone.w + '%'; div.style.height = zone.h + '%';
    div.style.overflow = 'hidden';
    div.style.zIndex = String(zone.z);
    div.style.background = zone.bg;
    self.stage.appendChild(div);
    zone.el = div;

    if (list.length) self.showItem(zone, list, 0);
  });
};

ZoneRenderer.prototype.scheduleAdvance = function (zone, ms, fn) {
  if (this.timers[zone.id]) clearTimeout(this.timers[zone.id]);
  this.timers[zone.id] = setTimeout(fn, ms);
};

// Per-item schedule gating, mirrors PlaylistPlayer / Android. No blocks = always on;
// fails open (any evaluator error means the item plays).
ZoneRenderer.prototype.allows = function (item) {
  if (!item || !item.schedules || !item.schedules.length) return true;
  try {
    return (typeof ScheduleEval !== 'undefined')
      ? ScheduleEval.isItemActiveNow(item.schedules, Date.now(), this.timezone) : true;
  } catch (e) { return true; }
};

ZoneRenderer.prototype.nextActive = function (list, from) {
  for (var i = 0; i < list.length; i++) {
    var idx = (from + i) % list.length;
    if (this.allows(list[idx])) return idx;
  }
  return -1;
};

ZoneRenderer.prototype.durationMs = function (item) {
  var d = item.duration_sec || this.DEFAULT_DURATION;
  if (d < this.MIN_DURATION) d = this.MIN_DURATION;
  return d * 1000;
};

ZoneRenderer.prototype.contentUrl = function (item) {
  if (item.remote_url) return item.remote_url;
  if (item.content_id) return this.getBase() + '/api/content/' + item.content_id + '/file';
  return null;
};

ZoneRenderer.prototype.showItem = function (zone, list, index) {
  if (this.timers[zone.id]) { clearTimeout(this.timers[zone.id]); this.timers[zone.id] = null; }
  if (this.videos[zone.id]) { try { this.videos[zone.id].pause(); } catch (e) {} this.videos[zone.id] = null; }
  zone.el.innerHTML = '';

  var self = this;
  // #74/#75: skip items whose schedule excludes them now; blank-idle the zone and
  // re-check shortly (a daypart may open) if none are active.
  var activeIdx = this.nextActive(list, index);
  if (activeIdx < 0) { this.scheduleAdvance(zone, 30000, function () { self.showItem(zone, list, 0); }); return; }

  var a = list[activeIdx];
  // Scheduled zones cycle even with one active item so windows re-evaluate.
  var multi = list.length > 1 || list.some(function (x) { return x.schedules && x.schedules.length; });
  var advance = function () { self.showItem(zone, list, activeIdx + 1); };
  var dur = this.durationMs(a);
  var mime = a.mime_type || '';

  try {
    if (mime === 'video/youtube') {
      var yid = zrYoutubeId(a.remote_url);
      if (!yid) { if (multi) this.scheduleAdvance(zone, 2000, advance); return; }
      var yvert = /st_aspect=vertical/.test(a.remote_url || '');
      var ysrc = 'https://www.youtube.com/embed/' + yid +
        '?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&loop=1&playlist=' + yid + '&playsinline=1';
      zone.el.appendChild(zrFrame(ysrc, 'autoplay; encrypted-media', yvert));
      if (multi) this.scheduleAdvance(zone, dur, advance);
    } else if (a.widget_type || (a.widget_id && !a.content_id)) {
      zone.el.appendChild(zrFrame(this.getBase() + '/api/widgets/' + a.widget_id + '/render'));
      if (multi) this.scheduleAdvance(zone, dur, advance);
    } else if (mime.indexOf('video/') === 0) {
      var v = document.createElement('video');
      v.className = zrFitClass(zone.fit);
      // Zone videos are muted: TV web autoplay needs muted, and overlapping zone audio
      // is rarely intended. (Single-zone fullscreen handles audio in PlaylistPlayer.)
      v.autoplay = true; v.muted = true; v.setAttribute('playsinline', '');
      v.loop = !multi; // single-item zone loops; multi advances on end
      v.onended = function () { if (multi) advance(); };
      v.onerror = function () { if (multi) self.scheduleAdvance(zone, 2000, advance); };
      v.src = this.contentUrl(a);
      zone.el.appendChild(v);
      this.videos[zone.id] = v;
      var p = v.play(); if (p && p.catch) p.catch(function () {});
      if (multi) {
        var secs = a.content_duration || a.duration_sec || this.DEFAULT_DURATION;
        this.scheduleAdvance(zone, (secs + 5) * 1000, advance); // safety net if 'ended' never fires
      }
    } else if (mime.indexOf('image/') === 0) {
      var img = document.createElement('img');
      img.className = zrFitClass(zone.fit);
      img.onerror = function () { if (multi) self.scheduleAdvance(zone, 2000, advance); };
      img.src = this.contentUrl(a);
      zone.el.appendChild(img);
      if (multi) this.scheduleAdvance(zone, dur, advance);
    } else if (a.remote_url) {
      zone.el.appendChild(zrFrame(a.remote_url));
      if (multi) this.scheduleAdvance(zone, dur, advance);
    } else {
      if (multi) this.scheduleAdvance(zone, dur, advance);
    }
  } catch (e) {
    if (multi) this.scheduleAdvance(zone, 2000, advance);
  }
};

// --- ZoneRenderer helpers ---
function zrNum(v, d) { var n = parseFloat(v); return isNaN(n) ? d : n; }
function zrFitClass(fit) {
  var f = String(fit || 'cover').toLowerCase();
  if (f === 'contain' || f === 'fit') return 'contain';
  if (f === 'fill' || f === 'stretch') return 'fill';
  return 'cover';
}
function zrFrame(src, allow, vertical) {
  var f = document.createElement('iframe');
  f.setAttribute('frameborder', '0');
  f.setAttribute('allowfullscreen', '');
  if (allow) f.setAttribute('allow', allow);
  if (vertical) f.style.cssText = 'position:absolute;top:0;bottom:0;left:0;right:0;margin:auto;height:100%;width:auto;aspect-ratio:9/16;max-width:100%;border:0';
  f.src = src;
  return f;
}
function zrYoutubeId(url) {
  if (!url) return null;
  var m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;
  return null;
}

/* WallController — video-wall sync for the Tizen player.
 * Mirrors the WEB player's wall logic (server/player/index.html); the Android player
 * has no wall support, so the web player is the reference. A wall maps one playlist
 * across several screens: each screen renders the FULL content (player_rect) but the
 * stage is positioned (in vw/vh) so only this screen's slice (screen_rect) is on-view,
 * with object-fit:fill so a given source row lands on the same physical line on every
 * screen sharing a viewport height. The LEADER plays normally and broadcasts wall:sync
 * at 4Hz; FOLLOWERS hold the leader's item (PlaylistPlayer.wallFollower) and keep their
 * video locked to the leader's clock with a latency-compensated drift controller.
 * (Tizen video is always muted, so the "followers stay silent" rule is automatic.)
 */
function WallController(stageEl, player, getSocket, getDeviceId, canEmit) {
  this.stage = stageEl;
  this.player = player;
  this.getSocket = getSocket;
  this.getDeviceId = getDeviceId;
  this.canEmit = canEmit; // () -> authenticated && socket connected (don't emit pre-register)
  this.config = null;
  this.timer = null;
}

WallController.prototype.active = function () { return !!this.config; };

// Map this screen's slice. left/top/width/height in vw/vh so the viewport fills
// edge-to-edge (no pillarbox at the seam between adjacent screens).
WallController.prototype.styleStage = function (config) {
  var s = config.screen_rect, p = config.player_rect;
  if (!s || !p || !s.w || !s.h) return;
  this.stage.classList.add('wall-mode');
  var st = this.stage.style;
  st.position = 'absolute';
  st.left = (((p.x - s.x) / s.w) * 100) + 'vw';
  st.top = (((p.y - s.y) / s.h) * 100) + 'vh';
  st.width = ((p.w / s.w) * 100) + 'vw';
  st.height = ((p.h / s.h) * 100) + 'vh';
  st.transform = ''; st.transformOrigin = '';
};

// #group-sync: the sync id is wall_id (WALL) or group_id (GROUP mode).
WallController.prototype.syncId = function (c) { return c && (c.mode === 'group' ? c.group_id : c.wall_id); };
WallController.prototype.clearStageStyle = function () {
  this.stage.classList.remove('wall-mode');
  var st = this.stage.style;
  st.position = ''; st.left = ''; st.top = ''; st.width = ''; st.height = '';
  st.transform = ''; st.transformOrigin = '';
};

WallController.prototype.apply = function (config) {
  var isGroup = config.mode === 'group';
  var id = this.syncId(config);
  var roleChanged = !this.config ||
    this.config.is_leader !== config.is_leader ||
    this.syncId(this.config) !== id;
  this.config = config;

  // WALL: map this screen's slice (transform). GROUP: full-screen — clear any wall styling; the
  // normal render path honors per-item mute (no forced follower mute).
  if (isGroup) this.clearStageStyle(); else this.styleStage(config);
  this.player.setWallFollower(!config.is_leader);
  // Entering sync mode or flipping role: force a fresh render so leader/follower
  // semantics take effect (otherwise an unchanged signature de-dupes the load).
  if (roleChanged) this.player.invalidate();

  if (this.timer) { clearInterval(this.timer); this.timer = null; }
  var self = this;
  if (config.is_leader) {
    // 4Hz so followers nudge playbackRate instead of jerk-seeking; immediate first
    // tick so any already-up follower aligns now (and on leader-reclaim after reconnect).
    this.timer = setInterval(function () { self.emitSync(); }, 250);
    setTimeout(function () { self.emitSync(); }, 100);
  } else {
    // Follower: ask the leader for its position now so we don't show the item start
    // until the next periodic tick (up to ~250ms of visible drift on a fresh join).
    var s = this.getSocket();
    if (s && this.canEmit()) {
      s.emit(isGroup ? 'group:sync-request' : 'wall:sync-request', isGroup ? { group_id: id } : { wall_id: id });
    }
  }
};

WallController.prototype.exit = function () {
  var wasActive = !!this.config || !!this.timer || this.stage.classList.contains('wall-mode');
  if (this.timer) { clearInterval(this.timer); this.timer = null; }
  this.config = null;
  this.player.setWallFollower(false);
  if (wasActive) {
    this.clearStageStyle();
    this.player.invalidate(); // re-render cleanly back into normal (non-sync) mode
  }
};

WallController.prototype.emitSync = function () {
  if (!this.config || !this.config.is_leader || !this.canEmit()) return;
  var s = this.getSocket(); if (!s) return;
  var item = this.player.getCurrentItem();
  if (!item) return;
  var v = this.player.getCurrentVideo();
  var pos = v ? (v.currentTime || 0)
              : Math.max(0, (Date.now() - this.player.getItemStartedAt()) / 1000);
  var msg = {
    device_id: this.getDeviceId(),
    current_index: this.player.getIndex(),
    content_id: item.content_id || null,
    position_sec: pos,
    sent_at: Date.now()
  };
  if (this.config.mode === 'group') { msg.group_id = this.config.group_id; s.emit('group:sync', msg); }
  else { msg.wall_id = this.config.wall_id; s.emit('wall:sync', msg); }
};

WallController.prototype.onSync = function (data) {
  var c = this.config;
  if (!c || c.is_leader || !data) return;
  var isG = c.mode === 'group';
  if ((isG ? data.group_id : data.wall_id) !== this.syncId(c)) return;
  // Align to the leader's current item.
  if (typeof data.current_index === 'number' && data.current_index !== this.player.getIndex()) {
    this.player.gotoIndex(data.current_index);
  }
  // Hold close to the leader's clock, latency-compensated (mirrors the web player):
  //  > 0.3s  -> hard seek + reset rate
  //  > 0.05s -> nudge playbackRate +/-3% to converge gently
  //  else    -> ride at 1.0x
  var v = this.player.getCurrentVideo();
  if (v && typeof data.position_sec === 'number') {
    var latency = data.sent_at ? Math.max(0, (Date.now() - data.sent_at) / 1000) : 0;
    var target = data.position_sec + latency;
    var drift = (v.currentTime || 0) - target;
    var ad = Math.abs(drift);
    try {
      if (ad > 0.3 && isFinite(v.duration) && target < v.duration) { v.currentTime = target; v.playbackRate = 1.0; }
      else if (ad > 0.05) { v.playbackRate = drift > 0 ? 0.97 : 1.03; }
      else if (v.playbackRate !== 1.0) { v.playbackRate = 1.0; }
    } catch (e) {}
  }
};

WallController.prototype.onSyncRequest = function (data) {
  var c = this.config;
  if (!c || !c.is_leader) return;
  var isG = c.mode === 'group';
  var dataId = data && (isG ? data.group_id : data.wall_id);
  if (dataId && dataId !== this.syncId(c)) return;
  this.emitSync();
};

/* GroupSyncController — clock/schedule group sync for the Tizen player. Mirrors the WEB player's
 * groupScheduleTick (server/player/index.html). Unlike WallController there is NO leader and NO
 * server relay: every same-playlist member lays the deterministic playlist schedule (each item
 * occupies durationMs, in order, dayparted items skipped) on a server-DISCIPLINED clock and derives
 * the identical (index, position) locally. That is offline-native (no server at play-time) and
 * cannot go split-brain. Reuses the player's wallFollower mode (loop + no auto-advance).
 */
function GroupSyncController(player, getOffsetMs, report) {
  this.player = player;
  this.getOffsetMs = getOffsetMs;   // () -> smoothed clock offset in ms (server is the time authority)
  this.report = report;             // (level, msg) -> dashboard live-log
  this.groupId = null;
  this.timer = null;
  this.dbgLast = 0;
  // A fresh item snaps ONCE to the exact schedule position (load-and-hold) instead of nudging away
  // the ~0.3s load offset over ~10s. Steady-state drift rides the gentle nudge afterward.
  this.alignPending = true;
  this.lastAlignedIndex = -1;
}
GroupSyncController.prototype.active = function () { return !!this.groupId; };
GroupSyncController.prototype.syncedNow = function () { return Date.now() + (this.getOffsetMs() || 0); };
GroupSyncController.prototype.slots = function () {
  var p = this.player, items = p.items, acc = 0, s = [];
  for (var i = 0; i < items.length; i++) {
    if (!p.scheduleAllows(items[i])) continue;   // same daypart filter as solo playback
    // CANONICAL slot length — MUST match the web + Android engines exactly (max(1,dur||10)*1000).
    // Deliberately NOT durationMs() (its MIN_DURATION=3 clamp would diverge from the other players).
    var d = Math.max(1, Number(items[i].duration_sec) || 10) * 1000;
    s.push({ index: i, start: acc, dur: d }); acc += d;
  }
  return { slots: s, period: acc };
};
GroupSyncController.prototype.target = function () {
  var r = this.slots();
  if (!r.slots.length || r.period <= 0) return null;
  var phase = ((this.syncedNow() % r.period) + r.period) % r.period;
  var ci = -1;
  for (var i = 0; i < r.slots.length; i++) { var x = r.slots[i]; if (phase >= x.start && phase < x.start + x.dur) { ci = i; break; } }
  if (ci < 0) ci = r.slots.length - 1;
  var s = r.slots[ci], nx = r.slots[(ci + 1) % r.slots.length];
  // nextIndex + secToBoundary drive the double buffer (preload the upcoming clip a few s early).
  return { index: s.index, posSec: (phase - s.start) / 1000, nextIndex: nx.index, secToBoundary: (s.start + s.dur - phase) / 1000 };
};
GroupSyncController.prototype.tick = function () {
  if (!this.groupId || !this.player.items.length) return;
  var t = this.target(); if (!t) return;
  // Double buffer: warm the next clip ~6s before the boundary (once per boundary).
  if (t.nextIndex !== t.index && t.secToBoundary >= 0 && t.secToBoundary <= 6) {
    this.player.preloadVideo(t.nextIndex);   // warm next clip (video-only; no-ops otherwise)
    this.player.preloadImage(t.nextIndex);   // #187: warm next image (image-only; separate buffer)
  }
  var action = 'hold';
  if (t.index !== this.player.getIndex()) {
    this.player.gotoIndex(t.index); action = 'jump>' + t.index;
  } else {
    var v = this.player.getCurrentVideo();
    if (v && isFinite(v.duration) && v.duration > 0) {
      var target = t.posSec % v.duration;                        // loop-safe when slot > clip length
      var drift = (v.currentTime || 0) - target, ad = Math.abs(drift);
      if (this.player.getIndex() !== this.lastAlignedIndex) this.alignPending = true;
      try {
        if (this.alignPending) {
          if (ad > 0.05) { v.currentTime = target; this.lastSeekAt = Date.now(); }
          v.playbackRate = 1.0; this.alignPending = false; this.lastAlignedIndex = this.player.getIndex();
          action = 'align ' + drift.toFixed(2);
        }
        // Seek cooldown: don't hard-seek every tick (decoder-thrash guard); nudge within the window.
        else if (ad > 0.3 && Date.now() - (this.lastSeekAt || 0) > 1200) { v.currentTime = target; v.playbackRate = 1.0; this.lastSeekAt = Date.now(); action = 'seek ' + drift.toFixed(2); }
        else if (ad > 0.05) { v.playbackRate = drift > 0 ? 0.97 : 1.03; action = 'nudge ' + drift.toFixed(2); }
        else if (v.playbackRate !== 1.0) { v.playbackRate = 1.0; }
      } catch (e) {}
    }
  }
  // Log discrete corrections (jump/align/seek) immediately so the transition is visible; only the
  // routine steady-state line (hold/nudge) is throttled — else the one-tick "align" on load reads
  // misleadingly (sampled over by a later hold/nudge).
  var now = Date.now();
  var discrete = action.indexOf('jump') === 0 || action.indexOf('align') === 0 || action.indexOf('seek') === 0;
  if ((discrete || now - this.dbgLast > 1000) && this.report) {
    this.dbgLast = now;
    this.report('info', 'idx=' + this.player.getIndex() + ' tgt=' + t.index + ' pos=' + t.posSec.toFixed(2) + ' off=' + (this.getOffsetMs() || 0) + 'ms ' + action);
  }
};
GroupSyncController.prototype.apply = function (groupId) {
  var first = !this.groupId;
  this.groupId = groupId;
  this.alignPending = true; this.lastAlignedIndex = -1;   // snap the first item into sync on entry
  this.player.setWallFollower(true);   // group member: loop + no local auto-advance (schedule drives)
  this.player.invalidate();            // force a clean re-render into follower semantics
  this.tick();                         // align immediately from the cached clock offset
  if (this.timer) clearInterval(this.timer);
  var self = this;
  this.timer = setInterval(function () { self.tick(); }, 250);   // 4Hz local correction
  if (this.report) this.report('info', 'group-sync ' + (first ? 'entered' : 'refresh') + ' group=' + String(groupId).slice(0, 8) + ' off=' + (this.getOffsetMs() || 0) + 'ms');
};
GroupSyncController.prototype.exit = function () {
  if (!this.groupId && !this.timer) return;
  if (this.timer) { clearInterval(this.timer); this.timer = null; }
  this.groupId = null;
  this.player.setWallFollower(false);
  this.player.invalidate();
  this.player._takePreload(this.player.preloadIdx);   // drop any warmed next-clip element
  this.player._releasePreloadImage();                 // #187: drop any warmed next-image bitmap
  if (this.report) this.report('info', 'group-sync exited');
};
