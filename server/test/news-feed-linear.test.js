'use strict';

/*
 * lib/news-feed/parse.js and discover.js read a stranger's feed or page (up to 4-8 MB) on the main
 * thread, so they must take linear time. Two checks:
 *
 *   1. DIFFERENTIAL. The pre-rewrite modules are frozen in test/helpers/news-feed-legacy/. Every
 *      fixture, mutated copies of them and a few thousand generated feeds, pages, sitemaps and
 *      robots.txt files (items, CDATA, comments, entities, broken and nested tags, odd case and
 *      whitespace) must give deep-equal results from both.
 *   2. TIME. A crafted multi-MB input for each pattern that used to be quadratic (or worse) must
 *      finish well inside FAST_MS. The old code takes from minutes to forever on every one of them
 *      (NEWS_FEED_LINEAR_IMPL=legacy runs this file against it, to see that).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LEGACY = path.join(__dirname, 'helpers', 'news-feed-legacy');
const impl = process.env.NEWS_FEED_LINEAR_IMPL === 'legacy' ? LEGACY : path.join(__dirname, '..', 'lib', 'news-feed');
const parse = require(path.join(impl, 'parse'));
const discover = require(path.join(impl, 'discover'));
const oldParse = require(path.join(LEGACY, 'parse'));
const oldDiscover = require(path.join(LEGACY, 'discover'));
const scan = require('../lib/news-feed/scan');

const FX = path.join(__dirname, 'fixtures', 'news-feed');
const fixtures = fs.readdirSync(FX).map((f) => fs.readFileSync(path.join(FX, f), 'utf8'));
const BASE = 'https://news.example.test/section/page';

// Small deterministic PRNG so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
function compose(r, tokens, max) {
  let out = '';
  for (let n = 1 + Math.floor(r() * max); n > 0; n--) out += pick(r, tokens);
  return out;
}

/* ───────────── generators ───────────── */

