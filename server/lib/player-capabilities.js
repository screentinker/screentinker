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
  /* A live HLS stream (mime video/hls) opened by the player on its own LAN. Brand new, so
   * deliberately in NO baseline: a v1.9.28 player never heard of it and would sit on a black
   * <video src=…m3u8> it cannot decode, so an undeclared/legacy device must be treated as
   * NOT able to play it (deviceSocket strips live items from its payload). A player new enough
   * to decode HLS — web/BrightSign/webOS, Android via ExoPlayer, Tizen natively — declares it
   * for itself. E-ink never declares it. */
  'playback.hls',
  /* A live RTSP camera/stream (mime video/rtsp) opened by the player. Android/ExoPlayer ONLY —
   * browsers, BrightSign/webOS, Tizen and e-ink cannot open rtsp://, so only the native Android
   * player declares it and the deviceSocket strip keeps rtsp items off every other screen. In no
   * baseline (brand new). */
  'playback.rtsp',
  /* The screen's own HDMI INPUT played as an item (mime video/hdmi-in, remote_url hdmi://<port>):
   * a cable box or console plugged into a Fire TV Cube / Android TV box with HDMI in. Declared by
   * the native Android player ONLY when it found an HDMI passthrough input on this device at
   * runtime — most Android boxes have none, which is exactly why a static table could not know.
   * In NO baseline; the deviceSocket strip keeps it off every other screen. */
  'playback.hdmi_in',
  /* An uploaded HTML bundle (.wgt / .zip) played as a playlist item. Declared by a player that can
   * MOUNT one — today that means loading the server's flattened single-document render, which every
   * player with an iframe can do. It does NOT imply the player can unpack an archive locally, so it
   * says nothing about whether a bundle survives an outage; that is offline.cache's job. */
  'playback.bundle',
  /* A HOLD item (mime application/x-st-hold, remote_url hold://blank | hold://freeze): show nothing
   * new for the item's duration — blank, or freeze the previous frame. How a timeline across screens
   * is written (see lib/hold-item.js). In NO baseline: an old player would skip it as an unknown
   * type, shortening the timeline, so the deviceSocket strip keeps it off any screen that does not
   * declare it. */
  'playback.hold',
  /* Zones on a VIDEO WALL: the wall's layout, in percent of the wall's player rect, each zone paced
   * by the shared clock (lib/wall-layout.js). A wall member without it still plays the wall's
   * playlist across the whole wall, so the dashboard names the panels that lack it. In NO baseline. */
  'playback.wall_zones',
  /* A webpage widget with `interactive: true` played as a walk-up kiosk page (#473): touch reaches
   * the site, the playlist holds while a visitor uses it, and an idle reset wipes the session.
   * FULL support: the site loads TOP-LEVEL in a browser the player controls, so the navigation
   * allowlist is enforced and the wipe is real. Android, the native Pi/Windows player, and BrightSign
   * when its host can open a second widget. Fullscreen only. In NO baseline: every other player
   * still renders the page passively through the widget iframe, exactly as with the switch off. */
  'playback.web_interactive',
  /* The SAME switch on a player that is itself a web page (web player, webOS, Tizen, BrightSign on
   * an older host): the site runs in an iframe the player owns. Hold, idle reset, Home, zoom and
   * usage counts work; but sites that refuse framing stay blank, and the player CANNOT enforce the
   * allowlist or wipe the site's cookies/storage — so a visitor's login may survive the reset. A
   * player declares this OR playback.web_interactive, never both, and the dashboard tells the
   * operator which one a screen has. In NO baseline. */
  'playback.web_interactive_framed',
  // audio
  'audio.mute', 'audio.volume',
  /* A slide's voiceover and a deck's music bed. Declared by a player that owns those audio
   * elements ITSELF — the tracks are metadata on the item, not something inside the slide, so a
   * player that simply renders the widget iframe plays nothing. Separate from audio.mute because
   * the questions are different: audio.mute asks whether a screen can be silenced, this asks
   * whether it can make that particular sound at all. */
  'playback.slide_audio',
  // display
  'display.rotation', 'display.power', 'display.resolution', 'display.brightness',
  /*
   * The panel holds a WEEKLY BACKLIGHT SCHEDULE locally and evaluates it itself, offline, against
   * shared/power-window-vectors.json.
   *
   * ⚠️ SEPARATE FROM display.power ON PURPOSE, and this is the one place that distinction has
   * teeth. The note in the android baseline below records that display.power is kept as a PAIR for
   * un-updated panels even though their screen_on half is dead — a working sleep and a dead wake —
   * on the grounds that an operator can always wake a screen some other way. A SCHEDULE removes
   * that escape: a panel that sleeps at 22:00 on its own and cannot wake itself is a panel someone
   * drives to. So a player declares this only when it implements the local evaluator AND has a
   * wake path it has verified, exactly as PlayerCapabilities.kt already gates its display.power
   * claim on both halves. In NO baseline — brand new, and a fielded player simply ignores the
   * unknown command, which is the correct outcome rather than a dark screen.
   */
  'display.power_schedule',
  // remote view / control
  'remote.screenshot', 'remote.stream', 'remote.input',
  /* Voice: play the operator's audio (+ optional webcam) — one-way Talk / PA. Over the same go2rtc
   * path as remote.stream, in Opus. Brand-new, so NOT in any baseline: only a player new enough to
   * run the WebRTC audio subscriber declares it, and the dashboard shows the Talk control only for a
   * device that does. */
  'remote.talk',
  /* The device also has a MICROPHONE it can send back — unlocks the two-way "2-way audio" control.
   * A screen (signage) declares remote.talk but NOT this; a phone/tablet (or a browser tab with a
   * mic) declares both. Implies remote.talk. */
  'remote.mic',
  /* #312 follow-up: the player can accept a server-URL rewrite from the dashboard AND verify the new
   * address is reachable before committing, rolling back if not. Declared only by a player that
   * implements that verify-then-commit path (so a fat-fingered URL cannot strand it), which is why
   * the command is gated on it rather than sent blind. NOT in any baseline — brand new. */
  'remote.set_server_url',
  // lifecycle
  'system.reboot', 'system.restart_player', 'system.self_update',
  // device management (Android device-owner territory)
  'system.kiosk', 'system.brightness', 'system.screen_timeout',
  'system.install_apk', 'system.shell', 'system.time',
  /*
   * An INTERACTIVE terminal: a real PTY on the device, relayed byte-for-byte both ways over the
   * sockets (lib/pty-relay.js), as opposed to system.shell's one-shot `shell` command that runs one
   * line and returns its output. Separate on purpose, because the two are not the same privilege in
   * practice even where they are the same UID: a one-shot command is auditable line by line in
   * activity_log and the command queue; a PTY is a session whose keystrokes are NOT recorded (only
   * its open and close are), and it can run a full-screen program, su, or an editor. A player
   * declares it only when it actually spawns a PTY — today the native Pi and Windows players. Android's
   * app-UID shell has no PTY and never declares it.
   *
   * ⚠️ Gates EVENTS, not a command: dashboard:pty-open is refused server-side without it, and it is
   * never in COMMAND_CAPABILITY because a PTY session is not a `device:command`. NOT a mesh command
   * either — no peer server can ever open one (see the relay's header).
   */
  'system.pty',
  // The rest of the Tier-2 surface: lock the screen now, show the power menu, hide the status
  // bar, block uninstall. Separate from 'system.kiosk' because kiosk means lock-task specifically
  // and a panel can hold one without the other — and separate from the individual names above
  // because these four are only ever available together, gated by the same device-owner check.
  // Runtime state, not a platform fact: a panel that loses device owner loses all of them.
  'system.device_owner',
  /*
   * The player can perform an HTTP request on its OWN network and return a bounded snippet of the
   * response — the device-side REST client. Its own group because it is neither playback nor
   * device management: it is the panel acting as a client on the LAN it sits on, which is a
   * capability no other part of this vocabulary describes.
   *
   * In NO baseline — brand new, and a fielded player simply ignores the unknown command.
   */
  'net.http_request',
  /*
   * Audience counting (lib/audience.js): the player has a camera it can open and an on-device face
   * detector, and will report COUNTS ONLY. Declared by a player that could count if asked — not a
   * statement that it is counting; that is the org's switch, sent in the payload. In NO baseline.
   */
  'audience.camera',
  /*
   * A meeting-room display (lib/rooms) on this screen can be USED: the player hands the page its
   * panel capability (the #panel fragment, ws/deviceSocket.js) and a person at the screen can press
   * its buttons. The release sweep (lib/rooms/service.js sweepReleases) gives a room back only while
   * a screen with this is showing it, because releasing a meeting nobody COULD check in to just loses
   * a real booking. In NO baseline: a player older than room displays never passes the capability.
   * Not declared by Tizen, webOS, BrightSign or Vega (docs/room-booking.md lists them read-only).
   */
  'room.panel',

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
    'playback.slide_audio',
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
    'playback.bundle',
    'playback.slide_audio',
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
    // NOT remote.screenshot / remote.stream — but the ORIGINAL reason is now wrong, so read this
    // before restoring them. The old note said a canvas capture on a hwz player cannot read the
    // video plane and returns a frame with a hole. Two things changed:
    //
    //   1. st-bridge.js gained captureScreen(), which uses the native @brightsign/screenshot module
    //      and DOES composite the hardware plane. Confirmed on hardware (XT245 / BOS 10.0.16). It
    //      needs only require(), not a host bridge — so it works on the exact units the note feared.
    //   2. The canvas fallback is no longer silent: renderCaptureCanvas() paints "Video is playing
    //      on the hardware plane and cannot be captured" rather than a black rectangle.
    //
    // They stay out for a DIFFERENT and narrower reason: captureScreen() needs a node-enabled
    // widget. A widget built by the BSN Supervisor has no require(), so there the path really does
    // end at a canvas that cannot see the video. This baseline cannot tell the two apart.
    //
    // Restoring them would also be close to a no-op: server/player/index.html declares remote.stream
    // unconditionally and remote.screenshot behind an always-true canvas check, and platform=
    // 'brightsign' is only ever set by the same register that carries the declaration — so a
    // BrightSign row essentially always HAS one and never reaches this baseline. (audio.volume moved
    // INTO the list above in 1.9.31 — the payload it was waiting on now lands.)
  ],
  /*
   * Vega OS — Fire TV Stick 4K Select (AFTCA002) and Fire TV Stick HD 2026 (AFTCL001).
   *
   * The installed app (vega/) loads THIS page in a WebView. A stick that has registered is
   * running the same player a browser is, and it declares for itself; this list is only the
   * floor for a row whose capabilities column is still NULL.
   *
   * Same floor as web. playback.transitions belongs here: an AFTCA002 (ScreenTinker 2.1.6,
   * Kepler 1.2) ran the image wipe and it looked right. Withholding it hid a working control.
   * The page still caps the captured frame on Vega. The binding constraint on that stick was
   * CMA — about 236 MB of contiguous DMA, which fell to about 1 MB while MemFree stayed
   * large — not "1 GB of RAM", and not a missing feature.
   *
   * offline.cache belongs here too. The page claims it only when a service worker is actually
   * in control, and on that run one was. Offline playback worked. The earlier "WebView has
   * not been shown to allow a worker" note was wrong.
   *
   * Group sync still does not warm a second decoder. That is a second CMA claim, and there
   * is no capability name for it; the suppression lives in the page.
   *
   * NOT system.reboot, display.power, system.kiosk, system.self_update, playback.rtsp. The
   * shell announces an empty capability list on purpose. Those are Android powers, and a
   * baseline that grants them is a button that cannot work.
   */
  vega: [
    'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
    'playback.zones', 'playback.transitions', 'playback.pip',
    'playback.bundle',
    'playback.slide_audio',
    'audio.mute',
    'display.rotation',
    'remote.screenshot', 'remote.stream', 'remote.input',
    'system.restart_player',
    'audio.volume',
    'sync.clock', 'offline.cache',
  ],
  /*
   * The NATIVE Raspberry Pi player (pi/, Python + Qt) — client_type 'pi', platform 'Linux/<distro>
   * (<model>)'. Not the Chromium-kiosk install of the web player that scripts/raspberry-pi-setup.sh
   * sets up; that one registers as a browser and is BASELINE.web.
   *
   * ⚠️ THIS BASELINE BREAKS THE RULE ABOVE, knowingly, and the reason is that the rule has nothing to
   * check it against: no Pi player has ever been released, so there is no "last released build" to
   * cite. What makes that tolerable is that the Pi player declares on EVERY register — its
   * CAPABILITIES_ALWAYS list is unconditional, and contract v4 carries it — so a real Pi row
   * essentially always has a declaration and never reads this list. It answers only for a row whose
   * capabilities column is NULL for some other reason (a restore from a pre-capability backup, a
   * manual row), and for that row "what the first Pi release ships" is the least-wrong guess.
   *
   * Once a Pi build has shipped, re-derive this from `git show <tag>:native/screentinker_native/capabilities.py`
   * the way every other entry here was, and delete this paragraph.
   *
   * ⚠️ NOT system.shell / system.pty / system.time / system.kiosk / system.install_apk, although the
   * Pi player is expected to declare most of them. Each depends on what the .deb's postinst actually
   * granted on THIS unit (a sudoers drop-in, a polkit rule, the kiosk session) — runtime privilege,
   * the same reason Android keeps them out of its baseline — and player-parity-baselines.test.js
   * holds every baseline to that rule. Since the Pi always declares, leaving them out costs a
   * declaring Pi nothing; putting them in would hand a remote shell to a row nobody can vouch for.
   * system.device_owner / system.brightness / system.screen_timeout / display.resolution /
   * remote.talk / remote.mic / sync.native are out too — no Pi implementation behind them yet.
   *
   * And NOT playback.hls / playback.rtsp / net.http_request / display.power_schedule /
   * remote.set_server_url: each of those is "in NO baseline — brand new" by this file's own rule
   * (and by iptv-hls / http-request-command tests), because what they gate is only safe to send to
   * a player that has said so. A declaring Pi gets them; an undeclared row does not.
   */
  linux: [
    'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
    'playback.zones', 'playback.transitions', 'playback.pip',
    'playback.bundle', 'playback.slide_audio',
    'audio.mute', 'audio.volume',
    'display.rotation', 'display.power', 'display.brightness',
    'remote.screenshot', 'remote.stream', 'remote.input',
    'system.reboot', 'system.restart_player', 'system.self_update',
    'sync.clock', 'offline.cache',
  ],
  /*
   * The NATIVE Windows player — the same Python + Qt engine as the Pi (native/screentinker_native)
   * with a Windows OS backend (platform/windows) — client_type 'win', platform 'Windows/<edition>
   * (<model>)'. Not the kiosk-browser shortcut that scripts/windows-setup.bat creates; that one
   * registers as a browser and is BASELINE.web.
   *
   * ⚠️ Same knowing exception as BASELINE.linux, for the same reason: no Windows build has been
   * released, so there is no tag to derive this from, and the player declares on EVERY register
   * (CAPABILITIES_ALWAYS + platform/windows/ops.extra_capabilities), so a real row essentially never
   * reads this list. Once a Windows build has shipped, re-derive it from that tag and delete this
   * paragraph.
   *
   * STRICTER than BASELINE.linux: only what the SHARED ENGINE does by itself — playback, zones,
   * transitions, the Qt-scene screenshot/stream (grabWindow), input injected into the player's own
   * window, the per-window dim (display.brightness), restart, clock sync, the media cache. Every
   * OS-specific row is still being brought up on Windows (docs/player-parity.md "Windows (native)"),
   * so it stays out until a released build proves it:
   *   - display.power (SC_MONITORPOWER / DDC/CI D6 / overlay), audio.volume (Core Audio endpoint),
   *     system.self_update (the helper runs the installer), system.reboot (the helper service);
   *   - and, as for every family, the privilege-conditional ones (system.shell / pty / kiosk / time /
   *     install_apk / brightness / screen_timeout) and the brand-new ones that are in NO baseline
   *     (playback.hls / playback.rtsp / net.http_request / display.power_schedule /
   *     remote.set_server_url / remote.talk).
   * audio.mute stays: every family keeps it (player-parity-baselines.test.js), and on this engine it
   * is the Qt media element's own mute, not the OS mixer.
   */
  windows: [
    'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
    'playback.zones', 'playback.transitions', 'playback.pip',
    'playback.bundle', 'playback.slide_audio',
    'audio.mute',
    'display.rotation', 'display.brightness',
    'remote.screenshot', 'remote.stream', 'remote.input',
    'system.restart_player',
    'sync.clock', 'offline.cache',
  ],
  /*
   * The NATIVE macOS player — the same engine again (native/screentinker_native, platform/macos),
   * client_type 'mac', platform 'macOS/<version> (<model>)'. Exactly BASELINE.windows, for exactly its
   * reason: no macOS build has been released, the player declares on every register, and only what
   * the shared engine does by itself is assumed. And never system.self_update — a Mac does not update
   * itself at all (platform/macos/ops.py withdraws it from its own declaration too).
   */
  macos: [
    'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
    'playback.zones', 'playback.transitions', 'playback.pip',
    'playback.bundle', 'playback.slide_audio',
    'audio.mute',
    'display.rotation', 'display.brightness',
    'remote.screenshot', 'remote.stream', 'remote.input',
    'system.restart_player',
    'sync.clock', 'offline.cache',
  ],
  /*
   * The iPad/iPhone app (ios/): the web player, top-level in a WKWebView, platform 'ios'. BASELINE.web
   * minus two things iOS takes away from a web view:
   *   - audio.volume: HTMLMediaElement.volume is read-only (always 1) on iOS — the slider would be
   *     dead. The player withdraws it from its own declaration as well (declaredCapabilities).
   *   - offline.cache: a WKWebView runs service workers only for the "app-bound domains" an app lists
   *     in its Info.plist at build time, and a customer's server cannot be listed in advance. The
   *     player claims offline.cache only for a worker in control, so a row that declares never has it.
   */
  ios: [
    'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
    'playback.zones', 'playback.transitions', 'playback.pip',
    'playback.bundle',
    'playback.slide_audio',
    'audio.mute',
    'display.rotation',
    'remote.screenshot', 'remote.stream', 'remote.input',
    'system.restart_player',
    'sync.clock',
  ],
  // A browser tab. Deliberately the smallest set: it cannot reboot its host, rotate a panel, or
  // capture anything outside its own document.
  web: [
    'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
    'playback.zones', 'playback.transitions', 'playback.pip',
    'playback.bundle',
    'playback.slide_audio',
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
  // ⚠️ By what the device IS (set at pairing), never by whether it has a screen_profile: a profile
  // is a setting, and a family inferred from a setting turns any screen with one into an e-ink panel
  // — no controls, a different OTA family — ahead of every check below.
  if (clientType === 'embedded' || platform.includes('embedded')) return 'embedded';
  if (platform.includes('brightsign')) return 'brightsign';
  if (platform.includes('tizen')) return 'tizen';
  // Before the Web/ Android test. A Vega stick's android_version is "Web/...", because the
  // page that registers is the web player. Without this it would be classified as a browser
  // and would miss the CMA capture cap the shell turns on.
  if (platform.includes('vega')) return 'vega';
  if (clientType === 'wgt') return 'tizen';
  /*
   * The native Raspberry Pi player. ⚠️ MUST SIT BEFORE THE ANDROID TEST BELOW, which is a fallback
   * that claims ANY non-empty, non-"Web/" android_version. The Pi sends android_version '' today, so
   * it would fall through to web rather than android — but that is one field away from breaking: a
   * Pi build that ever fills android_version with its kernel or OS string would be classified as an
   * Android panel and offered MediaProjection bootstraps and device-owner provisioning. Two signals,
   * either sufficient, for the same reason client_type 'wgt' backs up platform for Tizen: platform
   * is the primary key, client_type survives an older register overwriting it.
   */
  if (clientType === 'pi' || platform.startsWith('linux/')) return 'linux';
  // The native Windows player: the same engine, the same reasoning, the same two signals. Also
  // before the Android fallback — it sends android_version '' today, and a build that ever put its
  // OS string there must not become an Android panel.
  if (clientType === 'win' || platform.startsWith('windows/')) return 'windows';
  // The native macOS player: the same engine, the same two signals, the same position ahead of the
  // Android fallback.
  if (clientType === 'mac' || platform.startsWith('macos/')) return 'macos';
  // The iPad/iPhone app registers through the web player (android_version 'Web/…', client_type
  // 'player'), so this must come before the browser fallback below — like Vega above.
  if (platform === 'ios') return 'ios';
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
  const family = platformFamily(device);
  if (family === 'embedded') {
    const power = (device && device.power_source) || 'battery';
    if (power === 'usb' || power === 'mains' || power === 'external') {
      return [
        'playback.image',
        'system.reboot',
        'offline.cache',
      ];
    }
    return [
      'playback.image',
      'offline.cache',
    ];
  }
  return (BASELINE[family] || BASELINE.web).slice();
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
  // ⚠️ NOT display.power — see the capability's own note. A panel that can be told to sleep is not
  // necessarily a panel that can be trusted to sleep UNATTENDED and wake itself again.
  set_power_schedule: 'display.power_schedule',

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
   * Device-side REST. Gated so a player that cannot honour it is refused at the door rather than
   * swallowing the command — and so the dashboard can say which screens will actually answer.
   */
  http_request: 'net.http_request',

  // #312 follow-up: rewrite the stored server URL. Gated so only a player that verifies-then-commits
  // (and rolls back an unreachable address) is ever sent it — a web player, whose "server" is its
  // page origin, does not declare it and is correctly skipped by a group/workspace push.
  set_server_url: 'remote.set_server_url',

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
