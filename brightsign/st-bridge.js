/*
 * ScreenTinker — BrightSign bridge (the JavaScript half of autorun.brs).
 *
 * Loaded by the web player only when it is running on a BrightSign. Everything here is a
 * capability the page cannot get on its own, plus one thing it must be STOPPED from doing:
 *
 *   - reload():  a page-initiated location.reload() does not reliably bring an roHtmlWidget
 *                back (a ScreenTinker deploy darkened a customer's player this way on
 *                2026-07-28). Ask the host to rebuild the widget instead.
 *   - identity:  the registry survives reboots, content updates and origin changes;
 *                localStorage does not. The hardware serial is the stable id, so two panels
 *                imaged from the same card never collide.
 *   - sync:      exposes which backend this deployment uses, so the player can run its own
 *                clock-derived group sync or defer to BrightSign's native BrightWall.
 *
 * Safe to load anywhere: if the @brightsign modules are absent (a desktop browser, or a widget
 * built without nodejs_enabled) every method degrades to a no-op or a sane default, and
 * isBrightSign() reports false. Nothing here may throw — this file loads before the player.
 */
(function (global) {
  'use strict';

  var HEARTBEAT_MS = 30000;

  function tryRequire(name) {
    try {
      // `require` exists only inside an roHtmlWidget created with nodejs_enabled:true
      if (typeof require !== 'function') return null;
      return require(name);
    } catch (e) {
      return null;
    }
  }

  var MessagePortClass = tryRequire('@brightsign/messageport');
  var RegistryClass = tryRequire('@brightsign/registry');
  var DeviceInfoClass = tryRequire('@brightsign/deviceinfo');
  /*
   * ⚠️ @brightsign/videooutput does NOT set a video mode. Its surface is read-only plus power
   * (getVideoResolution / getEdid / isAttached / setPowerSaveMode / setBackgroundColor); there is
   * no setMode on it at all. Mode setting lives on @brightsign/videomodeconfiguration, whose
   * setMode() returns a Promise<{restartRequired}>.
   *
   * The two were conflated here, and the cost was not a broken call — the call was guarded — it was
   * a LIE: a widget with no host bridge declared display.resolution purely because videooutput
   * resolved, and the dashboard grew a resolution control that could never do anything.
   */
  var VideoModeConfigClass = tryRequire('@brightsign/videomodeconfiguration');
  var CecClass = tryRequire('@brightsign/cec');
  // Reads the attached display's EDID. Read-only; the mode setter is videomodeconfiguration.
  var VideoOutputClass = tryRequire('@brightsign/videooutput');
  /*
   * Node's standard library, present because the widget is created with nodejs_enabled. Used for
   * the LAN address (see refreshTelemetry) exactly as BrightSign's own dev-cookbook templates do.
   * tryRequire, not a bare require: in a plain browser there is no require at all, and this file
   * must load there too.
   */
  var osModule = tryRequire('os');
  var fsModule = tryRequire('fs');

  var port = null;
  if (MessagePortClass) {
    try { port = new MessagePortClass(); } catch (e) { port = null; }
  }

  // The UA check is the fallback for a widget without node integration: the player still needs
  // to know it is on a BrightSign so it can pick the right video and caching behaviour, even
  // when it cannot reach the host. Observed UA: "BrightSign/9.1.92.2 (HD1026) ... Chrome/120".
  var uaIsBrightSign = typeof navigator !== 'undefined' &&
    /BrightSign/i.test(navigator.userAgent || '');

  var listeners = [];
  if (port && typeof port.addEventListener === 'function') {
    try {
      port.addEventListener('bsmessage', function (msg) {
        for (var i = 0; i < listeners.length; i++) {
          try { listeners[i](msg); } catch (e) { /* one bad listener must not kill the rest */ }
        }
      });
    } catch (e) { /* no inbound channel; outbound may still work */ }
  }

  function post(obj) {
    if (!port || typeof port.PostBSMessage !== 'function') return false;
    try { port.PostBSMessage(obj); return true; } catch (e) { return false; }
  }

  var registry = null;
  if (RegistryClass) {
    try { registry = new RegistryClass(); } catch (e) { registry = null; }
  }

  function screenNumber() {
    try {
      var m = new RegExp('[?&]screen=([^&]*)').exec(global.location.search || '');
      var n = m ? parseInt(decodeURIComponent(m[1]), 10) : 1;
      return (isNaN(n) || n < 1) ? 1 : n;
    } catch (e) { return 1; }
  }

  /*
   * Registry keys are namespaced per output. On a dual-output player autorun.brs runs TWO
   * widgets against the same registry, the same SD storage_path and the same origin — so an
   * un-namespaced "device_id" would have both outputs adopt one identity and collapse into a
   * single device row. Screen 1 keeps the bare key so existing single-output panels are
   * unaffected.
   */
  function key(name) {
    var s = screenNumber();
    return s > 1 ? name + '_s' + s : name;
  }

  /*
   * The registry API is ASYNCHRONOUS and section-oriented:
   *   registry.read(section, key)      -> Promise<string>
   *   registry.write(section, {k: v})  -> Promise
   * (per @brightsign/registry in the dev-cookbook enable-ldws example and the trace-event docs).
   *
   * The player needs identity synchronously during boot, so the values are prefetched once into
   * a cache and every accessor reads the cache. Callers wait on whenReady() before trusting it.
   * Both shapes are tolerated — a Promise or a bare value — so a firmware that returns
   * synchronously still works rather than caching a Promise object as if it were a device id,
   * which would register a "[object Promise]" display.
   */
  /*
   * What the HOST told us about the hardware. Empty until the probe answers, and it may never
   * answer — a widget built without nodejs_enabled has no host at all. Every consumer treats
   * absence as "unknown", never as "no".
   */
  var probe = null;

  var SECTION = 'screentinker';
  // device_token belongs here as much as device_id: the server authenticates the claim to an
  // existing display with the token, so an id presented without one reads as a NEW display and
  // gets a fresh row. Persisting the id alone looked correct and still spawned a duplicate on
  // every boot — found on hardware, not in a test.
  var CACHED_KEYS = ['device_id', 'device_token', 'server_url', 'sync_backend'];
  var cache = {};
  var ready = false;
  var readyWaiters = [];

  function markReady() {
    if (ready) return;
    ready = true;
    var waiters = readyWaiters;
    readyWaiters = [];
    for (var i = 0; i < waiters.length; i++) {
      try { waiters[i](); } catch (e) { /* one bad waiter must not block the rest */ }
    }
  }

  function normalise(v) {
    return (v === undefined || v === null || v === '') ? null : String(v);
  }

  /*
   * Ask the host what the hardware can do. Folded into the SAME readiness gate as the registry
   * prefetch, because the player declares its capabilities at registration — and registration
   * happens once readiness fires. A probe that resolved afterwards would mean the first
   * registration of every boot carried the wrong capability set, and the dashboard would show
   * controls for a disk that is not there until the display happened to re-register.
   *
   * Never blocks: settle() runs on the answer, and the 5s cap in the boot path fires markReady
   * regardless, so a host that says nothing costs a slower boot rather than a dead player.
   */
  function probeHost(settle) {
    if (!port) { settle(); return; }
    var answered = false;
    listeners.push(function (msg) {
      if (answered || !msg || msg.type !== 'probe-result') return;
      answered = true;
      probe = msg;
      settle();
    });
    if (!post({ type: 'probe' })) { settle(); return; }
    // Independent of the global cap: if the host is alive but this one message is lost, readiness
    // must not wait the full 5s for it.
    if (global.setTimeout) global.setTimeout(function () {
      if (answered) return;
      answered = true;
      settle();
    }, 3000);
  }

  function prefetch() {
    // The probe still runs without a registry: a widget can have a host bridge and no registry
    // module, and the capability set matters more than the identity cache in that case.
    var pending = (registry ? CACHED_KEYS.length : 0) + 1;   // +1 = the host probe
    var settle = function () { if (--pending <= 0) markReady(); };

    probeHost(settle);
    if (!registry) return;

    for (var i = 0; i < CACHED_KEYS.length; i++) {
      (function (name) {
        var result;
        try { result = registry.read(SECTION, key(name)); } catch (e) { settle(); return; }
        if (result && typeof result.then === 'function') {
          result.then(
            function (v) { cache[name] = normalise(v); settle(); },
            function () { settle(); }
          );
        } else {
          cache[name] = normalise(result);
          settle();
        }
      })(CACHED_KEYS[i]);
    }
  }

  function regGet(name, fallback) {
    var v = cache[name];
    return (v === undefined || v === null) ? fallback : v;
  }

  /* values: { device_id: 'x', ... } using UNPREFIXED names; the screen suffix is applied here. */
  function regSet(values) {
    var payload = {};
    for (var name in values) {
      if (!Object.prototype.hasOwnProperty.call(values, name)) continue;
      var v = values[name];
      payload[key(name)] = v === null || v === undefined ? '' : String(v);
      cache[name] = normalise(v);
    }
    if (!registry) return false;
    try {
      var r = registry.write(SECTION, payload);
      // A rejected write must not surface as an unhandled rejection on a signage player.
      if (r && typeof r.catch === 'function') r.catch(function () {});
      return true;
    } catch (e) { return false; }
  }

  var cec = null;
  var cecTried = false;

  function getCec() {
    if (cecTried) return cec;
    cecTried = true;
    if (!CecClass) return null;
    try {
      // Connector names are HDMI-1..HDMI-4. Screen 2 lives on the second connector, so a
      // dual-output player powers the display it actually paints rather than always output 1.
      cec = new CecClass('HDMI-' + screenNumber());
    } catch (e) { cec = null; }
    return cec;
  }

  // Telemetry cache. Starts EMPTY rather than pre-filled with nulls: the player spreads this over
  // its own telemetry object, and a null here would overwrite a value another player family had
  // legitimately supplied. Absent means "nothing to say", which is not the same as "zero".
  var telemetry = {};

  // The attached panel's raw EDID, base64. Held apart from `telemetry` deliberately: it is
  // IDENTITY, not a reading. It changes only when someone physically swaps the screen, so it rides
  // the register (where hardware_model and hardware_serial already go) rather than the 15-second
  // heartbeat, where ~350 characters of unchanging data would be pure noise forever.
  var edidRaw = null;

  /*
   * Normalise whatever getEdid() hands back into base64.
   *
   * Its return type is undocumented and could not be determined from the firmware, so every
   * plausible shape is handled rather than betting on one and shipping a silent null to the fleet.
   * Returns null for anything unrecognisable — the server treats a missing EDID as "unknown",
   * which is honest, whereas a mangled one would be a lie that parses.
   */
  function toBase64(v) {
    try {
      if (!v) return null;
      if (typeof v === 'string') {
        var s = v.trim();
        if (!s) return null;
        // Hex comes back roughly twice the length of the 128/256 bytes it encodes.
        if (/^[0-9a-fA-F]+$/.test(s) && s.length >= 256) {
          var by = [];
          for (var i = 0; i < s.length; i += 2) by.push(parseInt(s.substr(i, 2), 16));
          return toBase64(by);
        }
        return s;   // already base64
      }
      var arr = (typeof v.length === 'number') ? v : (v.buffer ? new Uint8Array(v.buffer) : null);
      if (!arr || !arr.length) return null;
      var bin = '';
      for (var j = 0; j < arr.length; j++) bin += String.fromCharCode(arr[j] & 0xff);
      if (typeof global.btoa === 'function') return global.btoa(bin);
      var B = tryRequire('buffer');
      return B && B.Buffer ? B.Buffer.from(bin, 'binary').toString('base64') : null;
    } catch (e) { return null; }
  }

  /*
   * Facts pushed by the host, merged into the same cache the heartbeat reads.
   *
   * Registered at load, directly on the listener list rather than behind the readiness gate: the
   * host starts sending these the moment the widget exists, and anything attached later would miss
   * the boot report — the one that says which volume the player came up from and whether a package
   * applied.
   *
   * The host's numbers WIN over the page's where they overlap. navigator.storage.estimate()
   * describes the widget's cache quota, not the disk: a panel can report gigabytes free while the
   * volume holding them is full, and only the host can tell the difference.
   */
  /*
   * Host diagnostics arrive BEFORE anyone is listening, and that is not an edge case — it is the
   * normal order of events and the whole reason they are worth carrying.
   *
   * The host buffers its pre-widget boot lines and posts them the moment the page says hello. The
   * player, correctly, does not subscribe until its socket is connected, because a line forwarded
   * before that has nowhere to go. Between those two facts every boot line was dropped: the host
   * spoke into a page with no listener, and the listener arrived after the words had gone. The
   * player's own comment says wiring earlier "would drop the host's boot report on the floor" —
   * which was true, and left the report on the floor anyway.
   *
   * So the bridge holds them. Messages land in these queues from the moment the file loads, and are
   * replayed to each consumer as it registers. Bounded, because a host stuck in a reboot loop must
   * not grow this without limit on a player that runs for months.
   */
  var PENDING_MAX = 200;
  var logSinks = [];
  var eventSinks = [];
  var pendingLogs = [];
  var pendingEvents = [];

  function drain(queue, fn) {
    // Copied first: fn is free to register another sink, and iterating a live array while it is
    // being appended to is how a replay turns into a loop.
    var items = queue.slice();
    for (var i = 0; i < items.length; i++) {
      try { fn(items[i]); } catch (e) { /* one bad consumer must not eat the rest of the boot log */ }
    }
  }

  function fanout(sinks, queue, payload) {
    if (sinks.length === 0) {
      if (queue.length < PENDING_MAX) queue.push(payload);
      return;
    }
    for (var i = 0; i < sinks.length; i++) {
      try { sinks[i](payload); } catch (e) { /* ignore */ }
    }
  }

  listeners.push(function (msg) {
    if (!msg) return;
    if (msg.type === 'host-log') {
      fanout(logSinks, pendingLogs, {
        tag: String(msg.tag || 'host').slice(0, 64),
        level: String(msg.level || 'i').slice(0, 8),
        message: String(msg.message || '').slice(0, 2000)
      });
      return;
    }
    if (msg.type === 'host-event' && msg.event) {
      fanout(eventSinks, pendingEvents, {
        event: String(msg.event),
        reason: String(msg.reason || '').slice(0, 64),
        detail: String(msg.detail || '').slice(0, 500)
      });
    }
  });

  listeners.push(function (msg) {
    if (msg && msg.type === 'host-telemetry') {
      var keys = ['uptime_seconds', 'local_ip', 'model', 'os_version', 'video_mode',
                  'storage_volume', 'storage_free_mb', 'storage_total_mb',
                  'boot_volume', 'package_version'];
      for (var i = 0; i < keys.length; i++) {
        var v = msg[keys[i]];
        if (v !== undefined && v !== null && v !== '') telemetry[keys[i]] = v;
      }
    }
  });
  var TELEMETRY_REFRESH_MS = 60000;

  var deviceInfo = null;
  if (DeviceInfoClass) {
    try { deviceInfo = new DeviceInfoClass(); } catch (e) { deviceInfo = null; }
  }

  function qs(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location.search || '');
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  /*
   * Compare dotted versions. Returns -1/0/1. Missing or unparseable reads as OLDEST, so a feature
   * with a firmware floor is withheld when we cannot prove the floor is met — the safe direction
   * for a capability declaration.
   */
  function compareVersions(a, b) {
    var pa = String(a || '').split('.');
    var pb = String(b || '').split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = parseInt(pa[i], 10); if (isNaN(na)) na = -1;
      var nb = parseInt(pb[i], 10); if (isNaN(nb)) nb = -1;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  // SyncManager is documented from BrightSignOS 8.2.10. Below it the module may resolve and do
  // nothing, which is the worst outcome for a video wall: every panel reports healthy and drifts.
  var SYNCMANAGER_MIN_OS = '8.2.10';

  /*
   * WHAT THIS PLAYER CAN ACTUALLY DO — computed, never assumed.
   *
   * Declared to the server at registration and used by the dashboard to decide which controls to
   * offer. The whole point is that a static per-platform table cannot know any of this: the same
   * XT245 supports remote.screenshot with an SSD fitted and not without, and native sync only
   * above a firmware floor.
   *
   * The bias is deliberate. A capability is declared only when the thing it gates will actually
   * work; anything uncertain is withheld. A control that appears later, when a disk is fitted, is
   * a far smaller problem than a button that silently does nothing — which is the bug this whole
   * mechanism exists to remove.
   */
  function computeCapabilities() {
    var caps = [];
    var add = function (c) { caps.push(c); };

    // ---- always true on this platform -----------------------------------------------------
    // The player IS the web player; these are properties of the renderer, not of the hardware.
    add('playback.video'); add('playback.image'); add('playback.widget'); add('playback.youtube');
    add('playback.zones');
    add('audio.mute'); add('audio.volume');
    add('sync.clock');            // clock-derived group sync is pure JS and needs nothing
    add('remote.input');          // synthesised DOM events; needs no host and no mouse_enabled

    /*
     * ⚠️ Both of these composite DOM content over video, and with hwz the video is on a hardware
     * plane the DOM sits behind. They work over images and widgets and may be INVISIBLE over
     * video. Declared anyway because the failure is benign — a transition degrades to a hard cut,
     * which the engine already does on any failure — and withholding them would remove a feature
     * that genuinely works for the non-video majority of content.
     *
     * The likely fix is roVideoMode.SetGraphicsZOrder("front"), deliberately NOT applied here:
     * changing the z-order blind risks hiding video entirely on a player that currently works.
     * See the README — it wants a hardware experiment, not a guess.
     */
    add('playback.transitions'); add('playback.pip');

    /*
     * Service-worker content caching — and this platform does not have it.
     *
     * `navigator.serviceWorker` EXISTS on a BrightSign widget and is not usable: our XT245 on alpha
     * passes this exact check, then never even fetches sw.js. Presence was therefore the one signal
     * that could not distinguish "caches offline" from "cannot", and it answered yes to both — the
     * player advertised offline.cache to the whole fleet while being unable to hold a single byte
     * through an outage. The web player already learned this (it waits for a worker that is in
     * CONTROL, see declareCapabilities in server/player/index.html); this copy had not.
     *
     * A controller is proof, not a promise: something is actually intercepting this page's fetches.
     */
    try {
      var sw = global.navigator && global.navigator.serviceWorker;
      if (sw && sw.controller) add('offline.cache');
    } catch (e) { /* no SW in this widget */ }

    // ---- needs the host bridge --------------------------------------------------------------
    // Each of these is a BrightScript call. Without a host the page can only reload itself, and a
    // page-initiated reload does not reliably bring an roHtmlWidget back — the failure that
    // darkened a customer's panel on 2026-07-28. So none of them are declared without one.
    if (port) {
      add('system.restart_player');   // host rebuilds the widget
      add('system.reboot');           // RebootSystem
      add('display.rotation');        // roVideoMode transform — the ONLY way video rotates here
      add('display.resolution');      // roVideoMode SetMode
    } else if (VideoModeConfigClass) {
      // No host, but the JS mode-configuration module resolved: resolution alone is still reachable.
      add('display.resolution');
    }

    /*
     * Storage-gated. The DWS snapshot endpoint writes the full-size capture to disk before
     * returning a thumbnail, so with no card or SSD it answers "No primary storage found" —
     * verified on our XT245, which boots from internal flash and is refused. Self-update needs a
     * volume to stage autorun.zip onto for the same reason.
     *
     * Unknown (no probe answer) is treated as NO. Claiming a disk we could not confirm is exactly
     * the button-that-does-nothing case.
     */
    if (port && probe && probe.storage_present) {
      add('remote.screenshot');
      add('remote.stream');
      add('system.self_update');
    }

    /*
     * CEC. Module presence is a weak signal and we know it: our XT245 resolves @brightsign/cec
     * perfectly while the kernel logs "failed to get cec clock" and the display never responds.
     * There is no reliable way to distinguish "sent" from "received" without a cooperating
     * display, so this is declared on module presence and the README states the limitation.
     *
     * Blanking does NOT depend on this — the player tears the media down, which is what actually
     * works — so a display that ignores CEC still goes dark.
     */
    if (CecClass) add('display.power');

    /*
     * Native sync needs the module AND the firmware floor. Below 8.2.10 the module may exist and
     * silently do nothing, which on a video wall means every panel reports healthy while drifting
     * apart — strictly worse than falling back to our own clock-derived protocol.
     */
    var osVer = probe && probe.os_version ? probe.os_version : null;
    if (!osVer && deviceInfo) {
      try { osVer = deviceInfo.osVersion ? String(deviceInfo.osVersion) : null; } catch (e) { osVer = null; }
    }
    var syncManagerPresent = !!tryRequire('@brightsign/syncmanager');
    if (syncManagerPresent && osVer && compareVersions(osVer, SYNCMANAGER_MIN_OS) >= 0) {
      add('sync.native');
    }

    /*
     * NEVER declared, because BrightSign has no equivalent — this is the half of parity that is
     * about removing controls rather than adding features:
     *
     *   system.kiosk           there is no lock-task or device-owner concept; the player is the
     *                          only application on the box, so "kiosk" is not a mode to enter
     *   system.brightness      no per-window or system brightness control
     *   system.screen_timeout  no OS screen timeout; blanking is scheduled content, not a setting
     *   system.install_apk     not Android
     *   system.shell           no remote shell exposed to the player
     *   system.time            BrightScript CAN set time and timezone, but this host does not
     *                          implement it — declaring an unimplemented capability is the same
     *                          lie in the opposite direction
     */
    return caps;
  }

  var API = {
    /* True only when this really is a BrightSign — either module access or the UA. */
    isBrightSign: function () {
      return !!(port || registry || deviceInfo || uaIsBrightSign);
    },

    /* True when the host bridge is live, i.e. restart/identity/sync calls will be honoured. */
    hasHost: function () { return !!port; },

    /*
     * The stable hardware identity. autorun.brs passes it on the URL so it is available even
     * before the modules resolve; the module is the authority when both exist.
     */
    serial: function () {
      if (deviceInfo) {
        try {
          // `serialNumber` is the whole answer. There is no getDeviceUniqueId() on
          // @brightsign/deviceinfo — that is the BrightScript roDeviceInfo method name, and
          // BrightSign's own migration note maps it to this attribute. `deviceUniqueId` is the
          // legacy BSDeviceInfo global's spelling, also an attribute rather than a call, and is
          // read here only so a very old widget build still answers with something.
          var s = deviceInfo.serialNumber || deviceInfo.deviceUniqueId;
          if (s) return String(s);
        } catch (e) { /* fall through to the URL */ }
      }
      return qs('serial') || null;
    },

    model: function () {
      if (deviceInfo) {
        try { if (deviceInfo.model) return String(deviceInfo.model); } catch (e) { /* fall through */ }
      }
      return qs('model') || null;
    },

    osVersion: function () {
      if (deviceInfo) {
        try { if (deviceInfo.osVersion) return String(deviceInfo.osVersion); } catch (e) { /* ignore */ }
      }
      return null;
    },

    // The attached panel's raw EDID as base64, or null until the async probe answers (and forever
    // on a player whose firmware has no getEdid, or an output with nothing plugged in). The page
    // sends it on register; the server stores it COALESCE-style, so a null never erases a value
    // that arrived on an earlier connection.
    edid: function () { return edidRaw; },

    /* Which physical output this widget is painting. 1 unless autorun.brs made a second one. */
    screen: screenNumber,

    /*
     * Suffix callers should append to any per-display storage key. Two widgets on one player
     * share an origin and therefore share localStorage, so the config, playlist cache and
     * install salt all need separating or the second output silently becomes the first.
     */
    storageSuffix: function () {
      var s = screenNumber();
      return s > 1 ? '_s' + s : '';
    },

    /*
     * Persisted device id. Registry first (survives a card re-image with the same registry),
     * then the URL, then localStorage for the browser case.
     */
    deviceId: function () {
      var v = regGet('device_id', null) || qs('device_id');
      if (v) return v;
      try { return global.localStorage.getItem('st_device_id'); } catch (e) { return null; }
    },

    /* The credential that proves this player IS that display. Useless without deviceId, and
       deviceId is useless without it. */
    deviceToken: function () { return regGet('device_token', null); },

    /* Called once pairing completes, so a reboot comes back as the same display. */
    setIdentity: function (deviceId, serverUrl, deviceToken) {
      var values = {};
      if (deviceId) values.device_id = deviceId;
      if (serverUrl) values.server_url = serverUrl;
      if (deviceToken) values.device_token = deviceToken;
      regSet(values);
      post({ type: 'identity', device_id: deviceId || null, server_url: serverUrl || null });
    },

    /*
     * Forget this display. Required for the operator reset to mean anything: the registry
     * outlives localStorage, so clearing local storage alone would leave the panel re-adopting
     * the same identity on its next boot — a reset that resets nothing.
     */
    clearIdentity: function () {
      regSet({ device_id: '', device_token: '' });
      return post({ type: 'identity', clear: true });
    },

    /*
     * THE reload replacement. Never call location.reload() on this platform.
     * Returns false if there is no host, so the caller can decide whether reloading in place
     * is better than doing nothing (in a plain browser, it is).
     */
    restart: function (reason) {
      return post({ type: 'restart', reason: reason || 'unspecified' });
    },

    reboot: function () { return post({ type: 'reboot' }); },

    /*
     * Which sync protocol this deployment runs. Resolved by the server
     * (server/lib/sync-backend.js) and pushed down; the registry holds the last known value so
     * a cold boot with no network still starts in the right mode.
     *   'screentinker' — our clock-derived group sync; the only option in a mixed fleet.
     *   'brightsign'   — native BrightWall; the host drives it over the bridge.
     */
    syncBackend: function () {
      return qs('sync_backend') || regGet('sync_backend', 'auto');
    },

    setSyncBackend: function (backend) {
      if (!backend) return false;
      regSet({ sync_backend: backend });
      return post({ type: 'set-sync-backend', backend: backend });
    },

    /*
     * Identity readiness. The registry is async, so a caller that registers with the server
     * before this resolves would pair as a NEW display and leave a duplicate row behind. The
     * callback always runs — on success, on failure, or off-platform — so nothing can hang the
     * player waiting for hardware that isn't there.
     */
    isReady: function () { return ready; },

    onReady: function (fn) {
      if (typeof fn !== 'function') return;
      if (ready) { try { fn(); } catch (e) { /* ignore */ } return; }
      readyWaiters.push(fn);
    },

    /*
     * Real display power over CEC, which is the difference between a signage player and a browser
     * tab: the web player can only paint the screen black, leaving the panel lit, drawing power
     * and burning in. This actually tells the display to sleep.
     *
     *   on  = Image View On (0x0D)
     *   off = Standby       (0x36)
     *
     * 0x4f is a broadcast header. Returns false when CEC is unavailable so the caller still
     * applies the black overlay and something visible happens either way. Some displays ignore
     * broadcast and need direct addressing — hence "best effort", not "guaranteed".
     */
    displayPower: function (on) {
      var c = getCec();
      if (!c || typeof c.send !== 'function') return false;
      try {
        var packet = new Uint8Array(2);
        packet[0] = 0x4f;
        packet[1] = on ? 0x0d : 0x36;
        var r = c.send(Array.prototype.slice.call(packet));
        if (r && typeof r.catch === 'function') r.catch(function () {});
        return true;
      } catch (e) { return false; }
    },

    setVideoMode: function (mode) {
      if (VideoModeConfigClass) {
        try {
          var vmc = new VideoModeConfigClass();
          if (vmc && typeof vmc.setMode === 'function') {
            // Promise<{restartRequired}>. Nothing here awaits it — a mode change that restarts the
            // application takes this page with it, so there is no "after" to report into. Rejection
            // is swallowed rather than left as an unhandled rejection on a signage player.
            var r = vmc.setMode(mode);
            if (r && typeof r.catch === 'function') r.catch(function () {});
            return true;
          }
        } catch (e) { /* fall back to the host */ }
      }
      return post({ type: 'set-video-mode', mode: mode });
    },

    /*
     * Ask the HOST to capture what is actually on screen, and resolve with a data URL.
     *
     * This exists because an in-page capture cannot work here: with hwz enabled the video decodes
     * onto a hardware plane the DOM cannot read, so drawImage() returns a transparent frame and
     * throws nothing — a screenshot that reports success and shows a dead screen. The host uses
     * the player's own DWS, which captures the real framebuffer including video.
     *
     * Rejects rather than hanging: without a host, or if the player has no primary storage (the
     * DWS writes the full capture to disk before returning a thumbnail), the caller gets a reason
     * it can show instead of a spinner that never resolves.
     */
    /*
     * Capture the screen using BrightSign's OWN screenshot API — the composite of the video and
     * graphics layers, which is the whole point: an in-page canvas cannot read the hardware video
     * plane, so a DOM composite returns a frame with the content missing.
     *
     * Entirely page-side, and that is what makes it work here. The obvious route was to ask the
     * host (BrightScript) to capture via the player's DWS, but page->host messaging is dead after
     * load on this platform, so the request never arrived. `@brightsign/screenshot` needs no host,
     * no DWS, no messageport — just the Node `require` the widget already has (the same one that
     * makes `module` visible to classic scripts).
     *
     * The API writes a FILE rather than returning bytes, so it is read straight back with Node's
     * fs — available for exactly the same reason require() is.
     */
    captureScreen: function (opts) {
      var o = opts || {};
      return new Promise(function (resolve, reject) {
        var ScreenshotClass = tryRequire('@brightsign/screenshot');
        var fs = tryRequire('fs');
        if (!ScreenshotClass) { reject(new Error('no @brightsign/screenshot module')); return; }
        if (!fs) { reject(new Error('no fs module')); return; }

        // RAM FIRST, deliberately. The remote-control view drives this once a second, and a
        // screenshot per second written to the boot flash is a wear-out mechanism with no upside —
        // the file is read back and deleted microseconds later, so it never needs to be durable.
        // BrightSign exposes tmp as a RAM volume alongside the storage ones. Real storage is only
        // a fallback for a unit that does not present tmp, and the directory must already exist or
        // the capture fails, so each candidate is checked rather than assumed.
        var dirs = ['/storage/tmp', '/tmp', '/storage/ssd', '/storage/usb1', '/storage/sd', '/storage/flash'];
        var dir = null;
        for (var i = 0; i < dirs.length; i++) {
          try { if (fs.existsSync(dirs[i])) { dir = dirs[i]; break; } } catch (e) { /* keep looking */ }
        }
        if (!dir) { reject(new Error('no writable volume for the capture')); return; }

        var path = dir + '/st-capture.jpg';
        try { fs.unlinkSync(path); } catch (e) { /* first run, or already gone */ }

        var params = {
          destinationFileName: path,
          fileName: path,                 // deprecated alias, still honoured on older firmware
          fileType: 'JPEG',
          width: o.width || 960,
          height: o.height || 540,
          quality: o.quality || 70,
          rotation: 0,
        };

        var shot;
        try { shot = new ScreenshotClass(); } catch (e) { reject(new Error('screenshot object: ' + e.message)); return; }

        try {
          // syncCapture may interrupt on-screen operations, which the docs flag as a debugging
          // trait — but it guarantees the file exists when it returns, and an operator asking for
          // one screenshot is worth a single frame of interruption. The stream path uses async.
          if (o.async && typeof shot.asyncCapture === 'function') shot.asyncCapture(params);
          else if (typeof shot.syncCapture === 'function') shot.syncCapture(params);
          else if (typeof shot.asyncCapture === 'function') shot.asyncCapture(params);
          else { reject(new Error('screenshot object exposes neither capture method')); return; }
        } catch (e) { reject(new Error('capture failed: ' + e.message)); return; }

        // Poll for the file rather than trusting a return value: sync and async differ, and the
        // documented contract is "a file appears", not "a promise settles".
        var waited = 0;
        var tick = function () {
          var st = null;
          try { st = fs.statSync(path); } catch (e) { st = null; }
          if (st && st.size > 512) {
            var b64;
            try { b64 = fs.readFileSync(path).toString('base64'); }
            catch (e) { reject(new Error('could not read the capture: ' + e.message)); return; }
            try { fs.unlinkSync(path); } catch (e) { /* best-effort: never let cleanup fail a good capture */ }
            resolve('data:image/jpeg;base64,' + b64);
            return;
          }
          waited += 150;
          if (waited > (o.timeoutMs || 8000)) { reject(new Error('capture produced no file in ' + waited + 'ms')); return; }
          global.setTimeout(tick, 150);
        };
        global.setTimeout(tick, 150);
      });
    },

    requestSnapshot: function (opts) {
      var o = opts || {};
      return new Promise(function (resolve, reject) {
        if (!port) { reject(new Error('no host bridge')); return; }

        var settled = false;
        var timer = global.setTimeout(function () {
          if (settled) return;
          settled = true;
          reject(new Error('host did not answer in time'));
        }, o.timeoutMs || 15000);

        listeners.push(function handler(msg) {
          if (settled || !msg || msg.type !== 'snapshot-result') return;
          settled = true;
          try { global.clearTimeout(timer); } catch (e) { /* ignore */ }
          if (msg.ok && msg.image) resolve(msg.image);
          else reject(new Error(msg.error || 'snapshot failed'));
        });

        post({ type: 'snapshot', width: o.width || 640, height: o.height || 360 });
      });
    },

    /*
     * Rotate the physical output. Resolves true when the host rotated the screen itself, which is
     * the only way video rotates on this platform: a CSS transform cannot touch the hardware plane
     * the video decodes onto, so it would turn the images and widgets and leave the video alone.
     *
     * Resolves FALSE rather than rejecting when the host cannot do it — the caller then applies its
     * CSS transform, which rotates most of the content instead of none of it.
     */
    setOrientation: function (orientation, timeoutMs) {
      var self = this;
      return new Promise(function (resolve) {
        if (!port) { resolve(false); return; }
        var settled = false;
        var timer = global.setTimeout(function () {
          if (settled) return;
          settled = true;
          resolve(false);
        }, timeoutMs || 8000);

        listeners.push(function (msg) {
          if (settled || !msg || msg.type !== 'orientation-result') return;
          settled = true;
          try { global.clearTimeout(timer); } catch (e) { /* ignore */ }
          resolve(!!msg.ok);
        });

        post({ type: 'set-orientation', orientation: orientation });
      });
    },

    /*
     * The capability list to send at registration.
     *
     * Call AFTER onReady() — the host probe resolves inside the same readiness gate, and calling
     * earlier returns a set computed without it, which would under-report a display that does
     * have a disk. Cheap enough to call every registration rather than caching, so a display that
     * gains an SSD declares it at its next reconnect instead of at its next reboot.
     */
    capabilities: computeCapabilities,

    /*
     * The raw host probe, for diagnostics. Null until the host answers, and null forever on a
     * widget with no bridge — callers must treat that as "unknown", not as "nothing".
     */
    hostProbe: function () { return probe; },

    onHostMessage: function (fn) { if (typeof fn === 'function') listeners.push(fn); },

    /*
     * Host diagnostics, routed into the channels the player already speaks.
     *
     * The host sees things the page has no API for — the uptime, the wired IP, the video mode
     * actually in force, which volume it booted from, whether a staged package applied — and until
     * now it printed all of it to a serial console. On a panel on a wall that is the same as not
     * reporting it. A bad string literal once stopped this script compiling and the only evidence
     * anywhere was on a cable; the server just saw a player that never appeared.
     *
     * These are deliberately thin: the bridge does not decide what a log line or an incident MEANS,
     * it just carries them to the player, which sends them the same way it sends its own.
     */
    onHostLog: function (fn) {
      if (typeof fn !== 'function') return;
      logSinks.push(fn);
      drain(pendingLogs, fn);
    },

    onHostEvent: function (fn) {
      if (typeof fn !== 'function') return;
      eventSinks.push(fn);
      drain(pendingEvents, fn);
    },

    /*
     * Telemetry, read synchronously from a cache.
     *
     * The heartbeat builds its payload synchronously every 15s, but the only real number this
     * platform exposes — temperature — arrives from a PROMISE (deviceInfo.getTemperature()).
     * Awaiting it inside the heartbeat would either block the beat or, worse, serialise a pending
     * Promise into the telemetry object, which is exactly how device_id once became
     * "[object Promise]". So the values are refreshed on a timer and the beat reads whatever
     * landed last.
     *
     * Returns an EMPTY object off-platform, so the caller can spread it unconditionally and a
     * browser's telemetry is unchanged.
     */
    telemetrySnapshot: function () { return telemetry; },

    /*
     * Refresh the cache. Safe to call repeatedly; each source fails independently so one missing
     * API cannot take the others down with it.
     */
    refreshTelemetry: function () {
      // Temperature: documented on @brightsign/deviceinfo, resolves { celsius }.
      if (deviceInfo && typeof deviceInfo.getTemperature === 'function') {
        try {
          var t = deviceInfo.getTemperature();
          if (t && typeof t.then === 'function') {
            t.then(function (v) {
              var c = v && (v.celsius !== undefined ? v.celsius : v.Celsius);
              if (typeof c === 'number' && isFinite(c)) telemetry.temperature_c = Math.round(c * 10) / 10;
            }, function () { /* sensor unavailable on this model */ });
          }
        } catch (e) { /* older OS without the call */ }
      }

      /*
       * The address this player holds on the LAN — the one an integrator needs to reach its DWS on
       * site, and the field the dashboard has always had a slot for and never been able to fill.
       *
       * This is Node's own `os.networkInterfaces()`, which is what BrightSign's dev-cookbook does in
       * both html5-app-template/src/info.ts and src-js/info.js. The widget is created with
       * nodejs_enabled, so the standard library is simply there — there is no @brightsign module for
       * this, and looking for one is a dead end that cost a whole afternoon:
       *
       *   @brightsign/networkconfiguration EXISTS but exposes only callback,
       *   getNeighborInformation and enableLeds — no config reader at all.
       *   @brightsign/hostconfiguration has getConfig()/applyConfig(), but it returns HOST settings
       *   (forwardingEnabled, hostName, loginPassword, nameServers…) with no address in them.
       *
       * Both verified by enumerating the live objects on our XT245 (FW 9.1.93.2), not from docs —
       * the docs pages for the JavaScript API 404, and their own roNetworkConfiguration page links
       * to one of the dead URLs. getCurrentConfig() is BrightScript-only.
       *
       * `internal` is Node's own loopback flag, which beats string-matching 127.*; the 169.254
       * link-local a player assigns itself when DHCP never answered is still filtered by hand,
       * because sending an operator to an unreachable address is worse than showing nothing.
       *
       * family is compared loosely: it is the string "IPv4" on the Node in this firmware (and in
       * the cookbook), but became the number 4 in Node 18, and this file outlives firmwares.
       */
      if (osModule && typeof osModule.networkInterfaces === 'function') {
        try {
          var ifaces = osModule.networkInterfaces() || {};
          var names = Object.keys(ifaces);
          for (var ni = 0; ni < names.length; ni++) {
            var addrs = ifaces[names[ni]] || [];
            for (var ai = 0; ai < addrs.length; ai++) {
              var a = addrs[ai];
              if (!a || a.internal) continue;
              var ip = String(a.address || '');
              if (!ip) continue;
              var isV4 = (a.family === 'IPv4' || a.family === 4);
              var isV6 = (a.family === 'IPv6' || a.family === 6);
              if (isV4 && !telemetry.local_ip && ip.indexOf('169.254.') !== 0) telemetry.local_ip = ip;
              /*
               * The v6 column has existed as long as the v4 one and has never held anything, on any
               * player. The dashboard is already built for it — it renders a second card ONLY when
               * this is set, precisely so the overwhelmingly v4 fleet does not pay screen space for
               * an empty row.
               *
               * fe80:: is skipped for the same reason 169.254 is: a link-local address is scoped to
               * one interface and cannot be dialled from a laptop across the office, so reporting it
               * would send someone somewhere they cannot go. A ULA (fd00::/8) is kept — that IS
               * reachable on the site network, which is the question this field answers.
               */
              if (isV6 && !telemetry.local_ip6 && ip.toLowerCase().indexOf('fe80') !== 0) {
                // Node appends a zone id to link-locals ("fe80::1%eth0"); strip any that survives.
                var pct = ip.indexOf('%');
                telemetry.local_ip6 = pct === -1 ? ip : ip.slice(0, pct);
              }
            }
          }
        } catch (e) { /* no networking yet, or a firmware without it — stay silent */ }
      }

      /*
       * WHICH SCREEN IS PLUGGED IN, and what the output is actually driving.
       *
       * The first question about a dark sign is "which panel is that?", and until now the dashboard
       * could not answer it: screen_width/height are what the PAGE believes it has, which is the
       * widget's own geometry, not what the hardware negotiated with the display.
       *
       * The output is chosen by SCREEN NUMBER, because a dual-output player registers one device
       * row per output (?screen=N, see output_index) and each row must report its OWN panel — a box
       * driving a lobby TV and a menu board would otherwise show the lobby TV twice.
       *
       * Both names are tried. Probed on an XT245 (FW 9.1.93.2): "hdmi" and "HDMI-1" both resolve to
       * output 1 and answer with the same monitor, while a second output that does not exist fails
       * cleanly — "hdmi2" throws from the constructor and "HDMI-2" rejects. So a single-output
       * player simply reports nothing here rather than inventing a screen.
       */
      if (VideoOutputClass) {
        var wantScreen = screenNumber();
        var outNames = ['HDMI-' + wantScreen];
        if (wantScreen === 1) outNames.push('hdmi');
        for (var oi = 0; oi < outNames.length; oi++) {
          try {
            var vo = new VideoOutputClass(outNames[oi]);
            if (!vo || typeof vo.getEdidIdentity !== 'function') continue;
            var edid = vo.getEdidIdentity();
            if (edid && typeof edid.then === 'function') {
              edid.then(function (e) {
                var mn = e && (e.monitorName || e.monitor_name);
                if (typeof mn === 'string' && mn.trim()) telemetry.attached_display = mn.trim();
              }, function () { /* no display on this output */ });
            }

            /*
             * The RAW EDID, alongside the identity object above.
             *
             * getEdidIdentity() answers seven questions (monitorName, product, serialNumber, the
             * manufacture date and the BT2020/HDR flags) and cannot answer any others. Everything
             * else the player's own DWS prints — manufacturer, EDID version, physical size, gamma,
             * the VESA/standard/DTD mode lists, the CEA blocks — is in these bytes.
             *
             * Sent as-is and parsed on the SERVER (server/lib/edid.js). Parsing here would mean a
             * bridge update for every new field, and this file is the one behind a CDN that held it
             * for four hours at a stretch. Bytes now, questions later.
             *
             * The return shape is not documented and was not observable from the firmware strings,
             * so nothing is assumed: Uint8Array, Array, Buffer-like, hex or base64 all get
             * normalised to base64 here, and the parser accepts every one of those anyway.
             */
            if (typeof vo.getEdid === 'function') {
              try {
                var raw = vo.getEdid();
                if (raw && typeof raw.then === 'function') {
                  raw.then(function (bytes) { edidRaw = toBase64(bytes) || edidRaw; },
                           function () { /* no EDID on this output */ });
                } else if (raw) {
                  edidRaw = toBase64(raw) || edidRaw;
                }
              } catch (e) { /* older firmware without getEdid */ }
            }
          } catch (e) { /* no such output on this model */ }
        }
      }

      /*
       * The mode the output is negotiated to, which is not the same as the widget's size. Reported
       * as WxH@Hz so it reads the way an installer would say it out loud. Our XT245 answers
       * 1920x1200@60 — the panel's native mode, while the page reports its own 1920x1080 canvas.
       */
      if (VideoModeConfigClass) {
        try {
          var vmc = new VideoModeConfigClass();
          if (vmc && typeof vmc.getActiveMode === 'function') {
            var mode = vmc.getActiveMode();
            if (mode && typeof mode.then === 'function') {
              mode.then(function (m) {
                if (!m) return;
                var w = m.graphicsPlaneWidth || m.width;
                var h = m.graphicsPlaneHeight || m.height;
                var f = m.frequency || m.refreshRate;
                if (w && h) telemetry.video_mode = w + 'x' + h + (f ? '@' + f : '');
              }, function () { /* mode not readable on this firmware */ });
            }
          }
        } catch (e) { /* older OS without the call */ }
      }

      /*
       * Memory, load and REAL uptime — all from the same Node standard library the address above
       * came from, and all previously NULL on every BrightSign in the fleet.
       *
       * uptime deliberately OVERRIDES the page's own figure. index.html sends
       * performance.now()/1000, which is how long this PAGE has been up; a widget rebuilt by the
       * watchdog resets it while the player has been running for weeks. os.uptime() is the machine,
       * which is what an operator reading "uptime" means and what makes a reboot loop visible.
       *
       * cpu_usage is the 1-minute load average normalised by core count and expressed as a
       * percentage, so it is comparable with what the other players report rather than being a raw
       * load figure that means nothing next to them. Clamped, because load can exceed core count.
       */
      if (osModule) {
        try {
          if (typeof osModule.totalmem === 'function' && typeof osModule.freemem === 'function') {
            var totalB = osModule.totalmem();
            var freeB = osModule.freemem();
            if (isFinite(totalB) && totalB > 0) telemetry.ram_total_mb = Math.round(totalB / 1048576);
            if (isFinite(freeB) && freeB >= 0) telemetry.ram_free_mb = Math.round(freeB / 1048576);
          }
          if (typeof osModule.uptime === 'function') {
            var up = osModule.uptime();
            if (isFinite(up) && up > 0) telemetry.uptime_seconds = Math.round(up);
          }
          if (typeof osModule.loadavg === 'function' && typeof osModule.cpus === 'function') {
            var la = osModule.loadavg();
            var cores = (osModule.cpus() || []).length || 1;
            if (la && isFinite(la[0])) {
              var pct = Math.round((la[0] / cores) * 100);
              telemetry.cpu_usage = pct < 0 ? 0 : (pct > 100 ? 100 : pct);
            }
          }
        } catch (e) { /* a firmware without part of the stdlib — report what did work */ }
      }

      /*
       * REAL disk, from statfs rather than the browser's storage quota.
       *
       * The quota is what this file used to report and it is not the disk: our XT245 answered
       * "1026 MB total" for a 119 GB NVMe, because navigator.storage.estimate() describes the
       * widget's cache budget. An operator reading that has been told something false about the
       * machine, which is worse than an empty field.
       *
       * The volume is DISCOVERED, not assumed. BrightSign mounts storage under /storage (SD, SSD,
       * USB), and which one a given player boots from varies — ours runs from an NVMe while the
       * card slot is dead. So statfs every mount and keep the largest, which is the content volume
       * on every shape of player. Falls back to the widget's own working directory.
       */
      if (fsModule && typeof fsModule.statfsSync === 'function') {
        try {
          var candidates = [];
          try {
            var mounts = fsModule.readdirSync('/storage') || [];
            for (var mi = 0; mi < mounts.length; mi++) candidates.push('/storage/' + mounts[mi]);
          } catch (e) { /* no /storage on this firmware */ }
          candidates.push('/');
          var bestTotal = 0, bestFree = 0;
          for (var ci = 0; ci < candidates.length; ci++) {
            try {
              var st = fsModule.statfsSync(candidates[ci]);
              if (!st || !isFinite(st.blocks) || !isFinite(st.bsize)) continue;
              var tot = st.blocks * st.bsize;
              // bavail is space usable by an unprivileged writer; bfree includes the reserve.
              var fre = (isFinite(st.bavail) ? st.bavail : st.bfree) * st.bsize;
              if (tot > bestTotal) { bestTotal = tot; bestFree = fre; }
            } catch (e) { /* not a mount point */ }
          }
          if (bestTotal > 0) {
            telemetry.storage_total_mb = Math.round(bestTotal / 1048576);
            telemetry.storage_free_mb = Math.round(bestFree / 1048576);
          }
        } catch (e) { /* leave the quota estimate below to fill in */ }
      }

      /*
       * REAL device storage, when the host could see a volume.
       *
       * There is no JavaScript API for this — @brightsign/storage formats and ejects but does not
       * enumerate — which is why this previously reported the widget's cache quota instead. The
       * host has roStorageInfo and answers with the actual free/total of the mounted volume, so
       * "storage" in the dashboard now means the disk rather than a browser budget.
       *
       * Set BEFORE the quota estimate below so the real numbers win: the estimate only fills in
       * when the host had nothing to report.
       */
      if (probe && probe.storage_present) {
        var total = Number(probe.storage_total_mb);
        var free = Number(probe.storage_free_mb);
        if (isFinite(total) && total > 0) telemetry.storage_total_mb = Math.round(total);
        if (isFinite(free) && free >= 0) telemetry.storage_free_mb = Math.round(free);
      }

      /*
       * Fallback: the WIDGET'S storage quota (storage_path/storage_quota in autorun.brs), used
       * only when the host reported no volume. It is the budget the player has for cached content
       * and it is what fills up, so it is worth reporting — but it is not the disk, and it must
       * never overwrite a real figure from the host.
       */
      if (!telemetry.storage_total_mb) {
        try {
          var s = global.navigator && global.navigator.storage;
          if (s && typeof s.estimate === 'function') {
            var e = s.estimate();
            if (e && typeof e.then === 'function') {
              e.then(function (est) {
                if (!est) return;
                // Re-checked inside the callback: a host probe can land while this is in flight,
                // and the disk figure must not be overwritten by the cache budget afterwards.
                if (telemetry.storage_total_mb) return;
                var quota = Number(est.quota), usage = Number(est.usage);
                if (isFinite(quota) && quota > 0) {
                  telemetry.storage_total_mb = Math.round(quota / 1048576);
                  if (isFinite(usage)) telemetry.storage_free_mb = Math.round((quota - usage) / 1048576);
                }
              }, function () { /* estimate refused */ });
            }
          }
        } catch (e) { /* no storage manager */ }
      }
    },

    /*
     * Heartbeat. autorun.brs rebuilds the widget after three missed beats, which is what
     * recovers a page that loaded fine and then wedged (dead socket, JS exception, decoder
     * stall) — a case load-error never reports.
     */
    startHeartbeat: function () {
      if (!port) return;
      var beat = function () { post({ type: 'heartbeat', t: Date.now() }); };
      beat();
      return global.setInterval(beat, HEARTBEAT_MS);
    }
  };

  global.ScreenTinkerBS = API;

  // Kick the registry prefetch immediately, and never let a silent module hold boot: the player
  // stops waiting after this and carries on with whatever identity it has.
  prefetch();
  if (global.setTimeout) global.setTimeout(markReady, 5000);

  // Only worth polling where a sensor exists. A browser has neither the temperature API nor a
  // meaningful storage quota to report, and an interval that can only ever produce nothing is
  // just a timer burning a wakeup every minute on a device that runs for months.
  if (API.isBrightSign()) {
    API.refreshTelemetry();
    if (global.setInterval) global.setInterval(API.refreshTelemetry, TELEMETRY_REFRESH_MS);
  }

  if (API.hasHost()) API.startHeartbeat();
})(typeof window !== 'undefined' ? window : this);
