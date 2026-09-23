// Plays that happened while the socket was down (#299).
//
// ⚠️ THE BUG THIS EXISTS FOR: playback is offline-native, reporting was online-only. Every player
// guarded its proof-of-play emit on a live socket and returned, so a play occurring with the link
// down was discarded where it happened. A measured 5h49m server outage lost ~1,040 plays: the
// screens played them faultlessly and play_logs has a 20,963-second hole.
//
// ⚠️ IT STORES COMPLETE PLAYS, NOT start/end EVENTS. The server closes a play by finding "the most
// recent open row for this device+content", so replaying a start/end pair alongside live playback
// could close the row the player has open RIGHT NOW rather than the historical one. A finished play
// carrying both its timestamps inserts in one shot and cannot race anything.
//
// ⚠️ AND IT IS BOUNDED. A panel can sit offline for weeks; an unbounded queue grows until the device
// runs out of storage, turning a reporting gap into a dead screen — far worse than the bug. Past the
// cap the OLDEST play goes, and `dropped` counts it, so the loss is reportable rather than silent
// the way the original bug was.
//
// Storage-free by design: the caller hands in the persisted text and writes back what serialize()
// returns, so the same logic runs under localStorage (web/Tizen) and is testable under Node.
//
// CONTRACT: mirrors android/.../data/OfflinePlayQueue.kt. The two must agree on the wire shape.
// Dependency-free UMD: Node (require) + browser/Tizen (window.OfflinePlayQueue).

(function (root, factory) {
  // BOTH, not either/or — a BrightSign widget runs with Node integration, so `module` exists in
  // page scope and an `else` here would leave root.OfflinePlayQueue undefined on that platform,
  // silently restoring the very data loss this file exists to stop.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OfflinePlayQueue = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** ~11 hours of 20-second items: past a typical outage, still small on disk. */
  var MAX_ENTRIES = 2000;
  /** One flush sends at most this many; the server bounds its own side independently. */
  var BATCH = 200;

  function OfflinePlayQueue(maxEntries) {
    this.maxEntries = maxEntries || MAX_ENTRIES;
    this.entries = [];
    this.dropped = 0;
  }

  OfflinePlayQueue.prototype.size = function () {
    return this.entries.length;
  };

  OfflinePlayQueue.prototype.add = function (play) {
    if (!play || !play.client_event_id || !(play.started_at > 0)) return;
    this.entries.push(play);
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
      this.dropped++;
    }
  };

  /** The next flush, oldest first. Left in place until the server acks. */
  OfflinePlayQueue.prototype.peekBatch = function (limit) {
    return this.entries.slice(0, limit || BATCH);
  };

  /*
   * ⚠️ ACK BY ID, NOT BY COUNT. "Remove the first N" assumes the queue has not moved since the
   * batch was taken — but live plays keep arriving during a flush, and a full-queue eviction can
   * shift it underneath. Removing the exact ids is the only version that stays correct while the
   * queue is changing; the count version silently deletes entries the server never received.
   */
  OfflinePlayQueue.prototype.ack = function (ids) {
    if (!ids || !ids.length) return;
    var set = {};
    for (var i = 0; i < ids.length; i++) set[ids[i]] = true;
    this.entries = this.entries.filter(function (e) { return !set[e.client_event_id]; });
  };

  OfflinePlayQueue.prototype.clear = function () {
    this.entries = [];
  };

  OfflinePlayQueue.prototype.serialize = function () {
    try { return JSON.stringify(this.entries); } catch (e) { return '[]'; }
  };

  /*
   * ⚠️ TOTAL, NEVER THROWS. This runs on the boot path, and a panel losing power mid-write is the
   * ordinary case for signage rather than an exotic one. Anything unreadable costs the backlog,
   * never the boot.
   */
  OfflinePlayQueue.prototype.restore = function (text) {
    this.entries = [];
    if (!text) return;
    try {
      var arr = JSON.parse(text);
      if (!Array.isArray(arr)) return;
      for (var i = 0; i < arr.length; i++) {
        var e = arr[i];
        // No start time cannot be reported honestly; no id cannot be de-duplicated on replay.
        // Either would poison the very data this is meant to repair.
        if (!e || typeof e !== 'object') continue;
        if (!e.client_event_id || !(e.started_at > 0)) continue;
        this.add(e);
      }
    } catch (err) {
      this.entries = [];
    }
  };

  /** Build one completed play, ready to queue. */
  OfflinePlayQueue.makePlay = function (o) {
    return {
      client_event_id: o.client_event_id,
      content_id: o.content_id || null,
      widget_id: o.widget_id || null,
      content_name: o.content_name || 'Unknown',
      started_at: o.started_at,
      ended_at: o.ended_at || null,
      completed: !!o.completed,
    };
  };

  /** A dependency-free unique id (crypto.randomUUID is absent on older webviews/BrightSign). */
  OfflinePlayQueue.newId = function () {
    try {
      if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch (e) { /* fall through */ }
    return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };

  OfflinePlayQueue.MAX_ENTRIES = MAX_ENTRIES;
  OfflinePlayQueue.BATCH = BATCH;
  return OfflinePlayQueue;
});