const WS = [' ', '\n', '\t', '\r', ' ', ' ', '\v', '  '];
const COMMON = [
  '<![CDATA[', ']]>', '<!--', '-->', '<!-->', '&amp;', '&lt;', '&gt;', '&#8217;', '&#x2014;', '&nbsp;', '&bogus;',
  '&lt;img src="/i.jpg"&gt;', '&lt;p&gt;', '&lt;/p&gt;', '<', '>', '/', '/>', '"', "'", '=', '<>', '<<', '>>',
  '<b>', '</b>', '<br>', '<br/>', '<BR', '<p>', '</p>', '<pre>', '<div class="x">', '</div>', '<script>', '</script>',
  '</SCRIPT >', '<style>', '</style>', '<noscript>', '</noscript', '<template>', '</template>', '<svg>', '</svg>',
  '<img src="/i.png">', "<img data-src='/d.webp' >", '<img alt="x" src="https://cdn.test/p.gif?x=1">', '<img ',
  '<IMG SRC="/u.jpg">', '<img src="">', '<img\tsrc = "/t.jpg"/>', ' src="/s.jpg"', ' src=', 'src',
  'text', 'Hello world', 'A story about the city council and its budget', 'x', 'é', '\u0085', '\u0000',
  'https://x.test/p', '/rel/path', ...WS,
];
const FEED = [
  '<item>', '</item>', '<item ', '<item/>', '<item />', '<items>', '<ITEM>', '</item >', '</ITEM>', '<item rdf:about="https://x.test/r">',
  '<entry>', '</entry>', '<entry xml:lang="en">', '<title>', '</title>', '<TITLE>', '</title >', '<title type="html">',
  '<titles>', '<link>', '</link>', '<link/>', '<link href="https://x.test/l" rel="alternate"/>', '<link rel="replies" href="/r">',
  '<link href="/a">', '<description>', '</description>', '<content:encoded>', '</content:encoded>', '<summary>', '</summary>',
  '<content type="html">', '</content>', '<media:description>', '</media:description>', '<media:title>', '</media:title>',
  '<guid isPermaLink="false">', '<guid>', '<guid ', '<guid\t>', '</guid>', '<guid isPermaLink="true">https://x.test/g</guid>',
  '<guid >https://x.test/g2</guid>', 'https://x.test/g', '<guid isPermaLink="false">https://x.test/g3</guid>', '<pubDate>', '</pubDate>', '<dc:date>', '</dc:date>',
  '<published>', '</published>', '<updated>', '</updated>', 'Wed, 14 Oct 2026 20:44:21 CEST', 'Wed, 14 Oct 2026 20:44:21 EDT',
  '2026-10-15T01:34:03Z', ' GMT', ' ABCDEF', 'Thu, 15 Oct 2026 01:44:21 +0000',
  '<media:content url="https://x.test/a.jpg" medium="image"/>', '<media:content url="/v.mp4" medium="video">',
  '<media:content ', '<media:thumbnail url="/t.png"/>', '<enclosure url="/e.jpg" type="image/jpeg"/>',
  '<enclosure url="/a.mp3" type="audio/mpeg">', '<itunes:image href="/it.png"/>', '<image>', '</image>', '<image ',
  '<url>', '</url>', '<atom:link href="https://x.test/self" rel="self"/>', '<atom:link ', '<channel>', '</channel>',
  ...COMMON,
];
const FEED_HEADS = [
  '<?xml version="1.0"?><rss version="2.0"><channel>', '<rss><channel><title>Feed</title><link>https://x.test/</link>',
  '<?xml version="1.0" encoding="utf-8"?>\n<!-- a note --><rdf:RDF xmlns:rdf="r"><channel><title>R</title></channel>',
  '<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><link href="https://x.test/"/>', '<rss>', '<feed>',
  '<!DOCTYPE rss><rss>', '<rdf:RDF>',
];
const PAGE = [
  '<article>', '</article>', '<article class="c">', '<ARTICLE>', '</article >', '<articles>', '<h2>', '</h2>', '<H3 class=x>',
  '</h3 >', '<h1>', '</h4>', '<h5>', '<h2x>', '<h23>', '<a href="https://news.example.test/news/story-one-is-long">',
  '<a href="/news/a-second-story/">', '<a>', '<a ', '</a>', '<A HREF="/x/y/z">', '</A>', '</a >', '<abbr>', '<span>', '</span>',
  '<div>', '<img src="/p.jpg">', '<img data-srcset="/s1.jpg 1x, /s2.jpg 2x">', '<script type="application/ld+json">',
  '<script type=application/ld+json>', '<script>', '</script>',
  '{"@type":"NewsArticle","headline":"A headline here","url":"/n/1","image":"/i.jpg","datePublished":"2026-10-10"}',
  '[{"@type":"ItemList","itemListElement":[{"url":"/n/2","name":"Listed story"}]}]', '{"@graph":[{"@type":"Article","name":"G","url":"/g"}]}',
  '<meta property="og:title" content="OG Title">', '<meta name="description" content="D">', '<meta property="og:image" content="/og.png">',
  '<meta ', '<link rel="alternate" type="application/rss+xml" href="/feed" title="F">', '<link rel="alternate" type="text/xml" href="/x.xml">',
  '<link rel="alternate" type="application/atom+xml" href="/atom.xml">', '<link ', '<title>', '</title>', '<title ',
  'A long headline with several words in it', 'Another fairly long headline about things', 'short', ...COMMON,
];
const SITEMAP = [
  '<urlset>', '</urlset>', '<url>', '</url>', '<url ', '<urls>', '<loc>', '</loc>', '<locale>', '<news:news>', '</news:news>',
  '<news:title>', '</news:title>', '<news:publication_date>', '</news:publication_date>', '2026-10-10T10:00:00Z', '2026-10-11',
  '<image:loc>', '</image:loc>', '<sitemapindex>', '</sitemapindex>', '<sitemap>', '</sitemap>', '<sitemaps>',
  'https://news.example.test/n/1', 'https://news.example.test/news-sitemap.xml', '/n/2', 'Story title', ...COMMON,
];
const ROBOTS = [
  'User-agent: *', 'User-agent: screentinker', 'User-Agent:other', 'Disallow: /', 'Disallow:', 'Allow: /news',
  'Disallow: /private*', 'Disallow: /*.php$', 'Allow: /*?', 'Sitemap: https://x.test/s.xml', '# comment', ' #x', '\r', '\n',
  '\r\n', ':', '*', '$', 'a', '/', ' ', '\t', ' ', 'Disallow: /a*b*c$', 'Disallow:  /x # trailing',
];

