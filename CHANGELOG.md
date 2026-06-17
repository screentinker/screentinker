# Changelog

## 1.9.1-beta3 — unreleased

### Fixed — Tizen player
- **#118 Sticky "Not authenticated" banner.** On TV sleep/wake the socket reconnects and
  a heartbeat could fire on the fresh, not-yet-registered socket; the server rejected it
  with `device:auth-error`, which the player showed as a *sticky* toast over still-playing
  content (and, worse, dropped its saved credentials and re-paired). Heartbeats are now
  gated on a per-connection `authenticated` flag (set only between `device:registered` and
  `disconnect`/`auth-error`), the heartbeat timer is stopped on `connect`/`disconnect`/
  `auth-error`, the stale banner is cleared on `device:registered`, and the `auth-error`
  toast is non-sticky so any transient case self-clears.
- **#119 `app_version` stuck at `1.0.0`.** The hardcoded constant made every Tizen device
  report `1.0.0` regardless of the installed `.wgt`. The version now resolves at runtime
  from `config.xml` via the Tizen application API, with a fallback constant that
  `build-wgt.sh` stamps from `config.xml`'s `version=""`.

### Added — Tizen player
- **Video walls (`wall:sync`).** The Tizen player now supports wall membership: when the
  payload carries `wall_config`, a new `WallController` positions the stage (vw/vh) as this
  screen's slice of the wall and drives the single-zone player as leader or follower. The
  leader broadcasts `wall:sync` at 4Hz; followers align their index and keep their video
  locked to the leader's clock with a latency-compensated drift controller (hard-seek past
  0.3s, gentle ±3% playbackRate nudge past 0.05s), and request an immediate position on
  (re)connect via `wall:sync-request`. Mirrors the web player (the Android player has no
  wall support). Per-tile `rotation` is not applied yet (web-player parity). Wall emits are
  gated on auth + connection so a pre-register tick can't trip `device:auth-error`.
- **Multi-zone layouts (Android parity).** The Tizen player now renders assigned layouts,
  not just fullscreen single-zone. A new `ZoneRenderer` (ports the Android `ZoneManager`)
  positions zones by percent geometry with `z_index`/`fit_mode`/background, groups
  assignments by `zone_id` (unassigned content goes to the first zone), and rotates each
  zone independently with the same per-item schedule gating (#74/#75). `app.js` selects the
  renderer from `payload.layout`; single-zone playback is unchanged. (Video walls
  `wall:sync` are still Android-only.)
- **#121 Remote commands.** Added a `device:command` handler (`refresh`, `launch`,
  `screen_on`, `screen_off`, plus honest no-op toasts for `update`/`reboot`/`shutdown`,
  which need B2B/MDM privileges a sideloaded app lacks). Removed the dead `device:reload`
  listener (the server never emitted it) in favour of `device:command` `refresh`.
- **#120 Dashboard preview.** Added `device:screenshot-request` / `device:remote-start` /
  `device:remote-stop`. Images capture for real; `<video>`/YouTube fall back to a status
  card because the TV's hardware video plane and cross-origin iframes can't be read into a
  `<canvas>`. See `tizen/README.md` for the support matrix.
- **#122 Updates / boot.** Documented the supported paths — `.wgt` re-sideload or URL
  Launcher/MDM refresh for updates, and display-level kiosk/URL-Launcher settings for
  auto-launch on boot (there is no in-app OTA or `config.xml` autostart for a sideloaded
  consumer TV web app).

## 1.9.0 — 2026-06-11

### Added
- **Per-playlist-item schedules.** Each playlist item can carry one or more schedule
  blocks — active days, a start/end time-of-day, and optional start/end dates. An item
  plays when the screen's local "now" matches at least one block; an item with no
  blocks always plays. Edit per item via the clock icon in the playlist editor (a badge
  summarises the schedule on each row).
  - **#74 dayparting:** time-of-day + day-of-week windows, including overnight windows
    that cross midnight (a Fri 22:00–02:00 block is active Sat 01:00).
  - **#75 auto-expire:** inclusive start/end dates; an item past its end date stops
    showing automatically — even on offline screens, because evaluation is on-device.
- All three players (web, Android, Tizen) evaluate schedules client-side against their
  own clock, so dayparting and expiry work offline. They share one evaluator contract,
  `shared/schedule-vectors.json` — 39 conformance vectors covering DST (US + AU),
  overnight-wrap day anchoring, timezone correctness, and date boundaries. CI runs the
  vectors against the JS evaluator (node) and the Kotlin port (Gradle/JUnit); the Tizen
  copy is byte-identical to the JS source and checked under node.
- Device detail now shows the screen's reported timezone and clock, with a **clock-skew
  warning** when the device clock differs from the server by more than 2 minutes (a bad
  device clock makes schedules fire at the wrong local time).

### Changed — device-level schedule timezone (behaviour change)
- Device/group **schedule overrides** (the existing calendar feature) are now evaluated
  in each device's effective timezone instead of the server's local time. Previously the
  `schedules.timezone` field was never applied and "07:00" meant the *server's* 07:00.
  Now "07:00" means the *screen's* 07:00 — which is what was intended.
  - **Who is affected:** self-hosters whose server timezone differs from their screens'
    timezone — their existing device schedules will shift to fire at the screens' local
    time. Single-timezone deployments (server and screens in the same zone) are
    unaffected. A device with no timezone set and not reporting one falls back to the
    server clock (unchanged from before).

### Fixed
- **#81 — release APK is now v1 + v2 + v3 signed.** With `minSdk 26`, the Android Gradle
  Plugin defaulted the v1 (JAR) signature *off*, producing a v2-only APK that some
  MDM-managed commercial signage (e.g. MAXHUB via the Pivot MDM) silently removes on the
  next reboot — so screens that power-cycle nightly lost the app and fell back to the
  setup screen. Setting `enableV1Signing = true` had no effect at minSdk ≥ 24; the release
  build now re-signs with `apksigner` and a low `--min-sdk-version` to emit the JAR
  signature alongside v2/v3. Verified to install and run on Android 14+/API 36 as well.

### Notes
- **Scheduling fails open.** If the on-device evaluator ever errors (bad timezone id,
  malformed block), the item **plays** rather than being hidden. A blank screen is worse
  than an over-running promo — this is a guarantee, enforced in all three players.
- Windows are enforced at **item boundaries**: a long item finishes before the schedule
  is re-checked, so it can overshoot its window by up to its own duration.
- **A single video *with a schedule* now re-renders at each loop boundary** so its window
  can be re-evaluated; seamless native looping still applies to unscheduled single videos.
  Deliberate tradeoff — a brief seam each loop for a scheduled lone video, in exchange for
  its daypart/expiry actually being honoured.
- **Re-publish required:** editing a schedule puts the playlist into draft; publish to
  push schedules to devices. Existing published playlists keep playing unchanged until
  re-published.
- Players that predate this release ignore the new fields and keep playing everything
  (graceful degradation) — update players to honour schedules.
