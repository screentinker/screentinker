'use strict';

/*
 * What a player can actually do.
 *
 * The dashboard offered every control to every display. A browser tab cannot reboot its host, a
 * Tizen TV has no device-owner concept, a BrightSign has no per-window brightness — so those
 * buttons did nothing, silently, and looked like bugs. "UI that reports success and changes
 * nothing" is a recurring shape in this codebase and this module exists to end it.
 *
 * The player DECLARES its capabilities at registration, because only the player knows at runtime:
 * an Android device gains real screenshots when accessibility is switched on, and loses Tier-2
 * commands when it is not device owner. A static per-platform table could never know that.
 *
 * ⚠️ Legacy displays declare nothing. A fleet of several hundred is not going to update before the
 * next dashboard deploy, so an absent declaration falls back to a per-platform baseline rather
 * than to "supports nothing" — which would strip the UI for every existing display at once. The
 * baseline is deliberately optimistic for things that always worked, and pessimistic for anything
 * that depends on runtime state.
 */

/*
 * The vocabulary. Stable strings, because they are persisted per device and sent over the wire —
 * renaming one silently disables a control on every display that still reports the old name.
 * Grouped by what the operator is trying to do, not by how it is implemented.
 */
const CAPABILITIES = [
  // playback surface
  'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
  'playback.zones', 'playback.transitions', 'playback.pip',
  // audio
  'audio.mute', 'audio.volume',
  // display
  'display.rotation', 'display.power', 'display.resolution', 'display.brightness',
  // remote view / control
  'remote.screenshot', 'remote.stream', 'remote.input',
  // lifecycle
  'system.reboot', 'system.restart_player', 'system.self_update',
  // device management (Android device-owner territory)
  'system.kiosk', 'system.brightness', 'system.screen_timeout',
  'system.install_apk', 'system.shell', 'system.time',
  // The rest of the Tier-2 surface: lock the screen now, show the power menu, hide the status
  // bar, block uninstall. Separate from 'system.kiosk' because kiosk means lock-task specifically
  // and a panel can hold one without the other — and separate from the individual names above
  // because these four are only ever available together, gated by the same device-owner check.
  // Runtime state, not a platform fact: a panel that loses device owner loses all of them.
  'system.device_owner',
  // synchronisation
  'sync.clock', 'sync.native',
  // resilience
  'offline.cache',
];

const CAP_SET = new Set(CAPABILITIES);

/*
 * Baselines for displays that declare nothing.
 *
 * THE RULE, and it is the only one that keeps this table honest: a baseline entry describes what
 * the LAST RELEASED player for that platform does, unconditionally, with no privilege it might not
 * have been granted. Not what HEAD does — HEAD declares for itself. Not what the platform could do
 * — a capability nobody shipped is a button nobody can press.
 *
 * Every entry below was checked against `git show v1.9.28:<player source>`, the last release before
 * capability declaration existed at all, because v1.9.29 is the first build in which any player
 * declares anything. Every display that falls back to a baseline is therefore running v1.9.28 or
 * older by construction, and that is the build the justifications cite.
 */