// Tag-dense pages: runs of tags with headings and links in them, for the headline patterns.
const RUN = [
  '<a href="/news/x-y-z-w">', '<a href="/news/another-story-path">', '<A>', '<a ', '</a>', '</A >', '<h2>', '</h2>', '<h3 class=a>',
  '</h3>', '<H4>', '</h4 >', '<h2x>', '<span>', '</span>', '<b>', '<img src="/r.jpg">', ' ', '\n', '<', '>', '<>', '< a>',
  'Headline words go here now', 'More words in another headline', '<article>', '</article>', '</ a>', '<!-- c -->',
];

const genFeed = (r) => pick(r, FEED_HEADS) + compose(r, FEED, 70);
const genPage = (r) => (r() < 0.4 ? compose(r, RUN, 40) : compose(r, PAGE, 70));
const genSitemap = (r) => compose(r, SITEMAP, 60);

/** A fixture with a few random edits: a slice dropped, duplicated or replaced by tokens, a case flip. */
function mutate(r, s, tokens) {
  for (let k = 1 + Math.floor(r() * 4); k > 0; k--) {
    const a = Math.floor(r() * s.length);
    const b = Math.min(s.length, a + Math.floor(r() * 80));
    const op = Math.floor(r() * 5);
    if (op === 0) s = s.slice(0, a) + s.slice(b);
    else if (op === 1) s = s.slice(0, b) + s.slice(a, b) + s.slice(b);
    else if (op === 2) s = s.slice(0, a) + compose(r, tokens, 6) + s.slice(b);
    else if (op === 3) s = s.slice(0, a) + s.slice(a, b).toUpperCase() + s.slice(b);
    else s = s.slice(0, a);
  }
  return s;
}

/* ───────────── comparison ───────────── */

const ATTRS = ['href', 'url', 'src', 'rel', 'type', 'rdf:about', 'title'];
const TAGS = ['title', 'link', 'description', 'item', 'guid', 'media:content', 'url', 'image', 'h2', 'a', 'x'];

let compared = 0;
function same(label, input, fnNew, fnOld) {
  compared += 1;
  let a, b;
  try { a = { v: fnNew() }; } catch (e) { a = { err: e.message }; }
  try { b = { v: fnOld() }; } catch (e) { b = { err: e.message }; }
  assert.deepEqual(a, b, `${label} differs on ${JSON.stringify(input).slice(0, 2000)}`);
}

function compareFeed(s, r) {
  same('parseFeed', s, () => parse.parseFeed(s, BASE), () => oldParse.parseFeed(s, BASE));
  same('detectFormat', s, () => parse.detectFormat(s), () => oldParse.detectFormat(s));
  same('plain', s, () => parse.plain(s, 300), () => oldParse.plain(s, 300));
  same('unwrap', s, () => parse.unwrap(s), () => oldParse.unwrap(s));
  same('firstImgSrc', s, () => parse.firstImgSrc(s, BASE), () => oldParse.firstImgSrc(s, BASE));
  const tag = pick(r, TAGS);
  same(`rawOf ${tag}`, s, () => parse._test.rawOf(s, tag), () => oldParse._test.rawOf(s, tag));
  const attr = pick(r, ATTRS);
  same(`attrOf ${tag} ${attr}`, s, () => parse._test.attrOf(s, tag, attr), () => oldParse._test.attrOf(s, tag, attr));
}

function comparePage(s) {
  for (const fn of ['findFeedLinks', 'pageMeta', 'extractJsonLd', 'extractHeadlineLinks', 'parseSitemap']) {
    same(fn, s, () => discover[fn](s, BASE), () => oldDiscover[fn](s, BASE));
  }
  same('plain', s, () => parse.plain(s), () => oldParse.plain(s));
}

function compareRobots(text, paths) {
  same('parseRobots', text, () => {
    const p = discover.parseRobots(text);
    return { sitemaps: p.sitemaps, allows: paths.map((x) => p.allows(x)) };
  }, () => {
    const p = oldDiscover.parseRobots(text);
    return { sitemaps: p.sitemaps, allows: paths.map((x) => p.allows(x)) };
  });
}

/* ───────────── 1. differential ───────────── */

