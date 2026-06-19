'use strict';

// Offline test for the news-ticker parser. No network, no PiP push.
const fs = require('fs');
const path = require('path');
const { parseHeadlines, feedLabel, decodeText, buildOverlayUri } = require('./news');

const xml = fs.readFileSync(path.join(__dirname, 'fixture-feed.xml'), 'utf8');
let pass = true;
const checks = [];
function check(name, cond, got) {
  checks.push({ name, cond, got });
  if (!cond) pass = false;
}

const all = parseHeadlines(xml, 12);
check('extracts all 5 items', all.length === 5, all.length);
check('order preserved (#1)', all[0] === 'City council approves new transit line', all[0]);
check('CDATA decoded + tags stripped', all[1] === 'Markets rally as tech shares climb', all[1]);
check('ampersand entity decoded', all[2] === 'Storms & flooding expected this weekend', all[2]);
check('numeric entity (–) decoded', all[3] === 'Local team wins championship 3–2', all[3]);
check('last item present', all[4] === 'Library extends weekend hours', all[4]);

const capped = parseHeadlines(xml, 3);
check('max_items caps the list', capped.length === 3, capped.length);

const label = feedLabel(xml);
check('channel title used as label', label === 'Demo Newsroom', label);

// decodeText: ampersand applied last so escaped entities survive
check('escaped &lt; survives', decodeText('a &amp;lt; b') === 'a &lt; b', decodeText('a &amp;lt; b'));

// uri round-trips through URLSearchParams
const uri = buildOverlayUri('https://signage.example.com/news-overlay.html', {
  text: 'A • B & C', label: 'NEWS', sep: ' • ',
});
const parsed = new URLSearchParams(uri.split('?')[1]);
check('uri text round-trips', parsed.get('text') === 'A • B & C', parsed.get('text'));
check('uri label round-trips', parsed.get('label') === 'NEWS', parsed.get('label'));
check('uri uses ? join once', (uri.match(/\?/g) || []).length === 1, uri);

for (const c of checks) console.log(`${c.cond ? '✓' : '✗'} ${c.name}${c.cond ? '' : `  (got: ${JSON.stringify(c.got)})`}`);
console.log(`\nRESULT: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
process.exit(pass ? 0 : 1);
