'use strict';

// Offline test. No network, no player. Covers:
//   - qr.js pure helpers (entry validation, overlay-uri build/round-trip, rotation wrap)
//   - the embedded QR encoder's Reed-Solomon core, checked against the published QR
//     generator polynomials (degree 7 and 10) — this catches GF(256) math errors without
//     needing a QR decoder — plus structural invariants of a generated matrix.
const { validateEntries, overlayUri, nextIndex } = require('./qr');
const QR = require('./qr-overlay');

let ok = true;
function check(name, cond) { console.log(`${cond ? '•' : '✗'} ${name}`); if (!cond) ok = false; }

// ---- qr.js pure helpers ----
const v = validateEntries([
  { label: 'A', data: 'https://x.test/1' },
  { label: 'B', data: '   ' },          // blank -> rejected
  { data: 'WIFI:T:WPA;S:Net;P:pw;;' },   // no label -> ok, label defaults to ''
  { label: 'C' },                        // no data -> rejected
]);
check('validateEntries keeps the 2 valid entries', v.entries.length === 2);
check('validateEntries reports the 2 bad entries', v.errors.length === 2);
check('validateEntries defaults missing label to ""', v.entries[1].label === '');
check('validateEntries non-array -> error', validateEntries('nope').errors.length === 1);

const entry = { label: 'Guest Wi-Fi & More', data: 'WIFI:T:WPA;S:Lobby Guest;P:p@ss=1;;' };
const uri = overlayUri('https://s.example.com/qr-overlay.html', entry);
const back = new URLSearchParams(uri.split('?')[1]);
check('overlayUri round-trips data exactly', back.get('data') === entry.data);
check('overlayUri round-trips label exactly', back.get('label') === entry.label);
check('overlayUri encodes (no raw spaces/&/;)', !/[ &;]/.test(uri.split('?')[1].replace(/&data=|&label=/, '')));
check('overlayUri joins with & when base already has ?',
  overlayUri('https://s/x?a=1', { data: 'd' }).includes('?a=1&'));

check('nextIndex wraps around', nextIndex(2, 3) === 0 && nextIndex(0, 3) === 1 && nextIndex(1, 3) === 2);
check('nextIndex guards empty list', nextIndex(0, 0) === 0);

// ---- Reed-Solomon core vs published QR generator polynomials ----
// Build GF(256) exp/log tables from the encoder's own multiply, then convert the computed
// divisor coefficients back to alpha-exponent form to compare with the spec's values.
const exp = new Array(256), log = new Array(256);
exp[0] = 1;
for (let i = 1; i < 256; i++) exp[i] = QR.rsMul(exp[i - 1], 2);
for (let i = 0; i < 255; i++) log[exp[i]] = i;

function toAlpha(coeffs) { return coeffs.map((c) => log[c]); }

// Published non-leading generator-polynomial exponents (Thonky / ISO 18004 Annex A).
const GEN7 = [87, 229, 146, 149, 238, 102, 21];
const GEN10 = [251, 67, 46, 61, 118, 70, 64, 94, 32, 45];
const d7 = toAlpha(QR.rsDivisor(7));
const d10 = toAlpha(QR.rsDivisor(10));
check('RS generator poly (deg 7) matches spec', JSON.stringify(d7) === JSON.stringify(GEN7));
check('RS generator poly (deg 10) matches spec', JSON.stringify(d10) === JSON.stringify(GEN10));

// ---- encoder structural invariants ----
const tiny = QR.encodeBytes(QR.utf8Bytes('hi'), 'M');     // tiny -> version 1
check('tiny payload -> 21x21 (version 1)', tiny.size === 21 && tiny.modules.length === 21);
// finder patterns: dark outer ring at the three corners, white separator beside them.
check('top-left finder corner dark', tiny.modules[0][0] === true);
check('top-left separator light', tiny.modules[0][7] === false);
check('top-left finder centre dark', tiny.modules[3][3] === true);
check('top-right finder present', tiny.modules[0][tiny.size - 1] === true);
check('bottom-left finder present', tiny.modules[tiny.size - 1][0] === true);
// timing pattern alternates along row/col 6
check('timing pattern alternates', tiny.modules[6][8] !== tiny.modules[6][9]);

const url = QR.encodeBytes(QR.utf8Bytes('https://example.com/menu'), 'M');
check('longer URL bumps the version (size > 21)', url.size > 21 && (url.size - 17) % 4 === 0);

console.log('\nRESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