test('differential: the fixtures give exactly what the old parser gave', () => {
  for (const s of fixtures) { compareFeed(s, rng(1)); comparePage(s); }
});

test('differential: generated feeds (RSS, RDF, Atom) and mutated fixtures', () => {
  const r = rng(20261016);
  for (let i = 0; i < 3000; i++) compareFeed(genFeed(r), r);
  for (let i = 0; i < 1500; i++) {
    const s = mutate(r, pick(r, fixtures), FEED);
    compareFeed(s, r);
    comparePage(s);
  }
});

test('differential: JSON Feed text through plain(), dates and images', () => {
  const r = rng(7);
  for (let i = 0; i < 1500; i++) {
    const it = {
      title: compose(r, COMMON, 12), summary: r() < 0.5 ? compose(r, COMMON, 12) : undefined,
      content_html: compose(r, COMMON, 20), url: pick(r, ['https://x.test/a', '/b', '', 'javascript:x']),
      date_published: pick(r, ['2026-10-15T01:34:03Z', 'Wed, 14 Oct 2026 20:44:21 CEST', `a${pick(r, WS).repeat(5)}PDT`, 'x  ABC', 'ABC', ' ']),
    };
    const s = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: compose(r, COMMON, 5), items: [it] });
    same('parseFeed json', s, () => parse.parseFeed(s, BASE), () => oldParse.parseFeed(s, BASE));
    const d = compose(r, [...WS, 'A', 'B', 'Z', 'a', '1', ' EST', ' CEST', 'Mon'], 8);
    same('isoDate', d, () => parse.isoDate(d), () => oldParse.isoDate(d));
  }
});

test('differential: generated pages and sitemaps', () => {
  const r = rng(42);
  for (let i = 0; i < 3000; i++) comparePage(genPage(r));
  for (let i = 0; i < 1500; i++) comparePage(genSitemap(r));
});

test('differential: robots.txt groups, comments and wildcard rules', () => {
  const r = rng(9);
  const PATH = ['/', 'a', 'b', 'c', '.', '?', '$', '*', 'php', '/news', '/private', 'x'];
  for (let i = 0; i < 2000; i++) {
    const lines = [];
    for (let n = Math.floor(r() * 8); n >= 0; n--) {
      lines.push(r() < 0.5 ? pick(r, ROBOTS) : `${pick(r, ['Allow', 'Disallow', 'disallow', 'Sitemap', 'X-y'])}${pick(r, [':', ' :', ': ', ': '])}${compose(r, ['/', 'a', 'b', 'c', '*', '$', '.', '?', '#', ' ', '\r', 'php'], 8)}`);
    }
    const paths = Array.from({ length: 6 }, () => '/' + compose(r, r() < 0.1 ? [...PATH, '\r', '\n', '\u2028'] : PATH, 8));
    compareRobots(lines.join(pick(r, ['\n', '\r\n'])), paths);
  }
});

test('differential: the size caps sit exactly where they were', () => {
  // `fill(core, n)`: core padded with spaces to exactly n characters.
  const fill = (core, n) => core + ' '.repeat(n - core.length);
  // rawOf and the item opener: <tag(?:\s[^>]{0,2000})?> — 1 + 2000 characters between "<tag" and ">".
  for (const n of [1999, 2000, 2001, 2002, 2003]) {
    const a = fill(' a="x"', n);
    compareFeed(`<rss><channel><item${a}><title${a}>T</title><link${a}>https://x.test/</link><title>U</title></item></channel></rss>`, rng(n));
  }
  // rawOf content: [\s\S]{0,200000}?.
  for (const n of [199999, 200000, 200001]) {
    compareFeed(`<rss><channel><item><title>${'y'.repeat(n)}</title><title>z</title><description>d</description></item></channel></rss>`, rng(n));
  }
  // attrOf: <tag\s([^>]{0,4000}?)\/?> — with and without the "/".
  for (const n of [3999, 4000, 4001, 4002]) {
    for (const end of ['>', '/>']) {
      compareFeed(`<rss><channel><item><title>t</title><enclosure${fill(' url="/e.jpg" type="image/jpeg"', n)}${end}`
        + `<enclosure url="/f.jpg" type="image/png"/></item></channel></rss>`, rng(n));
    }
  }
  // <link\b([^>]{0,4000})>, <meta\b…>, <img\b…>; and <title…>{0,2000}</title>.
  for (const n of [3999, 4000, 4001]) {
    comparePage(`<link${fill(' rel="alternate" type="application/rss+xml" href="/feed"', n)}><link rel="alternate" type="application/rss+xml" href="/b">`
      + `<meta${fill(' property="og:title" content="T"', n)}><meta property="og:title" content="U">`
      + `<article><img${fill(' src="/a.jpg"', n)}><img src="/b.jpg"><h2><a href="/news/one-long-story-here">One long story headline here</a></h2></article>`);
  }
  for (const n of [1999, 2000, 2001]) comparePage(`<title>${'t'.repeat(n)}</title><title>short</title>`);
});

