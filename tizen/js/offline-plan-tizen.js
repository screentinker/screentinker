/*
 * ScreenTinker Tizen: offline schedule plan (#825).
 *
 * The server can send a bounded, already-UTC timeline of what this screen should show for the next
 * 14 days (server/lib/offline-schedule-plan.js), plus a normal payload for every distinct state in
 * it. Without it, a panel that loses its server can only replay the LAST payload it saw, so a
 * schedule that ended while it was offline keeps playing through the gap that follows (#818 on
 * Android, the same shape here). The plan is opt-in: the server sends it only to a player that
 * declares `offline.schedule_plan` (capabilities.js), and strips it for everyone else.
 *
 * The timeline maths is NOT here. Interval selection, the validity window and dependency discovery
 * are the Samsung SSSP3 player's STOfflinePlan (samsung-sssp3/app/offline-plan.js), shipped in
 * this .wgt as js/offline-plan.js, byte-identical (build-wgt.sh copies it; a drift test pins it).
 * The device does no timezone or DST work at all: the server already turned local wall-clock edges
 * into UTC boundaries, so choosing a state is one comparison against the trusted clock.
 *
 * What lives here is the Tizen glue, written to be driven from Node without a TV:
 *   - the CACHE GATE: a new plan is held as `pending` and committed only once every media item it
 *     references (each state's assignments and default_content, as the copies this TV actually
 *     plays) is complete in MediaCache. Until then the last complete plan stays the authority.
 *   - the ATOMIC COMMIT: one localStorage.setItem of the whole plan, read back before it is
 *     believed. A failed write leaves the previous value in place (per the Storage spec), so a
 *     power cut or a full store can never leave a half plan behind.
 *   - the OFFLINE DRIVER: while the socket is not live, tick() returns the payload for the interval
 *     the clock is in, once per interval. A gap resolves to the server's `schedule_id: null` state,
 *     which IS the normal unscheduled state (base playlist, or empty + default_content).
 *   - reconciliation: every live payload re-seeds which interval is "already on screen", so the
 *     live server stays authoritative while connected and the driver only acts at the next edge.
 *
 * ⚠️ FAIL OPEN. Every entry point catches and answers "no opinion" (null), which the caller treats
 * as today's behaviour: replay the last payload, or keep what is on screen. Nothing here may be the
 * reason a screen goes black. Plain ES5 on purpose; this runs on 2017-era Samsung web engines.
 */
