'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveIcalData } = require('../lib/data-sources/ical-resolver');
const { renderSlideHtml, interpolateDataSources } = require('../lib/slide-render');

const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ScreenTinker Test//DE
CALSCALE:GREGORIAN
BEGIN:VEVENT
UID:evt-today-1
SUMMARY:Projekt-Sync & Review
DESCRIPTION:Wöchentliches Team-Meeting
LOCATION:Konferenzraum Berlin
DTSTART:20260904T090000Z
DTEND:20260904T100000Z
END:VEVENT
BEGIN:VEVENT
UID:evt-today-2
SUMMARY:Kunden-Präsentation
DESCRIPTION:Vorstellung Release 2.0
LOCATION:Konferenzraum Berlin
DTSTART:20260904T140000Z
DTEND:20260904T153000Z
END:VEVENT
BEGIN:VEVENT
UID:evt-future-3
SUMMARY:Gelber Sack Abholung
DESCRIPTION:Entsorgung Wertstoffe
LOCATION:Musterstraße 1
DTSTART:20260905T060000Z
DTEND:20260905T070000Z
END:VEVENT
END:VCALENDAR`;

const RECURRING_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ScreenTinker Test//DE
BEGIN:VEVENT
UID:evt-daily-standup
SUMMARY:Daily Standup
LOCATION:Raum 101
DTSTART:20260901T080000Z
DTEND:20260901T083000Z
RRULE:FREQ=DAILY;COUNT=10
END:VEVENT
END:VCALENDAR`;

test('iCal resolver parses events and formats room status', async () => {
  const now = new Date('2026-09-04T09:30:00Z');
  const data = await resolveIcalData({ raw_data: SAMPLE_ICS, timezone: 'UTC', locale: 'de' }, now);

  assert.equal(data.status, 'BELEGT');
  assert.equal(data.status_de, 'BELEGT');
  assert.equal(data.status_en, 'BUSY');
  assert.equal(data.is_busy, true);
  assert.equal(data.current_event_summary, 'Projekt-Sync & Review');
  assert.equal(data.current_event_location, 'Konferenzraum Berlin');
  assert.match(data.status_detail, /Belegt bis/);
  assert.equal(data.next_event_summary, 'Kunden-Präsentation');
  assert.equal(data.event_count, 3);
  assert.ok(data.agenda_text.includes('Projekt-Sync & Review'));
});

test('iCal resolver reports AVAILABLE when no active event', async () => {
  const now = new Date('2026-09-04T11:00:00Z');
  const data = await resolveIcalData({ raw_data: SAMPLE_ICS, timezone: 'UTC', locale: 'de' }, now);

  assert.equal(data.status, 'FREI');
  assert.equal(data.status_de, 'FREI');
  assert.equal(data.status_en, 'AVAILABLE');
  assert.equal(data.is_busy, false);
  assert.equal(data.current_event_summary, '');
  assert.equal(data.next_event_summary, 'Kunden-Präsentation');
  assert.match(data.status_detail, /Frei bis/);
});

test('iCal resolver handles recurring RRULE events', async () => {
  const now = new Date('2026-09-04T08:15:00Z');
  const data = await resolveIcalData({ raw_data: RECURRING_ICS, timezone: 'UTC' }, now);

  assert.equal(data.status_en, 'BUSY');
  assert.equal(data.current_event_summary, 'Daily Standup');
  assert.equal(data.current_event_location, 'Raum 101');
});

test('iCal resolver respects keyword filters', async () => {
  const now = new Date('2026-09-04T07:00:00Z');
  const data = await resolveIcalData({
    raw_data: SAMPLE_ICS,
    filter_include: 'Gelber Sack',
    timezone: 'UTC'
  }, now);

  assert.equal(data.event_count, 1);
  assert.equal(data.next_event_summary, 'Gelber Sack Abholung');
});

test('iCal resolver respects privacy mode', async () => {
  const now = new Date('2026-09-04T09:30:00Z');
  const data = await resolveIcalData({
    raw_data: SAMPLE_ICS,
    hide_private: true,
    timezone: 'UTC'
  }, now);

  assert.equal(data.status_en, 'BUSY');
  assert.equal(data.current_event_summary, 'Belegt');
  assert.equal(data.current_event_description, '');
});