/* Each scan against the very regex it replaced, on short strings over a dense alphabet. */

function micro(name, seed, alphabet, max, n, fnNew, fnOld) {
  test(`differential: ${name}`, () => {
    const r = rng(seed);
    for (let i = 0; i < n; i++) {
      const x = compose(r, alphabet, max);
      same(name, x, () => fnNew(x), () => fnOld(x));
    }
  });
}
const allMatches = (re, s, map) => { const out = []; let m; while ((m = re.exec(s))) out.push(map(m)); return out; };
const D = discover._test;
const P = parse._test;
const U = [' ', '\t', '\n', '\r', ' ', ' ', ' ', '﻿', '　'];

micro('isoDate zone fallback', 1, ['A', 'B', 'Z', 'a', '1', ':', '-', ...U], 10, 4000,
  (v) => P.zoneToGmt(v), (v) => v.replace(/\s+[A-Z]{3,5}$/, ' GMT'));
micro('isoDate', 2, ['2026-10-10', 'T10:00', ' ', 'ABC', 'CEST', 'Z', 'GMT', 'Wed, 14 Oct 2026 20:44:21', ...U], 6, 3000,
  (v) => parse.isoDate(v), (v) => oldParse.isoDate(v));
micro('guid attributes', 3, ['<guid', '<GUID', '<guidx', ' ', ' ', '>', 'x', '/', '<', 'a=b'], 8, 4000,
  (b) => P.guidAttrs(b), (b) => (/<guid(\s[^>]*)?>/i.exec(b) || [])[1] || '');
micro('rdf item attributes', 4, ['<item', '<ITEM', '<items', ' ', ' ', '>', 'x', '/', '<', 'a=b'], 8, 4000,
  (w) => P.itemAttrs(w), (w) => (/<item(\s[^>]*)>/i.exec(w) || [])[1] || '');
micro('rawOf and attrOf', 5, ['<ab', '<AB', '<abc', '</ab>', '</ab >', '</AB\t>', '</ab', '>', '/', '/>', ' ', ' ', 'x', '<',
  '<![CDATA[', ']]>', '&lt;', ' u="v"', " u='w'", ' u=z', ' U="q"'], 12, 6000,
(s) => [P.rawOf(s, 'ab'), P.attrOf(s, 'ab', 'u')], (s) => [oldParse._test.rawOf(s, 'ab'), oldParse._test.attrOf(s, 'ab', 'u')]);
micro('plain', 6, ['<![CDATA[', ']]>', '<!--', '-->', '<script', '<script>', '</script>', '<STYLE>', '</style >', '<noscript', '</noscript>',
  '<br', '</p', '<pre', '<h1', '<hr/>', '<img', '<figcaption>', '>', '<', ' ', 'x', 'é', '&amp;', '&#65;', '-', '!', '[', ...U], 14, 6000,
(s) => parse.plain(s, 12), (s) => oldParse.plain(s, 12));
micro('unwrap', 7, ['<![CDATA[', ']]>', '<![CDATA[x]]>', '&amp;', '&lt;', ']', '[', '<', '!', 'x'], 10, 3000,
  (s) => parse.unwrap(s), (s) => oldParse.unwrap(s));
micro('firstImgSrc', 8, ['<img', '<IMG', '<imgx', '<img/', ' ', '\t', ' ', 'src', 'data-src', 'SRC', '=', '"', "'", 'x', '/a.png', '>', '/', '<'], 14, 6000,
  (s) => parse.firstImgSrc(s, BASE), (s) => oldParse.firstImgSrc(s, BASE));
