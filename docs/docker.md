# Running ScreenTinker with Docker

The release image, `ghcr.io/screentinker/screentinker:<version>` (amd64 and arm64), is the
simplest way to self-host. It holds the server, the dashboard, the web player, ffmpeg for video
thumbnails, and the Raspberry Pi player package it offers for download. All state lives in one
volume at `/data`.

This guide covers a first install, configuration, putting it behind HTTPS, serving the Android
APK, backups and upgrades. For a git + systemd install instead, see the README's
Production Deployment section.

## 1. First start

You need Docker with the Compose plugin (`docker compose version`). Then:

```bash
mkdir -p /opt/screentinker && cd /opt/screentinker
curl -fsSLO https://raw.githubusercontent.com/screentinker/screentinker/main/docker-compose.example.yml
cp docker-compose.example.yml docker-compose.yml
```

**Pin the version.** The example says `:latest`; change it to the release you want, so the server
never changes under you on a `docker compose pull`:

```yaml
    image: ghcr.io/screentinker/screentinker:3.2.1
```

Start it:

```bash
docker compose up -d
docker compose ps          # wait for "(healthy)"; the first boot runs database migrations
curl -s localhost:3001/api/status
```

Open `http://<server>:3001` and **register**. With `SELF_HOSTED=true` (set in the example) the
first account is the platform admin and there is no billing.

## 2. Configuration

The server reads its **process environment**. In Docker that means the service's `environment:`
block, or an `env_file:` next to it. A `.env` file is not read by the server itself.

```yaml
services:
  screentinker:
    environment:
      SELF_HOSTED: "true"
      APP_URL: "https://signage.example.com"   # the public address used in emailed links
    # or keep secrets out of the compose file:
    env_file: ./screentinker.env
```

The full list, with what each does, is in [`.env.example`](../.env.example). The ones most installs
set:

| Variable | What it does |
|---|---|
| `SELF_HOSTED` | `true`: first user is admin, no billing, no hosted signup mail. |
| `APP_URL` | The public URL. Without it, emailed links (verification, reset, invites) use whatever host a request claims. |
| `EMAIL_TRANSPORT=smtp` with `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Outgoing mail (verification, password reset, invites, alerts). |
| `DISABLE_HOMEPAGE` | `true`: `/` goes straight to the app instead of the landing page. |
| `TERMS_URL`, `PRIVACY_URL` | Self-hosted: your own terms of use and privacy policy; `/legal/terms` and `/legal/privacy` redirect there. Unset: a neutral page saying the instance is run by you (screentinker.com's terms are never shown on a self-hosted server). |
| `HIDE_BILLING` | `true`: hide the billing pages in the dashboard (display only). |
| `OUTBOUND_ALLOW_HOSTS` | LAN addresses the server may fetch (calendars, data sources, webhooks). Private ranges are refused by default; see [outbound-requests.md](outbound-requests.md). |
| `JWT_SECRET` | Leave unset. One is generated on first boot and kept in the volume; changing it later signs everyone out and makes saved secrets unreadable. |

Restart after a change: `docker compose up -d` (Compose recreates the container when its
configuration changed).

## 3. What is in `/data`

The `st-data` named volume holds everything that must survive an upgrade:

| Path | Contents |
|---|---|
| `/data/db/remote_display.db` | the SQLite database (WAL mode: also `-wal` and `-shm` files) |
| `/data/uploads/` | uploaded content and screenshots |
| `/data/certs/` | the generated JWT secret and other keys |
| `/data/plugins/` | your own plugins, if you enable them |

Recreating or upgrading the container never touches the volume. `docker compose down -v` **deletes
it**; never use `-v` on a real install.

## 4. HTTPS and a reverse proxy

The container serves plain HTTP on 3001. In production put a TLS-terminating proxy in front of it.
Two things matter:

- **WebSockets.** Screens and the dashboard keep a Socket.IO connection open. The proxy must pass
  `Upgrade` and `Connection` headers and allow long-lived connections.
- **Upload size.** Raise the proxy's body limit, or large videos fail to upload.

nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name signage.example.com;
    ssl_certificate     /etc/ssl/signage.pem;
    ssl_certificate_key /etc/ssl/signage.key;
    client_max_body_size 500M;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

Caddy (certificates included):

```
signage.example.com {
    request_body {
        max_size 500MB
    }
    reverse_proxy 127.0.0.1:3001
}
```

The server trusts `X-Forwarded-For` from loopback, link-local and private (LAN) addresses, including
Docker's bridge networks, and from Cloudflare's
published ranges, so client IPs in logs and rate limits are right behind any of those. With the
proxy on the same host you can publish the port on loopback only: `ports: ["127.0.0.1:3001:3001"]`.

## 5. Serving the Android APK

Android screens update themselves from `/download/apk`. Download `ScreenTinker.apk` from the
release you run (it is attached to every GitHub release) and mount it:

```yaml
    volumes:
      - st-data:/data
      - ./ScreenTinker.apk:/data/ScreenTinker.apk:ro