const BASELINE = {
  android: [
    'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
    'playback.zones', 'playback.transitions', 'playback.pip',
    // set_volume and set_brightness are #160 Track-A, released in v1.9.10 — long before anything
    // still in the field. Both are Tier 0: MainActivity applies them with no owner, no admin and
    // no WRITE_SETTINGS, so they are unconditional on any build a fielded panel could be running.
    'audio.mute', 'audio.volume',
    'display.rotation', 'display.power', 'display.brightness',
    // Capture without accessibility falls back to ScreenshotCapture.captureView, which is a real
    // frame of the player's own view — i.e. of the content. Narrower than the full-screen path,
    // but the operator gets a picture, not a dead button.
    'remote.screenshot', 'remote.stream',
    'remote.input',
    'system.restart_player', 'system.self_update',
    'sync.clock', 'offline.cache',
    // display.power is KEPT for the un-updated Android fleet, deliberately, with the trade-off
    // recorded here because it is genuinely two-sided.
    //
    // v1.9.28 MainActivity answers screen_on with
    //   Log.w("screen_on: no privileged wake path on a non-rooted panel — no-op")
    // so the ON half is dead on every fielded Android panel, while screen_off does work (device
    // owner / device-admin FORCE_LOCK, else the accessibility lock). One capability renders BOTH
    // dashboard buttons, so this baseline cannot offer the working half without the dead one.
    //
    // Withholding it takes away blank-at-night, which is the half signage actually schedules, from
    // every panel that has not updated. Keeping it means an operator can sleep a screen and not
    // wake it from the dashboard — mitigated by the fact that a schedule, a restart, or anyone
    // standing at the panel will wake it, while nothing else can blank it.
    //
    // A panel that HAS updated declares for itself, and PlayerCapabilities.kt gates its own claim
    // on both halves — so this governs the un-updated fleet only. If the dead ON button turns out
    // to be the louder complaint, split it into display.power_off / display.power_on rather than
    // dropping the pair.
    //
    // NOT system.reboot. STPolicy.reboot() requires device owner; off-owner v1.9.28 falls back to
    // the accessibility power DIALOG, which needs a human standing at the screen — and on the
    // accessibility-enabled panels that are common in this fleet it paints that dialog OVER the
    // signage. Device-owner provisioning is not released (#161/PR #168 is still open), so the set
    // of panels that are both device owner AND pre-1.9.29 is effectively empty.
    // ⚠️ Consequence, deliberately accepted: services/scheduler.js gates the nightly scheduled
    // reboot on this capability, so scheduled reboots now no-op for undeclared Android panels
    // instead of logging "scheduled reboot fired" for a panel that never rebooted. That log line
    // is the reason the gate is there; the honest answer is to skip, not to claim.
    //
    // NOT system.shell / system.kiosk / system.time / system.install_apk / system.brightness /
    // system.screen_timeout: every one is device-owner or WRITE_SETTINGS conditional.
  ],
  tizen: [
    'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
    'playback.zones', 'playback.transitions', 'playback.pip',
    // audio.mute only. `git show v1.9.28:tizen/js/app.js` has NO set_volume handler — the command
    // falls through STDeviceControl.run to "unknown command", so the dashboard slider does nothing
    // on every fielded panel. (HEAD ships applyVolume, but see the note on BASELINE.web: it reads
    // payload.value while the dashboard sends payload.level, so even HEAD's slider is dead. The
    // baseline stays out until a released .wgt honours the payload the product actually sends.)
    'audio.mute',
    'display.rotation',
    // Both really are implemented in the shipped player (captureAndSend / startStreaming), so
    // omitting them would have hidden working controls on every legacy Tizen panel.
    'remote.screenshot', 'remote.stream',
    'remote.input',
    // ADDED after audit. v1.9.28 app.js implements BOTH halves with no partner signing and no
    // panel API: screen_off -> showScreenOff() paints the blanking overlay, screen_on ->
    // clearScreenOff() + keepAwake(). Unlike Android above, neither half is privilege-gated, so
    // the pair is honest. The panel backlight stays lit — the log line says which mechanism ran —
    // but the screen genuinely goes dark, and HEAD's capabilities.js declares it for that reason.
    'display.power',
    'system.restart_player',
    'sync.clock',
    // NOT offline.cache: v1.9.28 has no tizen/js/media-cache.js at all (the file is new at HEAD).
    // The fielded player caches only the playlist JSON (st_payload_cache in localStorage), so an
    // outage leaves the panel knowing exactly what it cannot show. My first baseline claimed it —
    // caught by the platform audit, and exactly the kind of optimistic claim this model exists to
    // stop.
  ],
  /*
   * A BrightSign that declares nothing is a BrightSign we cannot prove has a host bridge, and that
   * is the whole story of this baseline.
   *
   * The JS half of the bridge is served BY US (server.js routes /player/st-bridge.js at
   * brightsign/st-bridge.js), so it is always current — but it is only half. `port` exists only
   * inside an roHtmlWidget created with nodejs_enabled:true, which is the on-device BrightScript's
   * decision, and `git ls-tree v1.9.28 brightsign/` shows no st-bridge.js at all: no released
   * package ever shipped the two halves as a pair. The one real BrightSign we have runs BSN
   * Supervisor's widget rather than our autorun.brs, and BS.hasHost() is false on it.
   *
   * A unit that DOES have a bridge declares for itself and never reads this list — the page
   * computes hasHost() at registration. So this baseline only ever answers for a row that has not
   * re-registered, and the right answer for a display we know nothing about is the floor:
   * everything below is "the web player with no bridge", and nothing above that.
   */
  brightsign: [
    'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
    'playback.zones', 'playback.transitions', 'playback.pip',
    'audio.mute',
    // CSS transform. Graphics rotate; with hwz the video sits on a hardware plane that ignores it,
    // so this is partial — but nothing routes a COMMAND to display.rotation and no control is
    // gated on it, so the entry describes content rendering rather than offering a button.
    'display.rotation',
    'remote.input',
    // RESTORED in 1.9.31 with BASELINE.web, and for the same reason plus one of its own: a
    // BrightSign runs the web player we serve, so it gets the fixed handler the moment the server
    // does. The unit-specific question is whether the media element is even reachable on a player
    // that puts video on a hardware plane — and that question is already settled by `audio.mute`
    // above, which this baseline has always claimed: set_volume reaches setMediaVolume() and
    // device:mute-changed reaches `currentVideoEl.muted`, the same element by the same path. If hwz
    // silently swallowed one it would swallow both, so volume is exactly as honest as mute here.
    'audio.volume',
    'sync.clock',
    // NOT offline.cache. This is the documented case, not a hypothetical: the XT245 on alpha has
    // navigator.serviceWorker, passes every presence check, and then never fetches sw.js because
    // its widget refuses the registration. It advertised offline caching to the fleet and could
    // not cache one byte. A widget with no storage_path has no persistent storage at all, and the
    // baseline cannot know which kind of widget it is talking to.
    //
    // NOT system.restart_player. `refresh` reaches restartPlayer(), which without a host does
    // location.reload() — and a page-initiated reload does not reliably bring an roHtmlWidget
    // back. That is what darkened a customer's panel on 2026-07-28. st-bridge.js withholds this
    // for the same reason; a baseline that hands it to every undeclared unit undoes that.
    //
    // NOT system.reboot / display.power / display.resolution / system.self_update: all four are
    // BrightScript calls through a bridge this unit is not known to have.
    //
    // NOT remote.screenshot / remote.stream: a canvas capture on a hwz player cannot read the video
    // plane, so it returns a frame with a hole where the content is. (audio.volume moved INTO the
    // list above in 1.9.31 — the payload it was waiting on now lands.)
  ],
  // A browser tab. Deliberately the smallest set: it cannot reboot its host, rotate a panel, or
  // capture anything outside its own document.
  web: [
    'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
    'playback.zones', 'playback.transitions', 'playback.pip',
    'audio.mute',
    'display.rotation',
    'remote.screenshot', 'remote.stream', 'remote.input',
    'system.restart_player',
    // RESTORED in 1.9.31, having been removed by the audit that found the slider dead. Both of the
    // reasons it was removed have expired, and the second one was reasoning from the wrong artifact:
    //   1. It read `data.payload?.value ?? data.value` while the dashboard sends `{ level: 0..1 }`,
    //      so the number was undefined and the handler declined. Fixed in 1.9.31 — index.html now
    //      takes the fraction as canonical (volumeLevelFromCommand) and set_volume reaches
    //      setMediaVolume().
    //   2. The removal cited `git show v1.9.28:server/player/index.html` having no handler at all.
    //      But this player is SERVED BY THE SERVER: a browser panel loads it from whatever build is
    //      running, not from the release its row was created under. There is no such thing as a
    //      browser panel stuck on the v1.9.28 player once the server moves — which is the whole
    //      difference between this baseline and the Android/Tizen ones below, where an un-updated
    //      panel really is running an old artifact.
    // So the moment the server ships the fix, an undeclared web display can be driven, and holding
    // the entry back would hide a control that works. Released and live on prod 2026-08-06.
    'audio.volume',
    'sync.clock', 'offline.cache',
  ],
};

