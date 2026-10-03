# Windows native player — server contract

The native Windows player is the **same engine** as the native Raspberry Pi player
(`native/screentinker_native`, Python + Qt) with a Windows OS backend (`platform/windows`). It is
shipped as an Inno Setup installer, `ScreenTinker-Setup-<ver>.exe`, and talks to the server exactly
like the Pi: Socket.IO on `<server>/device`, `device:register`, heartbeats, `device:command`, and the
PTY relay. Read [`pi-native-player.md`](pi-native-player.md) first — everything there applies unless
this page says otherwise. It is **not** the kiosk-browser shortcut that `scripts/windows-setup.bat`
creates; that one is a browser and registers as the web player.

Status: server and dashboard side implemented on `feat/pi-native-player`; the Windows OS backend is
being built to this contract. The OS-specific capability rows are 🔜 in
[`player-parity.md`](player-parity.md) until they have run on a Windows box.

## 1. Identity (`device:register`)

| field | value | server use |
|---|---|---|
| `client_type` | `'win'` | `platformFamily()` → `'windows'` (either this **or** `platform`) |
| `platform` | `'Windows/<edition> (<model>)'`, e.g. `Windows/11 Pro 25H2 (OptiPlex 7010)` | `platformFamily()` → `'windows'` (prefix `Windows/`, case-insensitive). ⚠️ `navigator.platform`'s `Win32` from a browser has no slash and stays `web` |
| `contract_version` | `'v4'` | liveness |
| `capabilities` | always sent — `CAPABILITIES_ALWAYS` + `platform/windows/ops.extra_capabilities()` | replaces the baseline (`parseDeclared`); unknown names are dropped silently |
| `device_info.android_version` | `''` | ⚠️ keep empty. `windows` is matched before the Android fallback, so a value there would not misclassify today, but the fallback claims any non-empty non-`Web/` string |
| `device_info.hardware_model` / `hardware_os_version` | e.g. `OptiPlex 7010`, `Windows 11 Pro 25H2 (build 26200)` | the Model and OS cards on the Info tab |

`platformFamily()` checks, in order: brightsign → tizen → vega → wgt → **linux** → **windows** →
android → web. `client_type` survives a register that omits it (`liveness.preserveKnownIdentity`), so
a row keeps `'win'` — and its family — across an older build's register.

`BASELINE.windows` (for a row whose capability column is NULL) is deliberately **narrower than
`BASELINE.linux`**: only what the shared engine does by itself — playback (video, image, widget,
YouTube, zones, transitions, PiP, bundle, slide audio), `audio.mute`, `display.rotation`,
`display.brightness` (the dim layer), `remote.screenshot` / `remote.stream` / `remote.input`,
`system.restart_player`, `sync.clock`, `offline.cache`. No OS row (`display.power`, `audio.volume`,
`system.reboot`, `system.self_update`), no privilege-conditional row (`system.shell`, `system.pty`,
`system.kiosk`, `system.time`, `system.install_apk`, `system.brightness`, `system.screen_timeout`),
and none of the "in no baseline" names. A Windows player that can do those declares them — and it
always declares.

The server tests (`server/test/windows-native-player.test.js`) read `capabilities.py` **and**
`platform/windows/*.py` when `platform/windows/ops.py` exists: every quoted `group.name` string must be
a name this server knows, and every `BASELINE.windows` entry must appear somewhere in those files.

## 2. Commands

Identical wire format and gating to the Pi. The differences are what runs on the device:

| command | capability | on Windows |
|---|---|---|
| `shell {cmd}` | `system.shell` | `powershell -NoProfile -Command <cmd>` as the **signed-in player user** (not elevated); answer `device:shell-result {cmd, output, exit}` |
| PTY (`device:pty-*`) | `system.pty` | PowerShell over ConPTY, same frames and rules as the Pi (§3 of the Pi doc) |
| `install_apk {url}` | `system.install_apk` | the dashboard labels it "Install package (.exe/.msi URL)"; the player downloads and hands the file to the helper's `install` verb (§4) |
| `reboot` / `set_time` / `set_timezone` / `set_screen_timeout` | `system.reboot` / `system.time` / `system.screen_timeout` | helper verbs (§4) |
| `kiosk_lock` / `kiosk_unlock` / `lock_now` / `power_menu` | `system.kiosk` | the player is the fullscreen shell; `kiosk_lock` hides its on-screen exit |
| `screen_off` / `screen_on` | `display.power` | `SC_MONITORPOWER` broadcast + DDC/CI VCP `D6` + the black overlay |
| `set_system_brightness` | `system.brightness` | DDC/CI VCP `10` (dxva2) or WMI `WmiMonitorBrightness`; declared only when one is present |

