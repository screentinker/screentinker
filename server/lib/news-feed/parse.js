'use strict';

/*
 * News feed parsing: RSS 2.0, RSS 1.0 (RDF), Atom and JSON Feed → one item shape
 *
 *   { title, link, summary, published, image }
 *
 * title/summary are PLAIN TEXT (tags stripped, entities decoded, whitespace collapsed), link/image
 * are absolute http(s) URLs or '', published is an ISO string or null.
 *
 * ⚠️ NOT AN XML PARSER, ON PURPOSE, like lib/data-sources/rss-resolver.js: a scan for elements over
 * a size-capped string. No DTD processing, no external entities, no entity expansion beyond the XML
 * five, numeric references and a fixed table of HTML names — so XXE and "billion laughs" have
 * nothing to act on. Real-world feeds are often not well-formed XML (a bare `&` in a title, an HTML
 * entity XML does not define), and a strict parser would refuse exactly the feeds people paste
 * most; this reads them.
 *
 * ⚠️ LINEAR TIME IN THE INPUT, ON PURPOSE. Anyone who can make a news widget can point it at a feed
 * they wrote, and this runs on the main thread. The element access below used to be lazy regexes
 * (/<item…>([\s\S]*?)<\/item>/g and the like), which are quadratic on a run of openers with no
 * closer: 50 KB of "<item>" or "<!--" took tens to hundreds of ms, 4 MB would take minutes. They are
 * now indexOf-style scans (lib/news-feed/scan.js explains the one idea behind all of them) that give
 * the same answers — test/news-feed-linear.test.js holds the old regexes and checks both agree. Do
 * not bring back a `[\s\S]*?` or an unbounded `[^>]*` over feed text; small token regexes with no
 * nested quantifier (an opener, a closer) are fine.
 *
 * Everything here is pure: no I/O. lib/news-feed/index.js fetches and caches.
 */

const { stripTags } = require('../strip-tags');
const {
  isWs, finder, gtFinder, replacePairs, replaceBlocks, closerByName, replaceOpenTags, esc,
} = require('./scan');

const MAX_INPUT = 4 * 1024 * 1024;
const MAX_ITEMS = 100;
const TITLE_MAX = 300;
const SUMMARY_MAX = 400;

/* ───────────── bytes → text ───────────── */

/**
 * Decode a response body. The charset comes from (in order) a BOM, the Content-Type header, the
 * XML declaration, an HTML <meta charset>; UTF-8 otherwise. A label TextDecoder does not know
 * falls back to UTF-8 rather than failing the feed.
 */
function decodeBody(buf, contentType = '') {
  if (typeof buf === 'string') return buf;
  if (!buf || !buf.length) return '';
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return decodeAs(buf.subarray(2), 'utf-16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return decodeAs(buf.subarray(2), 'utf-16be');
  let label = (/charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentType)) || [])[1];
  if (!label) {
    const head = buf.subarray(0, 2048).toString('latin1');
    label = (/^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head) || [])[1]
      || (/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head) || [])[1];
  }
  return decodeAs(buf, label || 'utf-8');
}
function decodeAs(buf, label) {
  let dec;
  try { dec = new TextDecoder(String(label).toLowerCase()); } catch (_) { return buf.toString('utf8'); }
  // windows-1252 (which the Encoding Standard also uses for latin1, iso-8859-1 and us-ascii) is
  // decoded by hand. Node 22.14, the floor, decodes it as ISO-8859-1, so 0x80-0x9F (curly quotes,
  // dashes, the euro sign) came out as C1 control characters.
  if (dec.encoding === 'windows-1252') return decodeCp1252(buf);
  return dec.decode(buf);
}
// 0x80-0x9F in windows-1252. The five undefined bytes map to the matching C1 code point, as the
// Encoding Standard does.
const CP1252_C1 = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f'
  + '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';
function decodeCp1252(buf) {
  const s = buf.toString('latin1');
  return /[\x80-\x9f]/.test(s) ? s.replace(/[\x80-\x9f]/g, (c) => CP1252_C1[c.charCodeAt(0) - 0x80]) : s;
}

/* ───────────── entities ───────────── */

