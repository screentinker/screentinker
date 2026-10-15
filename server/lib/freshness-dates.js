'use strict';

/*
 * "This slide mentions a date that has passed": the detector behind the Freshness chips.
 *
 * ⚠️ CONSERVATIVE BY DESIGN. A false "past date" on a sign that is fine teaches the operator to
 * ignore the chip, and an ignored chip is worth less than no chip. So this recognises only shapes a
 * human would read as a calendar date with confidence, and every finding carries a sentence saying
 * exactly how it was read, so a wrong one is visibly wrong rather than mysteriously wrong:
 *
 *   - a month NAME with a day and/or a year ("Oct 3", "3rd October 2025", "October 2025");
 *   - a holiday or season WITH a year ("Christmas 2025", "Summer 2024");
 *   - a weekday with an ordinal day and no month ("Friday 12th"), only when exactly one month near
 *     the item's last change makes that weekday fall on that day;
 *   - numeric dates WITH a four-digit year (2025-10-03, 03/10/2025), in slide text only, and a
 *     day/month order that is ambiguous counts only when BOTH readings have passed.
 *
 * What it deliberately does not read: numbers with no year and no month name (24/7, 3/4 cup,
 * 9-5), bare years ("est. 2019", "© 2024"), and numeric dates in FILE NAMES — cameras and
 * screenshot tools stamp the capture date into the name (IMG_20230512, "Screenshot 2025-03-04"),
 * which says when the photo was taken, not that an event is over.
 *
 * ⚠️ A TEXT WITH ANY FUTURE DATE IS NOT FLAGGED. "Was Oct 3 — now through Dec 1" is a sign that
 * was updated, not one that rotted. Only the LATEST date a text mentions decides.
 *
 * ⚠️ A YEARLESS DATE IS READ RELATIVE TO WHEN THE ITEM WAS LAST CHANGED, not to today: "Sale ends
 * Oct 3" uploaded in September means this October 3rd; the same words read against today would
 * always be "next year" and never stale. The first occurrence on or after (last change - 14 days)
 * is the reading, and the explanation names the year it chose.
 *
 * All arithmetic is on UTC calendar days. A date counts as passed only once the whole day is over
 * everywhere (GRACE_SEC past its UTC midnight end), so a screen in Auckland and a server in UTC
 * never disagree about "yesterday".
 */

const DAY = 86400;
// The day after the date, plus 14 hours: the latest time zone (UTC+14) has finished the day too.
const GRACE_SEC = 14 * 3600;
// How far before the last change a yearless date may sit and still be read as "this year's".
const ANCHOR_BACK_DAYS = 14;

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const WEEKDAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };

const MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const WD_RE = '(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\\.?';
const DAY_RE = '(\\d{1,2})(?:st|nd|rd|th)?';
const YEAR_RE = "(?:,?\\s*'?(20\\d{2}))";
const RANGE_RE = '(?:\\s*(?:-|–|—|to|till|until)\\s*(\\d{1,2})(?:st|nd|rd|th)?)?';

// Order matters: the longer, more specific shapes are tried first and their spans are consumed.
const PATTERNS = [
  // Friday 12th December 2025 / Fri, 12 Dec / 12 December 2025 / 3rd-5th October
  { kind: 'dmy', re: new RegExp(`(?:\\b${WD_RE},?\\s+)?\\b${DAY_RE}${RANGE_RE}(?:\\s+of)?\\s+${MON_RE}${YEAR_RE}?\\b`, 'gi') },
  // October 3rd, 2025 / Oct 3-5 / Friday, October 3
  { kind: 'mdy', re: new RegExp(`(?:\\b${WD_RE},?\\s+)?\\b${MON_RE}\\s+${DAY_RE}${RANGE_RE}${YEAR_RE}?\\b`, 'gi') },
  // October 2025
  { kind: 'my', re: new RegExp(`\\b${MON_RE}\\s+'?(20\\d{2})\\b`, 'gi') },
  // Friday 12th (no month): only with an ordinal suffix, which is what makes "12" a date
  { kind: 'wd', re: new RegExp(`\\b${WD_RE},?\\s+(?:the\\s+)?(\\d{1,2})(st|nd|rd|th)\\b(?!\\s*(?:of\\s+)?${MON_RE})`, 'gi') },
];
const ISO_RE = /(?<![\w./-])(20\d{2})-(\d{1,2})-(\d{1,2})(?![\w/-])/g;
const NUMERIC_RE = /(?<![\w./-])(\d{1,2})[/.](\d{1,2})[/.](20\d{2})(?![\w/.-])/g;