/*
 * Which baseline a device falls back to. Keyed off the same `platform` field the sync resolver
 * uses, so a device is classified one way across the whole product.
 */
function platformFamily(device) {
  const platform = String((device && device.platform) || '').toLowerCase();
  const android = String((device && device.android_version) || '');
  const clientType = (device && device.client_type) || '';
  if (platform.includes('brightsign')) return 'brightsign';
  if (platform.includes('tizen')) return 'tizen';
  // Second, independent signal for a Tizen TV: the .wgt player sends client_type 'wgt' (see
  // tizen/js/app.js). `platform` is the primary key, but it lives in a column that a register from
  // a client not sending it used to overwrite — and misreading a Tizen panel as a browser tab
  // hands it a volume slider with no handler behind it. Two signals, one conclusion.
  if (clientType === 'wgt') return 'tizen';
  // client_type 'apk' is the Android player; android_version that is NOT the web player's
  // "Web/..." shape is the older signal for the same thing.
  if ((device && device.client_type === 'apk') || (android && !android.startsWith('Web/'))) return 'android';
  return 'web';
}

/**
 * The capability set for a device, as an array of known capability strings.
 *
 * @param {object} device  a device row; may carry `capabilities` (JSON array or string)
 * @returns {string[]}
 */
function capabilitiesFor(device) {
  const declared = parseDeclared(device && device.capabilities);
  if (declared) return declared;
  return (BASELINE[platformFamily(device)] || BASELINE.web).slice();
}

