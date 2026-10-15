# Upgrading to ScreenTinker 3.0

3.0 is an in-place upgrade from 2.6.x. Your database, screens, pairing codes, content, playlists,
API tokens and players carry over unchanged. No player needs updating. The upgrade has two
prerequisites and one new behaviour you need to know about.

## Before you start

1. **Node.js 22.14 or newer is required, and enforced.** 2.x printed a warning on an older Node and
   then usually crashed. 3.0 refuses to start, prints the version it needs and the binary it is
   running, and exits with code **78**.
   - Check your Node with `node -v`. Also check the Node your service actually runs:
     `systemctl show -p ExecStart screentinker`. A unit with an nvm path in `ExecStart` keeps
     running that old Node whatever `node -v` says.
   - Docker images already ship Node 22. Pull the new image and restart.
   - Upgrade Node first, on the 2.6 release you already run (2.6 works on Node 22). Then upgrade
     ScreenTinker. See "Upgrading Node.js" in [operations.md](operations.md).
   - `ST_ALLOW_OLD_NODE=1` downgrades the refusal to a warning. This is not supported.
2. **Leave room for one copy of your database.** The first 3.0 start takes a snapshot before it
   changes anything (below).

## Upgrading

Use whichever method you used to install. Every path runs the same migrations at startup.

| Install | Command |
|---|---|
| git + systemd (`scripts/upgrade.sh`) | 3.0's `scripts/upgrade.sh` (from 2.6.x, see below). This checks Node, backs up the database, checks out the release, runs `npm ci`, proves the database driver loads, builds the Raspberry Pi player, downloads the release's other player packages (checksum-verified; the APK it replaces is kept as `.bak-pre-<tag>`), then restarts. |
| Instance updater | Choose 3.0 under Platform → System. The updater does not upgrade Node: if it refuses, run `scripts/upgrade.sh` once. |
| Docker / Compose | `docker compose pull && docker compose up -d` |
| Manual | `git fetch --tags && git checkout v3.0.0 && (cd server && npm ci --omit=dev)`, then restart. |

### From 2.6.x on a git install: run 3.0's upgrade script

The copy of `scripts/upgrade.sh` that runs is the one in your checkout, which is 2.6's. It does not check Node, so on Node 20 it would install 3.0 and restart into a server that refuses to start (exit 78). Run 3.0's script against your checkout instead:

```bash
cd /opt/screentinker              # your checkout
git fetch --tags origin
git show v3.0.0:scripts/upgrade.sh > /tmp/st-upgrade-3.0.sh
sudo env NEEDRESTART_SUSPEND=1 NEEDRESTART_MODE=l APP_DIR="$PWD" bash /tmp/st-upgrade-3.0.sh v3.0.0
```

From 3.0 on, `sudo scripts/upgrade.sh` in the checkout is the new script, so later upgrades need nothing special.

⚠️ **Keep the two `NEEDRESTART_*` settings in that command** on Debian/Ubuntu. When the script installs Node 22, apt's needrestart otherwise restarts the server in the middle of the upgrade. The half-installed server then runs npm alongside the upgrade's own `npm ci`, and files go missing from `server/node_modules` (it shows as `Cannot find module` for `stripe`). If that already happened to you, run `npm ci --omit=dev` in `server/` and restart. 3.0.0's script passes the settings through to apt; from 3.0.1 the script sets them itself.

### What happens on the first 3.0 start

1. **Node check** (`server/lib/node-guard.js`). Below 22.14 the server stops here with exit 78.
2. **Pre-upgrade snapshot** (`server/lib/upgrade-snapshot.js`). The database is copied to
   `db/remote_display.pre-upgrade-<time>-from-pre-3.0.db` before any schema change. This happens on
   the first boot of every new version from now on, however the code arrived (git pull, Docker
   pull, `upgrade.sh`). The newest three are kept. If the snapshot cannot be written (disk full,
   permissions), the server refuses to migrate. Set `ST_SKIP_UPGRADE_SNAPSHOT=1` to start without
   a snapshot.
3. **Additive migrations.** These run automatically and need no manual steps:
   - `users.token_version`: session revocation (below).
   - `users.ui_mode` and `users.onboarded_at`: simple menu and first-run guide.
   - A `conversion_events` table. On a hosted instance it records trial-to-paid steps; on a
     self-hosted instance nothing is written.
   - A one-time step marks every account that existed before 3.0 as **onboarded, on the full
     menu**, so nobody who already uses ScreenTinker sees a menu item disappear or gets walked
     through pairing again.