micro('detectFormat', 9, ['<?xml', '?>', '<!--', '-->', '<!DOCTYPE', '<!doctype', '>', '<rss', '<rss>', '<feed ', '<rdf:RDF>', ' ', 'x', '<'], 10, 4000,
  (s) => parse.detectFormat(s), (s) => oldParse.detectFormat(s));
micro('robots comment', 10, ['#', '\r', ' ', ' ', '\n', 'a', ' '], 10, 4000,
  (l) => D.dropRobotsComment(l), (l) => l.replace(/#.*$/, ''));
micro('robots field', 11, ['a', 'B', '-', ':', ' ', '\r', ' ', '\t', 'x', '#', '1', ' ', '\v'], 10, 5000,
  (l) => D.robotsField(l), (l) => { const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(l); return m ? [m[0], m[1], m[2]] : null; });
test('differential: robots wildcard rules', () => {
  const r = rng(12);
  const old = (rule, p) => {
    let re;
    try { re = new RegExp('^' + rule.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\\\$$/, '$')); } catch (_) { return false; }
    return re.test(p);
  };
  for (let i = 0; i < 8000; i++) {
    const rule = compose(r, ['/', 'a', 'b', '*', '$', '.', '\\', '?', '(', '[', '\r', 'ab'], 7);
    const p = compose(r, r() < 0.2 ? ['/', 'a', 'b', '$', '*', '.', '\n', '\r', ' '] : ['/', 'a', 'b', '$', '*', '.', 'ab'], 9);
    same('robotsRuleMatches', [rule, p], () => D.robotsRuleMatches(rule, p), () => old(rule, p));
  }
});
micro('page <title>', 13, ['<title', '<TITLE ', '<titlex', '>', '</title>', '</TITLE>', '</title >', 'x', ' ', '<'], 10, 4000,
  (h) => D.titleText(h), (h) => (/<title[^>]*>([\s\S]{0,2000}?)<\/title>/i.exec(h) || [])[1] || '');
micro('ld+json scripts', 14, ['<script', '<SCRIPT ', '<scripts', ' type=', 'type = ', 'application/ld+json', '"', "'", '>', '</script>', '</script >', '{}', 'x', ' ', '<'], 12, 5000,
  (h) => { const out = []; D.eachLdScript(h, (b) => { out.push(b); }); return out; },
  (h) => allMatches(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi, h, (m) => m[1]));
const HEADINGS = ['<h2', '<H3', '<h5', '<h2x', '<h1>', '>', '</h2>', '</H4 >', '</h2', '<a', '<A', '<abbr', '<a>', ' href=x', '</a>', '</A >', '</ a>',
  ' ', '\n', ' ', 'x', '<', '<>', '<b>', '</', '/'];
micro('heading with a link inside', 15, HEADINGS, 14, 6000,
  (b) => D.headingWithLink(b),
  (b) => { const m = /<h[1-4]\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a\s*>[\s\S]*?<\/h[1-4]\s*>/i.exec(b); return m ? { attrs: m[1], html: m[2] } : null; });
for (const closeA of [false, true]) {
  micro(`link wrapping a heading${closeA ? ' (no </a> in between)' : ''}`, 16 + closeA, HEADINGS, 16, 8000,
    (s) => { const out = []; D.eachLinkedHeading(s, closeA, (x) => { out.push(x); }); return out; },
    (s) => allMatches(closeA ? /<a\b([^>]*)>\s*(?:<(?!\/a)[^>]+>\s*)*<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]\s*>/gi
      : /<a\b([^>]*)>\s*(?:<[^>]+>\s*)*<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]\s*>/gi, s,
    (m) => ({ index: m.index, attrs: m[1], html: m[2], end: m.index + m[0].length })));
}
micro('heading containing a link', 18, HEADINGS, 16, 8000,
  (s) => { const out = []; D.eachHeadingLink(s, (x) => { out.push(x); }); return out; },
  (s) => allMatches(/<h[1-4]\b[^>]*>\s*(?:<[^a][^>]*>\s*)*<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, s,
    (m) => ({ index: m.index, attrs: m[1], html: m[2], end: m.index + m[0].length })));