/**
 * True when the device supports `cap`. Unknown capability names are always false.
 *
 * A missing device supports nothing. It would otherwise fall through to the web baseline and
 * claim video playback for a row that does not exist — a caller rendering controls from a failed
 * lookup should get an empty panel, not a plausible-looking one.
 */
function supports(device, cap) {
  if (!device) return false;
  if (!CAP_SET.has(cap)) return false;
  return capabilitiesFor(device).includes(cap);
}

/*
 * Parse whatever the device sent. Returns null when there is no usable declaration, which is the
 * signal to fall back to the baseline — distinct from an EMPTY declaration, which is a player
 * genuinely saying "I can do nothing" and must be honoured.
 */
function parseDeclared(raw) {
  if (raw === null || raw === undefined) return null;
  let list = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try { list = JSON.parse(trimmed); } catch (e) { return null; }
  }
  if (!Array.isArray(list)) return null;
  // Unknown strings are dropped rather than rejected wholesale: a newer player declaring a
  // capability this server has never heard of must not lose the ones it does understand.
  return list.filter((c) => CAP_SET.has(c));
}

/*
 * Which capability a fleet command needs.
 *
 * The dashboard and the socket layer both dispatch commands by string name, so the check has to
 * happen against that name or it does not happen at all. Kept here rather than in the socket
 * handler because two call sites dispatch commands — dashboardSocket for a single device and the
 * group route for many — and a map that lives in one of them protects only that one.
 *
 * A command mapped to null needs no capability: it is a diagnostic every player understands, and
 * refusing it would remove the tool you use to work out why a panel is misbehaving.
 *
 * A command may map to a LIST, meaning any one of them is enough. That is not a convenience: it is
 * how a capability name that no shipped player declares stays in the vocabulary without taking its
 * commands down with it. The first name in the list is the canonical one and is what a refusal
 * reports, so the operator is told what the panel is missing in the vocabulary they see elsewhere.
 */