// The HTML names that actually turn up in feeds. Anything else is left as written.
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', sbquo: '‚', bdquo: '„', laquo: '«', raquo: '»',
  lsaquo: '‹', rsaquo: '›', mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·', prime: '′',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½',
  frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', micro: 'µ', para: '¶', sect: '§', cent: '¢',
  pound: '£', euro: '€', yen: '¥', iexcl: '¡', iquest: '¿', shy: '',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', ugrave: 'ù',
  uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù',
  Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
};

function safeChar(cp) {
  if (!Number.isFinite(cp) || cp < 9 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
  return String.fromCodePoint(cp);
}

/** One pass of entity decoding: numeric references and the names above. */
function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,8});/gi, (m, e) => {
    if (e[0] === '#') return safeChar(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });
}

/* ───────────── element access ───────────── */

/**
 * Where the opening tag that starts at `i` (just past "<name") ends: the index of its ">", -1 when
 * this opener does not count, -2 when no ">" is left at all (so no later opener can count either).
 * The scan for `(?:\s[^>]{0,maxAttr})?>`, plus `(?<!/)` before the ">" when noSelfClose.
 */
function openEnd(s, i, gt, maxAttr, noSelfClose) {
  const c = s.charCodeAt(i);
  if (c === 62) return i;
  if (!isWs(c)) return -1;
  const g = gt(i + 1);
  if (g < 0) return -2;
  if (g - (i + 1) > maxAttr) return -1;
  if (noSelfClose && s.charCodeAt(g - 1) === 47) return -1;
  return g;
}

/**
 * Raw inner text of the first <tag>…</tag> in block ('' when absent). Tag names are literal (media:content).
 * Was /<tag(?:\s[^>]{0,2000})?(?<!\/)>([\s\S]{0,200000}?)<\/tag\s*>/i.
 */
function rawOf(block, tag) {
  const open = new RegExp(`<${esc(tag)}`, 'gi');
  const gt = gtFinder(block);
  const close = finder(block, new RegExp(`</${esc(tag)}\\s*>`, 'gi'));
  let m;
  while ((m = open.exec(block))) {
    // noSelfClose is the old (?<!/): a self-closing <link href="…"/> has no content and must not swallow the next </link>.
    const end = openEnd(block, open.lastIndex, gt, 2000, true);
    if (end === -2) return '';
    if (end < 0) continue;
    const c = close(end + 1);
    if (!c) return '';
    if (c.index - (end + 1) <= 200000) return block.slice(end + 1, c.index);
  }
  return '';
}

/**
 * Element content as the author meant it: CDATA sections taken verbatim, everything between them
 * entity-decoded once. What comes out may itself be HTML (an escaped <description>), which plain()
 * then strips.
 */
function unwrap(s) {
  let out = '';
  let last = 0;
  for (;;) {
    const a = s.indexOf('<![CDATA[', last);
    if (a < 0) break;
    const b = s.indexOf(']]>', a + 9);
    if (b < 0) break;
    out += decodeEntities(s.slice(last, a)) + s.slice(a + 9, b);
    last = b + 3;
  }
  return out + decodeEntities(s.slice(last));
}

const textOf = (block, tag) => unwrap(rawOf(block, tag));

/**
 * Attribute `attr` of the first <tag …> in block whose attribute string passes filter.
 * Each <tag …> was /<tag\s([^>]{0,4000}?)\/?>/gi: the attributes run to the first ">", less a "/" before it.
 */