micro('scan.js building blocks', 19, ['<ab', '<AB', '<abc', '</ab>', '</ab >', '</AB>', '>', '<', '<!--', '-->', ' ', 'x', ' '], 12, 5000,
  (s) => [
    scan.replacePairs(s, '<!--', '-->', () => '_'),
    scan.replaceBlocks(s, /<(ab|abc)\b/gi, scan.closerByName(s), '_'),
    scan.replaceOpenTags(s, /<ab/gi, '_'),
    (() => { const o = []; scan.eachBlock(s, /<ab\b/gi, /<\/ab\s*>/gi, (b) => { o.push(b); }); return o; })(),
    (() => { const o = []; scan.eachTag(s, /<ab\b/gi, 3, (a, i) => { o.push([a, i]); }); return o; })(),
  ],
  (s) => [
    s.replace(/<!--[\s\S]*?-->/g, '_'),
    s.replace(/<(ab|abc)\b[\s\S]*?<\/\1\s*>/gi, '_'),
    s.replace(/<ab[^>]*>/gi, '_'),
    allMatches(/<ab\b([^>]*)>([\s\S]*?)<\/ab\s*>/gi, s, (m) => ({ index: m.index, attrs: m[1], inner: m[2], end: m.index + m[0].length })),
    allMatches(/<ab\b([^>]{0,3})>/gi, s, (m) => [m[1], m.index]),
  ]);

test('differential: how many inputs were compared', () => {
  assert.ok(compared > 100000, `compared ${compared} results`);
});

/* ───────────── 2. time ───────────── */