```

The server reads the APK's version out of the file itself, and screens on an older version are
offered the update.

⚠️ **Replace it in place** when you upgrade, never with `mv` or `cp` over it: the container holds
the bind-mounted file's inode and keeps serving the old bytes after a replace, with nothing in any
log. Then restart:

```bash
cat ~/Downloads/ScreenTinker.apk > /opt/screentinker/ScreenTinker.apk   # same inode
docker compose restart screentinker
curl -s 'localhost:3001/api/update/check?version=1.0.0'   # "latest_version" is the new APK
```

The Raspberry Pi player package (`/download/pi`) is already inside the image; there is nothing to
mount for it.

## 6. Backups

The database is the one thing to back up carefully: copying the file while the server writes to it
can give a broken copy. Let SQLite make a consistent one:

```bash
docker compose exec screentinker node -e 'new (require("better-sqlite3"))("/data/db/remote_display.db",{readonly:true}).exec("VACUUM INTO \x27/data/db/backup-" + new Date().toISOString().slice(0,10) + ".db\x27")'
```

That writes the copy into the volume. To take everything off the host (database copy, uploads,
keys), archive the volume:

```bash
docker run --rm -v screentinker_st-data:/data:ro -v "$PWD":/out debian:12-slim \
  tar czf /out/st-data-$(date +%F).tgz -C /data .
```

The volume's full name is `<project>_st-data`, where the project is the compose directory's name
(`screentinker` for `/opt/screentinker`); `docker volume ls` shows it.

## 7. Upgrading

Read the release notes first, then:

```bash
cd /opt/screentinker
cp -a docker-compose.yml docker-compose.yml.bak-pre-3.2.2
docker compose exec screentinker node -e 'new (require("better-sqlite3"))("/data/db/remote_display.db",{readonly:true}).exec("VACUUM INTO \x27/data/db/pre-3.2.2.db\x27")'
sed -i 's|screentinker/screentinker:3.2.1|screentinker/screentinker:3.2.2|' docker-compose.yml
docker compose pull && docker compose up -d
docker compose ps && curl -s localhost:3001/api/status
```

Migrations run at boot and only go forward, so the database copy is your way back. To roll back,
restore the compose backup, stop the container, put the copy back as `remote_display.db` (removing
its `-wal` and `-shm` files), and `docker compose up -d`. Update the mounted APK as in section 5.

**One-click upgrades.** The optional `updater` service in the example compose file lets a platform
admin upgrade from **Platform → System → Update now**: it backs up the database, pins the new
release, recreates the app and rolls back if it does not come up healthy. It never upgrades on its
own. It holds `docker.sock`, which is root on the host; read
[instance-updater.md](instance-updater.md) before enabling it.

## 8. Optional pieces

- **Live video** (sub-second camera and screen view): the `go2rtc` sidecar in the example compose
  file. See [live-video.md](live-video.md).
- **Broadcast stream out and recording** need Chromium, Xvfb and PulseAudio, which the release
  image does not include. See [broadcast-docker.md](broadcast-docker.md) for the small image that
  adds them.
- **BrightSign players** provisioned from this server: mount the BrightSign archives from the
  release into `/app/scripts/` (`autorun.zip`, `autorun-server.zip`, `server-payload.zip`,
  `server-payload.json`). They are served at `/scripts/<name>`.

## 9. Day-to-day

```bash
docker compose logs -f screentinker              # logs (add ACCESS_LOG: "true" for HTTP access lines)
docker compose exec screentinker node ../scripts/reset-admin.js   # locked out: a one-hour admin token
docker compose restart screentinker
```

**Troubleshooting**

- *Unhealthy right after an upgrade:* `docker compose logs screentinker` shows migrations and any
  error. The first boot after an upgrade can take longer than `start_period` on a large database.
- *Screens connect, then drop every few seconds:* the proxy is not passing WebSocket upgrades, or
  its read timeout is short (section 4).
- *Emailed links point at the wrong address:* set `APP_URL`.
- *Calendars or data sources on your LAN say "The address is not allowed":* set
  `OUTBOUND_ALLOW_HOSTS`.
- *A setting has no effect:* check it reached the container with
  `docker compose exec screentinker printenv | grep <NAME>`. A `.env` file is not read by the server.
