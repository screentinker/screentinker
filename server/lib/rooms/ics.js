'use strict';

/*
 * A room calendar published as an ICS URL (Outlook "publish calendar", Google "secret address in
 * iCal format", most booking systems). Read-only: nothing can be booked or released through it.
 *
 * Fetched through the existing iCal resolver, so it gets the same SSRF guard, size cap and RRULE
 * expansion as the iCal data source.
 */

const { resolveIcalData } = require('../data-sources/ical-resolver');
const { midnightIn } = require('./freebusy');

let testFetcher = null;   // tests: (url) => ics text

function organiserOf(o) {
  if (!o) return '';
  if (typeof o === 'string') return o.replace(/^mailto:/i, '');
  if (o.params && o.params.CN) return String(o.params.CN).replace(/^"|"$/g, '');
  return String(o.val || '').replace(/^mailto:/i, '');
}

/** node-ical gives an all-day date as local midnight on the SERVER; re-anchor it in the room's zone. */
function allDayMs(d, tz) {
  return midnightIn(tz || 'UTC', d.getFullYear(), d.getMonth() + 1, d.getDate());
}

async function events(url, tz) {
  const cfg = { raw_events: true, lookahead_days: 2, timezone: tz || 'UTC' };
  if (testFetcher) cfg.ics_data = await testFetcher(url);
  else cfg.url = url;
  const list = await resolveIcalData(cfg);
  return (Array.isArray(list) ? list : [])
    .filter((e) => e.status !== 'CANCELLED')
    .map((e) => ({
      id: String(e.uid),
      title: e.summary || '',
      organiser: e.organizerName || organiserOf(e.organizer),
      start: e.isAllDay ? allDayMs(e.start, tz) : e.start.getTime(),
      end: e.isAllDay ? allDayMs(e.end, tz) : e.end.getTime(),
      allDay: !!e.isAllDay,
      free: !!e.transparent,
      private: !!e.private,
    }))
    .filter((e) => Number.isFinite(e.start) && Number.isFinite(e.end));
}

function _setFetcher(fn) { testFetcher = fn || null; }

module.exports = { events, _setFetcher };
