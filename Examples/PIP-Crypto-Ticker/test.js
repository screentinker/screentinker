'use strict';

// Offline test: no network, no PiP push. Proves the normaliser formats prices and
// changes, derives direction from the 24h change, and that the compact items
// encoding round-trips through the overlay's decoder.

const fs = require('fs');
const t = require('./ticker');

const raw = JSON.parse(fs.readFileSync('./fixture-prices.json', 'utf8'));
const coins = [
  { id: 'bitcoin', symbol: 'BTC' },
  { id: 'ethereum', symbol: 'ETH' },
  { id: 'solana', symbol: 'SOL' },
  { id: 'cardano', symbol: 'ADA' },
];

const items = t.normalise(raw, { coins, vs_currency: 'usd' });

console.log('Normalised ticker items:\n');
for (const i of items) {
  console.log(`• ${i.symbol}  ${i.priceStr}  ${i.changeStr}  (${i.dir})`);
}

const encoded = t.encodeItems(items);
const decoded = t.decodeItems(encoded);
console.log(`\nencoded: ${encoded}\n`);

function eq(a, b, msg) { if (a !== b) { console.error(`  ✗ ${msg}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); return false; } return true; }

let ok = true;
// order + count preserved
ok = eq(items.length, 4, 'item count') && ok;
ok = eq(items.map(i => i.symbol).join(','), 'BTC,ETH,SOL,ADA', 'symbol order') && ok;

// formatting: thousands separators, decimal precision by magnitude
ok = eq(items[0].priceStr, '64,012.34', 'BTC thousands+2dp') && ok;
ok = eq(items[0].changeStr, '+1.23%', 'BTC change sign') && ok;
ok = eq(items[0].dir, 'up', 'BTC dir') && ok;

ok = eq(items[1].priceStr, '3,380.10', 'ETH trailing zero') && ok;
ok = eq(items[1].dir, 'down', 'ETH dir (negative)') && ok;

// near-zero change rounds to flat
ok = eq(items[2].changeStr, '+0.00%', 'SOL ~0 change') && ok;
ok = eq(items[2].dir, 'flat', 'SOL dir flat') && ok;

// sub-$1 coin gets extra decimals, no thousands grouping
ok = eq(items[3].priceStr, '0.3821', 'ADA 4dp sub-dollar') && ok;
ok = eq(items[3].dir, 'down', 'ADA dir') && ok;

// round-trip: decoded display fields match the normaliser's
ok = eq(decoded.length, items.length, 'decoded count') && ok;
for (let k = 0; k < items.length; k++) {
  ok = eq(decoded[k].symbol, items[k].symbol, `rt[${k}] symbol`) && ok;
  ok = eq(decoded[k].priceStr, items[k].priceStr, `rt[${k}] priceStr`) && ok;
  ok = eq(decoded[k].changeStr, items[k].changeStr, `rt[${k}] changeStr`) && ok;
  ok = eq(decoded[k].dir, items[k].dir, `rt[${k}] dir`) && ok;
}

console.log('\nRESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
