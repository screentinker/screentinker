# ScreenTinker cache node for Windows

A small Windows PC in a studio keeps a **live copy** of your main ScreenTinker server: its workspaces,
playlists and the media they use. Screens in the studio keep playing, and new screens can still
download files, when the studio's internet connection is down.

It is an ordinary ScreenTinker server running as a **replica** (see `docs/scale-out.md`), packaged so
nobody at the studio needs a terminal, Docker or Linux:

- Node.js is bundled; nothing else is installed on the PC.
- It runs as the Windows service **ScreenTinker Cache Node**, starts at boot (before anyone logs in)
  and restarts itself if it stops.
- **It connects out to the main server.** The main server never needs to reach the PC: no port
  forwarding, no VPN. Only the studio's own screens connect to it, over the studio network, and only
  if you turn that on (step 3).
- It runs as the low-privilege **LocalService** account, and its folders are open only to that
  account and to administrators.

**What the PC needs:** Windows 10 or 11 (64-bit), 8 GB RAM, an SSD with room for the media cache
(256 GB is plenty for the default 100 GB cache), and internet access to the main server.

## How a studio turns this on

### 1. On the main server (whoever runs it does this once per studio)

The main server needs `MESH_ALLOW_UPLINK=true` in its environment.

1. Sign in as an administrator and open **Servers → Report this server to another one**.
2. Under **What to share**, tick the studio's workspace(s).
3. Click **Create a replica invite**. Copy the code; it works once and lasts 7 days.

The studio also needs the main server's address and its `JWT_SECRET`. The secret must match, so
that a login on the main server also works on the cache node. Send it privately, not in the same
message as the invite.

### 2. On the studio PC

Run `ScreenTinker-CacheNode-Setup-<version>.exe` as an administrator and fill in:

| Page | What to enter |
|---|---|
| Main server address | e.g. `https://signage.example.com` |
| Invite code | the code from step 1 |
| Shared secret | the main server's `JWT_SECRET` |
| Media cache size | in GB (default 100) |
| Port | the port for this PC's dashboard and for screens that connect to it (default 3001) |
| Screens | whether the studio's screens connect to this PC (see step 3) |
| Data folder | a **new or empty** folder for the copy and media (default `C:\ProgramData\ScreenTinker\data`). Its permissions are locked down, so it may not be a folder that already holds other files. |

Setup waits until the server answers before it finishes. **Open the status page** then shows
whether it has joined; if the main server cannot be reached yet it keeps trying, and the page says
so. The first copy takes a minute or two. The status page is in the Start menu as **ScreenTinker
Cache Node status**.

If the server does not come up (the logs say why), run setup again: it asks for the settings again
rather than treating the failed attempt as an install to upgrade.

### 3. Screens

A screen fetches its media from the server it is paired to. To have the studio's screens play from
the cache node, so they keep working when the internet is down, they must connect to it:

1. Tick **Let screens connect to this PC** in the installer (or pass `/PLAYERS=1`). This also opens
   the port in Windows Firewall, on every network type, since Windows treats a new network as
   Public. Without the tick, no firewall rule is added.
2. On the main server, allow it under **What this server may change** for that cache node.
3. Point the studio's screens at `http://<the PC's address>:<port>`, the port chosen in setup
   (3001 unless you changed it).

See `docs/scale-out.md`, "Players on a replica". Without this, the cache node still keeps the copy
and the media for dashboards and for a catalog that lists what is on the PC.

### Silent install (for us or a partner)

```
ScreenTinker-CacheNode-Setup-3.0.2.exe /S ^
  /PRIMARY_URL=https://signage.example.com /JOIN_CODE=ABCDE-FGHJK /JWT_SECRET=... ^
  [/CACHE_GB=100] [/PORT=3001] [/PLAYERS=1] [/DATADIR=D:\ScreenTinker]
```

| Exit code | Meaning |
|---|---|
| 0 | Installed, and the server answered on its port. |
| 2 | Refused: a missing or wrong value, the port already in use, a data folder that is not empty, or a `C:\ProgramData\ScreenTinker` this installer did not leave. The reason is in `%TEMP%\ScreenTinker-CacheNode-setup.txt`. |
| 3 | Installed, but the server did not answer within two minutes. See the logs; running setup again asks for the settings again. |

Values may not contain `#` or quote characters; they are written into the settings file as
`KEY=value` lines. `/PLAYERS` accepts `1`, `true` or `yes`.

A silent uninstall is `"C:\Program Files\ScreenTinker Cache Node\uninstall.exe" /S`.

## What the status page shows

- Whether it is connected to the main server, and if not, why not.
- When it last synced, and how many workspaces it copies.
- Cache used out of the cap, plus how many videos and files are cached and any still downloading.

It reads `http://localhost:<port>/api/status`, so support can read the same numbers remotely in the
`scale_out.replica_of` block.

## Logs and settings

| | |
|---|---|
| Logs | `C:\ProgramData\ScreenTinker\logs` (rolled at 10 MB, 8 kept). Send this folder to support. |
| Settings | `C:\ProgramData\ScreenTinker\screentinker.env`, readable only by Administrators, SYSTEM and the service. Edit it (as UTF-8, no `#` or quotes in values), then restart the service in `services.msc`. |
| Program | `C:\Program Files\ScreenTinker Cache Node` |

**Upgrading:** run the newer installer. It asks nothing and keeps the settings, the copy and the cache.

**Uninstalling** (Settings → Apps) removes the program, the service and the firewall rule. It
**keeps** `C:\ProgramData\ScreenTinker` (settings, copy, cache), so a reinstall carries on. Delete
that folder afterwards to remove everything, and the registry key
`HKLM\Software\ScreenTinker\CacheNode` that lets a reinstall recognise it. Installed with `/D=` into
a folder of your own, only the files setup put there are removed. To also disconnect it on the main
server, use **Stop reporting** next to the studio under **This server reports to**.

## Security notes

- The service runs as `NT AUTHORITY\LocalService`, not LocalSystem.
- `C:\ProgramData\ScreenTinker` and the data folder are locked to Administrators, SYSTEM and that
  account **before** anything is written into them. The settings file, which holds the secret that
  signs every login, is read-only to the service.
- Any Windows user can create folders under ProgramData, so setup never trusts one it finds. A
  `C:\ProgramData\ScreenTinker` that this installer did not leave is refused, and whether a run is an
  upgrade is decided from the registry (HKLM, administrators only), never from a file existing.

## Building the installer

On Windows x64 with [NSIS 3](https://nsis.sourceforge.io) (`choco install nsis`). NSIS is
zlib/libpng-licensed, free for any use including commercial:

```
powershell -ExecutionPolicy Bypass -File server\packaging\windows\build.ps1 [-Version 3.0.2]
```

The script:

1. Downloads Node.js and WinSW and checks them against the SHA-256 values pinned in `build.ps1`.
2. Stages the server as the release tarball ships it, leaving out the same files the tarball does
   (`.env*`, databases and their backups, keys, keystores, `.mcp.json`). It fails if any such file
   is staged anyway.
3. Installs its production dependencies with the bundled Node, so `better-sqlite3` is the Windows build. The build fails if that build doesn't load.
4. Writes `server\packaging\windows\dist\ScreenTinker-CacheNode-Setup-<version>.exe`.

The `Windows cache node` CI workflow builds the installer and tests it end to end on a Windows runner:
a silent install, joining a primary, the service account and folder permissions, a service restart,
an upgrade over the top, then uninstall.