(function (root) {
  'use strict';

  var PLAN_KEY = 'st_offline_plan';
  // The keys the server copies into a state payload (offlineStatePayload in deviceSocket.js). A
  // state replaces exactly these on top of the last live payload; everything else (wall_config,
  // group_sync, timezone, custom_shaders, volume...) describes the SCREEN, not the schedule, and is
  // carried over from the last live payload so a wall member offline is still its own slice.
  var STATE_KEYS = ['assignments', 'layout', 'orientation', 'background_color', 'playback_order', 'default_content'];
  // A plan that differs only by its clipped first interval and a later expiry is the same promise.
  // Re-committing it is a 2MB flash write; do it only when it buys at least this much more horizon.
  var REFRESH_HORIZON_MS = 6 * 60 * 60 * 1000;

  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function cacheable(it) {
    // Exactly what MediaCache.sync would fetch. A widget, a stream, a hold or a remote URL has no
    // bytes this player can keep, so it cannot gate a plan (it is online-only today as well).
    return !!(it && it.content_id && !it.remote_url && it.mime_type !== 'application/x-st-hold');
  }

  /* Structural identity of a plan: its states and its boundaries, minus the parts that move every
   * time the server rebuilds it (generation time, the first interval's clipped start, the expiry). */
  function structure(plan) {
    var iv = plan.intervals || [], out = [], i;
    for (i = 0; i < iv.length; i++) {
      out.push([i === 0 ? 0 : iv[i].start_utc_ms, i === iv.length - 1 ? 0 : iv[i].end_utc_ms,
        iv[i].schedule_id || null, iv[i].playlist_id || null, iv[i].layout_id || null]);
    }
    return JSON.stringify([out, plan.states || []]);
  }

  function create(opts) {
    var P = opts.plan;                        // STOfflinePlan
    var storage = opts.storage;               // { get(k), set(k, v), del(k) }
    var now = opts.now;                       // trusted clock: Date.now() + server offset
    var cache = opts.cache || function () { return null; };       // -> MediaCache | null
    var videoItems = opts.cacheItems || function (items) { return items; }; // StVideoPlan.cacheItems
    var log = opts.log || function () {};

    var committed = null;   // last complete, verified plan (parsed)
    var committedSig = '';
    var pending = null;     // newest plan from the server, not yet fully cached
    var pendingSig = '';
    var applied = null;     // key of the interval whose content is on screen

    try { committed = P.read(storage.get(PLAN_KEY)); if (committed) committedSig = structure(committed); }
    catch (e) { committed = null; }

    function resolve(plan, at) {
      if (!plan) return null;
      var r = P.select(plan, at);
      if (!r || !r.valid || !r.interval) return null;          // expired / uncovered: no opinion
      var state = r.state, i, s;
      if (!r.interval.schedule_id) {
        // A gap. STOfflinePlan hands back no state here (the SSSP3 renderer paints idle itself);
        // this player renders the server's unscheduled state, which may be the base playlist.
        state = null;
        for (i = 0; i < plan.states.length; i++) {
          s = plan.states[i];
          if (s && !s.schedule_id && s.payload) { state = s; break; }
        }
      }
      if (!state || !state.payload || !Array.isArray(state.payload.assignments)) return null;
      return { key: String(r.interval.start_utc_ms) + '|' + String(r.interval.schedule_id || ''), payload: state.payload };
    }

    function merge(base, statePayload) {
      var out = {}, k, i;
      if (typeof base === 'function') base = base();
      if (base && typeof base === 'object') {
        for (k in base) if (own(base, k) && k !== 'offline_plan' && k !== 'suspended') out[k] = base[k];
      }
      for (i = 0; i < STATE_KEYS.length; i++) {
        k = STATE_KEYS[i];
        if (own(statePayload, k)) out[k] = statePayload[k]; else delete out[k];
      }
      return out;
    }

    /* Every item the plan needs on disk, as the copies this TV would play. */
    function deps(plan, base) {
      var out = [], states = (plan && plan.states) || [], i, j, p, items, orient;
      var wall = !!(base && base.wall_config);
      for (i = 0; i < states.length; i++) {
        p = states[i] && states[i].payload;
        if (!p) continue;
        items = Array.isArray(p.assignments) ? p.assignments.slice() : [];
        if (p.default_content) items.push(p.default_content);
        orient = wall ? 'landscape' : (p.orientation || 'landscape');
        items = videoItems(items, orient) || [];
        for (j = 0; j < items.length; j++) if (cacheable(items[j])) out.push(items[j]);
      }
      return out;
    }

    function complete(plan, base) {
      var mc = cache(), list, i;
      if (!mc || typeof mc.localUrl !== 'function') return false;
      list = deps(plan, base);
      for (i = 0; i < list.length; i++) if (!mc.localUrl(list[i].content_id, list[i].content_rev)) return false;
      return true;
    }

    function commit(plan, sig) {
      var text = JSON.stringify(plan), back;
      storage.set(PLAN_KEY, text);
      back = storage.get(PLAN_KEY);
      if (back !== text) {
        // The store refused it (quota) or holds something else. Whatever is there is the previous
        // value or nothing; re-read it so memory never claims a plan the disk does not have.
        committed = P.read(back);
        committedSig = committed ? structure(committed) : '';
        log('warn', 'offline plan commit did not persist; keeping the previous plan');
        return false;
      }
      committed = plan; committedSig = sig;
      log('info', 'offline plan committed: ' + plan.intervals.length + ' intervals until ' + new Date(Number(plan.valid_until_utc_ms)).toISOString());
      return true;
    }

    function clear() {
      committed = null; committedSig = ''; pending = null; pendingSig = ''; applied = null;
      storage.del(PLAN_KEY);
    }

    function seed() {
      var r = resolve(committed, now());
      applied = r ? r.key : null;
    }

    return {
      PLAN_KEY: PLAN_KEY,

      /* Called with EVERY live device:playlist-update. Returns the payload to render: the same
       * object when it carried no plan (a non-capable screen is untouched), otherwise a copy without
       * `offline_plan`, so the plan never rides into st_payload_cache or a replay. */
      ingestLive: function (payload) {
        if (!payload || typeof payload !== 'object' || !own(payload, 'offline_plan')) {
          try {
            // The operator took the screen away. The plan must not hand it back while offline.
            if (payload && payload.suspended && (committed || pending)) clear();
            else seed();
          } catch (e) { /* fail open */ }
          return payload;
        }
        var render = {}, k, incoming;
        for (k in payload) if (own(payload, k) && k !== 'offline_plan') render[k] = payload[k];
        try {
          incoming = payload.offline_plan;
          if (incoming === null) {
            // The server's explicit "no plan": override, emergency, corporate mandate, or no
            // schedules at all. Never let an offline panel resurrect the old one.
            clear();
          } else {
            incoming = P.read(incoming);
            if (incoming) {
              var sig = structure(incoming);
              var same = committed && sig === committedSig;
              var longer = committed && Number(incoming.valid_until_utc_ms) - Number(committed.valid_until_utc_ms) >= REFRESH_HORIZON_MS;
              // The newest plan is always the candidate; an older pending one is superseded.
              if (!same || longer) { pending = incoming; pendingSig = sig; }
              else { pending = null; pendingSig = ''; }
              // A plan whose media is already here commits now; otherwise afterSync() does it.
              if (pending && complete(pending, render)) { if (commit(pending, pendingSig)) { pending = null; pendingSig = ''; } }
            }
            // An unreadable plan is ignored: the last verified one stays.
          }
          seed();
        } catch (e) { /* fail open: the live payload still renders */ }
        return render;
      },

      /* Items MediaCache.sync should keep and fetch for this payload: the current ones plus every
       * plan's dependencies, so applying one state never evicts the next interval's media. Current
       * items go LAST: the cache holds one revision per id, and the live payload is the newest. */
      cacheItems: function (current, base) {
        try {
          if (!committed && !pending) return current;
          var mc = cache(), out = [], cur = current || [], i, id, idx;
          out = out.concat(deps(committed, base), deps(pending, base), cur);
          // MediaCache never prunes on a payload that references no media (a server-side parse
          // failure looks exactly like that). Adding plan items would make it prune, so keep
          // everything already complete as well, which turns that sweep back into a non-prune.
          var curMedia = false;
          for (i = 0; i < cur.length; i++) if (cur[i] && cur[i].content_id) { curMedia = true; break; }
          if (!curMedia && mc && mc.index) {
            idx = mc.index;
            for (id in idx) if (own(idx, id) && idx[id] && idx[id].complete) out.unshift({ content_id: id, content_rev: idx[id].rev });
          }
          return out;
        } catch (e) { return current; }
      },

      /* After a cache pass: commit the pending plan if everything it needs is now on disk. */
      afterSync: function (base) {
        try {
          if (pending && complete(pending, base) && commit(pending, pendingSig)) { pending = null; pendingSig = ''; seed(); }
        } catch (e) { /* the previous plan stays */ }
      },

      /* Cold boot, before the socket: the payload for now, or null for "replay the legacy cache".
       * `base` (the last live payload, or a function returning it) supplies the screen-level keys. */
      boot: function (base) {
        try {
          var r = resolve(committed, now());
          if (!r) return null;
          applied = r.key;
          return merge(base, r.payload);
        } catch (e) { return null; }
      },

      /* Offline driver, called about once a second while the socket is not live. Returns a payload
       * only when the clock has crossed into a different interval; null means leave the screen. */
      tick: function (base) {
        try {
          var r = resolve(committed, now());
          if (!r || r.key === applied) return null;
          applied = r.key;
          log('info', 'offline plan: entering interval ' + r.key);
          return merge(base, r.payload);
        } catch (e) { return null; }
      },

      clear: function () { try { clear(); } catch (e) { /* storage gone; memory is cleared */ committed = null; pending = null; } },
      hasPlan: function () { return !!committed; },
      _state: function () { return { committed: committed, pending: pending, applied: applied }; }
    };
  }

  /* Can this runtime durably keep a plan? Probed by writing, never assumed. */
  function storageUsable(ls) {
    try {
      var k = '__st_plan_probe', v = String(Math.random());
      ls.setItem(k, v);
      var ok = ls.getItem(k) === v;
      ls.removeItem(k);
      return ok;
    } catch (e) { return false; }
  }

  root.STTizenOfflinePlan = { create: create, storageUsable: storageUsable, PLAN_KEY: PLAN_KEY, STATE_KEYS: STATE_KEYS };
})(typeof window !== 'undefined' ? window : this);
