# PiP Incident Webhook

An **event-driven** PiP example: a tiny webhook receiver that turns your monitoring
stack's alerts into a floating ScreenTinker overlay — perfect for an engineering wall
TV or NOC screen.

- alert **firing**  → red overlay appears (kept until cleared)
- alert **resolved** → overlay disappears

Unlike the CAP / NOAA examples (which *poll* a feed), nothing happens here until your
alerting system **pushes** to `POST /webhook`. Zero runtime dependencies — just Node 18+
(`http` + global `fetch`).

## Payload shapes

It accepts either:

**Generic** (great for `curl`, cron jobs, custom scripts):
```json
{ "status": "firing", "key": "db-down", "title": "Primary DB unreachable", "detail": "conn refused on 5432", "severity": "critical" }
```

**Prometheus Alertmanager** (point a `webhook_config` straight at it):
```json
{ "status": "firing", "alerts": [
  { "status": "firing", "fingerprint": "abc123",
    "labels": { "alertname": "HighCPU", "severity": "warning", "instance": "web-1" },
    "annotations": { "summary": "CPU > 90%", "description": "web-1 hot for 5m" } }
]}
```

`severity` drives the band colour: `critical`→dark red, `warning`→orange, `info`→amber,
anything else→red. The `key` (or Alertmanager `fingerprint`) is what matches a later
*resolve* back to the overlay it should clear.

## Setup

1. `cp config.example.json config.json` and fill in:
   - `api_token` — an `st_` API token with the **`full`** scope.
   - `api_base` / `overlay_base_url` — your signage server.
   - `device_id` — a device **or** group id.
   - `shared_secret` *(optional)* — if set, callers must send it as the `X-Webhook-Secret`
     header or `?secret=` query param.
2. **Serve the overlay assets.** The overlay is a `web` PiP rendered in an iframe, so the
   player fetches `overlay_base_url` directly. Copy `incident-overlay.html` and
   `incident-overlay.js` into the directory your signage server serves at the web root
   (e.g. the server's `frontend/` dir) so that `https://<server>/incident-overlay.html`
   resolves. They must be **same-origin** with the player (the server CSP only allows
   same-origin scripts — that's why the JS is an external `incident-overlay.js`, not inline).
3. `node server.js` (or `npm start`).

## Local quick-start (this repo's dev server)

```bash
cp config.example.json config.json
# edit config.json:
#   "api_base":          "https://localhost:3443/"
#   "api_token":         "st_REPLACE_WITH_A_FULL_SCOPE_TOKEN"
#   "overlay_base_url":  "https://localhost:3443/incident-overlay.html"
#   "device_id":         "DEVICE_OR_GROUP_ID"

# copy the overlay assets into the server's web root (served same-origin as the player):
cp incident-overlay.html incident-overlay.js ../../frontend/

# self-signed cert on localhost -> let Node accept it:
NODE_TLS_REJECT_UNAUTHORIZED=0 node server.js
```

Then drive it with `curl`:

```bash
# fire a critical incident -> red overlay appears on the player
curl -s localhost:8088/webhook -H 'Content-Type: application/json' -d \
  '{"status":"firing","key":"db-down","title":"Primary DB unreachable","detail":"conn refused on 5432","severity":"critical"}'

# ...later, resolve it -> overlay clears
curl -s localhost:8088/webhook -H 'Content-Type: application/json' -d \
  '{"status":"resolved","key":"db-down"}'

# health
curl -s localhost:8088/healthz
```

`Ctrl-C` clears any still-showing overlays before exiting.

> Heads-up: this dev box has a shared player. If someone else is demoing on
> `d7c88aa0-…`, point `device_id` at your own device/group instead.

## Wire up Alertmanager

```yaml
# alertmanager.yml
route:
  receiver: signage
receivers:
  - name: signage
    webhook_configs:
      - url: http://YOUR_HOST:8088/webhook
        send_resolved: true        # so "resolved" clears the overlay
```

If you set a `shared_secret`, append it to the URL: `...:8088/webhook?secret=YOUR_SECRET`.

## Test

```bash
npm test   # offline; exercises both payload shapes + the colour map
```