test('interpolateDataSources correctly replaces {{ds:slug.key}} tags', () => {
  const dataMap = {
    room_berlin: {
      status: 'BELEGT',
      status_detail: 'Belegt bis 11:30 (Projekt-Sync)',
      next_event_summary: 'Kunden-Präsentation',
      next_event_time: '14:00 - 15:30',
    },
    weather_berlin: {
      temp: '22°C',
    }
  };

  const resolver = (slug, key) => dataMap[slug]?.[key];

  const templateText = 'Status: {{ds:room_berlin.status}} | Details: {{ds:room_berlin.status_detail}}';
  const resolved = interpolateDataSources(templateText, resolver);

  assert.equal(resolved, 'Status: BELEGT | Details: Belegt bis 11:30 (Projekt-Sync)');

  // Missing data source returns empty string
  const missing = interpolateDataSources('Missing: {{ds:unknown.field}}', resolver);
  assert.equal(missing, 'Missing: ');
});

test('renderSlideHtml integrates data source variables into rendered slide HTML', () => {
  const slideConfig = {
    template: {
      aspect: '16:9',
      background: '#000000',
      elements: [
        { id: 'el-1', kind: 'head', slot: 'headline', x: 5, y: 10, w: 90, h: 20, style: { color: '#ffffff', size: 5, weight: 700, align: 'left', font: 'f:inter' } },
        { id: 'el-2', kind: 'body', slot: 'subhead', x: 5, y: 35, w: 90, h: 20, style: { color: '#cccccc', size: 3, weight: 400, align: 'left', font: 'f:inter' } },
      ]
    },
    fields: {
      headline: 'Raum Berlin: {{ds:room_berlin.status}}',
      subhead: '{{ds:room_berlin.status_detail}}',
    }
  };

  const dataSources = {
    room_berlin: {
      status: 'FREI',
      status_detail: 'Frei bis 14:00 (Nächstes Meeting: Kunden-Präsentation)',
    }
  };

  const html = renderSlideHtml(slideConfig, { dataSources });

  assert.ok(html.includes('Raum Berlin: FREI'), 'Rendered HTML contains interpolated status');
  assert.ok(html.includes('Frei bis 14:00 (Nächstes Meeting: Kunden-Präsentation)'), 'Rendered HTML contains interpolated status detail');
});

test('iCal resolver rejects SSRF targets (loopback / private ranges)', async () => {
  const now = new Date('2026-09-04T09:30:00Z');
  // Loopback and cloud-metadata endpoints must never be fetched.
  for (const bad of [
    'http://127.0.0.1:8080/feed.ics',
    'http://127.0.0.1/private.ics',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/feed.ics',
    'http://192.168.1.10/feed.ics',
    'http://10.0.0.5/feed.ics',
  ]) {
    await assert.rejects(
      () => resolveIcalData({ url: bad, timezone: 'UTC' }, now),
      (e) => e instanceof Error,
      `expected SSRF guard to reject ${bad}`,
    );
  }
});

test('iCal resolver rejects non-HTTP(S) URL schemes', async () => {
  const now = new Date('2026-09-04T09:30:00Z');
  await assert.rejects(
    () => resolveIcalData({ url: 'file:///etc/passwd', timezone: 'UTC' }, now),
    (e) => e instanceof Error,
    'file:// scheme must be rejected',
  );
});

test('iCal resolver tolerates malformed inline ICS without crashing', async () => {
  const now = new Date('2026-09-04T09:30:00Z');
  // node-ical is lenient: garbage fails gracefully as an empty feed rather than throwing.
  // The contract is "no crash / no 500", not "reject".
  const data = await resolveIcalData({ raw_data: 'this is not a valid calendar{', timezone: 'UTC' }, now);
  assert.equal(typeof data, 'object');
  assert.equal(data.event_count, 0);
});

test('iCal resolver treats empty config as a clean error (not a crash)', async () => {
  const now = new Date('2026-09-04T09:30:00Z');
  await assert.rejects(
    () => resolveIcalData({}, now),
    (e) => e instanceof Error,
  );
  await assert.rejects(
    () => resolveIcalData(null, now),
    (e) => e instanceof Error,
  );
});