// Each vector is several MB; the linear code takes 1-200 ms on a developer machine, the old code
// minutes to hours (it is quadratic or worse: 50 KB already took 20-1000 ms). Generous for slow CI.
const FAST_MS = 1500;
const MB4 = 4 * 1024 * 1024;
const rep = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const json = (item) => JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [{ url: 'https://x.test/a', ...item }] });
const rss = (inner) => `<?xml version="1.0"?><rss version="2.0"><channel>${inner}`;
const item = (inner) => rss(`<item>${inner}</item></channel></rss>`);
function timed(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

const FEED_VECTORS = {
  'plain(): a title of "<"': json({ title: rep('<', MB4) }),
  'plain(): a title of "<br"': json({ title: rep('<br', MB4) }),
  'plain(): a title of "<!--"': json({ title: rep('<!--', MB4) }),
  'plain(): a title of "<![CDATA["': json({ title: rep('<![CDATA[', MB4) }),
  'plain(): a title of "<script>"': json({ title: rep('<script>', MB4) }),
  'plain(): an RSS title of "<" (200 KB, the element cap)': item(`<title>${rep('<', 199000)}</title>`),
  'raw comment strip: a run of "<!--"': rss(rep('<!--', MB4)),
  'item regex: a run of "<item>"': rss(rep('<item>', MB4)),
  'entry regex: a run of "<entry>"': `<feed xmlns="http://www.w3.org/2005/Atom">${rep('<entry>', MB4)}`,
  'channel: a run of "<title>"': rss(rep('<title>', MB4)),
  'item: a run of "<title>"': item(rep('<title>', MB4)),
  'channel: a run of "<image>"': rss(rep('<image>', MB4)),
  'channel: a run of "<atom:link "': rss('<title>T</title>' + rep('<atom:link ', MB4)),
  'attrOf: a run of "<link "': item('<title>a</title>' + rep('<link ', MB4)),
  'attrOf: a run of "<media:content "': item('<title>a</title>' + rep('<media:content ', MB4)),
  'unwrap: a run of "<![CDATA["': item(`<title>${rep('<![CDATA[', 199000)}</title>`),
  'firstImgSrc: a run of "<img " in a description': item(`<title>a</title><description>${rep('&lt;img ', 199000)}</description>`),
  'firstImgSrc: a run of "<img " in JSON content_html': json({ title: 'a', content_html: rep('<img ', MB4) }),
  'isoDate: a date with a long run of spaces': json({ title: 'a', date_published: 'a' + ' '.repeat(MB4) + 'b' }),
};
for (const [name, s] of Object.entries(FEED_VECTORS)) {
  test(`time: parseFeed, ${name}`, () => {
    assert.ok(s.length >= 190000, 'the vector is the size it claims');
    const ms = timed(() => parse.parseFeed(s, BASE));
    assert.ok(ms < FAST_MS, `${ms.toFixed(0)} ms`);
  });
}

const PAGE_VECTORS = {
  'findFeedLinks: "<link " then a far ">"': ['findFeedLinks', rep('<link ', 1024 * 1024 - 1) + '>'],
  'pageMeta: "<meta " then a far ">"': ['pageMeta', rep('<meta ', 512 * 1024 - 1) + '>'],
  'pageMeta: a run of "<title"': ['pageMeta', rep('<title', 512 * 1024)],
  'pageMeta: a run of "<title>"': ['pageMeta', rep('<title>', 512 * 1024)],
  'extractJsonLd: a run of "<script " then ">"': ['extractJsonLd', rep('<script ', MB4) + '>'],
  'extractJsonLd: unclosed ld+json scripts': ['extractJsonLd', rep('<script type="application/ld+json">', MB4)],
  'parseSitemap: a run of "<url>"': ['parseSitemap', rep('<url>', 8 * 1024 * 1024)],
  'parseSitemap: a run of "<sitemap>"': ['parseSitemap', '<sitemapindex>' + rep('<sitemap>', 8 * 1024 * 1024)],
  'parseSitemap: a run of "<loc>" in one entry': ['parseSitemap', '<sitemapindex><sitemap>' + rep('<loc>', MB4) + '</sitemap>'],
  'parseSitemap: "<news:title>" runs in news entries': ['parseSitemap', rep('<url><news:news><loc>https://x.test/a</loc>' + '<news:title>'.repeat(50) + '</url>', MB4)],
  'extractHeadlineLinks: a run of "<script>"': ['extractHeadlineLinks', rep('<script>', MB4)],
  'extractHeadlineLinks: a run of "<!--"': ['extractHeadlineLinks', rep('<!--', MB4)],
  'extractHeadlineLinks: a run of "<article>"': ['extractHeadlineLinks', rep('<article>', MB4)],
  'extractHeadlineLinks: a run of "<h2>"': ['extractHeadlineLinks', rep('<h2>', MB4)],
  'extractHeadlineLinks: a run of "<a>"': ['extractHeadlineLinks', rep('<a>', MB4)],
  'extractHeadlineLinks: a run of "<a><h2>"': ['extractHeadlineLinks', rep('<a><h2>', MB4)],
  'extractHeadlineLinks: a run of "<h2><a>"': ['extractHeadlineLinks', rep('<h2><a>', MB4)],
  'extractHeadlineLinks: "<a>" runs in an article': ['extractHeadlineLinks', '<article>' + rep('<a>', MB4) + '</article>'],
  'extractHeadlineLinks: "<h2><a></a>" runs in an article': ['extractHeadlineLinks', '<article>' + rep('<h2><a></a>', MB4) + '</article>'],
  'extractHeadlineLinks: slash-heavy duplicate links': ['extractHeadlineLinks', rep(`<h2><a href="/news/${'/'.repeat(1900)}x">A long headline with several words</a></h2>`, MB4)],
};
for (const [name, [fn, s]] of Object.entries(PAGE_VECTORS)) {
  test(`time: ${name}`, () => {
    const ms = timed(() => discover[fn](s, BASE));
    assert.ok(ms < FAST_MS, `${ms.toFixed(0)} ms`);
  });
}

test('time: robots.txt comment, field and wildcard-rule vectors', () => {
  const vectors = [
    ['User-agent: *\nDisallow: /x' + '#'.repeat(512 * 1024 - 40) + '\rz', '/x'],
    ['User-agent: *\nDisallow:' + ' '.repeat(512 * 1024 - 40) + 'y\rz', '/y'],
    ['User-agent: *\nDisallow: /' + '*a'.repeat(30) + '*b', '/' + 'a'.repeat(2000)],
    ['User-agent: *\n' + 'Disallow: /*a*a*a*a*a*a*a*a*a*a*b$\n'.repeat(2000), '/' + 'a'.repeat(2000)],
  ];
  for (const [text, p] of vectors) {
    const ms = timed(() => discover.parseRobots(text).allows(p));
    assert.ok(ms < FAST_MS, `${ms.toFixed(0)} ms`);
  }
});
