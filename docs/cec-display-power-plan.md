# Scheduled display dark-hours (blackout / display power) — plan

Customer ask (PowerSprout / Andreas, Raspberry Pi web player driving a Colorlight LED wall): LED walls
have off-hours, and today the only tool is a black/default image on a timetable — the wall stays
**powered on** showing black. He wants the display to actually **go dark** during off-hours (power,
lifespan, true-dark) on a schedule, and back on for opening hours.

We already shipped the *content* side of this in 2.1.2 (device **default/standby image** rendered when
the playlist is empty or fully dayparted-off). This plan is the *power* side: driving the display's
real dark/power state on a schedule, per player platform.

> Note on the name: an earlier draft assumed HDMI-CEC was the primary mechanism. Research on Andreas's
> actual hardware (a Colorlight X6) showed CEC does not apply to an LED-wall processor at all, and that
> the right primitive is a **content blackout** command that every platform can honour, with deeper
> power states layered on where the hardware allows. The plan below is built around that ladder; the
> filename is kept only to preserve existing links.

## Goal / non-goals

**Goal.** A per-device (and per-group) **dark-hours schedule**: an on-time and an off-time (with days),
evaluated in the device's own timezone, that darkens the physical display during off-hours and restores
it for opening hours. Offline-capable, and honoured by whatever mechanism the player platform actually
has (see the actuation ladder), from a content blackout up to a real mains cut.

**Non-goals (v1).** Not a full calendar/holiday engine (mirror the existing single daily window used by
`reboot_schedule`; multi-window/holiday can come later). Not a replacement for the default image (a
player that can only blank content still benefits from the standby image). Not per-zone power. Not the
mains-relay tier as shipped product (documented as an integrator escalation, below).

## Reuse: this is `reboot_schedule` shaped as a window

The scheduled-reboot feature is the exact template and should be extended, not reinvented:
- Storage: `devices.reboot_schedule` / `device_groups.reboot_schedule` (`"HH:MM"`, device overrides
  group; `scheduler.js:effectiveRebootSchedule`).
- Evaluation: `scheduler.js` ticks periodically, resolves the effective schedule, and calls a pure,
  unit-tested `rebootDue(schedule, tz, now, lastDate)` in the **device-local timezone** with a
  once-per-day guard (`reboot_last_date`), then emits to the device over `deviceNs`.
- Offline: the value rides in the device payload so evaluation also works with the WAN down.

Dark-hours differs in one way: it is a **window with two edges** (dark at X, restore at Y), not a single
fire, so the evaluator returns a desired *state* (on/off) for "now", and we act on the **transition**
(guard on the last-applied state, not a once-per-day date).

## Data model

Add to `devices` and `device_groups` (device overrides group, same precedence as reboot):
- `display_power_schedule TEXT` — JSON: `{ "off": "HH:MM", "on": "HH:MM", "days": [0..6] }`
  (days optional = every day; `null`/empty = feature off). Keep it one JSON column so we can grow it
  (multiple windows, holidays) without more migrations.
- `display_power_state TEXT` (device row only) — last state the server commanded (`on`/`off`), the
  transition guard so we don't re-send every tick.

Validation in `routes/devices.js` (mirror the `reboot_schedule` `HH:MM` regex), plus `off != on`.

## Server

1. **Scheduler.** In `scheduler.js`'s per-device tick, add `maybeSetDisplayPower(device, now, deviceNs)`
   beside `maybeRebootDevice`. A pure `desiredPowerState(schedule, tz, now)` (unit-tested like
   `rebootDue`, handles the overnight case where off > on, DST, and the days filter) returns `on`/`off`.
   If it differs from `display_power_state`, emit `device:command { type: 'display_power', state }` and
   record the new state. On a **fresh connect/register**, re-assert the current desired state once (a
   player that booted mid-off-window must catch up).
2. **Payload.** Include `display_power_schedule` in the device payload (`assemblePayload`) so a player can
   also self-enforce offline (belt-and-suspenders: the server drives it online, the device holds the
   schedule for outages).
3. **Capability gate.** Only send `display_power` to a device that declares it can honour it, and only
   show the schedule UI for such devices (the existing "Controls this display cannot honour are hidden"
   pattern). The command is uniform (`display_power on|off`); the *mechanism* is the player's business.

## The actuation ladder

The single command is `display_power on|off`. What "off" physically does depends on the strongest rung
the player can reach. **Content blackout is the universal floor and the primary path**; deeper power
states are layered on where the hardware supports them. ⚠️ For every rung the target is the **downstream
display**, not the player box's own housekeeping.

