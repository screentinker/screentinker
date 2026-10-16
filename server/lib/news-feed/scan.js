'use strict';

/*
 * Linear-time building blocks for lib/news-feed/parse.js and discover.js.
 *
 * WHY THIS EXISTS. Both files read text a stranger controls (any feed or page a news widget points
 * at, up to several MB), and they used to do it with lazy regular expressions such as
 * /<item[^>]*>([\s\S]*?)<\/item\s*>/g. Every such pattern is quadratic on a run of openers with no
 * closer after them: each opener starts a match that walks to the end of the text before failing,
 * so 50 KB of "<item>" was ~1.25e9 steps and a 4 MB feed would pin the event loop for minutes.
 *
 * THE FIX, IN ONE IDEA. A lazy span `OPEN[\s\S]*?CLOSE` always ends at the FIRST closer after the
 * opener, and "the first closer at or after x" only moves forward as x does. So each closer is
 * searched for once and remembered (finder below), and an opener whose closer is missing means no
 * later opener has one either. `[^>]*>` is the same idea for the next ">". Small regexes are still
 * used to RECOGNISE tokens (an opener such as /<h[1-4]\b/i, a closer such as /<\/a\s*>/i): those
 * have no nested quantifier, run in linear time, and keep the exact character semantics (\s, \b,
 * case-insensitive matching) of the patterns they replace.
 *
 * Each caller documents the pattern it replaced; test/news-feed-linear.test.js checks the two
 * against each other on every fixture and a few thousand generated feeds and pages.
 */

/** JavaScript's \s: WhiteSpace and LineTerminator, by char code. */
function isWs(c) {
  return (c >= 9 && c <= 13) || c === 32 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
    || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
function skipWs(s, i) {
  while (i < s.length && isWs(s.charCodeAt(i))) i++;
  return i;
}

/**
 * The first match of global regex `re` in `s` starting at or after `at`: { index, end } or null.
 * Remembers its last answer, so queries that move forward cost one scan in all — the whole point.
 * Correct for queries in any order; only forward ones are cheap.
 */
function finder(s, re) {
  let from = -1;
  let hit = null;
  return (at) => {
    if (from >= 0 && at >= from && (hit === null || hit.index >= at)) return hit;
    re.lastIndex = at;
    const m = re.exec(s);
    from = at;
    hit = m ? { index: m.index, end: m.index + m[0].length } : null;
    return hit;
  };
}

/** finder() for a single ">": its index at or after `at`, or -1. */
function gtFinder(s) {
  let from = -1;
  let hit = -1;
  return (at) => {
    if (from >= 0 && at >= from && (hit < 0 || hit >= at)) return hit;
    from = at;
    hit = s.indexOf('>', at);
    return hit;
  };
}

/**
 * `s.replace(/OPEN[\s\S]*?CLOSE/g, fn(inner))` for literal, case-sensitive OPEN and CLOSE (comments,
 * CDATA sections). An opener with no closer after it ends the scan: no later one has a closer either.
 */
function replacePairs(s, open, close, fn) {
  let out = '';
  let i = 0;
  for (;;) {
    const a = s.indexOf(open, i);
    if (a < 0) break;
    const b = s.indexOf(close, a + open.length);
    if (b < 0) break;
    out += s.slice(i, a) + fn(s.slice(a + open.length, b));
    i = b + close.length;
  }
  return i === 0 ? s : out + s.slice(i);
}

/**
 * `s.replace(/OPENER[\s\S]*?CLOSER/gi, repl)` where `open` is a global regex for the opener and
 * closeFor(m) the finder() of the closer that goes with opener match m (one per tag name, for the
 * `<(script|style)\b…<\/\1` kind).
 */
function replaceBlocks(s, open, closeFor, repl) {
  open.lastIndex = 0;
  let out = '';
  let i = 0;
  let m;
  while ((m = open.exec(s))) {
    const c = closeFor(m)(open.lastIndex);
    if (!c) continue;
    out += s.slice(i, m.index) + repl;
    i = c.end;
    open.lastIndex = c.end;
  }
  return i === 0 ? s : out + s.slice(i);
}

/** closeFor() for replaceBlocks when the opener captured a tag name in group 1: `</name\s*>`. */
function closerByName(s) {
  const closers = new Map();
  return (m) => {
    const name = m[1].toLowerCase();
    if (!closers.has(name)) closers.set(name, finder(s, new RegExp(`</${name}\\s*>`, 'gi')));
    return closers.get(name);
  };
}

/** `s.replace(/OPENER[^>]*>/gi, repl)`: from each opener to the next ">". */
function replaceOpenTags(s, open, repl) {
  open.lastIndex = 0;
  let out = '';
  let i = 0;
  let m;
  while ((m = open.exec(s))) {
    const g = s.indexOf('>', open.lastIndex);
    if (g < 0) break;
    out += s.slice(i, m.index) + repl;
    i = g + 1;
    open.lastIndex = g + 1;
  }
  return i === 0 ? s : out + s.slice(i);
}

/**
 * Every match of /OPENER([^>]*)>([\s\S]*?)CLOSER/gi, in order: fn({ index, attrs, inner, end })
 * for each; fn returning false stops. `open` and `close` are global regexes.
 */
function eachBlock(s, open, close, fn) {
  const gt = gtFinder(s);
  const cl = finder(s, close);
  open.lastIndex = 0;
  let m;
  while ((m = open.exec(s))) {
    const start = open.lastIndex;
    const g = gt(start);
    if (g < 0) return;
    const c = cl(g + 1);
    if (!c) return;
    open.lastIndex = c.end;
    if (fn({ index: m.index, attrs: s.slice(start, g), inner: s.slice(g + 1, c.index), end: c.end }) === false) return;
  }
}

/** The first match of /OPENER([^>]*)>([\s\S]*?)CLOSER/i, as eachBlock gives it, or null. */
function firstBlock(s, open, close) {
  let hit = null;
  eachBlock(s, open, close, (b) => { hit = b; return false; });
  return hit;
}

/**
 * Every match of /OPENER([^>]{0,max})>/gi: fn(attrs, index) for each; fn returning false stops.
 * An opener whose ">" is more than `max` characters on is skipped, as the bounded regex did.
 */
function eachTag(s, open, max, fn) {
  const gt = gtFinder(s);
  open.lastIndex = 0;
  let m;
  while ((m = open.exec(s))) {
    const start = open.lastIndex;
    const g = gt(start);
    if (g < 0) return;
    if (g - start > max) continue;
    open.lastIndex = g + 1;
    if (fn(s.slice(start, g), m.index) === false) return;
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
  isWs, skipWs, finder, gtFinder, replacePairs, replaceBlocks, closerByName, replaceOpenTags,
  eachBlock, firstBlock, eachTag, esc,
};
