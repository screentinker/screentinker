'use strict';

/*
 * RSS 2.0 / Atom / RDF feed → headline variables. News tickers, a company blog, a status page
 * (Statuspage, GitHub status, AWS health all publish feeds), job boards, an events calendar.
 *
 * ⚠️ NOT AN XML PARSER, ON PURPOSE. Feeds are read with bounded regular expressions: no DTD
 * processing, no external entities, no entity expansion beyond the five XML ones and numeric
 * references — so XXE and "billion laughs" have nothing to act on. A feed that needs a real XML
 * parser to read is rare enough that a clear "could not find any items" is the right answer.
 *
 * Variables: feed_title, feed_link, item_count, headlines_text (one per line),
 *            item{i}_title / _link / _date / _date_iso / _summary / _image / _author  (1-based)
 *
 * config: url, max_items (default 10, ≤ 50), locale, timezone, summary_chars (default 200),
 *         interval_min
 */

const { fetchText, checkHttpUrl, UserFacingError } = require('./http');

const MAX_ITEMS = 50;

function validateRssConfig(c) {
  if (!c || typeof c !== 'object') return 'Config must be an object';
  const bad = checkHttpUrl(c.url, 'The feed URL');
  if (bad) return bad;
  const n = c.max_items == null || c.max_items === '' ? 10 : parseInt(c.max_items, 10);
  if (!(n >= 1 && n <= MAX_ITEMS)) return `Items must be between 1 and ${MAX_ITEMS}`;
  if (c.locale && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(String(c.locale))) return 'Unknown locale';
  if (c.timezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: String(c.timezone) }); } catch { return 'Unknown time zone'; }
  }
  return null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&(lt|gt|quot|apos|nbsp|amp);/g, (_, n) => ({ lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', amp: '&' })[n]);
}
function safeChar(cp) {
  if (!Number.isFinite(cp) || cp < 9 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
  return String.fromCodePoint(cp);
}

/* The text of an element: CDATA unwrapped, entities decoded. Only the first match. */
function textOf(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]{0,2000})?>([\\s\\S]{0,100000}?)</${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return '';
  return unwrap(m[1]);
}
function unwrap(s) {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return cdata ? cdata[1] : decodeEntities(s);
}
function attrOf(block, tag, attr, filter) {
  const re = new RegExp(`<${tag}\\s([^>]{0,2000}?)/?>`, 'gi');
  let m;
  while ((m = re.exec(block))) {
    const attrs = m[1];
    if (filter && !filter(attrs)) continue;
    const a = new RegExp(`(?:^|\\s)${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
    if (a) return decodeEntities(a[2] !== undefined ? a[2] : a[3]);
  }
  return '';
}

/** HTML → plain text: tags dropped, whitespace collapsed, clipped at a word boundary. */
function plain(html, max) {
  let s = decodeEntities(String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return s;
}

function httpUrl(s) {
  const v = String(s || '').trim();
  return /^https?:\/\//i.test(v) ? v.slice(0, 2000) : '';
}

function parseFeed(xml) {
  const src = String(xml).slice(0, 2 * 1024 * 1024);
  const isAtom = /<feed[\s>]/i.test(src) && /<entry[\s>]/i.test(src);
  const channel = isAtom ? src.split(/<entry[\s>]/i)[0] : (src.split(/<item[\s>]/i)[0]);
  const feed = {
    title: plain(textOf(channel, 'title'), 200),
    link: isAtom ? httpUrl(attrOf(channel, 'link', 'href', (a) => !/rel\s*=\s*["'](?:self|hub)/i.test(a))) : httpUrl(textOf(channel, 'link')),
    items: [],
  };
  const blockRe = isAtom ? /<entry(?:\s[^>]{0,2000})?>([\s\S]*?)<\/entry>/gi : /<item(?:\s[^>]{0,2000})?>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = blockRe.exec(src)) && feed.items.length < MAX_ITEMS) {
    const b = m[1];
    const summaryHtml = isAtom ? (textOf(b, 'summary') || textOf(b, 'content')) : (textOf(b, 'description') || textOf(b, 'content:encoded'));
    const image = httpUrl(attrOf(b, 'media:content', 'url', (a) => !/medium\s*=\s*["'](?:video|audio)/i.test(a)))
      || httpUrl(attrOf(b, 'media:thumbnail', 'url'))
      || httpUrl(attrOf(b, 'enclosure', 'url', (a) => /type\s*=\s*["']image\//i.test(a)))
      || httpUrl(attrOf(summaryHtml, 'img', 'src'));
    feed.items.push({
      title: plain(textOf(b, 'title'), 300),
      link: isAtom ? httpUrl(attrOf(b, 'link', 'href', (a) => !/rel\s*=\s*["'](?!alternate)/i.test(a))) : httpUrl(textOf(b, 'link') || textOf(b, 'guid')),
      date: (isAtom ? (textOf(b, 'updated') || textOf(b, 'published')) : (textOf(b, 'pubDate') || textOf(b, 'dc:date'))).trim(),
      author: plain(isAtom ? textOf(textOf(b, 'author'), 'name') : (textOf(b, 'author') || textOf(b, 'dc:creator')), 120),
      summaryHtml,
      image,
    });
  }
  return feed;
}

function formatDate(raw, locale, timeZone) {
  const d = new Date(raw);
  if (!raw || Number.isNaN(d.getTime())) return { text: String(raw || '').slice(0, 60), iso: '' };
  let text;
  try {
    text = new Intl.DateTimeFormat(locale || 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timeZone || undefined }).format(d);
  } catch { text = d.toUTCString(); }
  return { text, iso: d.toISOString() };
}

async function resolveRss(config, ctx = {}) {
  const c = config || {};
  const err = validateRssConfig(c);
  if (err) throw new UserFacingError(err, 'config');
  const { text } = await fetchText(String(c.url).trim(), {
    headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5' },
    maxBytes: 2 * 1024 * 1024,
    fetcher: ctx.fetcher,
  });
  if (!/<(?:rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 4096))) {
    throw new UserFacingError(/^\s*<(?:!doctype html|html)/i.test(text) ? 'That address is a web page, not a feed. Look for an RSS or Atom link on the site (often /feed or /rss).' : 'That address did not return an RSS or Atom feed.', 'not-feed');
  }
  const feed = parseFeed(text);
  const max = c.max_items == null || c.max_items === '' ? 10 : parseInt(c.max_items, 10);
  const chars = Math.max(40, Math.min(1000, parseInt(c.summary_chars, 10) || 200));
  const items = feed.items.slice(0, max);
  const data = {
    feed_title: feed.title,
    feed_link: feed.link,
    item_count: items.length,
    headlines_text: items.map((i) => i.title).filter(Boolean).join('\n'),
    updated: (ctx.now || new Date()).toISOString(),
  };
  items.forEach((it, idx) => {
    const n = idx + 1;
    const d = formatDate(it.date, c.locale, c.timezone);
    data[`item${n}_title`] = it.title;
    data[`item${n}_link`] = it.link;
    data[`item${n}_date`] = d.text;
    data[`item${n}_date_iso`] = d.iso;
    data[`item${n}_summary`] = plain(it.summaryHtml, chars);
    data[`item${n}_image`] = it.image;
    data[`item${n}_author`] = it.author;
  });
  const columns = [{ name: 'Title', key: 'title' }, { name: 'Date', key: 'date' }, { name: 'Summary', key: 'summary' }];
  const sample = items.slice(0, 5).map((it, i) => ({ title: it.title, date: data[`item${i + 1}_date`], summary: data[`item${i + 1}_summary`] }));
  return { data, table: { columns, sample } };
}

module.exports = { validateRssConfig, parseFeed, decodeEntities, plain, resolveRss };