| Rung | Mechanism | Effect | Wake | Extra hardware |
|---|---|---|---|---|
| **0 — content blackout** (universal, primary) | Player paints a full-screen black frame / stops output | Wall goes dark; LED/backlight current drops to near-zero. Panel logic + PSUs stay powered | Instant, non-destructive | None |
| **1 — panel / backlight off** | Turn the display's own backlight/panel off | Backlight depowered; panel electronics warm | Fast | None |
| **2 — downstream display power** | HDMI-CEC standby to an external TV/monitor | External sink enters standby (if it honours CEC) | Depends on sink | None |
| **3 — LED-wall source blackout** | Colorlight Z-Protocol blackout over TCP | Processor outputs a black raster to the whole wall | Instant, non-destructive | None (uses the wall's processor) |
| **4 — mains cut** | Network relay/contactor on the PSU feed | True zero-draw | Relay-driven | Relay + contactor (integrator) |

Rung 0 is always available as the fallback and can sit *under* any deeper rung (paint black, then also
power the backlight/panel or send CEC), which guards against a panel that glows at content-black.

### Per-platform: which rung each player reaches

| Player | Primary rung | Notes |
|---|---|---|
| **Web player — Raspberry Pi + Colorlight LED wall** (Andreas) | **3 (source blackout)** + 0 | Pi-side agent sends the X6 a blackout command over TCP (Z-Protocol, port 9999). Browser can't do it directly. See below. This is the real work. |
| **Android — all-in-one / tablet** (e.g. KB1001) | **1 (backlight off)** | The panel IS the device's own screen. Device-owner `STPolicy.lockNow` / `screen_off` powers the backlight down; we already ship this as the manual **Screen Off**, so the schedule drives the same path. Falls back to rung 0 (fullscreen black) if not device owner. |
| **Android — box / stick → external TV** | **2 (CEC) or 0** | The box can't power an external panel except via CEC. ⚠️ `HdmiControlManager` power control to an external display is **not reliably available to a normal app** even as device owner — needs a system/vendor path; detect at runtime. Where CEC is absent, rung 0 content-blackout on the box (the TV's own backlight stays on). |
| **BrightSign** | **2 (native CEC)** + 0 | `roHdmiOutput` `SendCecCommand` / `SetPowerSaveMode`, or the video-output power API. BrightSign owns the HDMI out; cleanest CEC path. |
| **Tizen** (Samsung signage) | **1 (panel self-power)** | The panel IS the display; `b2bapis` (`b2bcontrol` power / `PanelControl`) turns its own backlight/panel off. Signage-only API. |
| **webOS** (LG signage) | **1 (panel self-power)** | `luna://com.webos.service.tvpower` (or commercial `com.webos.service.scap` power). Self-power the LG panel. |
| **Web player — generic browser / vMix** | **0 (content blackout) or none** | Fullscreen black is all a plain browser can do; no backlight/CEC reach. May still be worth offering as "blank content on schedule." |
| **E-ink** | none | No backlight to power; excluded. |

## Capability