function attrOf(block, tag, attr, filter) {
  const open = new RegExp(`<${esc(tag)}`, 'gi');
  const gt = gtFinder(block);
  let m;
  while ((m = open.exec(block))) {
    const start = open.lastIndex + 1;
    if (!isWs(block.charCodeAt(start - 1))) continue;
    const g = gt(start);
    if (g < 0) return '';
    const end = g > start && block.charCodeAt(g - 1) === 47 ? g - 1 : g;
    if (end - start > 4000) continue;
    open.lastIndex = g + 1;
    const attrs = block.slice(start, end);
    if (filter && !filter(attrs)) continue;
    const v = attrIn(attrs, attr);
    if (v) return v;
  }
  return '';
}
function attrIn(attrs, attr) {
  const a = new RegExp(`(?:^|\\s)${esc(attr)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return a ? decodeEntities(a[1] !== undefined ? a[1] : (a[2] !== undefined ? a[2] : a[3])).trim() : '';
}

/* ───────────── values ───────────── */

const BLOCK_TAG = /<\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|td|th|table|section|article|blockquote|figure|figcaption|header|footer|hr|img)\b/gi;

/**
 * HTML or text → one line of plain text, clipped at a word boundary. Each step is the linear form of
 * the regex in its comment, applied in the same order.
 */
function plain(html, max) {
  let s = String(html == null ? '' : html);
  s = replacePairs(s, '<![CDATA[', ']]>', (inner) => inner);                     // /<!\[CDATA\[([\s\S]*?)\]\]>/g → $1
  s = replaceBlocks(s, /<(script|style|noscript|template)\b/gi, closerByName(s), ' '); // /<(script|…)\b[\s\S]*?<\/\1\s*>/gi
  s = replacePairs(s, '<!--', '-->', () => ' ');                                 // /<!--[\s\S]*?-->/g
  // Block boundaries become spaces; inline tags (<b>, <a>, <span>) vanish, so "in <b>x</b>." stays "in x.".
  s = replaceOpenTags(s, BLOCK_TAG, ' ');                                         // /<\/?(?:br|p|…)\b[^>]*>/gi
  s = stripTags(s);                                                               // /<[^>]*>/g (one pass is a fixed point)
  s = decodeEntities(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return s;
}

/** An absolute http(s) URL, resolved against base, or ''. */
function absUrl(raw, base) {
  const v = String(raw || '').trim();
  if (!v || v.length > 2000) return '';
  try {
    const u = base ? new URL(v, base) : new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (u.username || u.password) return '';
    return u.toString();
  } catch (_) { return ''; }
}

/** RFC 822 / ISO 8601 → ISO, or null. */
function isoDate(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  let d = new Date(v);
  // "Wed, 14 Oct 2026 20:44:21 EDT"-style zones Date handles; "CEST" and friends it does not.
  if (Number.isNaN(d.getTime())) d = new Date(zoneToGmt(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/**
 * v.replace(/\s+[A-Z]{3,5}$/, ' GMT') without the regex, which is quadratic on a long run of
 * whitespace inside the value (each space restarts \s+ and walks the run). v is trimmed.
 */
function zoneToGmt(v) {
  let k = 0;
  while (k < 6 && k < v.length && v.charCodeAt(v.length - 1 - k) >= 65 && v.charCodeAt(v.length - 1 - k) <= 90) k++;
  if (k < 3 || k > 5) return v;
  let a = v.length - k;
  if (a === 0 || !isWs(v.charCodeAt(a - 1))) return v;
  while (a > 0 && isWs(v.charCodeAt(a - 1))) a--;
  return v.slice(0, a) + ' GMT';
}

const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i;

const IMG_SRC_AT = /\s(?:data-src|src)\s*=\s*(?:"([^"]+)"|'([^']+)')/iy;

/**
 * The src (or data-src) of the first <img>. Was /<img\b[^>]*?\s(?:data-src|src)\s*=\s*(?:"…"|'…')/i:
 * the attribute must start before the tag's first ">". An <img> whose attributes before that ">"
 * hold no src means every <img> up to that ">" fails too (it sees a subset of the same attributes),
 * so the next one tried is past it.
 */
function firstImgSrc(html, base) {
  const h = String(html || '');
  const open = /<img\b/gi;
  let m;
  while ((m = open.exec(h))) {
    const g = h.indexOf('>', open.lastIndex);
    const end = g < 0 ? h.length : g;
    for (let q = open.lastIndex; q < end; q++) {
      if (!isWs(h.charCodeAt(q))) continue;
      IMG_SRC_AT.lastIndex = q;
      const a = IMG_SRC_AT.exec(h);
      if (a) return absUrl(decodeEntities(a[1] || a[2]), base);
    }
    if (g < 0) break;
    open.lastIndex = g;
  }
  return '';
}

/* ───────────── formats ───────────── */

/** Which format this text is, or null when it is not a feed. */
function detectFormat(text) {
  const head = String(text || '').slice(0, 8192).replace(/^\uFEFF/, '');
  if (/^\s*\{/.test(head)) {
    return /"version"\s*:\s*"https?:\/\/jsonfeed\.org\/version\//i.test(String(text).slice(0, 65536)) ? 'json' : null;
  }
  // Was head.replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/i, '').
  let body = head;
  const decl = body.indexOf('<?xml');
  const declEnd = decl < 0 ? -1 : body.indexOf('?>', decl + 5);
  if (declEnd >= 0) body = body.slice(0, decl) + body.slice(declEnd + 2);
  body = replacePairs(body, '<!--', '-->', () => '');
  const dt = /<!DOCTYPE/i.exec(body);
  const dtEnd = dt ? body.indexOf('>', dt.index + 9) : -1;
  if (dtEnd >= 0) body = body.slice(0, dt.index) + body.slice(dtEnd + 1);
  if (/<rss[\s>]/i.test(body)) return 'rss';
  if (/<rdf:RDF[\s>]/i.test(body)) return 'rdf';
  if (/<feed[\s>]/i.test(body)) return 'atom';
  return null;
}

function itemImage(b, summaryHtml, base) {
  const notAv = (a) => !/medium\s*=\s*["'](?:video|audio)/i.test(a) && !/type\s*=\s*["'](?:video|audio)\//i.test(a);
  return absUrl(attrOf(b, 'media:content', 'url', (a) => notAv(a) && (/medium\s*=\s*["']image/i.test(a) || /type\s*=\s*["']image\//i.test(a) || IMAGE_EXT.test(attrIn(a, 'url')))), base)
    || absUrl(attrOf(b, 'media:thumbnail', 'url'), base)
    || absUrl(attrOf(b, 'enclosure', 'url', (a) => /type\s*=\s*["']image\//i.test(a) || IMAGE_EXT.test(attrIn(a, 'url'))), base)
    || absUrl(attrOf(b, 'itunes:image', 'href'), base)
    || absUrl(textOf(textOf(b, 'image'), 'url') || (/^\s*https?:\/\//.test(textOf(b, 'image')) ? textOf(b, 'image') : ''), base)
    || firstImgSrc(summaryHtml, base);
}

function finishItem(it) {
  let title = plain(it.title, TITLE_MAX);
  const summary = plain(it.summaryHtml, SUMMARY_MAX);
  if (!title && summary) title = plain(summary, 120);
  return { title, link: it.link || '', summary: summary === title ? '' : summary, published: it.published || null, image: it.image || '' };
}

/** /<guid(\s[^>]*)?>/i.exec(b)[1]: the attributes of the first <guid> tag ('' when it has none). */
function guidAttrs(b) {
  const open = /<guid/gi;
  let m;
  while ((m = open.exec(b))) {
    const c = b.charCodeAt(open.lastIndex);
    if (c === 62) return '';
    if (!isWs(c)) continue;
    const g = b.indexOf('>', open.lastIndex + 1);
    return g < 0 ? '' : b.slice(open.lastIndex, g);
  }
  return '';
}

/** /<item(\s[^>]*)>/i.exec(whole)[1]: the attributes of the first <item …> in an item ('' when none). */
function itemAttrs(whole) {
  const open = /<item/gi;
  let m;
  while ((m = open.exec(whole))) {
    if (!isWs(whole.charCodeAt(open.lastIndex))) continue;
    const g = whole.indexOf('>', open.lastIndex + 1);
    return g < 0 ? '' : whole.slice(open.lastIndex, g);
  }
  return '';
}

function parseXmlFeed(raw, format, base) {
  // Comments first: one that mentions a tag (an <image> in a note) would otherwise be read as one.
  const src = replacePairs(raw, '<!--', '-->', () => '');
  const atom = format === 'atom';
  const itemTag = atom ? 'entry' : 'item';
  const firstItem = src.search(new RegExp(`<${itemTag}[\\s>]`, 'i'));
  let channel = firstItem >= 0 ? src.slice(0, firstItem) : src;
  // RSS 2.0's <image> carries its own <title>/<link>: drop it before reading the channel's.
  // Was channel.replace(/<image[\s>][\s\S]*?<\/image\s*>/gi, '').
  const imageClose = finder(channel, /<\/image\s*>/gi);
  channel = replaceBlocks(channel, /<image[\s>]/gi, () => imageClose, '');
  const feedTitle = plain(textOf(channel, 'title'), 200);
  const feedLink = atom
    ? absUrl(attrOf(channel, 'link', 'href', (a) => !/rel\s*=\s*["'](?!alternate)/i.test(a)), base)
    : absUrl(textOf(replaceOpenTags(channel, /<atom:link/gi, ''), 'link'), base);

  // Each item was /<item(?:\s[^>]{0,2000})?>([\s\S]*?)<\/item\s*>/gi (entry for Atom).
  const items = [];
  const open = new RegExp(`<${itemTag}`, 'gi');
  const gt = gtFinder(src);
  const close = finder(src, new RegExp(`</${itemTag}\\s*>`, 'gi'));
  let m;
  while (items.length < MAX_ITEMS && (m = open.exec(src))) {
    const end = openEnd(src, open.lastIndex, gt, 2000, false);
    if (end === -2) break;
    if (end < 0) continue;
    const c = close(end + 1);
    if (!c) break;
    open.lastIndex = c.end;
    const b = src.slice(end + 1, c.index);
    const whole = src.slice(m.index, c.end);
    let summaryHtml, link, published;
    if (atom) {
      summaryHtml = textOf(b, 'summary') || textOf(b, 'content') || textOf(b, 'media:description');
      link = absUrl(attrOf(b, 'link', 'href', (a) => !/rel\s*=\s*["'](?!alternate)/i.test(a)), base);
      published = isoDate(textOf(b, 'published') || textOf(b, 'updated') || textOf(b, 'issued'));
    } else {
      summaryHtml = textOf(b, 'description') || textOf(b, 'content:encoded') || textOf(b, 'media:description');
      const guid = rawOf(b, 'guid') ? textOf(b, 'guid') : '';
      const guidIsLink = /^\s*https?:\/\//i.test(guid) && !/isPermaLink\s*=\s*["']false/i.test(guidAttrs(b));
      link = absUrl(textOf(b, 'link'), base) || absUrl(attrOf(b, 'link', 'href'), base) || (guidIsLink ? absUrl(guid, base) : '')
        || (format === 'rdf' ? absUrl(attrOf(`<x ${itemAttrs(whole)}>`, 'x', 'rdf:about'), base) : '');
      published = isoDate(textOf(b, 'pubDate') || textOf(b, 'dc:date') || textOf(b, 'published') || textOf(b, 'updated'));
    }
    items.push(finishItem({
      title: textOf(b, 'title') || textOf(b, 'media:title'),
      summaryHtml, link, published, image: itemImage(b, summaryHtml, base),
    }));
  }
  return { format, title: feedTitle, link: feedLink, items: items.filter((i) => i.title) };
}

function parseJsonFeed(text, base) {
  let j;
  try { j = JSON.parse(text); } catch (_) { return null; }
  if (!j || typeof j !== 'object' || !Array.isArray(j.items)) return null;
  const str = (v) => (typeof v === 'string' ? v : '');
  const items = j.items.slice(0, MAX_ITEMS).filter((x) => x && typeof x === 'object').map((x) => finishItem({
    title: str(x.title),
    summaryHtml: str(x.summary) || str(x.content_text) || str(x.content_html),
    link: absUrl(str(x.url) || str(x.external_url), base),
    published: isoDate(str(x.date_published) || str(x.date_modified)),
    image: absUrl(str(x.image) || str(x.banner_image), base) || firstImgSrc(str(x.content_html), base),
  })).filter((i) => i.title);
  return { format: 'json', title: plain(str(j.title), 200), link: absUrl(str(j.home_page_url), base), items };
}

/**
 * Parse a feed. `base` is the feed's own URL, for relative links. Returns
 * { format, title, link, items } or null when the text is not a feed.
 */
function parseFeed(text, base = '') {
  const src = String(text == null ? '' : text).slice(0, MAX_INPUT).replace(/^\uFEFF/, '');
  const format = detectFormat(src);
  if (!format) return null;
  if (format === 'json') return parseJsonFeed(src, base);
  return parseXmlFeed(src, format, base);
}

module.exports = {
  parseFeed, detectFormat, decodeBody, decodeEntities, plain, absUrl, isoDate, attrIn, unwrap, firstImgSrc,
  MAX_ITEMS, TITLE_MAX,
  _test: { rawOf, attrOf, zoneToGmt, guidAttrs, itemAttrs },
};
