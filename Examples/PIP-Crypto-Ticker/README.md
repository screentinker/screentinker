# PiP Crypto Ticker

A live cryptocurrency **price ticker** for ScreenTinker screens. Polls
[CoinGecko](https://www.coingecko.com/en/api)'s keyless `simple/price` endpoint and
pushes a wide ticker-strip overlay via the **PiP API**. Each poll refreshes the same
overlay in place; prices update without a flash.

No API key required. Zero runtime dependencies (Node 18+ global `fetch`).

```
┌────────────────────────────────────────────────────────────────┐
│ BTC $64,012.34 ▲ +1.23%  •  ETH $3,380.10 ▼ -0.46%  •  SOL …     │
└────────────────────────────────────────────────────────────────┘
```

## How it works

1. `ticker.js` fetches `GET /api/v3/simple/price?ids=…&vs_currencies=…&include_24hr_change=true`.
2. It normalises the response into ordered items and encodes them compactly into the
   overlay URL's query string (`items=BTC:64012.34:+1.23,…`).
3. It pushes a `type: "web"` PiP overlay (`duration: 0`, i.e. persistent) pointing at
   `ticker-overlay.html`, which renders the strip. Up = green ▲, down = red ▼, flat = grey.
4. On the next poll it pushes again — the player keeps a single overlay slot
   (last-show-wins), so the numbers refresh in place.
5. `Ctrl-C` (SIGINT) clears the overlay.

## Files

| file | purpose |
|------|---------|
| `ticker.js` | poller + PiP pusher (and the pure, exported normaliser/encoder) |
| `ticker-overlay.html` / `ticker-overlay.js` | the overlay page (served by the signage server) |
| `config.example.json` | copy to `config.json` and fill in |
| `fixture-prices.json` | a saved CoinGecko response for the offline test |
| `test.js` | offline test — no network, no PiP push |

## Setup

The overlay page must be served **same-origin** with the signage server (the player
loads it in an iframe, and the server CSP only allows same-origin scripts). Copy the
two overlay files into the server's static frontend directory:

```sh
cp ticker-overlay.html ticker-overlay.js /path/to/screentinker/frontend/
```

Then they're reachable at `https://<your-server>/ticker-overlay.html`.

Create a **full-scope** `st_` API token in the dashboard (Settings → API tokens), then:

```sh
cp config.example.json config.json
# edit config.json: api_base, api_token, overlay_base_url, device_id, coins
node ticker.js
```

`device_id` may be a single device **or** a device group id.

### Config

| key | meaning |
|-----|---------|
| `api_base` | signage server base URL |
| `api_token` | full-scope `st_` token |
| `overlay_base_url` | URL of the served `ticker-overlay.html` |
| `device_id` | target device or group id |
| `vs_currency` | `usd`, `eur`, `gbp`, … |
| `coins` | array of `{ id, symbol }` — `id` is the CoinGecko id |
| `poll_interval_sec` | refresh cadence (default 120; respect CoinGecko rate limits) |
| `position` | `bottom-right` (default), `top-left`, … |
| `width` / `height` | overlay box px (default 1100×110) |

## Local quick-start (this machine)

A local ScreenTinker instance is already running on `https://localhost:3443` with a
paired web player (device `DEVICE_OR_GROUP_ID`). It uses a self-signed
cert, so set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

```sh
# 1. serve the overlay assets from the local frontend dir
cp ticker-overlay.html ticker-overlay.js /home/owner/Downloads/remote_display/frontend/

# 2. config.json
cat > config.json <<'JSON'
{
  "api_base": "https://localhost:3443/",
  "api_token": "st_REPLACE_WITH_A_FULL_SCOPE_TOKEN",
  "overlay_base_url": "https://localhost:3443/ticker-overlay.html",
  "device_id": "DEVICE_OR_GROUP_ID",
  "vs_currency": "usd",
  "coins": [
    { "id": "bitcoin",  "symbol": "BTC" },
    { "id": "ethereum", "symbol": "ETH" },
    { "id": "solana",   "symbol": "SOL" }
  ],
  "poll_interval_sec": 120,
  "position": "bottom-right"
}
JSON

# 3. run
NODE_TLS_REJECT_UNAUTHORIZED=0 node ticker.js
```

## Test (offline)

```sh
npm test
```

Validates price/percent formatting, up/down/flat direction, and that the compact
`items` encoding round-trips through the overlay's decoder. Prints `RESULT: PASS ✅`.
