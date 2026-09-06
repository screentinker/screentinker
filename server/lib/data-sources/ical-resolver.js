'use strict';

/**
 * iCal (.ics) Data Source Resolver for ScreenTinker.
 *
 * Ingests VCALENDAR feeds, handles RRULE recurring series, timezones,
 * and extracts standard structured fields for room signage and agenda displays.
 */

const ical = require('node-ical');
const http = require('http');
const https = require('https');
const { assertSafeUrl, pinnedLookup, SsrfError } = require('../ssrf-guard');

const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 4;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // refuse calendar feeds larger than 2 MB

/**
 * Fetch a calendar feed over HTTPS/HTTP with the project's SSRF guard applied.
 *
 * node-ical's built-in `fromURL` performs an unguarded fetch that follows redirects and
 * accepts any scheme, making it an open fetch primitive reachable by workspace editors.
 * Instead we fetch the bytes ourselves, reusing the hardened pipeline from the media
 * proxy: vet the URL (scheme + DNS + private-IP ranges), pin the socket to a vetted
 * address (defeating DNS rebinding), re-vet every redirect hop, and enforce a timeout.
 * The response body is then parsed locally with ical.sync.parseICS().
 *
 * @param {string} urlString - http(s) or webcal:// URL
 * @returns {Promise<string>} The raw calendar text
 */
function fetchCalendar(urlString) {
  const raw = String(urlString || '').trim().replace(/^webcal:\/\//i, 'https://');
  const deadline = Date.now() + FETCH_TIMEOUT_MS;

  const follow = (target, redirectsLeft) => new Promise((resolve, reject) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return reject(new Error('Calendar feed timed out'));
    }

    assertSafeUrl(target).then(({ url, addresses }) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(url, {
        method: 'GET',
        lookup: pinnedLookup(addresses),
        servername: url.hostname,
        headers: {
          'User-Agent': 'ScreenTinker-DataSource/2.0',
          'Accept': 'text/calendar, application/json, text/plain',
        },
      }, (res) => {
        const sc = res.statusCode;
        if (sc >= 300 && sc < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            return reject(new Error('Too many redirects fetching calendar feed'));
          }
          let next;
          try { next = new URL(res.headers.location, url).toString(); }
          catch (_) { return reject(new Error('Invalid redirect from calendar feed')); }
          return follow(next, redirectsLeft - 1).then(resolve, reject);
        }
        if (sc !== 200) {
          res.resume();
          return reject(new Error(`Calendar feed responded ${sc}`));
        }
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > MAX_BODY_BYTES) {
            res.destroy(new Error('Calendar feed exceeds size limit'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });

      const reqTimeout = Math.min(FETCH_TIMEOUT_MS, Math.max(100, deadline - Date.now()));
      req.setTimeout(reqTimeout, () => req.destroy(new Error('Calendar feed timed out')));
      req.on('error', reject);
      req.end();
    }, reject);
  });

  return follow(raw, MAX_REDIRECTS);
}

/**
 * Fetch and parse an iCal feed from a URL or raw string.
 *
 * @param {object} config Configuration object:
 *   - url: string (HTTP/HTTPS/webcal URL)
 *   - ics_data: string (optional raw .ics content)
 *   - locale: string ('de', 'en', default 'de')
 *   - timezone: string (IANA timezone, default 'local')
 *   - lookahead_days: number (default 14)
 *   - max_events: number (default 10)
 *   - event_type: 'all' | 'timed' | 'allday' (default 'all')
 *   - filter_text: string (case-insensitive include keyword)
 *   - exclude_text: string (case-insensitive exclude keyword)
 *   - hide_private: boolean (mask summary as 'Busy' / 'Belegt')
 * @param {Date} [nowRef] Reference timestamp for testing (default new Date())
 * @returns {Promise<object>} Structured data dictionary for template interpolation
 */