/*
 * Holidays and seasons with a year. `end(y)` is the last day the phrase can still be current, as
 * [year, month, day]. Generous on purpose: "Christmas 2025" is over after Boxing Day, and a season
 * is over only once both hemispheres are done with it (southern summer 2025 runs into Feb 2026).
 */
const EVENTS = [
  { re: /\b(christmas|x[-\s]?mas)\s*'?(20\d{2})\b/gi, label: 'Christmas', end: (y) => [y, 12, 26] },
  { re: /\b(new\s+year'?s?\s+eve|nye)\s*'?(20\d{2})\b/gi, label: "New Year's Eve", end: (y) => [y + 1, 1, 1] },
  { re: /\b(halloween)\s*'?(20\d{2})\b/gi, label: 'Halloween', end: (y) => [y, 11, 1] },
  { re: /\b(valentine'?s?(?:\s+day)?)\s*'?(20\d{2})\b/gi, label: "Valentine's Day", end: (y) => [y, 2, 15] },
  { re: /\b(black\s+friday|cyber\s+monday)\s*'?(20\d{2})\b/gi, label: 'Black Friday', end: (y) => [y, 12, 3] },
  { re: /\b(thanksgiving)\s*'?(20\d{2})\b/gi, label: 'Thanksgiving', end: (y) => [y, 11, 30] },
  { re: /\b(easter)\s*'?(20\d{2})\b/gi, label: 'Easter', end: (y) => { const e = easter(y); return addDays(e, 1); } },
  { re: /\b(st\.?\s+patrick'?s?(?:\s+day)?|saint\s+patrick'?s?(?:\s+day)?)\s*'?(20\d{2})\b/gi, label: "St Patrick's Day", end: (y) => [y, 3, 18] },
  { re: /\b(hanukkah|chanukah)\s*'?(20\d{2})\b/gi, label: 'Hanukkah', end: (y) => [y + 1, 1, 6] },
  { re: /\b(spring|summer|autumn|fall|winter)\s*'?(20\d{2})\b/gi, label: null, end: (y) => [y + 1, 2, 28] },
];

/*
 * Out-of-season holidays, for items with NO year. In-season windows as [month, day] pairs, generous
 * at both ends (people put Christmas up in mid October). A window may wrap the year end.
 */
const SEASONAL = [
  { re: /\b(christmas|x-?mas)\b/i, label: 'Christmas', from: [10, 15], to: [1, 6] },
  { re: /\bhalloween\b/i, label: 'Halloween', from: [9, 1], to: [11, 1] },
  { re: /\bvalentine'?s?\b/i, label: "Valentine's Day", from: [1, 10], to: [2, 15] },
  { re: /\b(black\s+friday|cyber\s+monday)\b/i, label: 'Black Friday', from: [10, 15], to: [12, 5] },
  { re: /\bthanksgiving\b/i, label: 'Thanksgiving', from: [9, 20], to: [11, 30] },
  { re: /\beaster\b/i, label: 'Easter', from: [2, 15], to: [4, 30] },
  { re: /\b(st\.?|saint)\s+patrick'?s?\b/i, label: "St Patrick's Day", from: [2, 15], to: [3, 18] },
  { re: /\b(hanukkah|chanukah)\b/i, label: 'Hanukkah', from: [11, 1], to: [1, 6] },
  { re: /\b(new\s+year'?s?\s+eve|nye)\b/i, label: "New Year's Eve", from: [12, 1], to: [1, 2] },
];

// ---------------------------------------------------------------------------------------------
// Calendar helpers (UTC, [y, m, d] triples)
// ---------------------------------------------------------------------------------------------

function utcEpoch(y, m, d) { return Date.UTC(y, m - 1, d) / 1000; }
function validDate(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function addDays([y, m, d], n) {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
}
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function iso([y, m, d]) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function ymdOf(epochSec) {
  const dt = new Date(epochSec * 1000);
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
}
function human([y, m, d]) { return `${d} ${MONTH_NAMES[m]} ${y}`; }

/** Western (Gregorian) Easter Sunday — the anonymous Gregorian algorithm. */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [y, month, day];
}

/** Has the whole of this calendar day ended everywhere on Earth, as of `now`? */
function isPast(ymd, now) {
  return utcEpoch(ymd[0], ymd[1], ymd[2]) + DAY + GRACE_SEC <= now;
}

/** The first (month, day) on or after the anchor's lookback start; null when it cannot exist. */
function inferYear(m, d, anchor) {
  const start = ymdOf(anchor - ANCHOR_BACK_DAYS * DAY);
  for (const y of [start[0], start[0] + 1, start[0] + 2, start[0] + 3, start[0] + 4]) {
    if (!validDate(y, m, d)) continue; // 29 Feb: try the following years
    if (utcEpoch(y, m, d) >= utcEpoch(start[0], start[1], start[2])) return y;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------------------------

/**
 * Every date a text mentions, as { ymd: [y,m,d] (the LAST day it covers), match, inferred, how }.
 * `source` is 'name' (a file or item name) or 'text' (words on a slide). Numeric shapes are read
 * only from 'text'. `anchor` (epoch seconds) is when the item was last changed.
 */
function findDates(text, { anchor, source = 'text' } = {}) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  let s = source === 'name' ? nameWords(text) : text;
  s = s.slice(0, 4000);
  // Spans already claimed by a more specific pattern, so "12th December 2025" is not also "Friday 12th".
  const taken = [];
  const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
  const claim = (a, b) => taken.push([a, b]);

  for (const ev of EVENTS) {
    for (const m of s.matchAll(ev.re)) {
      const y = Number(m[2]);
      const ymd = ev.end(y);
      claim(m.index, m.index + m[0].length);
      out.push({ ymd, match: m[0], inferred: false, how: 'event', label: ev.label || cap(m[1]) });
    }
  }

  for (const p of PATTERNS) {
    for (const m of s.matchAll(p.re)) {
      const a = m.index, b = m.index + m[0].length;
      if (!free(a, b)) continue;
      let r = null;
      if (p.kind === 'dmy') r = fromParts(Number(m[3] || m[2]), MONTHS[m[4].toLowerCase()], m[5], anchor);
      else if (p.kind === 'mdy') r = fromParts(Number(m[4] || m[3]), MONTHS[m[2].toLowerCase()], m[5], anchor);
      else if (p.kind === 'my') {
        const mo = MONTHS[m[1].toLowerCase()];
        const y = Number(m[2]);
        // "may 2025" is still a month: the year makes it one.
        r = { ymd: [y, mo, lastDayOfMonth(y, mo)], inferred: false, how: 'month' };
      } else if (p.kind === 'wd') {
        r = weekdayOrdinal(WEEKDAYS[m[1].toLowerCase()], Number(m[2]), anchor);
      }
      if (!r) continue;
      claim(a, b);
      out.push({ ...r, match: m[0].trim() });
    }
  }

  if (source === 'text') {
    for (const m of s.matchAll(ISO_RE)) {
      if (!free(m.index, m.index + m[0].length)) continue;
      const ymd = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (!validDate(...ymd)) continue;
      claim(m.index, m.index + m[0].length);
      out.push({ ymd, match: m[0], inferred: false, how: 'numeric' });
    }
    for (const m of s.matchAll(NUMERIC_RE)) {
      if (!free(m.index, m.index + m[0].length)) continue;
      const a1 = Number(m[1]), a2 = Number(m[2]), y = Number(m[3]);
      // dd/mm and mm/dd: keep every valid reading; the LATER one decides, so an ambiguous date is
      // "past" only when both readings are.
      const readings = [[y, a2, a1], [y, a1, a2]].filter((r) => validDate(...r));
      if (!readings.length) continue;
      readings.sort((x, z) => utcEpoch(...z) - utcEpoch(...x));
      claim(m.index, m.index + m[0].length);
      out.push({ ymd: readings[0], match: m[0], inferred: false, how: readings.length > 1 && a1 !== a2 ? 'numeric-ambiguous' : 'numeric' });
    }
  }
  return out;
}

/*
 * A file name's separators are spaces to a reader: christmas_2025_menu.png and
 * christmas-2025-menu.png both say "Christmas 2025", and the extension is not a word.
 * ⚠️ A '-' or '.' BETWEEN TWO DIGITS stays: it is part of a number ("v2-2025-03", "Oct 3-5", "1.2"),
 * and turning "Oct 3-5" into "Oct 3 5" would read the range's START as its end.
 */
function nameWords(text) {
  return String(text)
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_+]+/g, ' ')
    .replace(/(?<!\d)[-.]+|[-.]+(?!\d)/g, ' ');
}

function cap(w) { return String(w || '').replace(/^\w/, (c) => c.toUpperCase()); }

/** Day + month (+ year): validated, the year inferred from the anchor when absent. */
function fromParts(day, month, yearStr, anchor) {
  if (!month || !(day >= 1 && day <= 31)) return null;
  if (yearStr) {
    const y = Number(yearStr);
    return validDate(y, month, day) ? { ymd: [y, month, day], inferred: false, how: 'date' } : null;
  }
  if (!anchor) return null;
  const y = inferYear(month, day, anchor);
  return y ? { ymd: [y, month, day], inferred: true, how: 'date' } : null;
}

/*
 * "Friday 12th": which month? Walk forward from the anchor's lookback start for at most three
 * months and take the first month whose 12th is a Friday. Further than that and the reading is a
 * guess, so it is dropped.
 */
function weekdayOrdinal(wd, day, anchor) {
  if (wd == null || !anchor || !(day >= 1 && day <= 31)) return null;
  let [y, m] = ymdOf(anchor - ANCHOR_BACK_DAYS * DAY);
  const startEpoch = anchor - ANCHOR_BACK_DAYS * DAY - DAY;
  for (let i = 0; i < 4; i++) {
    if (validDate(y, m, day) && new Date(Date.UTC(y, m - 1, day)).getUTCDay() === wd
        && utcEpoch(y, m, day) >= startEpoch) {
      return { ymd: [y, m, day], inferred: true, how: 'weekday' };
    }
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return null;
}

/**
 * The verdict for one text: null, or { date: 'YYYY-MM-DD', match, inferred, explain } when the
 * LATEST date it mentions has passed. `explain` is the sentence the tooltip shows.
 */
function pastDateIn(text, { now = Math.floor(Date.now() / 1000), anchor = now, source = 'text' } = {}) {
  return pastDateInParts([{ text, source }], { now, anchor });
}

/**
 * The same verdict over several texts of ONE item (its name, each field on its slide): the latest
 * date across all of them decides, so a slide whose headline says "Oct 3" and whose footer says
 * "next event Dec 1" is not flagged.
 */
function pastDateInParts(parts, { now = Math.floor(Date.now() / 1000), anchor = now } = {}) {
  const found = [];
  for (const p of parts || []) {
    if (p && typeof p.text === 'string') found.push(...findDates(p.text, { anchor, source: p.source || 'text' }));
  }
  if (!found.length) return null;
  found.sort((a, b) => utcEpoch(...b.ymd) - utcEpoch(...a.ymd));
  const latest = found[0];
  if (!isPast(latest.ymd, now)) return null;
  let explain;
  if (latest.how === 'event') explain = `Mentions "${latest.match}", which ended ${human(latest.ymd)}.`;
  else if (latest.how === 'month') explain = `Mentions "${latest.match}", which ended ${human(latest.ymd)}.`;
  else if (latest.inferred) {
    explain = `Mentions "${latest.match}". This was last changed on ${iso(ymdOf(anchor))}, so it reads as ${human(latest.ymd)}, which has passed.`;
  } else if (latest.how === 'numeric-ambiguous') {
    explain = `Mentions "${latest.match}", which has passed whichever way the day and month are read.`;
  } else explain = `Mentions "${latest.match}" (${human(latest.ymd)}), which has passed.`;
  return { date: iso(latest.ymd), match: latest.match, inferred: !!latest.inferred, explain };
}

/*
 * In season, or within SEASON_LEAD_DAYS before it starts. ⚠️ Only a LEFTOVER is flagged: Christmas
 * artwork in February is rot, Christmas artwork in September is somebody planning ahead, and the
 * second must never be told off.
 */
const SEASON_LEAD_DAYS = 60;
function inOrAhead(h, now, y) {
  for (const yy of [y - 1, y]) {
    const start = utcEpoch(yy, h.from[0], h.from[1]) - SEASON_LEAD_DAYS * DAY;
    const endY = (h.to[0] * 100 + h.to[1]) < (h.from[0] * 100 + h.from[1]) ? yy + 1 : yy;
    const end = utcEpoch(endY, h.to[0], h.to[1]) + DAY + GRACE_SEC;
    if (now >= start && now < end) return true;
  }
  return false;
}

/** Out-of-season holiday with no year: { holiday, explain } or null. */
function outOfSeason(text, { now = Math.floor(Date.now() / 1000), source = 'text' } = {}) {
  if (typeof text !== 'string' || !text) return null;
  // A text that names a date of its own is the past-date detector's to judge: "Christmas 2026" in
  // October is an advert running early, not a leftover.
  if (findDates(text, { anchor: now, source }).length) return null;
  const s = text.replace(/[_+]+/g, ' ').slice(0, 4000);
  const [y] = ymdOf(now);
  for (const h of SEASONAL) {
    if (!h.re.test(s)) continue;
    if (inOrAhead(h, now, y)) continue;
    return { holiday: h.label, explain: `Mentions ${h.label}, which is out of season (${MONTH_NAMES[h.from[0]]} ${h.from[1]} to ${MONTH_NAMES[h.to[0]]} ${h.to[1]}).` };
  }
  return null;
}

module.exports = { pastDateIn, pastDateInParts, outOfSeason, findDates, easter, isPast, GRACE_SEC };
