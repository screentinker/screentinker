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
  en: { nothing_scheduled: 'Nothing scheduled right now', no_content: 'No content assigned yet' },
  es: { nothing_scheduled: 'No hay nada programado en este momento', no_content: 'Aún no hay contenido asignado' },
  fr: { nothing_scheduled: 'Rien de programmé pour le moment', no_content: 'Aucun contenu attribué pour l’instant' },
  de: { nothing_scheduled: 'Derzeit ist nichts geplant', no_content: 'Noch kein Inhalt zugewiesen' },
  pt: { nothing_scheduled: 'Nada programado no momento', no_content: 'Nenhum conteúdo atribuído ainda' }
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
  this.DEFAULT_DURATION = 10;
  this.MIN_DURATION = 3;
}

PlaylistPlayer.prototype.load = function (assignments) {
  var items = (assignments || []).filter(function (a) {
    return a && (a.content_id || a.widget_id || a.remote_url);
  });
  // Stable order
  items.sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });

  var sig = JSON.stringify(items.map(function (a) {
    // #74/#75: include schedules so a schedule edit (same content) re-renders.
    return [a.content_id, a.widget_id, a.remote_url, a.duration_sec, a.mime_type, a.schedules || []];
  }));
  if (sig === this.sig && this.items.length) return; // unchanged, keep playing

  this.sig = sig;
  this.items = items;
  this.index = 0;
  this.startPlayback();
};

PlaylistPlayer.prototype.stop = function () {
  if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  this.clearStage();
};

PlaylistPlayer.prototype.clearStage = function () {
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
  var d = item.duration_sec || this.DEFAULT_DURATION;
  if (d < this.MIN_DURATION) d = this.MIN_DURATION;
  return d * 1000;
};

PlaylistPlayer.prototype.contentUrl = function (item) {
  if (item.remote_url) return item.remote_url;
  if (item.content_id) return this.getBase() + '/api/content/' + item.content_id + '/file';
  return null;
};

PlaylistPlayer.prototype.advance = function () {
  if (!this.items.length) return;
  // #74/#75: advance to the next schedule-active item; idle if none.
  var idx = this.nextActiveIndex(this.index);
  if (idx < 0) { this.nothingScheduled(); return; }
  this.index = idx;
  this.playCurrent();
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
  this.clearStage();

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
  if (this.items.length > 1) this.schedule(2000);
};

PlaylistPlayer.prototype.fit = function (el, item) {
  // assignment may carry a fit hint; default cover (matches Android default)
  var f = (item.fit || item.scale || 'cover').toLowerCase();
  if (f === 'contain' || f === 'fit') el.className = 'contain';
  else if (f === 'fill' || f === 'stretch') el.className = 'fill';
  else el.className = 'cover';
};

PlaylistPlayer.prototype.renderImage = function (item, single) {
  var self = this;
  var img = document.createElement('img');
  this.fit(img, item);
  img.onerror = function () { self.skipSoon(); };
  img.src = this.contentUrl(item);
  this.stage.appendChild(img);
  if (!single) this.schedule(this.durationMs(item));
};

PlaylistPlayer.prototype.renderVideo = function (item, single) {
  var self = this;
  var v = document.createElement('video');
  this.currentVideoEl = v; // wall: leader reads currentTime; follower drift-corrects this
  this.fit(v, item);
  v.autoplay = true; v.muted = true; v.setAttribute('playsinline', '');
  v.loop = single; // single item loops; multi advances on end
  v.onended = function () { if (!single) self.advance(); };
  v.onerror = function () { self.skipSoon(); };
  v.src = this.contentUrl(item);
  this.stage.appendChild(v);
  var p = v.play(); if (p && p.catch) p.catch(function () {});
  // Safety net: if 'ended' never fires (rare), advance after the known
  // content duration (or the assignment duration) + a buffer.
  if (!single) {
    var secs = item.content_duration || item.duration_sec || this.DEFAULT_DURATION;
    this.schedule((secs + 5) * 1000);
  }
};

PlaylistPlayer.prototype.renderYouTube = function (item, single) {
  var id = this.youtubeId(item.remote_url);
  if (!id) { this.skipSoon(); return; }
  var src = 'https://www.youtube.com/embed/' + id +
    '?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&loop=1&playlist=' + id + '&playsinline=1';
  this.renderFrame(src, single ? 0 : this.durationMs(item), 'autoplay; encrypted-media');
};

PlaylistPlayer.prototype.renderWidget = function (item, single) {
  var src = this.getBase() + '/api/widgets/' + item.widget_id + '/render';
  this.renderFrame(src, single ? 0 : this.durationMs(item));
};

PlaylistPlayer.prototype.renderFrame = function (src, advanceMs, allow) {
  var f = document.createElement('iframe');
  f.setAttribute('frameborder', '0');
  f.setAttribute('allowfullscreen', '');
  if (allow) f.setAttribute('allow', allow);
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
      var ysrc = 'https://www.youtube.com/embed/' + yid +
        '?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&loop=1&playlist=' + yid + '&playsinline=1';
      zone.el.appendChild(zrFrame(ysrc, 'autoplay; encrypted-media'));
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
function zrFrame(src, allow) {
  var f = document.createElement('iframe');
  f.setAttribute('frameborder', '0');
  f.setAttribute('allowfullscreen', '');
  if (allow) f.setAttribute('allow', allow);
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

WallController.prototype.apply = function (config) {
  var roleChanged = !this.config ||
    this.config.is_leader !== config.is_leader ||
    this.config.wall_id !== config.wall_id;
  this.config = config;

  this.styleStage(config);
  this.player.setWallFollower(!config.is_leader);
  // Entering wall mode or flipping role: force a fresh render so leader/follower
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
    if (s && this.canEmit()) s.emit('wall:sync-request', { wall_id: config.wall_id });
  }
};

WallController.prototype.exit = function () {
  var wasActive = !!this.config || !!this.timer || this.stage.classList.contains('wall-mode');
  if (this.timer) { clearInterval(this.timer); this.timer = null; }
  this.config = null;
  this.player.setWallFollower(false);
  if (wasActive) {
    this.stage.classList.remove('wall-mode');
    var st = this.stage.style;
    st.position = ''; st.left = ''; st.top = ''; st.width = ''; st.height = '';
    st.transform = ''; st.transformOrigin = '';
    this.player.invalidate(); // re-render cleanly back into normal (non-wall) mode
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
  s.emit('wall:sync', {
    wall_id: this.config.wall_id,
    device_id: this.getDeviceId(),
    current_index: this.player.getIndex(),
    content_id: item.content_id || null,
    position_sec: pos,
    sent_at: Date.now()
  });
};

WallController.prototype.onSync = function (data) {
  var c = this.config;
  if (!c || c.is_leader || !data || data.wall_id !== c.wall_id) return;
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
  if (!this.config || !this.config.is_leader) return;
  if (data && data.wall_id && data.wall_id !== this.config.wall_id) return;
  this.emitSync();
};