The startup log shows each step. A healthy first start looks like:

```
[boot] Version change (pre-3.0) -> 3.0.0: database snapshot …/remote_display.pre-upgrade-…-from-pre-3.0.db
[migrate] applied 3 new column migration(s)
[migrate] 3.0: 12 existing account(s) kept on the full interface
```

### Rolling back

Stop the server, reinstall 2.6.x, then restore the snapshot:

```
cp db/remote_display.pre-upgrade-<time>-from-pre-3.0.db db/remote_display.db
```

A code-only rollback without the restore also works. The 3.0 columns are additive and 2.6 ignores
them. The one effect: sessions revoked under 3.0 become valid again until they expire.

## Behaviour changes to know about

- **Changing a password or 2FA setting ends your other sessions.** The browser tab that made the
  change stays signed in. An admin resetting someone's password ends that person's sessions.
  Sessions issued by 2.x keep working until the first such change. Settings → Security also has
  "Sign out everywhere else" (`POST /api/auth/sessions/revoke-others`).
- **New accounts start in Simple view**: a guide-style home (add a screen, change what a screen
  shows, upload photos, get help) with no sidebar. In Simple view, pages opened from links show the simple menu. It shows Screens, Content, Playlists, Schedule,
  Templates, Slides, Reports, Members, Settings and Subscription. The **Simple | Advanced** switch at the top
  of the menu shows everything (video walls, layouts, reviews, widgets, kiosk, automation, data
  sources, audience…). The choice is saved per account. Every page still opens from a link or
  bookmark in either mode.
- **New accounts are sent to the first-run guide** from an empty dashboard. People who join a
  workspace that already has screens, and viewers, are not.
- **In the simple menu, adding content to a screen publishes it.** If your workspace requires review
  before publishing, the change is left as a draft for review, exactly as in the full menu.
- **Self-hosted: later sign-ups no longer get a 14-day trial that drops them to the Free plan.** They
  get the enterprise plan, like the first account. To keep the 2.x behaviour (for example, if you use
  plans to ration accounts), set `SELF_HOSTED_SIGNUP_PLAN=trial`. Accounts that already exist keep
  their current plan.
- **Emailed links (verification, password reset, invites) now use `APP_URL`.** Set it to your public
  address, e.g. `APP_URL=https://signage.example.com`. Without it, a hosted instance only trusts
  request hosts listed in `PUBLIC_HOSTS`, and a self-hosted one keeps using the request host. A
  one-time startup warning recommends setting it.
- **`JWT_SECRET` placeholder refused in production.** If `JWT_SECRET` is still the example value
  `set-a-long-random-string`, a `NODE_ENV=production` server refuses to start. A secret shorter than
  32 characters logs a warning. The auto-generated `certs/.jwt_secret` is now created, and corrected
  at boot, with mode 0600.
- **Server-side rendering and imports are stricter** (see the security notes in
  [v3-review.md](v3-review.md)):
  - Widgets and layout zones rendered by the server's Chromium (Roku, BrightSign, e-paper frames)
    can no longer reach private or LAN addresses unless `OUTBOUND_ALLOW_HOSTS` /
    `OUTBOUND_ALLOW_PRIVATE` allow them. The raster renderer already followed this rule.
  - Workspace imports refuse remote URLs that fail the same checks as adding them by hand.
- **The shipped systemd template is now filled in by `scripts/install-service.sh`.** It uses the
  Node on your PATH, not a hard-coded nvm Node 20. All shipped units now carry
  `RestartPreventExitStatus=78`, so a Node refusal stops the service instead of looping. Add that
  line to any unit you wrote yourself.

## New environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ST_ALLOW_OLD_NODE` | unset | `1` starts below the Node floor with a warning (unsupported) |
| `ST_SKIP_UPGRADE_SNAPSHOT` | unset | `1` skips the pre-upgrade database snapshot |
| `UPGRADE_SKIP_PLAYERS` | unset | `1` stops `scripts/upgrade.sh` from downloading the release's player packages (the signed APK and the others), e.g. when you stage the APK by hand |
| `SELF_HOSTED_SIGNUP_PLAN` | `enterprise` | `trial` restores the 2.x self-hosted signup trial |
| `ST_HIDE_SPONSOR` | unset | `true` hides the self-hosted GitHub Sponsors ask (platform admins only; at once after an upgrade, 3 days after a fresh install) |
| `PUBLIC_HOSTS` | unset | Comma-separated hosts trusted for emailed links when `APP_URL` is unset |
