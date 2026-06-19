'use strict';

// Crypto price ticker -> ScreenTinker PiP overlay.
//
// Polls CoinGecko's keyless simple/price endpoint and pushes a wide "ticker strip"
// web overlay to a device or group. Each poll refreshes the same overlay slot
// (last-show-wins on the player), so prices update in place. The overlay is
// persistent (duration 0) and is cleared on SIGINT/SIGTERM.
//
//   node ticker.js [path/to/config.json]
//
// Node 18+ (global fetch). Needs an st_ API token with the 'full' scope.

const fs = require('fs');
const path = require('path');

// ---- pure helpers (exported for offline tests) --------------------------------

const CUR_SYMBOL = { usd: '$', eur: '€', gbp: '£', jpy: '¥', aud: 'A$', cad: 'C$' };

// Decimals scale with magnitude: cheap coins need more precision than BTC.
function priceDecimals(p) {
  const a = Math.abs(Number(p) || 0);
  if (a >= 1) return 2;
  if (a >= 0.01) return 4;
  return 6;
}

// Group the integer part with thousands separators; keep the fractional part as-is.
function addThousands(numStr) {
  const neg = numStr.startsWith('-');
  const s = neg ? numStr.slice(1) : numStr;
  const [int, frac] = s.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped + (frac != null ? '.' + frac : '');
}

// Raw (delimiter-safe) numeric price string: fixed decimals, NO thousands commas.
function priceRaw(p) { return (Number(p) || 0).toFixed(priceDecimals(p)); }

// Display price string: thousands-separated.
function formatPrice(p) { return addThousands(priceRaw(p)); }

// Signed change, 2 decimals, no % (compact for the query). e.g. "+1.23", "-0.45".
function signedChange(c) {
  const n = Number(c) || 0;
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

// Display change with % suffix. e.g. "+1.23%".
function formatChange(c) { return signedChange(c) + '%'; }

// Direction from the rounded 2-decimal change, so it matches what's displayed.
function dirOf(c) {
  const r = Number((Number(c) || 0).toFixed(2));
  if (r > 0) return 'up';
  if (r < 0) return 'down';
  return 'flat';
}

// CoinGecko simple/price response -> normalised items, preserving config coin order.
//   raw[coinId][vs] = price ; raw[coinId][vs+"_24h_change"] = pct change
function normalise(raw, opts = {}) {
  const vs = (opts.vs_currency || 'usd').toLowerCase();
  const coins = opts.coins || [];
  const out = [];
  for (const coin of coins) {
    const entry = raw && raw[coin.id];
    if (!entry || entry[vs] == null) continue;
    const price = Number(entry[vs]);
    const change = Number(entry[`${vs}_24h_change`]) || 0;
    out.push({
      symbol: coin.symbol || coin.id.toUpperCase(),
      price,
      priceStr: formatPrice(price),
      change24h: change,
      changeStr: formatChange(change),
      dir: dirOf(change),
    });
  }
  return out;
}

// Compact, comma/colon-delimited encoding for the overlay query string.
//   "BTC:64012.34:+1.23,ETH:3380.10:-0.45"
function encodeItems(items) {
  return items.map(i => `${i.symbol}:${priceRaw(i.price)}:${signedChange(i.change24h)}`).join(',');
}

// Inverse of encodeItems — mirrors the parser in ticker-overlay.js. Returns the
// display-ready shape so a test can prove the round-trip survives.
function decodeItems(s) {
  if (!s) return [];
  return s.split(',').filter(Boolean).map(tok => {
    const [symbol, priceRawStr, chg] = tok.split(':');
    return {
      symbol,
      priceStr: addThousands(priceRawStr),
      changeStr: chg + '%',
      dir: dirOf(parseFloat(chg)),
    };
  });
}

// ---- live runner --------------------------------------------------------------

function cgUrl(coins, vs) {
  const ids = coins.map(c => c.id).join(',');
  const q = new URLSearchParams({ ids, vs_currencies: vs, include_24hr_change: 'true' });
  return `https://api.coingecko.com/api/v3/simple/price?${q.toString()}`;
}

function overlayUri(base, items, vs) {
  const q = new URLSearchParams({ items: encodeItems(items), cur: vs });
  return `${base}${base.includes('?') ? '&' : '?'}${q.toString()}`;
}

async function main() {
  const configPath = process.argv[2] || path.join(__dirname, 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { console.error(`Could not read config at ${configPath}: ${e.message}`); process.exit(1); }

  const API_BASE = (cfg.api_base || '').replace(/\/$/, '');
  const API_TOKEN = cfg.api_token;
  const OVERLAY_BASE = cfg.overlay_base_url;
  const DEVICE = cfg.device_id;
  const COINS = cfg.coins || [];
  const VS = (cfg.vs_currency || 'usd').toLowerCase();
  const POLL_SEC = cfg.poll_interval_sec || 120;
  const POS = cfg.position || 'bottom-right';
  const WIDTH = cfg.width || 1100;
  const HEIGHT = cfg.height || 110;

  if (!API_BASE || !API_TOKEN || !OVERLAY_BASE || !DEVICE || COINS.length === 0) {
    console.error('config must set api_base, api_token, overlay_base_url, device_id, and at least one coin.');
    process.exit(1);
  }

  let pipId = null;

  async function show(items) {
    const body = {
      device_id: DEVICE, type: 'web', uri: overlayUri(OVERLAY_BASE, items, VS),
      position: POS, width: WIDTH, height: HEIGHT, duration: 0,
      opacity: cfg.opacity != null ? cfg.opacity : 1,
      border_radius: cfg.border_radius != null ? cfg.border_radius : 14,
      close_button: false,
    };
    const res = await fetch(`${API_BASE}/api/pip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.pip_id) throw new Error(`pip show failed (${res.status}): ${json.error || 'unknown'}`);
    pipId = json.pip_id;
    return items;
  }

  async function clear() {
    if (!pipId) return;
    try {
      await fetch(`${API_BASE}/api/pip/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
        body: JSON.stringify({ device_id: DEVICE, pip_id: pipId }),
      });
    } catch { /* best effort */ }
  }

  async function tick() {
    let raw;
    try {
      const res = await fetch(cgUrl(COINS, VS), { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
      raw = await res.json();
    } catch (e) { console.error(`[${new Date().toISOString()}] fetch error: ${e.message}`); return; }

    const items = normalise(raw, { coins: COINS, vs_currency: VS });
    if (items.length === 0) { console.error(`[${new Date().toISOString()}] no prices for configured coins`); return; }
    try {
      await show(items);
      const line = items.map(i => `${i.symbol} ${CUR_SYMBOL[VS] || ''}${i.priceStr} ${i.changeStr}`).join('  |  ');
      console.log(`[${new Date().toISOString()}] SHOW ticker pip=${pipId} :: ${line}`);
    } catch (e) { console.error(`[${new Date().toISOString()}] show error: ${e.message}`); }
  }

  console.log(`Crypto ticker starting — ${COINS.map(c => c.symbol).join(', ')} in ${VS.toUpperCase()}, poll every ${POLL_SEC}s`);
  await tick();
  const timer = setInterval(tick, POLL_SEC * 1000);

  async function shutdown() {
    clearInterval(timer);
    console.log('\nclearing ticker overlay before exit...');
    await clear();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  priceDecimals, addThousands, priceRaw, formatPrice,
  signedChange, formatChange, dirOf, normalise, encodeItems, decodeItems,
  cgUrl, overlayUri,
};

if (require.main === module) main();
