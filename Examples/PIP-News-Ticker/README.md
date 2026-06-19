# PIP News Ticker

A scrolling RSS/Atom headline ticker pushed to a ScreenTinker screen (or group) via the
PiP overlay API. Polls any feed, extracts the latest headlines, and renders a continuous
right-to-left strip along the bottom of the screen. Keyless and zero-dependency.

```
RSS/Atom feed ──poll──> news.js ──POST /api/pip (type:web)──> player
                          │                                     │
                  parse headlines                    iframe loads news-overlay.html
                  join with separator                scrolls the strip seamlessly
```

The overlay is **persistent** (`duration: 0`) and refreshed on every poll (the player keeps a
single overlay slot, last-show-wins), so headlines update in place. The ticker is cleared when
you stop the script (Ctrl-C).

## Files

| File | Purpose |
|------|---------|
| `news.js` | Poller + PiP pusher. Hand-rolled RSS/Atom parser (`parseHeadlines`, `feedLabel`). |
| `news-overlay.html` / `news-overlay.js` | The strip overlay. Served same-origin; reads `?text`/`?label`/`?sep`; external JS (no inline) so the server CSP allows it. |
| `config.example.json` | Copy to `config.json` and fill in. |
| `fixture-feed.xml`, `test.js` | Offline test (no network). |

## Setup

1. **Host the overlay.** Copy both overlay files into the signage server's web root so they're
   served from the same origin as the player (the server applies `Content-Security-Policy:
   script-src 'self'`, which is why the JS is external rather than inline):

   ```sh
   cp news-overlay.html news-overlay.js /path/to/screentinker/frontend/
   ```

   They'll be reachable at `https://<your-server>/news-overlay.html`.

2. **Create an API token** with the `full` scope (PiP is a fleet-affecting, full-trust action).

3. **Configure.** Copy `config.example.json` to `config.json` and set `api_base`, `api_token`,
   `overlay_base_url`, `device_id` (a device **or** group id), and your `feed_url`. Optional:
   `label` (left chip text; defaults to the feed's channel title), `max_items`, `separator`,
   `poll_interval_sec`, and overlay geometry (`position`, `width`, `height`).

4. **Run.**

   ```sh
   npm start         # or: node news.js
   ```

   Stop with Ctrl-C to clear the ticker.

## Local quick-start (self-signed dev server)

Against a local ScreenTinker dev instance with a self-signed certificate:

```sh
cp news-overlay.html news-overlay.js /path/to/screentinker/frontend/

cat > config.json <<'JSON'
{
  "api_base": "https://localhost:3443/",
  "api_token": "st_REPLACE_WITH_A_FULL_SCOPE_TOKEN",
  "overlay_base_url": "https://localhost:3443/news-overlay.html",
  "device_id": "DEVICE_OR_GROUP_ID",
  "feed_url": "https://feeds.bbci.co.uk/news/rss.xml",
  "position": "bottom-right",
  "width": 1200,
  "height": 90,
  "poll_interval_sec": 300
}
JSON

NODE_TLS_REJECT_UNAUTHORIZED=0 node news.js
```

`NODE_TLS_REJECT_UNAUTHORIZED=0` is only for trusting the dev box's self-signed cert — don't
use it against production.

## Test

```sh
npm test
```

Runs `test.js` against `fixture-feed.xml` (offline): verifies headline extraction order,
CDATA/entity decoding, `max_items` capping, channel-title labelling, and overlay-URI round-trip.
Prints `RESULT: PASS ✅`.

## Notes

- The parser handles RSS (`<item><title>`) and Atom (`<entry><title>`), decodes CDATA and common
  XML entities, and strips stray markup from titles. It's deliberately tolerant rather than a full
  XML parser, so it copes with the messy real-world feeds you'll point it at.
- Headline text is rendered with `textContent` only — feed content is never injected as HTML.
