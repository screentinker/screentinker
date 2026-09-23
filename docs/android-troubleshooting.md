# Android Player — Troubleshooting & Recovery

Practical runbook for the RemoteDisplay / ScreenTinker Android player
(package `com.remotedisplay.player`, shown on the device as **RemoteDisplay**).

---

## Symptom: player stuck on "Connecting to server"

The UI sits on **"Connecting to server…"** and never pairs/plays. In `logcat`
you'll see this repeating every few seconds:

```
E WebSocketService: Connection error: io.socket.engineio.client.EngineIOException: xhr poll error
```

`xhr poll error` is a **transport-level** failure — the Socket.IO client can't
even open an HTTP connection to the configured server. It is **not** an auth
rejection and **not** a code crash (those happen *after* the socket connects).

### What it almost always means
The player's stored **server URL points at a host it can no longer reach.**
Most common causes, in order:

1. **Server moved / IP changed.** The device was provisioned against a local
   dev box (`http://192.168.x.x:3000`) and that machine's IP changed or it's
   on a different network now.
2. **Local dev server is down.** `remotedisplay.service` isn't running.
3. **No internet route.** The device's Wi-Fi genuinely can't reach the
   internet (only relevant if it points at `https://screentinker.com`).

### Quick triage (no device access needed)
```bash
# Is the intended server even up?
curl -s -m 8 -o /dev/null -w "%{http_code}\n" https://screentinker.com/   # expect 200

# Local dev server running?
systemctl is-active remotedisplay.service
```
If the target server is up and on the **same LAN** as the device, the player
*should* connect once it's pointed there — so the fix is re-pointing the device.

> An APK upgrade does **not** cause this. `adb install -r` preserves app data,
> so the stored server URL survives the upgrade. Cleartext (`http://`) is
> allowed (`usesCleartextTraffic="true"` in the manifest), so upgrading does
> not block local servers either.

---

## Fix: re-point the player to a different server

Three ways to reconfigure the server URL, from easiest to most involved:

### A. In-app settings (APK v1.9.2+) — RECOMMENDED
1. **Press BACK (or ESC) twice quickly** on the device/remote — a Settings dialog opens.
2. Options available:
   - **Change server URL** — enter new URL, clears pairing, returns to provisioning
   - **Reconfigure device** — clears credentials, returns to provisioning screen
   - **Permissions** — check Accessibility/Notification status, open system settings
   - **Device info** — device ID, APK version, connection status
   - **Exit app** — close the kiosk app (3× BACK also opens exit directly)
3. After changing server/reconfiguring, enter the pairing code from the dashboard to reconnect.

If the app is stuck on "Connecting to server…" for more than a minute, it will
show a banner: **"Can't reach the server — Press BACK twice for settings."**

### B. On the phone, no tools (most reliable)
1. **Settings → Apps → RemoteDisplay → Storage → Clear data.**
   This wipes the stale server URL and pairing. (Cached content is cleared too;
   it re-downloads after pairing — no harm.)
2. Reopen **RemoteDisplay** → the setup screen appears.
3. Enter the server URL, e.g. **`https://screentinker.com`** → tap **Connect**.
4. It shows a **6-digit pairing code**.
5. In the dashboard (e.g. screentinker.com), pair a device with that code.
   The phone flips to "Paired as: …" and starts playing.

> After **Clear data**, the **Accessibility** permission the app uses for
> remote power/navigation is also reset. Re-enable it if you need remote
> reboot/screen control: Settings → Accessibility → RemoteDisplay → On.

### C. Via adb (if you have a working connection)
```bash
D=<ip:port>
# Option 1: reset provisioning the same way "Clear data" does
adb -s $D shell pm clear com.remotedisplay.player
adb -s $D shell monkey -p com.remotedisplay.player -c android.intent.category.LAUNCHER 1

# Option 2 (inspect first): read the currently-configured server URL
#   NOTE: release builds are NOT debuggable, so `run-as` returns nothing and
#   you cannot read /data/data/.../shared_prefs without root. Prefer Clear data.
```

---

## Connecting adb over Wi-Fi (Android 11+ Wireless Debugging)

Used to drive the device for installs/log capture. Ports here are **per-session
and change** when wireless debugging is toggled or the device reboots.

1. On device: **Developer options → Wireless debugging → On.**
2. **Pair** (one-time per host): tap *"Pair device with pairing code"*. It shows
   a **pairing port** (different from the connect port) and a **6-digit code**:
   ```bash
   adb pair <ip>:<pairing-port> <6-digit-code>
   ```
3. **Connect** using the **"IP address & Port"** from the *main* Wireless
   debugging screen (the *connect* port, not the pairing port):
   ```bash
   adb connect <ip>:<connect-port>
   ```

### Finding the ports when the UI/mDNS won't tell you
mDNS discovery (`adb mdns services`) **only works on the same L2 subnet**; it
won't cross a router. If the device is a hop away, scan for the open ports:
```bash
nmap -p 30000-50000 --open -T4 <ip> | grep open
```
The **connect** and **pairing** ports are random in the high range and churn;
the pairing port only exists while the pairing dialog is open.

