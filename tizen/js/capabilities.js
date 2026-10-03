/* ScreenTinker — Tizen capability declaration.
 *
 * The dashboard used to offer every control to every display, so buttons a platform cannot honour
 * did nothing and read as bugs. The player now DECLARES what it can actually do
 * (server/lib/player-capabilities.js holds the vocabulary) and the frontend hides the rest.
 *
 * Declared at RUNTIME rather than from a static table, because on Tizen the answer genuinely
 * varies by build and panel:
 *   - reboot and real panel power exist only through webapis.systemcontrol / b2bapis.b2bcontrol,
 *     which are injected ONLY on a Samsung panel running a .wgt signed with a Partner distributor
 *     certificate. The same code on an unsigned dev build, the URL-Launcher path, or a consumer TV
 *     has no such surface (see device-control.js).
 *   - tizen.tvaudiocontrol is a TV-profile API; it is absent in a plain browser context.
 * A hardcoded list would claim these on every Tizen device and be wrong on most of them.
 *
 * ⚠️ Names must match server/lib/player-capabilities.js exactly. An unknown string is DROPPED by the
 * server's parser, so a typo silently removes a control rather than failing loudly.
 */
(function () {
  'use strict';

  /* Native TV audio. Present on the TV profile; absent in a browser/URL-Launcher context, which is
   * why this is probed rather than assumed. */
  function tvAudio() {
    return (window.tizen && tizen.tvaudiocontrol && typeof tizen.tvaudiocontrol.setVolume === 'function')
      ? tizen.tvaudiocontrol : null;
  }

  /* The Samsung fleet-control surface, via the module that already owns those probes. Re-asked on
   * every call because the platform can inject these objects after the first script pass. */
  function fleet() {
    try { return window.STDeviceControl ? window.STDeviceControl.capabilities() : null; }
    catch (e) { return null; }
  }

  function detect() {
    var caps = [
      // Playback surface — all implemented in player.js on every Tizen build. A commercial Tizen
      // panel plays HLS (.m3u8) natively on a plain HTML5 <video>, so playback.hls is declared
      // unconditionally alongside playback.video (a video/hls item is just a <video src=remote_url>).
      'playback.video', 'playback.hls', 'playback.image', 'playback.widget', 'playback.youtube',
      'playback.zones', 'playback.transitions', 'playback.pip',
      /* Mounting a server-flattened HTML bundle needs nothing this player does not already have —
       * it is the widget iframe with a different URL and a sandbox attribute. Declared statically
       * for that reason. It says nothing about offline: nothing here unpacks an archive, so a
       * bundle is online-only even on a panel that reports offline.cache. */
      'playback.bundle',
      /* Slide voiceover + deck music bed. player.js owns those <audio> elements itself, and a
       * Tizen build is a privileged app — so unlike a browser tab it needs no user gesture and
       * genuinely makes sound on a wall. */
      'playback.slide_audio',

      /*
       * ⚠️ NOT trigger.http / trigger.udp, and this is a platform limit rather than an omission.
       *
       * External triggers require the player to LISTEN — a bound TCP port for the HTTP door, a
       * dgram socket for the UDP one. A Tizen web application has neither: the Web Device API
       * exposes no raw socket and no way to accept an inbound connection, so there is nothing to
       * probe and nothing that could be made to work by trying harder. A screen on this platform is
       * reachable by the hub and by nothing else on the LAN.
       *
       * Declaring these anyway would be the offline.cache mistake in a new place: a capability that
       * passes a presence check, is advertised to the fleet, and cannot do one byte of the work. An
       * integrator picking screens for a Crestron install needs the absence to be truthful, because
       * the alternative is discovering it on site.
       *
       * If a future Tizen profile gains a socket API, probe it by TRYING — bind, then declare — and
       * never by version-sniffing the platform.
       */

      // Per-item mute, honouring the shared rule in server/lib/media-mute.js (including the
      // YouTube embed, which used to be hardcoded muted and unmutable).
      'audio.mute',

      // Volume always resolves to SOMETHING: the native TV control where the profile provides it,
      // otherwise the media elements. Both change what a viewer hears, so the control is honest.
      'audio.volume',

      // CSS for graphics, and AVPlay's setDisplayRotation for portrait/flipped video — the Tizen
      // HTML5 <video> sits on a hardware plane that ignores CSS rotate.
      'display.rotation',

      // Blanking works on every build: a real panel API where one exists, and otherwise the black
      // overlay PLUS hardware-plane teardown (app.js showScreenOff). Declared because the screen
      // genuinely goes dark either way — hiding a working control is the opposite failure to the
      // one this whole model exists to fix. Which mechanism ran is reported in the device log.
      'display.power',

      // Images capture for real; video and YouTube return an honest status card saying live preview
      // is unavailable on this platform. Declared because the operator gets a truthful frame rather
      // than a dead button.
      'remote.screenshot', 'remote.stream', 'remote.input',

      // location.reload() — the URL-Launcher path also re-pulls content this way.
      'system.restart_player',

      // Clock/schedule-derived group sync, no leader.
      'sync.clock'
    ];

    var f = fleet();
    // Only on a partner-signed panel with the B2B/system surface present.
    if (f && f.reboot) caps.push('system.reboot');

    // NOT declared, deliberately, each for a concrete reason:
    //   display.resolution   — no web-accessible mode setting on the TV profile.
    //   system.self_update   — a .wgt is installed by the panel, not by the app; there is no
    //                          in-app OTA (device-control.js reports the same).
    //   system.kiosk         — Tizen has no device-owner equivalent reachable from a web app.
    //   system.brightness / system.screen_timeout / system.time / system.install_apk /
    //   system.shell         — no substantiated API on this surface. Claiming them would put back
    //                          exactly the dead buttons this change removes.
    //   sync.native          — no cross-player frame sync (that is BrightSign's SyncManager).
    //   (offline.cache is deliberately absent from this list — it is a RUNTIME check below.)

    // offline.cache is a RUNTIME fact, not a platform one. app.js has always cached the payload,
    // but the media bytes were fetched from the network every time — so a panel survived an outage
    // knowing exactly what it could not show. media-cache.js changes that, WHERE the platform
    // actually gives us persistent storage. It does not on every build, and a panel that cannot
    // write to wgt-private must not claim an offline capability it does not have.
    try {
      if (window.MediaCache && (window.__stMediaCache || window.MediaCache.create())) caps.push('offline.cache');
    } catch (e) { /* no storage: the claim stays absent, which is the honest answer */ }

    return caps;
  }

  window.STCapabilities = { detect: detect, tvAudio: tvAudio };
})();