Dashboard: the Terminal tab uses PowerShell presets (`Get-ComputerInfo`, `Get-CimInstance
Win32_OperatingSystem`, `Get-PSDrive C`, `Get-NetIPAddress`, `Get-Service ScreenTinkerHelper`,
`Get-Process ScreenTinker*`, `Get-WinEvent … ScreenTinker`); the Info tab shows "Windows (native)",
the OS and model cards and the settings PIN; no Android-only control (device-owner QR,
MediaProjection, Recents, the Android settings activity) is ever rendered for it.

## 3. Self-update

```
GET /api/win/update/check?version=<current>[&device_id=<id>][&forced=1]
→ { update_available, latest_version, current_version, download_url: '/download/win',
    sha256, size, reason, retry_after_seconds? }
GET /download/win  → the installer (Content-Disposition: attachment; filename="ScreenTinker-Setup-<ver>.exe";
                     X-Package-Sha256, X-Package-Version; Content-Type application/octet-stream)
```

- Package source (`server/lib/win-cache.js`, an instance of `lib/package-cache.js` — the same factory
  as the Pi's `deb-cache.js`): the newest `ScreenTinker-Setup-<ver>.exe` in `DATA_DIR`, else
  `WIN_DIST_DIR` if set, else `<repo>/native/dist/`. First directory with any match wins. `<ver>` is
  `X.Y.Z` or `X.Y.Z~rcN` / `X.Y.Z-rcN`; `~` is normalised to `-` for comparison and in
  `latest_version`.
- ⚠️ A release always beats a prerelease in the same directory (no beta channel), so an rc dropped
  beside a release is never offered to the fleet.
- The sha256 is computed once per (path, size, mtime), streamed; until it exists the check answers
  `exe-hashing` with `retry_after_seconds: 30` rather than offering an unverifiable file.
- **Player poll (with `device_id`)** — exactly the Pi/Android rules: `ota_disabled_global`,
  `ota_disabled_device`, `exe-missing`, then `otaBreaker.decide()` (`up-to-date`, `client-newer`,
  `superseded-prerelease`, `rate-backoff`, `no-progress`, `forced-override`, `unrecognized-version`,
  `no-version`, `offer`). `sha256`/`size` only on an offer.
- **Helper lookup (no `device_id`)** — see §4. Answered as `reason: 'package-lookup'`, always with
  the current package's `sha256` and `size` (once hashed), `update_available` a plain version
  comparison, and **no** breaker bookkeeping. The global kill switch still applies
  (`ota_disabled_global`, no hash), as do `exe-missing` / `exe-hashing`.
- `/download/win` shares the global OTA admission guard with `/download/apk` and `/download/pi`
  (503 + `Retry-After` under load).
- `/download` lists it as **Windows (native player)** (`id="windows-native"`) when an installer is
  hosted, beside the unchanged kiosk-script row.

## 4. The helper service and its trust model

The Windows player runs as the signed-in (kiosk) user. Everything that needs SYSTEM goes to
**ScreenTinkerHelper**, a Windows service running as `LocalSystem`, over the named pipe
`\\.\pipe\screentinker-helper`: one JSON request `{"verb": "...", "args": ["..."]}` + newline, one
JSON reply `{"ok": bool, "out": "..."}`, per connection. The verb list is **fixed**, and every
argument is re-validated in the service:

| verb | args | does |
|---|---|---|
| `reboot` | — | restart Windows |
| `poweroff` | — | shut down |
| `set-time` | epoch ms | set the system clock |
| `set-timezone` | IANA zone (mapped to the Windows id with tzlocal's CLDR table) | set the time zone |
| `set-screen-timeout` | ms (0 = never) | the display-off timeout of the active power plan |
| `hold` / `unhold` | — | block / allow uninstalling the player |
| `install` | path to a downloaded `.exe` / `.msi` | run it silently — **only after the sha256 check below** |

The threat the design answers: a compromised dashboard account can reach `shell` and the PTY, which
run as the player user. That must not become SYSTEM through the helper. So:

- **The helper never trusts the player for what to install.** Before `install`, it hashes the file
  itself and compares with the `sha256` that `/api/win/update/check` returns from the server named in
  the **admin-only** `%ProgramData%\ScreenTinker\config.json` (installer ACL: Administrators/SYSTEM
  write). It never uses a server URL, hash, or version supplied by the player or by the player
  user's own state files, which that user can rewrite.
- That is why the check endpoint answers **without a device token or `device_id`**: the helper has no
  device identity and does not need one — the hash of a public package is public — and it must get
  the hash even when it is verifying the very version the player just downloaded, and however often
  it retries. Those calls bypass the OTA breaker (its device-less bucket is keyed by version, so it
  would be shared with and tripped by unrelated callers); the player's own poll, which carries
  `device_id`, is still fully breaker-governed. See `server/routes/native-update.js`.
- **Who may call the pipe: the installed player binary, nothing else.** The DACL (well-known SIDs —
  SYSTEM, Administrators, INTERACTIVE — never account names, which are translated on non-English
  Windows) only decides who may *open* it; every connection is then authorised by the client's image
  path, which must be `ScreenTinker.exe` beside the helper in admin-only Program Files
  (`_client_allowed` in `winhelper/service.py`). `PIPE_REJECT_REMOTE_CLIENTS` is set.
  - Not a "ScreenTinker Players" group (the first design): a logon token never gains a group added
    after logon, and the installer runs while the kiosk user is logged on — the player was locked out
    of its own helper until the next logon. The executable check is also *tighter*: another program
    running as the same kiosk user (the dashboard's own remote shell) is refused.
- The helper runs **two** pipe listeners so an instance always exists; the player probes with
  `WaitNamedPipe`, never by opening the pipe.

### Verified on a Windows 11 25H2 VM (2026-09-29)

| check | result |
|---|---|
| silent install `/SERVER= /NAME=`, service Automatic + Running, watchdog launches the player into the console session | ✅ |
| upgrade-in-place keeps config + pairing; player relaunched on the new build | ✅ |
| `set_timezone America/Chicago` → Central Standard Time; `set_screen_timeout 600000` → 600 s AC | ✅ |
| self-update 2.2.3 → 2.2.4 via `update`: download, helper re-verifies sha256 against the server, silent install, back online as 2.2.4 | ✅ |
| `install_apk` of an arbitrary .exe with `allow_package_install` off | ✅ refused, reason logged to the dashboard |
| the dashboard shell (PowerShell, same user) connecting to the pipe and sending `reboot` | ✅ refused (`refused client … powershell.exe`), no reboot |
| `reboot` from the dashboard: reboot, auto-logon, service, watchdog, player back online unattended | ✅ |
| one-shot shell (PowerShell 5.1, Android output format) and interactive PTY (ConPTY; resize) | ✅ |
| playback, group sync, VanEck transition on Direct3D 11, screenshots | ✅ |

## Answers to the earlier open questions

1. **Arbitrary installers:** refused unless the admin config sets `allow_package_install: true`
   (installer switch `/ALLOWPACKAGES=1`) — the same rule as the Pi. The dashboard hint is right.
2. **`version` sent by the helper:** `0.0.0` with `forced=1`; it only needs the hash.
3. **Kill switch:** intended — `OTA_ENABLED=false` means no player installs, pushed or polled.
4. **`hold`/`unhold`:** the existing `block_uninstall`/`unblock_uninstall` commands (gated
   `system.device_owner` OR `system.kiosk`); they set `NoRemove`/`NoModify` on the uninstall key.
5. **Version strings:** as for the Pi.
