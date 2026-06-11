# Changelog

## Unreleased — Per-item scheduling (#74 dayparting + #75 auto-expire)

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