test('iCal resolver honours exclude_text and plain-substring (non-ReDoS) filtering', async () => {
  const now = new Date('2026-09-04T07:00:00Z');
  // exclude_text drops matching events.
  const excluded = await resolveIcalData({
    raw_data: SAMPLE_ICS,
    exclude_text: 'Gelber Sack',
    timezone: 'UTC',
  }, now);
  assert.equal(excluded.event_count, 2);
  assert.notEqual(excluded.next_event_summary, 'Gelber Sack Abholung');

  // A "regex-looking" filter pattern is treated as a literal substring, so a pathological
  // pattern cannot trigger catastrophic backtracking (ReDoS) on hostile summaries.
  const data = await resolveIcalData({
    raw_data: SAMPLE_ICS,
    filter_text: '(a+)+$',
    timezone: 'UTC',
  }, now);
  assert.equal(data.event_count, 0);
});

test('iCal resolver formats times in the configured timezone', async () => {
  const now = new Date('2026-09-04T09:30:00Z'); // 10:30 in Europe/Berlin (CEST), 09:30 in UTC
  const utc = await resolveIcalData({ raw_data: SAMPLE_ICS, timezone: 'UTC', locale: 'de' }, now);
  const berlin = await resolveIcalData({ raw_data: SAMPLE_ICS, timezone: 'Europe/Berlin', locale: 'de' }, now);

  assert.ok(String(utc.current_time).startsWith('09:00'), `UTC expected 09:00, got ${utc.current_time}`);
  assert.ok(String(berlin.current_time).startsWith('11:00'), `Berlin expected 11:00, got ${berlin.current_time}`);
});

test('data-source values are HTML-escaped when rendered into slide HTML (XSS invariant)', () => {
  const slideConfig = {
    template: {
      aspect: '16:9',
      background: '#000000',
      elements: [
        { id: 'el-1', kind: 'head', slot: 'headline', x: 5, y: 10, w: 90, h: 20, style: { color: '#ffffff', size: 5, weight: 700, align: 'left', font: 'f:inter' } },
      ]
    },
    fields: {
      headline: '{{ds:room.title}}',
    }
  };

  // A hostile data-source value containing script/attribute-breaking markup must be escaped,
  // never emitted verbatim into the rendered document.
  const dataSources = {
    room: {
      title: '<script>alert(1)</script>" onmouseover="x',
    }
  };

  const html = renderSlideHtml(slideConfig, { dataSources });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script must not appear');
  assert.ok(html.includes('&lt;script&gt;'), 'script tag must be HTML-escaped');
  assert.ok(!html.includes('onmouseover="x'), 'attribute-breaking markup must be escaped');
});

test('iCal resolver honours EXDATE for recurring RRULE events', async () => {
  const EXDATE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ScreenTinker Test//DE
BEGIN:VEVENT
UID:evt-daily-standup-exdate
SUMMARY:Daily Standup
LOCATION:Raum 101
DTSTART:20260901T080000Z
DTEND:20260901T083000Z
RRULE:FREQ=DAILY;COUNT=10
EXDATE:20260904T080000Z
END:VEVENT
END:VCALENDAR`;

  const now = new Date('2026-09-04T08:15:00Z');
  const data = await resolveIcalData({ raw_data: EXDATE_ICS, timezone: 'UTC' }, now);

  assert.equal(data.is_busy, false);
  assert.notEqual(data.current_event_summary, 'Daily Standup');
});

test('interpolateDataSources caps long values to MAX_FIELD_CHARS', () => {
  const longText = 'A'.repeat(5000);
  const resolver = (slug, key) => (slug === 'test' && key === 'long' ? longText : null);
  const interpolated = interpolateDataSources('{{ds:test.long}}', resolver);

  assert.equal(interpolated.length, 2000);
  assert.equal(interpolated, 'A'.repeat(2000));
});

test('background poller functions export cleanly', () => {
  const { pollDueDataSources, startDataSourcesPoller, stopDataSourcesPoller } = require('../lib/data-sources/service');
  assert.equal(typeof pollDueDataSources, 'function');
  assert.equal(typeof startDataSourcesPoller, 'function');
  assert.equal(typeof stopDataSourcesPoller, 'function');
});
