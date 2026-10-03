'use strict';

/**
 * iCal (.ics) Data Source Resolver for ScreenTinker.
 *
 * Ingests VCALENDAR feeds, handles RRULE recurring series, timezones,
 * and extracts standard structured fields for room signage and agenda displays.
 */

const ical = require('node-ical');
const { SsrfError, GuardedRequestError, guardedRequest } = require('../ssrf-guard');

const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 4;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // refuse calendar feeds larger than 2 MB

/**
 * Fetch a calendar feed over HTTPS/HTTP with the project's SSRF guard applied.
 *
 * @param {string} urlString - http(s) or webcal:// URL
 * @returns {Promise<string>} The raw calendar text
 */
async function fetchCalendar(urlString) {
  const raw = String(urlString || '').trim().replace(/^webcal:\/\//i, 'https://');
  try {
    const res = await guardedRequest(raw, {
      maxRedirects: MAX_REDIRECTS,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_BODY_BYTES,
      responseType: 'text',
      headers: {
        'User-Agent': 'ScreenTinker-DataSource/2.0',
        'Accept': 'text/calendar, application/json, text/plain',
      },
    });
    if (res.notModified || !res.text) {
      throw new GuardedRequestError('Calendar feed responded 304', 'upstream-status', 304);
    }
    return res.text;
  } catch (err) {
    if (err instanceof SsrfError) throw err;
    if (err.code === 'timeout') throw new GuardedRequestError('Calendar feed timed out', 'timeout');
    if (err.code === 'too-many-redirects') throw new GuardedRequestError('Too many redirects fetching calendar feed', 'too-many-redirects');
    if (err.code === 'bad-redirect') throw new GuardedRequestError('Invalid redirect from calendar feed', 'bad-redirect');
    if (err.code === 'size-limit') throw new GuardedRequestError('Calendar feed exceeds size limit', 'size-limit');
    if (err.code === 'upstream-status') throw new GuardedRequestError(`Calendar feed responded ${err.statusCode}`, 'upstream-status', err.statusCode);
    throw err;
  }
}

/*
 * #i18n — room-status strings for the iCal room-booking output, one entry per language the app
 * ships. The resolver produces these as literal text bound into slides via {{ds:name.status}},
 * so localization has to happen here (server-side), keyed off the data source's `locale` setting.
 * Unknown / unset locale falls back to English. busyUntil/freeUntil take an already-formatted time.
 *
 * Latin-script status words are upper-cased to match the existing BUSY/AVAILABLE convention.
 * ⚠️ The CJK and Hindi entries (ja/zh/hi) are best-effort and worth a native-speaker check.
 */
const ROOM_STRINGS = {
  en: { intl: 'en-US', hour12: true,  busy: 'BUSY', available: 'AVAILABLE', busyUntil: (t) => `Busy until ${t}`, freeUntil: (t) => `Free until ${t}`, freeAllDay: 'Free all day', allDay: 'All day', today: 'Today', tomorrow: 'Tomorrow', busyMask: 'Busy', eventFallback: 'Event' },
  de: { intl: 'de-DE', hour12: false, busy: 'BELEGT', available: 'FREI', busyUntil: (t) => `Belegt bis ${t}`, freeUntil: (t) => `Frei bis ${t}`, freeAllDay: 'Ganztägig frei', allDay: 'Ganztägig', today: 'Heute', tomorrow: 'Morgen', busyMask: 'Belegt', eventFallback: 'Termin' },
  nl: { intl: 'nl-NL', hour12: false, busy: 'BEZET', available: 'BESCHIKBAAR', busyUntil: (t) => `Bezet tot ${t}`, freeUntil: (t) => `Vrij tot ${t}`, freeAllDay: 'De hele dag vrij', allDay: 'Hele dag', today: 'Vandaag', tomorrow: 'Morgen', busyMask: 'Bezet', eventFallback: 'Afspraak' },
  es: { intl: 'es-ES', hour12: false, busy: 'OCUPADO', available: 'DISPONIBLE', busyUntil: (t) => `Ocupado hasta las ${t}`, freeUntil: (t) => `Libre hasta las ${t}`, freeAllDay: 'Libre todo el día', allDay: 'Todo el día', today: 'Hoy', tomorrow: 'Mañana', busyMask: 'Ocupado', eventFallback: 'Evento' },
  fr: { intl: 'fr-FR', hour12: false, busy: 'OCCUPÉ', available: 'LIBRE', busyUntil: (t) => `Occupé jusqu'à ${t}`, freeUntil: (t) => `Libre jusqu'à ${t}`, freeAllDay: 'Libre toute la journée', allDay: 'Journée entière', today: "Aujourd'hui", tomorrow: 'Demain', busyMask: 'Occupé', eventFallback: 'Événement' },
  pt: { intl: 'pt-PT', hour12: false, busy: 'OCUPADO', available: 'DISPONÍVEL', busyUntil: (t) => `Ocupado até ${t}`, freeUntil: (t) => `Livre até ${t}`, freeAllDay: 'Livre o dia todo', allDay: 'Dia inteiro', today: 'Hoje', tomorrow: 'Amanhã', busyMask: 'Ocupado', eventFallback: 'Evento' },
  it: { intl: 'it-IT', hour12: false, busy: 'OCCUPATO', available: 'LIBERO', busyUntil: (t) => `Occupato fino alle ${t}`, freeUntil: (t) => `Libero fino alle ${t}`, freeAllDay: 'Libero tutto il giorno', allDay: 'Tutto il giorno', today: 'Oggi', tomorrow: 'Domani', busyMask: 'Occupato', eventFallback: 'Evento' },
  hi: { intl: 'hi-IN', hour12: false, busy: 'व्यस्त', available: 'उपलब्ध', busyUntil: (t) => `${t} तक व्यस्त`, freeUntil: (t) => `${t} तक उपलब्ध`, freeAllDay: 'पूरे दिन उपलब्ध', allDay: 'पूरा दिन', today: 'आज', tomorrow: 'कल', busyMask: 'व्यस्त', eventFallback: 'कार्यक्रम' },
  ja: { intl: 'ja-JP', hour12: false, busy: '使用中', available: '空き', busyUntil: (t) => `${t} まで使用中`, freeUntil: (t) => `${t} まで空き`, freeAllDay: '終日空き', allDay: '終日', today: '今日', tomorrow: '明日', busyMask: '使用中', eventFallback: '予定' },
  zh: { intl: 'zh-CN', hour12: false, busy: '使用中', available: '空闲', busyUntil: (t) => `使用中，至 ${t}`, freeUntil: (t) => `空闲，至 ${t}`, freeAllDay: '全天空闲', allDay: '全天', today: '今天', tomorrow: '明天', busyMask: '使用中', eventFallback: '活动' },
};

// Map a data source's `locale` (may be null, 'en-US', 'nl', etc.) to a table key. Default English.
function pickRoomLocale(raw) {
  const code = String(raw || 'en').toLowerCase().split(/[-_]/)[0];
  return ROOM_STRINGS[code] ? code : 'en';
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
  const locale = pickRoomLocale(config?.locale);
  const L = ROOM_STRINGS[locale];
  const lookaheadDays = Math.max(1, Math.min(365, parseInt(config?.lookahead_days, 10) || 14));
  const maxEvents = Math.max(1, Math.min(50, parseInt(config?.max_events, 10) || 10));
  const eventType = config?.event_type || 'all';
  const filterText = (config?.filter_include || config?.filter_text || '').trim();
  const excludeText = (config?.filter_exclude || config?.exclude_text || '').trim();
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
  const tzOpts = timezone ? { timeZone: timezone } : {};
  const dateKey = (d) => d.toLocaleDateString('en-CA', tzOpts); // YYYY-MM-DD in target zone
  const todayKey = dateKey(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = dateKey(tomorrow);

  // Helper to format a calendar-day key honoring node-ical contract (d.dateOnly means local Y-M-D)
  const formatLocalDayKey = (d) => {
    if (!d || !(d instanceof Date) || isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const formatDayLabel = (key) => {
    if (key === todayKey) return L.today;
    if (key === tomorrowKey) return L.tomorrow;
    const [y, m, d] = key.split('-').map(Number);
    const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    return noonUtc.toLocaleDateString(L.intl, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  };

  const formatTime = (d) => d.toLocaleTimeString(L.intl, { hour: '2-digit', minute: '2-digit', hour12: L.hour12, ...tzOpts });

  const formatDate = (ev) => {
    if (ev.isAllDay) return formatDayLabel(ev.dayKey);
    const key = dateKey(ev.start);
    if (key === todayKey) return L.today;
    if (key === tomorrowKey) return L.tomorrow;
    return ev.start.toLocaleDateString(L.intl, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...tzOpts,
    });
  };

  const endWindow = new Date(now);
  endWindow.setDate(endWindow.getDate() + lookaheadDays);
  endWindow.setHours(23, 59, 59, 999);
  const endWindowDayKey = dateKey(endWindow);

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
    const isAllDay = Boolean(ev.datetype === 'date' || ev.start?.dateOnly || (
      ev.start instanceof Date && ev.end instanceof Date &&
      ev.start.getHours() === 0 && ev.start.getMinutes() === 0 && ev.start.getSeconds() === 0 &&
      ev.end.getHours() === 0 && ev.end.getMinutes() === 0 && ev.end.getSeconds() === 0 &&
      (ev.end - ev.start) >= 86400000 &&
      (ev.end - ev.start) % 86400000 === 0
    ));
    if (eventType === 'timed' && isAllDay) continue;
    if (eventType === 'allday' && !isAllDay) continue;

    const summary = hidePrivate ? L.busyMask : (rawSummary || L.eventFallback);
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
          if (isAllDay) exdateKeys.add(formatLocalDayKey(d));
        }
      }
    }

    // Handle RRULE series.
    if (ev.rrule) {
      try {
        const maxRruleExpansion = Math.max(50, maxEvents * 5);
        const durationMs = ev.end ? (new Date(ev.end).getTime() - new Date(ev.start).getTime()) : (isAllDay ? 86400000 : 3600000);

        const FREQ_NAMES = { 4: 'HOURLY', 5: 'MINUTELY', 6: 'SECONDLY' };
        const rawFreq = ev.rrule.options?.freq ?? ev.rrule.origOptions?.freq;
        const freq = String(FREQ_NAMES[rawFreq] || rawFreq || '').toUpperCase();
        const SPAN_MS = { HOURLY: 60 * 86400000, MINUTELY: 2 * 86400000, SECONDLY: 2 * 3600000 };

        const startOfToday = new Date(now);
        startOfToday.setHours(0, 0, 0, 0);
        const seriesStart = SPAN_MS[freq]
          ? new Date(now.getTime() - durationMs)
          : new Date(Math.min(startOfToday.getTime(), now.getTime() - durationMs));
        const seriesEnd = SPAN_MS[freq]
          ? new Date(Math.min(endWindow.getTime(), seriesStart.getTime() + SPAN_MS[freq]))
          : endWindow;
        let dates;
        try {
          dates = ev.rrule.between(seriesStart, seriesEnd, true) || [];
        } catch (capErr) {
          const narrowEnd = new Date(Math.min(seriesEnd.getTime(), now.getTime() + 86400000));
          dates = ev.rrule.between(seriesStart, narrowEnd, true) || [];
        }

        const hasOverride = (d) => {
          if (!ev.recurrences) return false;
          const dt = new Date(d);
          return Boolean(ev.recurrences[dt.toISOString().slice(0, 10)] || ev.recurrences[dt.toISOString()]);
        };
        dates = dates.filter((d) => isAllDay
          ? (formatLocalDayKey(new Date(d.getTime() + durationMs)) > todayKey)
          : (hasOverride(d) || (new Date(d).getTime() + durationMs) >= now.getTime()));
        if (dates.length > maxRruleExpansion) dates = dates.slice(0, maxRruleExpansion);

        for (const date of dates) {
          let occStart = new Date(date);
          let occEnd = new Date(occStart.getTime() + durationMs);
          const dateKeyIso = occStart.toISOString().slice(0, 10);
          const dayKey = isAllDay ? formatLocalDayKey(occStart) : dateKey(occStart);
          const endDayKey = isAllDay ? formatLocalDayKey(occEnd) : dateKey(occEnd);

          if (exdateKeys.has(dateKeyIso) || exdateKeys.has(occStart.getTime()) || (isAllDay && exdateKeys.has(dayKey))) continue;

          let occSummary = summary;
          let occLocation = location;
          let occDescription = description;
          if (ev.recurrences && (ev.recurrences[dateKeyIso] || ev.recurrences[occStart.toISOString()])) {
            const rec = ev.recurrences[dateKeyIso] || ev.recurrences[occStart.toISOString()];
            if (rec.summary && !hidePrivate) occSummary = rec.summary;
            if (rec.location) occLocation = rec.location;
            if (rec.description && !hidePrivate) occDescription = rec.description;
            if (rec.start) occStart = new Date(rec.start);
            if (rec.end) occEnd = new Date(rec.end);
            else if (rec.start) occEnd = new Date(occStart.getTime() + durationMs);
          }

          const occIsPast = isAllDay ? (endDayKey <= todayKey) : (occEnd < now);
          if (occIsPast) continue;

          flatEvents.push({
            summary: occSummary,
            start: occStart,
            end: occEnd,
            isAllDay,
            dayKey,
            endDayKey,
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
      const evEnd = ev.end ? new Date(ev.end) : new Date(evStart.getTime() + (isAllDay ? 86400000 : 3600000));
      const dayKey = isAllDay ? formatLocalDayKey(evStart) : dateKey(evStart);
      const endDayKey = isAllDay ? formatLocalDayKey(evEnd) : dateKey(evEnd);

      const isPast = isAllDay ? (endDayKey <= todayKey) : (evEnd < now);
      const isWithinWindow = isAllDay ? (dayKey <= endWindowDayKey) : (evStart <= endWindow);

      if (!isPast && isWithinWindow) {
        flatEvents.push({
          summary,
          start: evStart,
          end: evEnd,
          isAllDay,
          dayKey,
          endDayKey,
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

  // Determine current active event (timed event with DTSTART <= now < DTEND)
  const currentEvent = flatEvents.find(e => !e.isAllDay && e.start <= now && e.end > now) || null;

  // Determine next upcoming event (DTSTART > now for timed, dayKey > todayKey for all-day)
  const nextEvent = flatEvents.find(e => e.isAllDay ? e.dayKey > todayKey : e.start > now) || null;

  const isBusy = !!currentEvent;
  const statusDe = isBusy ? ROOM_STRINGS.de.busy : ROOM_STRINGS.de.available;
  const statusEn = isBusy ? ROOM_STRINGS.en.busy : ROOM_STRINGS.en.available;
  const status = isBusy ? L.busy : L.available;

  let statusDetail = '';
  if (isBusy) {
    statusDetail = L.busyUntil(formatTime(currentEvent.end));
  } else if (nextEvent) {
    const nextIsToday = nextEvent.isAllDay
      ? (nextEvent.dayKey <= todayKey && nextEvent.endDayKey > todayKey)
      : (dateKey(nextEvent.start) === todayKey);
    if (nextIsToday && !nextEvent.isAllDay) {
      statusDetail = L.freeUntil(formatTime(nextEvent.start));
    } else {
      statusDetail = L.freeAllDay;
    }
  } else {
    statusDetail = L.freeAllDay;
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
    next_time: nextEvent ? (nextEvent.isAllDay ? formatDate(nextEvent) : `${formatDate(nextEvent)}, ${formatTime(nextEvent.start)}`) : '',
    next_event_time: nextEvent ? (nextEvent.isAllDay ? formatDate(nextEvent) : `${formatDate(nextEvent)}, ${formatTime(nextEvent.start)}`) : '',
    next_date: nextEvent ? formatDate(nextEvent) : '',
    next_organizer: nextEvent ? nextEvent.organizer : '',

    total_upcoming_count: selectedEvents.length,
    event_count: selectedEvents.length,
    events_today_count: flatEvents.filter(e => e.isAllDay ? (e.dayKey <= todayKey && e.endDayKey > todayKey) : (dateKey(e.start) === todayKey)).length,
  };

  // Populate indexed items (event_0_title, event_1_title, ...)
  selectedEvents.forEach((ev, idx) => {
    payload[`event_${idx}_title`] = ev.summary;
    payload[`event_${idx}_summary`] = ev.summary;
    payload[`event_${idx}_date`] = ev.isAllDay ? formatDate(ev) : `${formatDate(ev)}, ${formatTime(ev.start)}`;
    payload[`event_${idx}_time`] = ev.isAllDay ? L.allDay : `${formatTime(ev.start)} – ${formatTime(ev.end)}`;
    payload[`event_${idx}_location`] = ev.location || '';
    payload[`event_${idx}_organizer`] = ev.organizer || '';
  });

  // Multi-line formatted agenda text
  payload.agenda_text = selectedEvents
    .map(ev => `${ev.isAllDay ? formatDate(ev) : formatTime(ev.start)}: ${ev.summary}`)
    .join('\n');

  return payload;
}

module.exports = {
  resolveIcalData,
};
