'use strict';

/*
 * lib/data-sources/rss-resolver.js reads a stranger's feed (up to 2 MB) on the main thread, so it
 * must take linear time. Same two checks as news-feed-linear.test.js:
 *
 *   1. DIFFERENTIAL. The pre-rewrite module is frozen in test/helpers/rss-resolver-legacy.js.
 *      parseFeed() and plain() must give deep-equal results from both on the news-feed fixtures,
 *      mutated copies of them, and a few thousand generated feeds (items, entries, CDATA, entities,
 *      script/style, broken, unclosed and odd-case tags, the 2000-character attribute bound).
 *   2. TIME. A crafted input for each pattern that used to be quadratic must finish inside FAST_MS.
 *      The old code took ~20 s on a 1 MB feed of "<item>" and ~50 s on 512 KB of "<".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseFeed, plain } = require('../lib/data-sources/rss-resolver');
const legacy = require('./helpers/rss-resolver-legacy');

const FX = path.join(__dirname, 'fixtures', 'news-feed');
const fixtures = fs.readdirSync(FX).map((f) => fs.readFileSync(path.join(FX, f), 'utf8'));

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
let withItems = 0;
const pick = (r, a) => a[Math.floor(r() * a.length)];

const TOKENS = [
  '<rss>', '<channel>', '</channel>', '<feed>', '<feed xmlns="http://www.w3.org/2005/Atom">',
  '<item>', '<item rdf:about="x">', '</item>', '<ITEM>', '</Item>', '<items>', '<item\n>', '<item/>',
  '<entry>', '</entry>', '<Entry >', '<entryx>',
  '<title>', '</title>', '<Title lang="en">', '<titles>', '<description>', '</description>',
  '<summary type="html">', '</summary>', '<content:encoded>', '</content:encoded>', '<content>', '</content>',
  '<link>', '</link>', '<link href="https://a.test/x" rel="alternate"/>', "<link rel='self' href='https://b.test/'>",
  '<link href="https://c.test/" />', '<guid>', '</guid>', '<pubDate>', '</pubDate>', '<updated>', '</updated>',
  '<author>', '</author>', '<name>', '</name>', '<dc:creator>', '</dc:creator>',
  '<media:content url="https://i.test/1.jpg" medium="image"/>', '<media:content url="https://v.test/1.mp4" medium="video">',
  '<media:thumbnail url=\'https://t.test/1.jpg\'/>', '<enclosure url="https://e.test/1.png" type="image/png"/>',
  '<enclosure url="https://e.test/1.mp3" type="audio/mpeg">', '&lt;img src="https://img.test/a.jpg"&gt;', '<img src="https://img.test/b.jpg">',
  '<![CDATA[', ']]>', '&lt;', '&gt;', '&amp;', '&#x41;', '&#66;', '&nbsp;', '&quot;', '&#0;',
  '<script>', '</script>', '<SCRIPT type="x">', '</Script>', '<style>', '</style>', '</STYLE >', '<scripts>',
  '<br/>', '<br >', '<BR\t/>', '</p>', '<p>', '<b>', '</b>', '<', '>', '/', '"', "'", '=',
  'Hello', 'world', 'https://x.test/p?a=1&amp;b=2', '2026-10-16T12:00:00Z', ' ', '  ', '\n', '\t', ' ',
];
function compose(r, n) {
  let out = '';
  for (let i = 0; i < n; i++) out += pick(r, TOKENS);
  return out;
}
const same = (input, label) => {
  const got = parseFeed(input);
  if (got.items.length) withItems++;
  assert.deepEqual(got, legacy.parseFeed(input), `${label}: parseFeed`);
  assert.deepEqual(plain(input, 120), legacy.plain(input, 120), `${label}: plain`);
  assert.deepEqual(plain(input), legacy.plain(input), `${label}: plain (no max)`);
};

test('differential: the news-feed fixtures and mutated copies parse exactly as before', () => {
  const r = rng(301);
  for (const [i, f] of fixtures.entries()) {
    same(f, `fixture ${i}`);
    for (let k = 0; k < 20; k++) {
      const at = Math.floor(r() * f.length);
      const cut = Math.floor(r() * 40);
      same(f.slice(0, at) + pick(r, TOKENS) + f.slice(at + cut), `fixture ${i} mutation ${k}`);
    }
  }
});

test('differential: generated feeds parse exactly as before', () => {
  const r = rng(656);
  for (let i = 0; i < 4000; i++) {
    const head = pick(r, ['<rss><channel>', '<feed>', '<rdf:RDF>', '']);
    same(head + compose(r, 5 + Math.floor(r() * 120)), `generated ${i}`);
  }
  assert.ok(withItems > 400, `the generator reaches the item parser (${withItems} feeds with items)`);
});

test('differential: the attribute and inner-text bounds sit exactly where they did', () => {
  for (const n of [1998, 1999, 2000, 2001, 2002]) {
    const pad = 'a'.repeat(n);
    same(`<rss><channel><item ${pad}><title>T</title></item></rss>`, `item attrs ${n}`);
    same(`<rss><channel><item><title ${pad}>T</title></item></rss>`, `title attrs ${n}`);
    same(`<rss><channel><item><enclosure ${pad.slice(4)} url="https://e.test/x.png" type="image/png"/></item></rss>`, `enclosure ${n}`);
    same(`<rss><channel><item><enclosure url="https://e.test/x.png" ${pad}/></item></rss>`, `enclosure slash ${n}`);
  }
  for (const n of [99999, 100000, 100001]) {
    same(`<rss><channel><item><title>${'x'.repeat(n)}</title><title>second</title></item></rss>`, `inner ${n}`);
  }
});

const FAST_MS = 1500;
const timed = (label, fn) => {
  const t0 = process.hrtime.bigint();
  fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < FAST_MS, `${label}: ${Math.round(ms)} ms`);
};

test('time: every pattern that used to be quadratic runs in linear time on a 2 MB feed', () => {
  const N = 2 * 1024 * 1024;
  const run = (u) => u.repeat(Math.floor(N / u.length));
  timed('unclosed <item>', () => parseFeed('<rss><channel>' + run('<item>')));
  timed('unclosed <entry>', () => parseFeed('<feed><entry>' + run('<entry>')));
  timed('unclosed <title> inside an item', () => parseFeed('<rss><channel><item>' + run('<title>') + '</item>'));
  timed('openers with no ">"', () => parseFeed('<rss><channel>' + run('<item ')));
  timed('enclosures with no ">"', () => parseFeed('<rss><channel><item>' + run('<enclosure ') + '</item>'));
  timed('plain: a run of "<"', () => plain('<'.repeat(N)));
  timed('plain: unclosed <script', () => plain(run('<script')));
  timed('50 items, each a 100 KB description of "&lt;"', () => {
    const item = `<item><description>${'&lt;'.repeat(25000)}</description></item>`;
    parseFeed('<rss><channel>' + item.repeat(50));
  });
});