### Gotchas learned the hard way
- **Be on the same subnet.** A wireless-debug *connect* port that is TCP-open
  from across a router can still refuse the adb/TLS handshake. Pairing tolerates
  routing; connecting often does not. Put your machine on the **same /24** as
  the device.
- **Do NOT run `adb root` over a wireless connection.** It restarts `adbd` in
  root mode, which **drops the TLS connection and stops re-binding the connect
  port** — the phone keeps *displaying* the old port but it's refused. Recovery
  is a **phone reboot** (or `adb unroot`, which you can't reach because you're
  disconnected). Release builds aren't debuggable anyway, so root buys you
  little here — prefer **Clear data** for config resets.
- After a reboot or a wireless-debugging toggle, the connect port **changes** —
  re-read it from the device and reconnect (pairing usually persists).

---

## Reference: where things live

| Thing | Location |
|---|---|
| Package id | `com.remotedisplay.player` |
| Display name | RemoteDisplay |
| Server URL entry | `ProvisioningActivity` (`R.id.serverUrlInput`) |
| Routing to setup | `MainActivity` → `if (!isProvisioned || !isPaired)` |
| Connection client | `service/WebSocketService.kt` (Socket.IO) |
| Cleartext allowed | `AndroidManifest.xml` → `usesCleartextTraffic="true"` |
| Build a signed APK | `KEYSTORE_PASSWORD=… KEY_PASSWORD=… ./gradlew assembleRelease` |
| APK output | `android/app/build/outputs/apk/release/app-release.apk` |

---

## Scheduled screen off vs device off

These are different things and the difference is the whole design. A **display power schedule** blanks
the **panel** on a weekly clock. It does **not** power the device down, and ScreenTinker deliberately
offers no way to schedule that — see "Why there is no scheduled device power-off" below.

During a scheduled-off window the player is still running:

| Still happening | Not happening |
|---|---|
| Socket.IO connection, heartbeats, telemetry | The backlight |
| Playlist sync and content downloads | |
| OTA update checks and installs | |
| `screen_on` from the dashboard (wakes instantly) | |

So a screen that is dark on schedule is **still a healthy screen** in the dashboard, which is the point:
it reports `display_power: scheduled_off` on every heartbeat, so a deliberately dark panel is
distinguishable from a dead one. Without that they look identical from the office, and the operator
drives out to check.

### What the player actually does at the edges

- **Going off** — releases `FLAG_KEEP_SCREEN_ON`, then locks via device owner / device admin
  (`FORCE_LOCK`) or the accessibility service, exactly as a remote `screen_off` does.
  ⚠️ Releasing the flag is the part that is easy to miss: `MainActivity` holds it unconditionally so a
  kiosk never sleeps mid-playback, and if it is still held, the first person who touches the panel at
  23:00 relights it **for the rest of the night** — the OS will not sleep a window asking to stay awake.
- **Coming on** — re-adds the flag, takes a wake lock and asks for the keyguard to be dismissed, exactly
  as a remote `screen_on` does.
- **A manual `screen_on` inside a window** wins until the window **ends**, then the schedule resumes on
  its own. Not permanent (the operator would silently lose the schedule) and not ignored (the panel
  would fight them, going dark again within 60 seconds).
- **Evaluation is local**, once a minute, against the device's own timezone. The schedule survives
  reboots in `SharedPreferences` and is re-applied before any socket exists, so a panel that restarts at
  02:00 with no network comes back dark and stays dark until its window ends.

### Requirements

The panel needs a way to blank itself, which is the same requirement `screen_off` has:

- **device owner** (see the provisioning notes above), **or**
- **device admin** with `FORCE_LOCK`, **or**
- the ScreenTinker **accessibility service** enabled.

With none of those the player declares neither `display.power` nor `display.power_schedule`, the server
refuses `set_power_schedule` for that device, and the dashboard says so instead of saving a schedule
that would never run. `WRITE_SETTINGS` is **not** required — that one is for system brightness and the
screen-off timeout, which are separate controls.

### Why there is no scheduled device power-off

Turning an Android device fully off on a timer is OEM-specific and unreliable, and — more to the point —
a device that is off cannot be told to come back on. A schedule that can only run in one direction is a
schedule that strands screens, and recovering one means someone walking to it. Blanking the panel gets
essentially the same backlight saving and is reversible from the dashboard at any moment.

### If a screen does not sleep when it should

1. Check the dashboard shows `Scheduled off` for it. If it shows `Screen on`, the player has not been
   given the schedule — confirm the device reports `display.power_schedule` (device page → capabilities).
2. Confirm the **timezone**. Windows are local wall-clock in the device's zone, not the server's.
   A screen in another country sleeps on its own clock, which is nearly always what you want and
   occasionally a surprise.
3. Check nobody pressed **screen on** during the window — that is an intentional exemption and it lasts
   until the window ends.
4. `adb logcat -s PowerSchedule:I` shows the restore, every state change, and whether an override is active.
