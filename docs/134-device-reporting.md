# #134 follow-ups — device reporting fixes

Two issues surfaced while investigating #134 (the PiP bug report). Neither is the
PiP rendering itself (that was #135) — both are device *reporting* problems.

## 1. "Device reconnects every ~45s" — a logging artifact, not instability

**Symptom (#134):** the server log shows the device reconnecting every ~45s, read
as an unstable WebSocket that could drop PiP commands.

**Reality:** the connection is stable. The player calls `requestPlaylistRefresh()`
every ~45–60s, which **re-emits a full `device:register` on the *same* socket** to
pull a fresh playlist. The server's register handler logged `Device reconnected`
for *every* register of a known device, so a healthy device that re-registers
~2000×/day looked like it was flapping.

Evidence from the attached 4-day log:

| Signal | Count |
|--------|-------|
| `Device reconnected` | **1415** |
| `Device socket connected` (real) | 30 |
| `Device disconnected` (real) | 21 |
| `marked offline (heartbeat timeout)` | **0** |

1415 "reconnects" vs 30 real socket connects, and the socket **never** timed out.
So #134's "PiP lost between reconnects / queue TTL-expired" was a misdiagnosis —
the socket doesn't drop; the PiP failure was the rendering bugs fixed in #135.

**Fix** (`ws/deviceSocket.js`): a re-register on the *same* socket
(`currentDeviceId === device_id`) is a playlist refresh, not a reconnect — only
log `Device reconnected` for a genuinely new socket. The refresh still resends the
playlist; it just no longer spams the log / reads as instability.

Verified on the emulator: a periodic refresh was processed (device received a new
playlist) while the server's `Device reconnected` count stayed flat; two genuine
reconnects logged exactly twice.

> Follow-up (not done here): the full re-register every ~45s is heavier than it
> needs to be (re-runs fingerprint/token/eviction + resends the playlist). A
> lightweight `device:request-playlist` event would cut that churn. Left as a
> separate optimization.

## 2. Reports 720p while the monitor shows a 1080 signal

**Symptom (#134-adjacent):** a panel receiving a real 1080p HDMI signal was
reported as 720p.

**Cause:** `DeviceInfo` reported `getRealMetrics()` — the **UI render surface**.
Many Android TV boxes/sticks (YaOS, Fire TV, etc.) render the UI at 1280×720 and
let the hardware scaler upscale to a 1920×1080 (or 4K) HDMI signal. `getRealMetrics`
honestly reports the 720p render surface; the monitor sees the 1080p output mode.
They are two different numbers.

**Fix:** report **both**, so neither is lost:

- `screen_width` / `screen_height` = the **HDMI/panel output** mode, from
  `Display.getMode().getPhysicalWidth()/getPhysicalHeight()` (orientation-independent;
  the panel doesn't rotate when the stage is software-rotated). This is the headline
  resolution and now reads 1080 on those boxes.
- `render_width` / `render_height` = the **UI render surface**, from `getRealMetrics()`.

Wiring: Android `DeviceInfo.getDeviceInfo()` → two new nullable `devices` columns
(`render_width`, `render_height`, migration) → stored in both the pairing INSERT and
the reconnect UPDATE → exposed via the device API (`SELECT d.*`) → the dashboard
device detail shows `1920x1080 (UI 1280x720)` when they differ.

### Backward compatibility

Required and verified: a device that doesn't report the new fields must still be
accepted.

- New columns are **nullable**; the store uses `device_info.render_width ?? null`
  (reconnect) and `device_info?.render_width || null` (pairing); `device_info`
  itself remains optional.
- Verified on the emulator: an old-style register with `screen_*` but no `render_*`,
  and a register with **no `device_info` at all**, both succeed with `render_*` =
  null — on both the INSERT (pairing) and UPDATE (reconnect) paths.
- The dashboard only appends `(UI …)` when `render_*` is present and differs, so
  legacy devices render as before.
