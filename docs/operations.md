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
- [Traps worth knowing before they bite](#traps-worth-knowing-before-they-bite)

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

`scripts/upgrade.sh` does the whole sequence — snapshot, checkout, `npm ci --omit=dev`, restart, and
report the running version. It defaults to the newest **stable** tag, deliberately skipping
`-rc`/`-beta`/`-alpha` prereleases:

```bash
cd /opt/screentinker
scripts/upgrade.sh              # latest stable release
scripts/upgrade.sh v1.2.3       # or pin one
```

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

**Check the version floor.** `npm start` uses `node --env-file-if-exists=.env`. That flag reached
the Node 22 line only in **22.9.0** — it works on Node 20 because it was separately backported
there. On Node 22.0–22.8 the server refuses to start with `node: bad option`. Target 22.9.0 or
newer.

**One native module has to survive the move.** `better-sqlite3` is compiled against a single Node
ABI, so changing Node invalidates it. Two things make this survivable:

- `lib/preflight-deps.js` runs before anything else at boot, detects the mismatch by *opening a
  database* (a bare `require` succeeds even on a wrong ABI, so it is not a valid check), and repairs
  it with `npm rebuild better-sqlite3`.
- The pinned version ships **prebuilt binaries for both the current and the next Node major**, so
  that repair downloads a binary instead of compiling one.

⚠️ **That second point is why the version is pinned exactly rather than with a caret**, and why
widening it is risky in a way `package.json` does not show. A version with no prebuild for your Node
falls back to a from-source `node-gyp` build — and because preflight rebuilds *synchronously before
the server listens*, a compile that outlives `TimeoutStartSec` turns `Restart=always` into a boot
loop that never finishes. Before changing that pin, check the project's release assets and confirm a
prebuild exists for every Node ABI you intend to run. A build toolchain (`python3`, `make`, `g++`)
should still be present as a fallback.

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

## Traps worth knowing before they bite

**Native modules are built for one Node ABI.** `better-sqlite3` is compiled against the Node that
installed it. Run the app — or its tests — under a different major version and it fails with
`NODE_MODULE_VERSION` mismatch, which presents as hundreds of unrelated test failures rather than
one clear error. Use the same Node the service runs. See [Upgrading Node.js](#upgrading-nodejs)
before changing it deliberately.

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
