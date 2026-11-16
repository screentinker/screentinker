# Broadcast streaming in Docker (the "-av" image)

Broadcast view's **stream out** (YouTube, Facebook, Twitch, RTMP, SRT, record to a file, and showing a
running stream on screens) renders the programme in a browser on the server and encodes it with
ffmpeg. The published image (`ghcr.io/screentinker/screentinker:<version>`) has ffmpeg and the
`st-render` user the renderer runs as, but **no browser, no virtual display and no sound server**.
On the stock image the Broadcast page says:

> Streaming out needs a Chromium browser on this server. Install one and set CHROME_PATH, then restart.

The fix is a small image of your own on top of the release, which we call the **-av image**: the
release plus Chromium, Xvfb and PulseAudio. Everything else (the mixer desk, scenes, graphics,
cameras, guests) works on the stock image; only stream out and recording need this.

Broadcast is available on self-hosted servers (`SELF_HOSTED=true`), which every Docker install is.

## What each package is for

| Package | Used for | Without it |
|---|---|---|
| `chromium` | renders the programme (`CHROME_PATH`) | stream out unavailable (`no_browser`) |
| `xvfb` | a virtual display per stream, grabbed by ffmpeg's `x11grab` | falls back to the slower screencast capture |
| `pulseaudio`, `pulseaudio-utils` | the stream's sound: the renderer plays into a sink the mixer reads | streams go out silent |
| `fonts-liberation` | metric-compatible fonts for text in the programme | text in fallback fonts |
| `ffmpeg` | encoding (already in the release image) | stream out unavailable (`no_ffmpeg`) |

## 1. Build it

Make a directory next to your compose file, for example `builds/3.2.1-av/`, with this `Dockerfile`:

```dockerfile
# The ScreenTinker release image plus Chromium, Xvfb and PulseAudio for Broadcast stream out.
ARG VERSION=3.2.1
FROM ghcr.io/screentinker/screentinker:${VERSION}
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation pulseaudio pulseaudio-utils xvfb \
 && apt-get clean && find /var/lib/apt/lists -type f -delete
ENV CHROME_PATH=/usr/bin/chromium
```

Build and tag it with the release version and an `-av` suffix, so it never gets confused with the
published image:

```bash
docker pull ghcr.io/screentinker/screentinker:3.2.1
docker build --build-arg VERSION=3.2.1 -t screentinker:3.2.1-av builds/3.2.1-av
```

Check it before you switch to it:

```bash
docker run --rm --entrypoint sh screentinker:3.2.1-av -c \
  'cat /app/VERSION; chromium --version; pulseaudio --version; id st-render; ffmpeg -hide_banner -devices | grep x11grab'
```

You should see the version, a Chromium version, `pulseaudio 16.x`, the `st-render` user and an
`x11grab` line. The -av image is about 0.7 GB larger than the release (3.2.1: 1.38 GB, 2.05 GB with
the additions).

## 2. Switch to it

Back up first. Migrations only go forward, so the database copy is the only way back. (Run these
from the directory with your compose file; `screentinker` is the service name in
`docker-compose.example.yml`.)

```bash
cp -a docker-compose.yml docker-compose.yml.bak-pre-3.2.1
docker compose exec screentinker node -e 'new (require("better-sqlite3"))("/data/db/remote_display.db",{readonly:true}).exec("VACUUM INTO \x27/data/db/pre-3.2.1.db\x27")'
```

Then point the service at the new image. Keep `init: true` (it is in `docker-compose.example.yml`):
each stream's renderer leaves a few processes behind when it stops, and the init collects them.

```yaml
services:
  screentinker:
    image: screentinker:3.2.1-av      # was ghcr.io/screentinker/screentinker:3.2.1
    init: true
    environment:
      SELF_HOSTED: "true"
```

```bash
docker compose up -d --force-recreate screentinker
docker compose ps screentinker                                # wait for "(healthy)"
curl -s localhost:3001/api/status                             # "version":"3.2.1"
```

In the dashboard, **Broadcast → Stream out** now offers outputs instead of the "needs a Chromium
browser" note. `GET /api/stream-out` (signed in) answers `"available": true, "reason": null`; if it
still says `no_browser` or `no_ffmpeg`, the container is not running the image you built.

## 3. Upgrading

The -av image is pinned to one release, so **rebuild it for every upgrade**: change `VERSION` (and
the directory name, if you keep one per release), build, back up, switch, as above. Pulling a new
release image alone changes nothing while compose still names the old -av tag.

⚠️ The dashboard's **Update now** button (the instance updater) refuses to run on a locally built
image: it only knows how to move between published release images. Upgrade -av installs by hand
with the steps above.

To roll back, restore the compose backup and the database copy, then `docker compose up -d`.

## Notes

- **Licences.** ScreenTinker itself bundles no GPL code. Chromium, PulseAudio, Xvfb and ffmpeg are
  system packages you install into your own image, under their own licences; the Broadcast page
  shows the notice for the ffmpeg build it finds.
- **The renderer's user.** When the server runs as root (as it does in the image) and the
  `st-render` user exists, the browser runs as `st-render`, so a compromised page cannot read the
  database, keys or uploads. `STREAM_RENDER_USER=""` turns this off; leave it on.
- **Capture mode.** With Xvfb and an ffmpeg that has `x11grab`, each stream gets its own virtual
  display. Set `STREAM_OUT_CAPTURE=screencast` to force the browser's screencast capture instead
  (no Xvfb needed).
- **Resources.** Each running stream is its own browser plus an ffmpeg encoder, so size the host for
  the number of streams you run at once and watch CPU on the first one.
- **Without Docker** (systemd installs): install the same packages on the host
  (`apt-get install chromium fonts-liberation pulseaudio pulseaudio-utils xvfb ffmpeg`), set
  `CHROME_PATH=/usr/bin/chromium` in the service's environment, and restart.
