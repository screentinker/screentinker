# Operations runbook

Running an instance day to day: deploying, verifying, rolling back, and the traps that have actually
cost people time.

The README covers the happy paths — [installing](../README.md#production-deployment),
[updating](../README.md#updating), [backups](../README.md#backups) and
[admin recovery](../README.md#admin-recovery). This is the part you want at 2am, or when a deploy
did not behave.

---

## Contents

- [Two deployment shapes](#two-deployment-shapes)
- [Before you deploy](#before-you-deploy)
- [Deploying: native (git + systemd)](#deploying-native-git--systemd)
- [Deploying: Docker](#deploying-docker)
- [The served APK](#the-served-apk)
- [Verifying a deploy](#verifying-a-deploy)
- [Rolling back](#rolling-back)
- [Releases and version numbers](#releases-and-version-numbers)
- [Upgrading Node.js](#upgrading-nodejs)
- [Upgrading 1.9 to 2.0 on slow storage](#upgrading-19-to-20-on-slow-storage)
- [Traps worth knowing before they bite](#traps-worth-knowing-before-they-bite)
- [Fail2ban (optional)](#fail2ban-optional)

---

## Two deployment shapes

An instance is either **native** (a git checkout on a release tag, run by systemd) or **Docker** (a
published image, run by compose). They are not interchangeable, and the commands differ at every
step.

> ⚠️ **Know which one you are on before you type anything.** The most expensive mistakes in this
> runbook come from applying one shape's procedure to the other — `git checkout` on a Docker host
> changes nothing the container is running, and bumping an image tag on a native host does nothing
> at all. If you run more than one instance, keep a note of which is which somewhere you will read.

---

## Before you deploy

Every time, in this order:

1. **Snapshot the database.**
   ```bash
   sqlite3 <db> ".backup /path/to/pre-<version>-$(date +%Y%m%d-%H%M%S).db"
   sqlite3 /path/to/pre-<version>-*.db "PRAGMA integrity_check;"   # want: ok
   ```
2. **Record the row counts** you intend to still have afterwards:
   ```sql
   SELECT (SELECT COUNT(*) FROM devices), (SELECT COUNT(*) FROM users),
          (SELECT COUNT(*) FROM content), (SELECT COUNT(*) FROM playlists);
   ```
3. **Check whether dependencies changed.** If `server/package.json` differs by more than the version
   field between the running release and the target, you need an install step. If it differs only in
   `"version"`, skip it — that is the cheapest and safest kind of deploy.
   ```bash
   git diff <current-tag> <target-tag> -- server/package.json
   ```
4. **Check whether migrations will run.** They apply automatically at boot. Additive columns and new
   tables are safe, and a code-only rollback simply leaves them unused.
   ```bash
   git diff <current-tag> <target-tag> -- server/db/database.js | grep -E '^\+.*(ALTER|CREATE) TABLE|CREATE INDEX'
   ```
5. **Back up the compose file / the served APK** if you are about to change either.

---

## Deploying: native (git + systemd)

> To upgrade from the dashboard instead (Platform → System → **Update Now**, platform admins
> only, never automatic), install the updater: [instance-updater.md](instance-updater.md).

`scripts/upgrade.sh` does the whole sequence — snapshot, checkout, `npm ci --omit=dev`, restart, and
report the running version. It restarts the systemd unit (`SERVICE_NAME`, default `screentinker`), or
the pm2 process for this checkout, or runs `RESTART_CMD`. If none applies, it says the old version
is still running and exits 2. It refuses to start over local edits to tracked files, and if a step
fails it names that step. It defaults to the newest **stable** tag, deliberately skipping
`-rc`/`-beta`/`-alpha` prereleases:

```bash
cd /opt/screentinker
scripts/upgrade.sh              # latest stable release
scripts/upgrade.sh v1.2.3       # or pin one
```

Before it changes anything it checks the host can run the target: a Node at least the release's
`engines` floor and, for a release on `better-sqlite3`, `python3`/`make`/`g++`. When something is
missing and you are at a terminal it **offers to fix it** (`Upgrade Node to 22.x now? [Y/n]`) and
carries on: Node from NodeSource's apt repository (a node apt does not own, such as nvm, is left
alone with instructions), the toolchain with `apt-get`. With no terminal it stops instead;
`ST_AUTO_INSTALL_PREREQS=1` answers yes in advance, `ST_ALLOW_OLD_NODE=1` skips the Node check.
After `npm ci` it opens a database with the new driver, and if that fails it puts the previous
release back and stops **without** restarting, so the running server is never replaced by one that
cannot start.

**Every run is recorded** in `backups/upgrade-history.jsonl` (beside the database backups), one
JSON line whatever the outcome: when and by whom, the release and commit it came **from** and went
**to**, Node before and after, what it changed on the host, the backup it took, and the result
(`done`, `refused`, `rolled_back`, `failed`, ...). When it upgrades Node it first saves the old
NodeSource apt files and version in `backups/node-apt-before-<time>/`, named in that line, so Node
can be put back exactly. The dashboard updater appends to the same file.

⚠️ **Run the TARGET release's copy of the script.** `upgrade.sh` is tracked, so the copy in your
checkout is the one from the release you are LEAVING, and checks added in a newer release do not
protect the upgrade to it. Run the new one against your checkout instead:

```bash
cd /opt/screentinker && git fetch --tags origin
git show v1.2.3:scripts/upgrade.sh > /tmp/st-upgrade.sh
APP_DIR=/opt/screentinker bash /tmp/st-upgrade.sh v1.2.3
```

The dashboard updater (`st-updater.sh`) is a copy too: re-run `scripts/updater/install-systemd.sh`
from the new release to pick up its checks.

If you are doing it by hand, the order matters:

```bash
sudo -u <service-user> git fetch --tags origin
sudo -u <service-user> git checkout -f v1.2.3
# only if dependencies actually changed:
cd server && sudo -u <service-user> npm ci --omit=dev
sudo systemctl restart <service>
```

**Ownership first.** Every file must belong to the service user *before* the checkout. A checkout
that fails partway through leaves the worst possible state: `VERSION` updated while the code is
still the old release, so the service reports a version it is not running and no migrations ran.

```bash
sudo chown -R <service-user>:<service-user> /opt/screentinker
```

**A service user with no home directory breaks npm.** It writes logs and a cache to `$HOME`, which
does not exist, and installs nothing while looking like it worked:

```bash
cd server && sudo -u <service-user> env HOME=/opt/screentinker \
  npm_config_cache=/opt/screentinker/.npm-cache npm ci --omit=dev
```

**Prove the checkout is complete** — a version string alone will not tell you:

```bash
git status --porcelain --untracked-files=no    # want: empty
git diff <tag> -- server frontend              # want: empty
```

---

## Deploying: Docker

```bash
# in the compose directory
cp -a docker-compose.yml docker-compose.yml.bak-pre-<version>
sed -i 's|screentinker:<old>|screentinker:<new>|' docker-compose.yml
docker compose pull && docker compose up -d
```

Migrations run at boot exactly as they do natively. State lives in the named volume (`st-data` in
the example compose), so recreating the container does not touch the database.

Anything bind-mounted into the container — the served APK, a `.wgt`, custom assets — must be updated
on the **host**, and see the inode warning below.

---

## The served APK

The file the OTA endpoint hands to Android displays. Two rules, both learned the hard way.

**1. Replace it in place. Never `mv` or `cp` over it.**

It is a bind-mounted *file*, so the container holds the inode. Replacing the file gives the host a
new inode and the container keeps serving the old bytes forever, with nothing in any log to say so.

```bash
cat /tmp/new.apk > /opt/screentinker/ScreenTinker.apk     # correct — same inode
# NOT: mv, cp, install, or anything that unlinks and recreates
stat -c %i /opt/screentinker/ScreenTinker.apk             # confirm it did not change
```

**2. The advertised size must match the served bytes, or displays loop.**

`/api/update/check` reports `apk_size` from a cache refreshed every `OTA_APK_REFRESH_MS`
(default 60s), and the server re-stats at boot. If the advertised size and the real file disagree,
a display downloads, rejects, and retries — forever. After swapping, restart the service and confirm:

```bash
curl -s 'http://127.0.0.1:3001/api/update/check?version=<an-older-version>'
stat -c %s /opt/screentinker/ScreenTinker.apk    # must equal the reported apk_size
```

> ⚠️ The query parameter is **`version`**, not `current_version`. The wrong name yields
> `reason: no-version, update_available: false`, which looks exactly like a broken OTA but is not.
> `/api/version` is a different endpoint and its `update_available` is not the OTA verdict.

**Verify the signature after any APK swap**, and use `jarsigner`:

```bash
jarsigner -verify ScreenTinker.apk          # want: "jar verified."
unzip -l ScreenTinker.apk | grep META-INF   # want: a .SF and a .RSA
```

`apksigner verify -v` misreports `v1 scheme: false` on some build-tools versions even when the JAR
signature is present and valid. MDM-managed signage needs v1, so trust `jarsigner`.

---

## Verifying a deploy

```bash
curl -s http://127.0.0.1:3001/api/version     # version + build hash
curl -s http://127.0.0.1:3001/api/status      # health, loop lag, connected displays
```

Then, and this is the part people skip:

- **Row counts match** what you recorded beforehand.
- **The log is clean.** Migrations reported, no errors:
  ```bash
  docker logs <container> 2>&1 | grep -iE 'migrat|error|exception'   # or journalctl -u <service>
  ```
- **Check through your reverse proxy / CDN too**, not only on loopback. Cached or misrouted assets
  only show up from outside.

> ⚠️ **A version string is not proof the new code is running, and neither is the build hash.** The
> hash covers the frontend, so a server-only change deploys with an *unchanged* hash — which looks
> exactly like a stale image. When it matters, check for the code itself:
> ```bash
> docker exec <container> grep -c '<a symbol only the new version has>' /app/server/<file>
> ```

**A frontend change needs a hard refresh** (Ctrl+Shift+R) before you judge it. Assets revalidate,
but a browser sitting on the old bundle will show you the old behaviour and you will debug a fixed
bug.

---

## Rolling back

Because backups are taken per deploy, rollback is mechanical:

**Native**
```bash
sudo -u <service-user> git checkout -f <previous-tag>
cd server && npm ci --omit=dev        # only if dependencies changed
cat /path/to/ScreenTinker.apk.bak > /opt/screentinker/ScreenTinker.apk
sudo systemctl restart <service>
```

**Docker**
```bash
cp -a docker-compose.yml.bak-<version> docker-compose.yml
cat /path/to/ScreenTinker.apk.bak > /opt/screentinker/ScreenTinker.apk
docker compose up -d
```

**The database usually does not need restoring.** Migrations are additive, so older code simply
ignores the new columns. Restore the snapshot only if a migration was destructive — and if one ever
is, that is the moment to stop and read it rather than reflexively rolling forward.

---

## Releases and version numbers

Cutting a release is documented in [RELEASING.md](../RELEASING.md). The operational consequences:

**A prerelease sorts BELOW its own release.** `1.2.3-alpha1` is semver-older than `1.2.3`. That has
two effects worth internalising:

- A display that takes a prerelease is not "ahead"; a later stable of the same version supersedes it,
  which is what you want.
- The Android update check offers a prerelease to any older client on the **stable** channel. Putting
  a prerelease on an instance means every Android display below it takes it at its next check. Do
  that deliberately, on an instance whose displays you are willing to move.

**`:latest` is not moved for a prerelease.** The release workflow skips it for any tag containing a
`-`, so nobody tracking `:latest` pulls untested code on their next restart.

**Android `versionCode` must never go backwards.** Android refuses a downgrade, so a build with a
lower code cannot install over a higher one — the usual cause is a side-loaded test build whose code
was bumped past the release line. Keep the release line ahead of anything you side-load, or you will
be reinstalling by hand (which wipes app data and drops pairing).

**A re-cut tag is only safe if it published nothing.** If a tag has already produced a GitHub Release
or an image, delete-and-repush is not a fix; cut the next version instead.

---

## Upgrading Node.js

Upgrading the runtime is not like deploying a release: nothing in the app's own upgrade path is
involved, so the usual `scripts/upgrade.sh` never runs and nothing reinstalls dependencies. Read
this before changing the Node major.

**Do it as two separate deploys, never one.** Move the app to a release whose dependencies support
both the old and new Node major first, confirm it on the runtime you already have, and only then
change Node. Each half is then independently reversible. Doing both at once means a failure gives
you nothing to bisect and no single step to undo.

**Check the version floor: Node 22.14 or newer** (`engines` in `server/package.json`).

**Since 3.0 the floor is enforced at boot.** `server/lib/node-guard.js` runs before anything else in
`server.js`: on an older Node the server prints the version it needs, the binary it is running
(`process.execPath`, which is how an nvm path left in a unit's `ExecStart` shows up), and exits with
code **78**. The shipped units carry `RestartPreventExitStatus=78`, so systemd stops instead of
looping; add the same line to a unit you wrote yourself. `ST_ALLOW_OLD_NODE=1` downgrades the refusal
to a warning (unsupported). 2.x only warned here.

- `better-sqlite3` 13, the database driver, is a Node-API 10 build and needs **22.14**. On an older
  Node it would crash the process outright, so the server never loads it there: preflight switches
  to Node's built-in `node:sqlite` where that exists (unflagged since Node 22.13; experimental, so it
  prints an `ExperimentalWarning`), and otherwise refuses to start with
  a message saying to upgrade Node. A 22.x host older than 22.14 must be upgraded first.
- `puppeteer-core` 25, which renders widgets and slides for players that cannot (Roku, BrightSign
  frames), needs **22.12**. On an older Node, npm skips it: the server still starts, preflight warns
  that it is below the floor, and Chromium rendering is off until Node is upgraded.
- `npm start` uses `node --env-file-if-exists=.env`, which reached the Node 22 line only in
  **22.9.0**. On Node 22.0–22.8 the server refuses to start with `node: bad option`.
- Node 20 reached end of life on 2026-04-30, and several dependencies now declare Node 22.

**Moving from Node 20: change Node FIRST, on the release you already run, then upgrade the app.**
Releases up to 2.6.x run on both Node 20 and Node 22, so that order is the two-step path above:
upgrade Node, confirm the server on it, then run `scripts/upgrade.sh` to the release that needs 22.
`upgrade.sh` refuses, before it changes anything, a target release that needs a newer Node than the
host has: below the floor the server no longer starts (see the database driver below), so this is
a refusal rather than the warning it once was. `ST_ALLOW_OLD_NODE=1` proceeds anyway.

**The native database module.** `better-sqlite3` 13 is a Node-API build: one binary serves every
Node from 22.14 on, so moving between Node versions above that floor no longer invalidates it.

- Its prebuilt binaries ship inside the npm package for Linux, macOS and Windows on x64 and arm64.
  The Linux ones need **glibc 2.34+** (Debian 12 Bookworm, Ubuntu 22.04 or newer) or musl. Debian 11
  Bullseye and Ubuntu 20.04 cannot load them, so a native install there must move to a newer OS.
- `lib/preflight-deps.js` runs before anything else at boot. It refuses to load the module on a Node
  below 22.14 (see the floor above), detects a broken install by *opening a database* (a bare
  `require` can succeed on a binary that cannot run), and repairs it with `npm rebuild better-sqlite3`.
- ⚠️ **`python3`, `make` and `g++` must be installed even where a prebuild exists.** npm runs the
  package's `node-gyp rebuild` install step regardless, and node-gyp cannot start without them; npm
  then *silently* drops `better-sqlite3` as a failed optional dependency and the server runs on
  Node's experimental built-in `node:sqlite` (Node 22.13+), or not at all on an older Node. The
  install scripts and the Docker build install them. Check with `ls server/node_modules/better-sqlite3`
  after any `npm ci`.
- Anywhere with no prebuild (32-bit ARM, for example) that repair is a from-source compile needing
  a C++20 toolchain. Because preflight rebuilds *synchronously before the server listens*, a compile
  that outlives `TimeoutStartSec` turns `Restart=always` into a boot loop. The version is pinned
  exactly for that reason: check the prebuilds before changing the pin.

**Native (git + systemd)**

1. Back up first — a Node upgrade cannot corrupt the database, but you want the rollback anyway.
2. Change the Node major. If Node came from a distribution repository pinned to a major, the repo
   definition itself must be repointed — upgrading the package alone can never cross majors, and
   this pin lives in system configuration rather than in this repository.
3. `node --version` to confirm.
4. Rebuild the native module explicitly (`npm rebuild better-sqlite3` as the service user, in
   `server/`), or let preflight do it on the next restart. Doing it by hand keeps the logs readable.
5. Restart, then verify as in [Verifying a deploy](#verifying-a-deploy). In the logs, confirm
   preflight reports a successful rebuild rather than exiting.

**Docker** — nothing to rebuild. Change the base image, build, and deploy the new tag: dependencies
are installed inside the image against its own Node, so the ABI can never be stale. Rollback is
repinning the previous tag.

**Afterwards, move CI too.** CI pins its own Node version, and it will happily keep validating a
version nobody runs — which is worse than no signal, because it looks like coverage. The Docker base
image is a separate pin from the CI one; both need changing or what CI tests and what ships diverge.

---

## Upgrading 1.9 to 2.0 on slow storage

**If this instance runs 50 or more players on a spinning disk (a NAS, a USB-attached volume), read
this before the first 2.0 boot.** Everywhere else the upgrade is ordinary and this section does not
apply.

The first 2.0 boot builds an index over `play_logs` and then drains the plays that 1.9 left open.
On a 73-device Synology DS225+ that index build sat in uninterruptible disk sleep for over five
minutes, and the backlog behind it was 494,000 rows. The server came up healthy, the whole fleet
reconnected at once, and HTTP was effectively unreachable for about twenty minutes while the
reconnect storm and the sweep competed for the event loop.

Either of these avoids it:

- **Set `SCREENTINKER_DEFER_PLAYERS=1`** for the first boot. Players are refused with a 503 (they
  back off and retry on their own) until the sweep reports idle, while `/api/status` keeps
  answering 200 and the dashboard stays usable so you can watch it happen. This is on by default
  for the first boot after a migration that touched `plays` (and only when there is actually a
  backlog); set it explicitly if you want it regardless, or `=0` to turn it off. "Idle" means a
  sweep batch closed fewer rows than it asked for — the end of the set, not a guessed threshold.
  It always lifts: when the sweep drains, or after 30 minutes, whichever comes first.
- **Or stop the reverse proxy** (`systemctl stop nginx`), start the app, wait for
  `[boot] Migration complete` followed by the `[boot-defer] players accepted again` line, then
  start the proxy. This is the manual form of the same thing.

Either way the boot is no longer silent. Watch for:

```
[migrate] building idx_play_logs_open over ~1440000 play_logs row(s). This is ONE synchronous
          statement: on spinning disks it can take minutes ... Do not kill it.
[migrate] built idx_play_logs_open in 331402ms — slow storage (>2000ms for one statement)
[boot-defer] holding players off: stranded-sweep; 494000 open play(s) to sweep
[boot] stranded sweep batch 41/988 closed=500 remaining=473500 duration=1180ms — slow storage
[boot-defer] players accepted again (sweep idle): 147s deferred, 494000 stranded play(s) closed, 0 still open
```

A batch or an index step over two seconds is logged at warn, so slow storage shows up alongside the
loop-lag band and download-shed lines rather than in a separate place. **Do not kill the process during the index build** — it is one
synchronous statement and it looks like a hang from outside because nothing can log while it runs.

## Traps worth knowing before they bite

**Native modules are built for one Node ABI.** `better-sqlite3` is compiled against the Node that
installed it. Run the app — or its tests — under a different major version and it fails with
`NODE_MODULE_VERSION` mismatch, which presents as hundreds of unrelated test failures rather than
one clear error. Use the same Node the service runs. See [Upgrading Node.js](#upgrading-nodejs)
before changing it deliberately.

**A replica shares `JWT_SECRET` with its primary, and login always proxies.** A replica
([docs/scale-out.md](scale-out.md)) never verifies a password — copied users have no hash — so
`JWT_SECRET` must be the same value on both nodes or a session minted by the primary is refused
by the replica. Rotate it on both at once.

**SQLite foreign keys are off unless enabled per connection.** A declared `ON DELETE CASCADE` does
not fire on its own, so deleting a parent row can leave orphaned children. Check with
`PRAGMA foreign_key_check;` after any bulk delete.

**Deploying reloads every connected web player.** The frontend self-reloads when the build hash
changes. Browsers cope. Some embedded webview players do not, and may need a restart afterwards —
worth knowing before you deploy during business hours.

**An SSO-linked administrator has no password.** If you link the platform administrator account to
an identity provider and that provider later fails, the login page cannot help you. Recovery is
`node scripts/reset-admin.js` on the server. See [sso-setup.md](sso-setup.md).

**Backups are only real once restored.** A snapshot that has never been restored is a hypothesis.
Periodically restore the newest one into a throwaway instance and confirm it boots and serves
`/api/status`.

**`curl … | sudo bash` answers the installer's questions for you.** The pipe *is* stdin, and bash
has consumed it before any prompt runs — so every question gets an instant end-of-input and the
script takes the default. On the Pi installer that meant the mode menu appeared to skip itself and
Player-Only was unreachable through the documented command. Fixed there (prompts read the terminal
now), but the trap is general: any piped installer that asks you something is not really asking.
Download the script and run it, or pass the answers as flags.

**A Raspberry Pi 5 on Bookworm runs Wayland, and X11 tools fail silently there.** `xset`,
`unclutter` and `xrandr` return an error and do nothing — so screen blanking is never suppressed and
the cursor is never hidden, while every command in your setup notes appears to have worked. If you
have hand-rolled kiosk tweaks on a Pi, check which session is actually running (`echo
$XDG_SESSION_TYPE`) before trusting them. The bundled launcher detects this and uses `wlopm` plus
`--ozone-platform=wayland` on Wayland.

**Overlay FS protects the SD card and discards everything written to it.** Reasonable on a
**player-only** Pi, where the loss is a content cache that simply re-downloads after each boot. Not
usable for an **all-in-one** install as-is: the server writes continuously — the SQLite database,
WAL, uploads and thumbnails — and a read-only root throws all of it away at reboot, so the instance
silently reverts to its state at the moment you enabled overlay. If you want both, put `DATA_DIR` on
a writable partition that overlay does not cover, and confirm a screen you add survives a power cut
before relying on it.

## Fail2ban (optional)

Fail2ban reads failed password/TOTP logins from `SECURITY_LOG` and temporarily bans
the source IP. The supplied jail bans after 10 failures within 10 minutes and
runs its unban action after 15 minutes. Logging and the jail are off by default.

A ban applies to all clients sharing that public IP, including working devices
behind the same router. The local firewall action blocks the configured ports;
the Cloudflare action blocks access across the configured zone. Leave the jail
disabled if that could interrupt devices that need to stay connected.

[Account security](../frontend/guides/digital-signage-users-roles.html#sign-in) works independently: use strong, unique passwords and enable
**Settings → Two-factor authentication** for password accounts. For SSO, configure
MFA with the identity provider. [Passkeys](passkeys.md) are also available.

### Security log

Install Fail2ban and logrotate. From the repository root, replace `APP_USER` and
`APP_GROUP` with the app's service user and its primary group (`id -gn APP_USER`):

Copy the jail template only for a new setup. If the jail already exists, skip that
copy command and edit its settings instead.

```sh
sudo install -d -o APP_USER -g APP_GROUP -m 0750 /var/log/screentinker
sudo install -m 0644 scripts/logging/screentinker.logrotate /etc/logrotate.d/screentinker
sudo install -m 0644 scripts/logging/fail2ban-filter.conf /etc/fail2ban/filter.d/screentinker.conf
sudo install -m 0644 scripts/logging/fail2ban-jail.local /etc/fail2ban/jail.d/screentinker.local
```

The copied jail is disabled and uses the local firewall. It is a starting template;
configure the action for your traffic path before enabling it.

Set `SECURITY_LOG=/var/log/screentinker/security.log` in the service environment and restart.
Systemd needs `Environment=` or `EnvironmentFile=`; `npm start` reads `server/.env`.
If you use another path, update the jail and logrotate to match.
The app creates the file on the first failed login, but does not create directories.
The service user needs write access to the directory and any existing log.
Console logs stay in journald or Docker; `ACCESS_LOG` is independent of Fail2ban.

### Nginx and Caddy

The [Nginx](../scripts/logging/examples/nginx.conf) and
[Caddy](../scripts/logging/examples/Caddyfile) examples cover two layouts:

| Layout | Configuration | Ban action |
|---|---|---|
| Client → proxy on this host → app | Default example | Local firewall on the proxy's public ports |
| Client → Cloudflare Tunnel → local cloudflared → proxy → app | All `TUNNEL` changes in the example | Cloudflare |

The default examples do **not** restore visitor IPs behind Cloudflare's public
proxy (proxied DNS). They would forward the edge IP instead. That layout needs
proxy trust configured for Cloudflare's published IP ranges before enabling bans.
See [Cloudflare's visitor-IP guidance](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/).

For the supplied layouts:

- Keep the app's port private. Both examples expect HTTP on `127.0.0.1:3001`.
  If app TLS is active, port 3001 redirects; the app serves HTTPS on 3443 by default.
  An HTTPS upstream also needs the correct certificate trust and server name.
- Nginx needs an existing TLS certificate for the public example. Its Tunnel
  configuration needs the [realip module](https://nginx.org/en/docs/http/ngx_http_realip_module.html).
  The example does not add an HTTP-to-HTTPS redirect on port 80.
- Caddy manages public certificates and redirects using [automatic HTTPS](https://caddyserver.com/docs/automatic-https).
  The Tunnel configuration needs Caddy 2.8+; the `servers` address must match the
  loopback bind address and port, as explained in [proxy trust settings](https://caddyserver.com/docs/caddyfile/options#trusted-proxies).
- The Tunnel examples require `cloudflared` on the same host, outside a separate
  container network. Set its service URL to `http://127.0.0.1:8080` and preserve the
  site's public Host header. Cloudflare's [HTTP Host Header setting](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/#httphostheader)
  can set it explicitly. Only use the forced forwarded protocol `https` when visitors use HTTPS.
- For local firewall bans, use the ports clients reach: normally `443`, plus `80`
  if served. If Caddy serves HTTP/3, include UDP too. The supplied nftables action
  uses the host INPUT hook; it is not a Docker forwarding-chain configuration.

### Cloudflare action

This action manages **zone-level IP Access rules**, available on the Free plan.
See Cloudflare's [feature availability](https://developers.cloudflare.com/waf/).
It requires `curl` and Fail2ban's `cloudflare.conf` action with `_cf_api_url` and
`_cf_api_prms` support, as noted in the [action example](../scripts/logging/examples/fail2ban-cloudflare-action.conf).

#### Configure the token and action

In **My Profile → API Tokens**, create a custom token:

- Permission: **Zone → Firewall Services → Edit**. Select **Zone** in the first dropdown.
- Zone resources: **Include → Specific zone → your domain**.
- If you restrict client IPs, allow the server's outgoing public IP.

Use **Edit**, not Read: a token can be active and list rules while creating blocks
still returns `403 Authentication error`. **Account Firewall Access Rules** is an
account permission; this action calls the zone endpoint.
References: [token setup](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/),
[current permission names](https://developers.cloudflare.com/fundamentals/api/reference/permissions/#zone-permissions),
[Fail2ban's zone-token example](https://github.com/fail2ban/fail2ban/blob/master/config/action.d/cloudflare-token.conf).

From the repository root:

```sh
sudo install -m 0644 scripts/logging/examples/fail2ban-cloudflare-action.conf /etc/fail2ban/action.d/screentinker-cloudflare.conf
sudo touch /etc/fail2ban/action.d/screentinker-cloudflare.local
sudo chown root:root /etc/fail2ban/action.d/screentinker-cloudflare.local
sudo chmod 0600 /etc/fail2ban/action.d/screentinker-cloudflare.local
sudo nano /etc/fail2ban/action.d/screentinker-cloudflare.local
```

The credentials file needs the section header, too:

```ini
[Init]
cfzone = YOUR_ZONE_ID
cftoken = YOUR_TOKEN_SECRET
```

Copy the **Zone ID**, not the Account ID, from the domain's overview page.
Enter only the token secret: no quotes and no `Bearer` prefix.

For a Cloudflare test, use this complete content in
`/etc/fail2ban/jail.d/screentinker.local`. Keep it disabled until the checks below pass:

```ini
[screentinker]
enabled = false
filter = screentinker
logpath = /var/log/screentinker/security.log
backend = auto
usedns = no
findtime = 10m
maxretry = 5
bantime = 2m
action = screentinker-cloudflare
```

The Cloudflare action ignores `port` and `protocol`; it blocks the IP across the zone.

The inherited `cloudflare.conf` action discards the create/delete response bodies
and does not check the API's JSON success flag. A Fail2ban `Ban`/`Unban` message alone
is not confirmation. API failures can leave a block absent or prevent its removal.
The token and API connection must work at unban time.
See the [IP Access rules API](https://developers.cloudflare.com/api/resources/firewall/subresources/access_rules/).
Use `sudo fail2ban-client get logtarget` to locate Fail2ban's logs. Avoid sharing
configuration dumps or expanded action commands: they can contain the token.

### Verify and enable

If using Nginx or Caddy, validate the installed configuration with `sudo nginx -t`
or `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`.
Reload the proxy only if validation passes.

Write errors are silently ignored. With the jail still disabled, submit an incorrect
password through the public hostname. The security log must show the visitor's IP,
not the proxy or loopback address. Check the log and filter:

```sh
sudo tail /var/log/screentinker/security.log
sudo fail2ban-regex /var/log/screentinker/security.log /etc/fail2ban/filter.d/screentinker.conf
```

Check that client-supplied `X-Forwarded-For` and `CF-Connecting-IP` values cannot
replace the logged visitor IP. Do not enable bans until attribution is correct.

Check rotation with `sudo logrotate -f /etc/logrotate.d/screentinker`, then confirm another
failed login reaches the new file. Logging and filter tests work with the jail disabled.

After these checks, set `enabled = true` in the jail. The Cloudflare test example
already uses `bantime = 2m`; use that duration for a short local-firewall test too.
For a local firewall action, set `port` to the public ports clients reach.
Validate first:

```sh
sudo fail2ban-client -t
```

If validation passes, reload the running Fail2ban service:

```sh
sudo fail2ban-client reload
sudo fail2ban-client get screentinker actions
sudo fail2ban-client get screentinker bantime
```

The duration should be `120` seconds. For Cloudflare, the action should be
`screentinker-cloudflare`. Reload after changing saved credentials; an existing ban
does not itself retest the action.

Replace `TEST_IP` below with the test device's current public IP. Use the same
address throughout; IPv4 and IPv6 are separate addresses.

```sh
sudo fail2ban-client set screentinker unbanip TEST_IP
sudo fail2ban-client set screentinker banip TEST_IP
sudo fail2ban-client status screentinker
```

An unban result of `0` means there was no active Fail2ban ban to remove.
For Cloudflare, in the domain's [IP Access rules](https://developers.cloudflare.com/waf/tools/ip-access-rules/create/),
confirm a **Block** rule for that exact IP, with a note containing `Fail2Ban screentinker`.

From the test device, request `/api/auth/config?ban_test=1` at your actual public
origin, including its scheme and port (for example, `http://HOST:3001` for direct
HTTP or `https://HOST:3443` for app TLS). It should be blocked.
An already loaded login page, or changing `#/login`, does not
prove access: the fragment change does not request a page from the server.

After `bantime` expires, confirm all three: the IP leaves Fail2ban's banned list,
a fresh request reaches the app again, and (for Cloudflare) the block disappears.
To unblock early, run `sudo fail2ban-client set screentinker unbanip TEST_IP`.
For Cloudflare, if a rule remains, remove it in Cloudflare before finishing the test.
After testing, restore `maxretry = 10` and `bantime = 15m`, or disable the jail.
Keep the action appropriate to your traffic path, then validate and reload again.
