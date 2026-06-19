'use strict';

// Offline test for the pure overlay-URI builder. No network, no config needed.
const { buildOverlayUri, sanitizeColor, parseArgs } = require('./announce');

let ok = true;
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) ok = false;
}

// color sanitisation
check("sanitizeColor strips '#'", sanitizeColor('#CC0000') === 'CC0000');
check('sanitizeColor falls back on garbage', sanitizeColor('not-a-color') === 'CC0000');
check('sanitizeColor falls back on short hex', sanitizeColor('#FFF') === 'CC0000');
check('sanitizeColor keeps valid 6-hex', sanitizeColor('1a2b3c') === '1a2b3c');

// uri building + round-trip through URLSearchParams
const base = 'https://signage.example.com/message-overlay.html';
const msg = 'Fire drill at 2:00 PM — exit via Stairwell B & meet @ lot #3';
const uri = buildOverlayUri(base, { title: 'Notice!', message: msg, color: '#CC0000' });
const u = new URL(uri);

check('uri keeps the base path', u.pathname.endsWith('/message-overlay.html'));
check('message round-trips exactly', u.searchParams.get('message') === msg);
check('title round-trips', u.searchParams.get('title') === 'Notice!');
check('color is sanitised in the uri', u.searchParams.get('color') === 'CC0000');
check('special chars are encoded (no raw space/&/# in query string)',
  !/[ #]/.test(u.search) && (u.search.match(/&/g) || []).length === 2);

// appends with '&' when the base already has a query
const uri2 = buildOverlayUri(base + '?v=2', { message: 'hi', color: 'abcdef' });
check("appends with '&' when base has a query", uri2.includes('?v=2&') && new URL(uri2).searchParams.get('message') === 'hi');

// arg parsing
const a = parseArgs(['Hello world', '--title', 'NOTICE', '--duration', '60', '--clear']);
check('parseArgs captures positional message', a._[0] === 'Hello world');
check('parseArgs reads flag values', a.title === 'NOTICE' && a.duration === '60');
check('parseArgs sets boolean --clear', a.clear === true);

console.log('\nRESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