async function resolveIcalData(config = {}, nowRef = new Date()) {
  const url = (config?.url || '').trim().replace(/^webcal:\/\//i, 'https://');
  const locale = (config?.locale || 'de').toLowerCase().startsWith('en') ? 'en' : 'de';
  const lookaheadDays = Math.max(1, Math.min(365, parseInt(config?.lookahead_days, 10) || 14));
  const maxEvents = Math.max(1, Math.min(50, parseInt(config?.max_events, 10) || 10));
  const eventType = config?.event_type || 'all';
  const filterText = (config?.filter_text || config?.filter_include || '').trim();
  const excludeText = (config?.exclude_text || config?.filter_exclude || '').trim();
  const hidePrivate = !!config?.hide_private;
  // IANA timezone for display; defaults to the server's local zone when unset.
  const timezone = (config?.timezone || '').trim() || undefined;

  let parsedEvents = {};

  const inlineIcs = config?.ics_data || config?.raw_data || config?.raw_ics;
  if (inlineIcs) {
    try {
      parsedEvents = ical.sync.parseICS(inlineIcs);
    } catch (e) {
      throw new Error(`Invalid inline calendar data: ${e.message}`);
    }
  } else if (url) {
    const text = await fetchCalendar(url);
    try {
      parsedEvents = ical.sync.parseICS(text);
    } catch (e) {
      throw new Error(`Remote calendar data could not be parsed: ${e.message}`);
    }
  } else {
    throw new Error('No valid iCal URL or data provided');
  }

  const now = new Date(nowRef);
  const startWindow = new Date(now);
  startWindow.setHours(0, 0, 0, 0); // Start of today

  const endWindow = new Date(startWindow);
  endWindow.setDate(endWindow.getDate() + lookaheadDays);
  endWindow.setHours(23, 59, 59, 999);

  const flatEvents = [];

  for (const k in parsedEvents) {
    if (!Object.prototype.hasOwnProperty.call(parsedEvents, k)) continue;
    const ev = parsedEvents[k];
    if (ev.type !== 'VEVENT') continue;

    // Filter by text if configured (case-insensitive substring match; deliberately NOT a
    // regular expression so user-supplied patterns cannot cause ReDoS on adversarial input).
    const rawSummary = ev.summary || '';
    const summaryLower = rawSummary.toLowerCase();
    if (filterText && !summaryLower.includes(filterText.toLowerCase())) continue;
    if (excludeText && summaryLower.includes(excludeText.toLowerCase())) continue;

    // Check if event is all-day (datetype === 'date' or midnight-to-midnight whole days)
    const isAllDay = ev.datetype === 'date' || (
      ev.start instanceof Date && ev.end instanceof Date &&
      ev.start.getHours() === 0 && ev.start.getMinutes() === 0 && ev.start.getSeconds() === 0 &&
      ev.end.getHours() === 0 && ev.end.getMinutes() === 0 && ev.end.getSeconds() === 0 &&
      (ev.end - ev.start) >= 86400000 &&
      (ev.end - ev.start) % 86400000 === 0
    );
    if (eventType === 'timed' && isAllDay) continue;
    if (eventType === 'allday' && !isAllDay) continue;

    const summary = hidePrivate ? (locale === 'de' ? 'Belegt' : 'Busy') : (rawSummary || (locale === 'de' ? 'Termin' : 'Event'));
    const organizer = hidePrivate ? '' : (ev.organizer?.val || ev.organizer || '');
    const location = ev.location || '';
    const description = hidePrivate ? '' : (ev.description || '');

    // Collect EXDATE exclusions
    const exdateKeys = new Set();
    if (ev.exdate) {
      const exList = Array.isArray(ev.exdate) ? ev.exdate : Object.values(ev.exdate);
      for (const ex of exList) {
        const d = new Date(ex);
        if (!isNaN(d.getTime())) {
          exdateKeys.add(d.toISOString().slice(0, 10));
          exdateKeys.add(d.getTime());
        }
      }
    }

    // Handle RRULE series
    if (ev.rrule) {
      try {
        const dates = ev.rrule.between(startWindow, endWindow, true);
        const durationMs = ev.end ? (new Date(ev.end).getTime() - new Date(ev.start).getTime()) : 3600000;

        for (const date of dates) {
          const occStart = new Date(date);
          const dateKey = occStart.toISOString().slice(0, 10);
          if (exdateKeys.has(dateKey) || exdateKeys.has(occStart.getTime())) continue;

          let occSummary = summary;
          let occLocation = location;
          let occDescription = description;
          if (ev.recurrences && (ev.recurrences[dateKey] || ev.recurrences[occStart.toISOString()])) {
            const rec = ev.recurrences[dateKey] || ev.recurrences[occStart.toISOString()];
            if (rec.summary && !hidePrivate) occSummary = rec.summary;
            if (rec.location) occLocation = rec.location;
            if (rec.description && !hidePrivate) occDescription = rec.description;
          }

          const occEnd = new Date(occStart.getTime() + durationMs);

          // Skip if occurrence has already ended before now
          if (occEnd < now && !isAllDay) continue;

          flatEvents.push({
            summary: occSummary,
            start: occStart,
            end: occEnd,
            isAllDay,
            organizer,
            location: occLocation,
            description: occDescription,
          });
        }
      } catch (e) {
        console.warn(`[ical-resolver] Failed to expand RRULE for "${ev.summary}": ${e.message}`);
      }
    } else if (ev.start) {
      const evStart = new Date(ev.start);
      const evEnd = ev.end ? new Date(ev.end) : new Date(evStart.getTime() + 3600000);

      // Include if within window and hasn't already ended
      if (evEnd >= now && evStart <= endWindow) {
        flatEvents.push({
          summary,
          start: evStart,
          end: evEnd,
          isAllDay,
          organizer,
          location,
          description,
        });
      }
    }
  }

  // Sort events chronologically
  flatEvents.sort((a, b) => a.start.getTime() - b.start.getTime());

  // Truncate to max events
  const selectedEvents = flatEvents.slice(0, maxEvents);

  // Determine current active event (DTSTART <= now < DTEND)
  const currentEvent = flatEvents.find(e => !e.isAllDay && e.start <= now && e.end > now) || null;

  // Determine next upcoming event (DTSTART > now)
  const nextEvent = flatEvents.find(e => e.start > now) || null;

  // Format date and time helpers (honour the configured IANA timezone, falling back to
  // the server's local zone so times are never silently shifted for a different venue).
  const tzOpts = timezone ? { timeZone: timezone } : {};
  const dateKey = (d) => d.toLocaleDateString('en-CA', tzOpts); // YYYY-MM-DD in target zone
  const todayKey = dateKey(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = dateKey(tomorrow);

  const formatTime = (d) => d.toLocaleTimeString(locale === 'de' ? 'de-DE' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: locale !== 'de', ...tzOpts });
  const formatDate = (d) => {
    const key = dateKey(d);
    if (key === todayKey) return locale === 'de' ? 'Heute' : 'Today';
    if (key === tomorrowKey) return locale === 'de' ? 'Morgen' : 'Tomorrow';

    return d.toLocaleDateString(locale === 'de' ? 'de-DE' : 'en-US', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...tzOpts,
    });
  };

  const isBusy = !!currentEvent;
  const statusDe = isBusy ? 'BELEGT' : 'FREI';
  const statusEn = isBusy ? 'BUSY' : 'AVAILABLE';
  const status = locale === 'de' ? statusDe : statusEn;

  let statusDetail = '';
  if (isBusy) {
    statusDetail = locale === 'de'
      ? `Belegt bis ${formatTime(currentEvent.end)}`
      : `Busy until ${formatTime(currentEvent.end)}`;
  } else if (nextEvent) {
    statusDetail = locale === 'de'
      ? `Frei bis ${formatTime(nextEvent.start)}`
      : `Free until ${formatTime(nextEvent.start)}`;
  } else {
    statusDetail = locale === 'de' ? 'Ganztägig frei' : 'Free all day';
  }

  // Build root dictionary payload
  const payload = {
    status,
    status_de: statusDe,
    status_en: statusEn,
    status_detail: statusDetail,
    is_busy: isBusy,

    current_title: currentEvent ? currentEvent.summary : '',
    current_summary: currentEvent ? currentEvent.summary : '',
    current_event_summary: currentEvent ? currentEvent.summary : '',
    current_time: currentEvent ? `${formatTime(currentEvent.start)} – ${formatTime(currentEvent.end)}` : '',
    current_organizer: currentEvent ? currentEvent.organizer : '',
    current_location: currentEvent ? currentEvent.location : '',
    current_event_location: currentEvent ? currentEvent.location : '',
    current_event_description: currentEvent ? currentEvent.description : '',

    next_title: nextEvent ? nextEvent.summary : '',
    next_summary: nextEvent ? nextEvent.summary : '',
    next_event_summary: nextEvent ? nextEvent.summary : '',
    next_time: nextEvent ? (nextEvent.isAllDay ? formatDate(nextEvent.start) : `${formatDate(nextEvent.start)}, ${formatTime(nextEvent.start)}`) : '',
    next_event_time: nextEvent ? (nextEvent.isAllDay ? formatDate(nextEvent.start) : `${formatDate(nextEvent.start)}, ${formatTime(nextEvent.start)}`) : '',
    next_date: nextEvent ? formatDate(nextEvent.start) : '',
    next_organizer: nextEvent ? nextEvent.organizer : '',

    total_upcoming_count: selectedEvents.length,
    event_count: selectedEvents.length,
    events_today_count: flatEvents.filter(e => dateKey(e.start) === todayKey).length,
  };

  // Populate indexed items (event_0_title, event_1_title, ...)
  selectedEvents.forEach((ev, idx) => {
    payload[`event_${idx}_title`] = ev.summary;
    payload[`event_${idx}_summary`] = ev.summary;
    payload[`event_${idx}_date`] = ev.isAllDay ? formatDate(ev.start) : `${formatDate(ev.start)}, ${formatTime(ev.start)}`;
    payload[`event_${idx}_time`] = ev.isAllDay ? (locale === 'de' ? 'Ganztägig' : 'All day') : `${formatTime(ev.start)} – ${formatTime(ev.end)}`;
    payload[`event_${idx}_location`] = ev.location || '';
    payload[`event_${idx}_organizer`] = ev.organizer || '';
  });

  // Multi-line formatted agenda text
  payload.agenda_text = selectedEvents
    .map(ev => `${ev.isAllDay ? formatDate(ev.start) : formatTime(ev.start)}: ${ev.summary}`)
    .join('\n');

  return payload;
}

module.exports = {
  resolveIcalData,
};