Add a `display.power` capability plus a **mechanism descriptor** so the UI can tell the truth about what
"off" means on each device (e.g. `blackout`, `backlight`, `cec`, `led-blackout`, `mains`). Each platform
declares the highest rung it can actually reach *at runtime* (e.g. Android box only claims `cec` when a
working CEC path is present; the Pi only claims `led-blackout` when it can reach its local agent). The
dashboard reads `capabilities`, hides the schedule where absent, and labels it honestly ("powers off the
panel" vs "blanks the screen"). Android `PlayerCapabilities.kt`, and the web/Tizen/webOS/BrightSign
equivalents.

## The Raspberry Pi + Colorlight agent (the hard part)

The browser can't open a raw TCP socket to the processor, so a small local agent is needed on the Pi.
This replaces the CEC helper the earlier draft assumed. Design:
- A tiny **systemd service** on the Pi (`screentinker-display`) shipped as part of the Pi setup image /
  install script, exposing a localhost-only endpoint (e.g. `http://127.0.0.1:8787/power` accepting
  `on`/`off`). Localhost-only, no external surface.
- On `off` it sends the **Colorlight blackout** command over TCP to the X6 (Z-Protocol, default port
  9999, device index `FF FF` = all). On `on` it clears blackout. Blackout is preferred over
  brightness-0 because it does not overwrite the wall's brightness setting, so restore is a clean toggle
  with nothing to remember. Optionally also drop brightness to 0 as belt-and-suspenders under blackout,
  restoring the stored brightness first on wake.
- Implementation reference: the open-source `companion-module-colorlight-processor` (Bitfocus Companion)
  lists the X6 and implements exactly these blackout/brightness actions; the command builders are ~30
  lines to port to Python, or run Companion itself on the Pi. The protocol is community-reverse-engineered,
  so **validate the byte format against the actual X6 firmware** before production, and keep the wall on a
  trusted/segmented VLAN (the protocol has no auth).
- The web player, when it receives `display_power`, POSTs to the localhost endpoint. If the endpoint is
  absent (plain browser, or no wall), it no-ops — and the player only declares the `led-blackout`
  mechanism when it can reach the agent (probe on boot), so the dashboard hides/relabels the control
  otherwise.
- ⚠️ The X6 is a **source-dependent synchronous processor**: no HDMI-CEC, and no confirmed standalone
  RTC that would let it run its own on/off schedule with the Pi off. So the schedule must be driven by
  the Pi (server-online) and self-enforced from the cached schedule (offline). Do not rely on the wall
  darkening itself.
- Ship the agent + a one-line installer in the Pi provisioning guide, like the Android device-owner doc.

## Escalation tier: true mains power-off (relay / PDU) — documented, not v1 product

Content/source blackout darkens the wall and cuts most LED current, but the receiver cards, panel logic
and PSUs stay powered and warm. For a customer who needs **true zero-draw or thermal shutdown**, the only
answer is a hardware cut of mains to the panel PSUs. This is an integrator-installed escalation, not
something we ship in the box, but the same schedule can drive it:
- **Switch the PSU mains via a contactor, never the video path.** LED PSU banks are highly capacitive
  (a 16A steady-state circuit can hit ~560A inrush), so a bare relay switching the wall directly will
  weld/erode. Drive an **LED-rated contactor** from a **dry-contact smart relay** (Shelly Pro DIN-rail,
  or Sonoff/Tasmota as budget), and add an inrush limiter / sequence banks a few hundred ms apart.
- **Local HTTP, no cloud:** Shelly `GET http://<ip>/rpc/Switch.Set?id=0&on=false` (Tasmota
  `/cm?cmnd=Power%20Off`). The **on-site player** issues the LAN call, so no inbound firewall changes on
  the customer network; the server only distributes the schedule/policy.
- **Fail-ON + on-device fallback.** Wire the contactor **fail-ON** (loss of control keeps the wall
  powered) and mirror the daily on/off onto the **relay's own cron** (Shelly `Schedule.Create`) so a dead
  server/network/player never strands the wall dark — this is the "off = truck roll" failure. Keep a
  physical manual override at the panel.
- APC/NetShelter switched PDUs (SNMP/CLI) are the right tool only for the **processor/rack gear**, not
  the wall's main high-current PSU load.

## Dashboard UI

Under Device settings (and Group settings) add a **Dark-hours schedule** control beside the existing
Reboot schedule: off-time, on-time, day toggles, timezone note ("evaluated in the device's timezone"),
gated on `display.power`. Label it by the device's mechanism descriptor so the copy is honest ("powers
off the panel" / "blanks the LED wall" / "blanks the screen"). A manual **Screen Off / Screen On**
already exists for capable devices; keep it and label the schedule as the automatic counterpart.

## Offline, DST, and the safety rail

- Content/source blackout is inherently fail-safe: "wake" is just "stop sending black," so a crashed
  agent or a cleared schedule leaves the wall lit, not dark. Preserve that property — **never leave a
  display dark on an ambiguous/invalid/empty schedule (fail *on*, not off)**.
- ⚠️ The mains-relay tier is the exception: a scheduled OFF that never turns back ON is a site visit.
  Its guards live at rung 4 (fail-ON wiring + the relay's own on-device cron), above.
- The player self-enforces `on` from the cached schedule even with the WAN down; a failsafe forces `on`
  on player start / on any error / if the schedule is cleared.
- Device-local timezone + the overnight case (off 22:00 → on 06:00 crosses midnight) must be covered by
  the pure evaluator's tests. DST: reuse the same tz handling `rebootDue` already relies on.
- Manual override precedence: a dashboard "Screen On" during an off-window should hold until the next
  scheduled edge (record a manual-override-until, or simplest: manual wins until the next transition).

## Testing

- Unit-test `desiredPowerState(schedule, tz, now)` like `rebootDue`: same-day window, overnight window,
  days filter, invalid/empty → on (feature off, display stays lit), DST boundaries.
- Server: the transition guard emits exactly on change, re-asserts on reconnect, and is capability-gated
  (no `display_power` to a device without the capability).
- Pi agent: a mock/echo path so the player→agent contract is unit-testable; a byte-format test against a
  captured/validated X6 blackout frame. Per-platform hardware paths (CEC, panel self-power) stay manual
  (no CI for real displays).

## Phasing

1. **Schema + server + capability + dashboard + the evaluator & tests**, plus the universal **rung 0
   content blackout** so every capable player gets *something* on day one, and the two easy real-power
   rungs: **BrightSign** (CEC) and **Tizen/webOS** (panel self-power).
2. **Android**: rung 1 backlight-off (reuse the device-owner Screen Off path) for all-in-one/tablet;
   rung 2 CEC (runtime-detected) for boxes.
3. **Raspberry Pi + Colorlight agent** (rung 3) + provisioning doc — unblocks Andreas. Highest effort,
   own milestone.
4. **Mains-relay tier** (rung 4): document the integrator install; optionally teach the player to fire a
   configured relay webhook. Only if a customer needs true zero-draw.

## Open questions

- Does Andreas need **true power-off** (rung 4 relay), or is a genuinely dark wall (rung 3 blackout)
  enough? Blackout is far simpler and probably what he actually wants; this decides whether the relay
  tier is in scope for him at all.
- One daily window enough for v1, or does he need different weekday/weekend hours? (Drives single-window
  vs multi-window.)
- Manual-override semantics: how long should a manual On/Off hold against the schedule?
- Confirm with Colorlight (nice-to-have): does the X6 have an onboard RTC that could run a stored
  blackout/brightness schedule with the Pi off? Currently unconfirmed; the plan does not depend on it.