const COMMAND_CAPABILITY = {
  // lifecycle
  reboot: 'system.reboot',
  // Power-off shares the reboot capability: it is the same "device power lifecycle" privilege, and
  // no platform we ship implements one without the other. Split it if that ever stops being true.
  shutdown: 'system.reboot',
  launch: 'system.restart_player',
  refresh: 'system.restart_player',
  update: 'system.self_update',
  // Clearing the staged-APK cache is part of the same self-update surface: a player that can
  // update itself is a player that can hold a bad download and needs a way to drop it.
  clear_update_cache: 'system.self_update',

  // display
  screen_on: 'display.power',
  screen_off: 'display.power',

  // audio
  set_volume: 'audio.volume',

  // system control (#160 Track-A)
  set_brightness: 'display.brightness',       // per-window overlay dim (Tier 0)
  set_system_brightness: 'system.brightness',
  set_screen_timeout: 'system.screen_timeout',

  // device-owner surface (#161 Tier-2)
  kiosk_lock: 'system.kiosk',
  kiosk_unlock: 'system.kiosk',
  /*
   * ⚠️ These five were UNREACHABLE for the entire fleet until this audit, and nothing failed
   * loudly enough to notice.
   *
   * 'system.device_owner' is declared by NO player. It is not in PlayerCapabilities.kt, not in
   * tizen/js/capabilities.js, not in the web player's declaredCapabilities(), not in st-bridge.js,
   * and not in any baseline. So `supports()` returned false for every device on every platform,
   * and every one of these commands was refused — including on the device-owner panels the whole
   * #161 Tier-2 surface was built for. The dashboard still rendered the buttons, because
   * device-detail.js gates that block on `device.tier === 2 ||` as well, so an operator on a real
   * owner panel pressed "Lock now" and got a silent server-side refusal.
   *
   * Until a player declares 'system.device_owner' for itself, 'system.kiosk' stands in, and it is
   * an exact stand-in rather than a loose one: PlayerCapabilities.kt declares system.kiosk under
   * `if (isOwner)` and nothing else, which is precisely the condition under which STPolicy's
   * owned() actions — setStatusBarDisabled, setUninstallBlocked, lockNow, reboot — do anything.
   * No non-Android player declares system.kiosk; Tizen and BrightSign both refuse it explicitly
   * and in writing, so this cannot leak the commands onto a platform that would swallow them.
   *
   * The canonical name stays first so a refusal still says 'system.device_owner'.
   */
  lock_now: ['system.device_owner', 'system.kiosk'],
  power_menu: ['system.device_owner', 'system.kiosk'],
  status_bar: ['system.device_owner', 'system.kiosk'],
  block_uninstall: ['system.device_owner', 'system.kiosk'],
  unblock_uninstall: ['system.device_owner', 'system.kiosk'],
  set_time: 'system.time',
  set_timezone: 'system.time',
  shell: 'system.shell',
  install_apk: 'system.install_apk',

  /*
   * Remote view. Ungated, and the reason is a circle: enable_system_capture asks Android to raise
   * the MediaProjection consent dialog, which is how a panel GAINS full-screen capture. Gating it
   * on 'remote.screenshot' meant the only panel that needs it — one with neither accessibility nor
   * a projection grant, which therefore declares no remote.screenshot — was the one panel that
   * could not be sent it. A bootstrap cannot require the thing it bootstraps.
   *
   * ⚠️ The dashboard still has the other half of this bug: device-detail.js renders the "enable
   * system view" button behind `can('remote.screenshot')`. Fixing that is a frontend change and is
   * written up in docs/player-parity.md; ungating the command is the half that lives here.
   */
  enable_system_capture: null,

  // Diagnostics: deliberately unrestricted. set_debug turns on the log stream you need precisely
  // when a panel is behaving in a way its capability declaration did not predict.
  set_debug: null,
};

/**
 * Every capability that would satisfy `type`, as an array. Empty means the command is ungated.
 * Unknown commands are ungated too — this map gates, it does not authorise: the allow-list of
 * valid command names lives with the routes, and duplicating it here would mean a new command
 * silently stops working until someone remembers to add it in two places.
 *
 * @param {string} type
 * @returns {string[]}
 */
function capabilitiesForCommand(type) {
  if (!Object.prototype.hasOwnProperty.call(COMMAND_CAPABILITY, type)) return [];
  const value = COMMAND_CAPABILITY[type];
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value.slice() : [value];
}

/**
 * The CANONICAL capability a command requires, or null when it needs none.
 * Kept returning a single string because that is what a refusal reports and what the dashboard
 * puts in front of an operator: "needs system.device_owner" is an answer, an array is a puzzle.
 */
function capabilityForCommand(type) {
  const list = capabilitiesForCommand(type);
  return list.length ? list[0] : null;
}

/**
 * Can this device be sent this command?
 * @returns {{ok: true} | {ok: false, capability: string}}
 */
function commandAllowed(device, type) {
  const needed = capabilitiesForCommand(type);
  if (!needed.length) return { ok: true };
  if (needed.some((cap) => supports(device, cap))) return { ok: true };
  return { ok: false, capability: needed[0] };
}

module.exports = {
  CAPABILITIES, CAP_SET, BASELINE, capabilitiesFor, supports, platformFamily, parseDeclared,
  COMMAND_CAPABILITY, capabilityForCommand, capabilitiesForCommand, commandAllowed,
};
