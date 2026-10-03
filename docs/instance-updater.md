# One-click upgrades (the instance updater)

**Platform → System → Update Now** upgrades the whole server to a newer release. The button is
shown only to platform admins, and only when the server knows of a newer release (the GHCR check
under **Check Now**). It never runs on its own: nothing schedules it, and the updater does nothing
until a platform admin presses the button and confirms.

Without the updater installed, the button still works the way it always did: it shows the command
to run on the server by hand.

## How it works

The ScreenTinker server never upgrades itself. It couldn't: a process that recreates its own
container or restarts its own systemd unit is killed partway through. Giving it the rights to try
(`docker.sock`, `sudo`) would also turn every app bug into a root-on-the-host bug.

So the work is split:

1. **The app** writes a request (just a version number) into a spool directory it owns,
   `$DATA_DIR/updater/requests/`.
2. **The updater**, `scripts/updater/st-updater.sh`, runs separately as root. It treats the request
   as untrusted and takes only an `X.Y.Z` that must be newer than the running version; everything
   else comes from its own configuration. It then:
   - backs up the database and checks the copy with `PRAGMA integrity_check`, refusing to go on
     without a good backup;
   - fetches the release (git tag or image);
   - installs it and restarts the server;
   - waits for `/api/status` to report the new version (and, on Docker, a passing healthcheck);
   - **rolls back** to the previous version if the new one does not come up within 4 minutes. The
     database is not restored automatically; the backup path is shown.
3. **The dashboard** polls `GET /api/admin/update-status`, which reads a status directory the
   updater writes and the app can only read. The progress view survives the restart, and the page
   reloads into the new version when the upgrade is done.

Every step and its output appear in the dashboard log. Each queued upgrade is recorded in the
activity log (`admin_trigger_update`).

The updater refuses, changing nothing, if:
- the target version is not newer than the running one;
- there is no such release;
- the database cannot be found or backed up;
- the git checkout has local changes;
- the compose file does not run `ghcr.io/screentinker/screentinker:<version>` exactly once.

## Install: git + systemd

Run from the checkout, as root:

```bash
sudo scripts/updater/install-systemd.sh                    # unit "screentinker"
sudo SERVICE_NAME=remotedisplay scripts/updater/install-systemd.sh
```

It reads the running unit to find the checkout, the service user, the node binary, `DATA_DIR`,
`DB_PATH` and `PORT` (from both `Environment=` and `EnvironmentFile=`), then installs:

| Path | What |
|---|---|
| `/usr/local/lib/screentinker-updater/st-updater.sh` | a root-owned **copy** of the script. Root never runs the repo file, which the app user could edit. |
| `/etc/screentinker-updater.env` | the updater's settings. **Review this after installing.** |
| `/etc/systemd/system/screentinker-updater.{path,service}` | the path unit starts the oneshot service when a request appears |
| `/var/lib/screentinker-updater/` | status and log (root-owned, readable by the app) |
| `$DATA_DIR/updater/requests/` | the only directory the app writes |

Git and `npm ci` run as the checkout's owner, never as root. Only `systemctl restart` runs as
root. The host needs `sqlite3` for the backup (`apt install sqlite3`).

When `scripts/updater/st-updater.sh` changes in a release, re-run the installer to refresh the copy.

Uninstall:

```bash
systemctl disable --now screentinker-updater.path
rm -rf /usr/local/lib/screentinker-updater /etc/screentinker-updater.env \
  /etc/systemd/system/screentinker-updater.* /var/lib/screentinker-updater
```

## Install: Docker

Add the `updater` service from `docker-compose.example.yml` and the `st-updater` volume, mounted
read-only on `screentinker` at `/updater`. Then:

```bash
docker compose build updater && docker compose up -d
```

- The updater holds `docker.sock`, which is root on the host. That is why it is a separate
  container and the app is not.
- Mount the compose file's directory at the **same absolute path** inside the updater, and set
  `COMPOSE_FILE` to that path, so relative bind mounts and `env_file:` resolve the same way they do
  for you.
- If you start the stack with `-p <name>` or `COMPOSE_PROJECT_NAME`, give the updater the same
  `COMPOSE_PROJECT_NAME`. Otherwise it works out the project name from the folder, finds no
  `screentinker` container and refuses.
- On an upgrade it rewrites the `image:` line to the pinned release (`:latest` becomes `:2.3.3`),
  keeps the previous file as `docker-compose.yml.bak-pre-v<version>`, and recreates only the
  `screentinker` service (`--no-deps`).
- It backs up the database inside the app container to `/data/db/pre-v<version>-<stamp>.db`.
- A compose file that runs a locally built image (`image: screentinker:local-…`) is refused.

The dashboard shows **Installed, not running** if the updater container has stopped. It
heartbeats every few seconds.

## Settings

The updater is configured through the environment (the `.env` file or the compose `environment:`):

| Var | Mode | Default |
|---|---|---|
| `UPDATER_MODE` | both | `git` or `docker` (required) |
| `UPDATER_REQUEST_DIR` / `UPDATER_STATUS_DIR` | both | set by the installer / image |
| `STATUS_URL` | both | `http://localhost:3001/api/status` (git), `http://screentinker:3001/api/status` (docker) |
| `VERIFY_TIMEOUT` | both | `240` seconds before rolling back |
| `APP_DIR`, `APP_USER`, `SERVICE_NAME`, `DB`, `BACKUP_DIR`, `NODE_BIN_DIR` | git | from the installer |
| `COMPOSE_FILE`, `APP_SERVICE`, `IMAGE_REPO`, `DB_IN_CONTAINER` | docker | `COMPOSE_FILE` required; `screentinker`, `ghcr.io/screentinker/screentinker`, `/data/db/remote_display.db` |

The app reads `UPDATER_STATUS_DIR` and `UPDATER_REQUEST_DIR` too. You only need to set them to move
those directories from their defaults: `/updater` or `/var/lib/screentinker-updater`, and
`$DATA_DIR/updater/requests`.

## Rolling back by hand

The updater rolls back the code or image, but not the database, because migrations only move
forward and devices keep writing during the upgrade. If you also need the data back, stop the
server and copy the backup named in the dashboard over the live database:

- **Docker:** restore `docker-compose.yml.bak-pre-v<version>`, then `/data/db/pre-v…db`.
- **git:** `git checkout <previous tag>`, `npm ci --omit=dev`, then the backup in `BACKUP_DIR`.
