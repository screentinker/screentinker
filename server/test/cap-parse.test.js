'use strict';

// CAP feed parsing (lib/cap/parse.js) against the shapes real agencies publish: a CAP 1.2
// document, the National Weather Service's Atom index and GeoJSON, a MeteoAlarm-style Atom index
// that links to CAP documents, and Update/Cancel references.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseFeed, alertKey, referenceKey } = require('../lib/cap/parse');

const CAP12 = `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>urn:oid:2.49.0.1.840.0.abc123</identifier>
  <sender>w-nws.webmaster@noaa.gov</sender>
  <sent>2026-10-07T14:05:00-05:00</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>es-US</language>
    <event>Aviso de Tornado</event>
    <severity>Extreme</severity>
    <headline>Spanish headline</headline>
  </info>
  <info>
    <language>en-US</language>
    <category>Met</category>
    <event>Tornado Warning</event>
    <urgency>Immediate</urgency>
    <severity>Extreme</severity>
    <certainty>Observed</certainty>
    <effective>2026-10-07T14:05:00-05:00</effective>
    <expires>2026-10-07T14:45:00-05:00</expires>
    <senderName>NWS Milwaukee/Sullivan WI</senderName>
    <headline>Tornado Warning issued October 7 at 2:05PM CDT</headline>
    <description>At 205 PM CDT, a confirmed tornado was located near Waukesha &amp; moving east.</description>
    <instruction>TAKE COVER NOW! Move to a basement or an interior room.</instruction>
    <area>
      <areaDesc>Waukesha, WI; Milwaukee, WI</areaDesc>
      <geocode><valueName>SAME</valueName><value>055133</value></geocode>
      <geocode><valueName>UGC</valueName><value>WIC133 WIC079</value></geocode>
    </area>
  </info>
</alert>`;

test('a CAP 1.2 document: header fields, the English <info>, entities decoded, every geocode', () => {
  const r = parseFeed(CAP12, { lang: 'en' });
  assert.equal(r.kind, 'cap');
  assert.equal(r.alerts.length, 1);
  const a = r.alerts[0];
  assert.equal(a.identifier, 'urn:oid:2.49.0.1.840.0.abc123');
  assert.equal(a.sender, 'w-nws.webmaster@noaa.gov');
  assert.equal(a.status, 'Actual');
  assert.equal(a.msgType, 'Alert');
  assert.equal(a.event, 'Tornado Warning', 'the en info is chosen over the first (Spanish) one');
  assert.equal(a.severity, 'Extreme');
  assert.equal(a.urgency, 'Immediate');
  assert.match(a.description, /Waukesha & moving east/);
  assert.match(a.instruction, /^TAKE COVER NOW!/);
  assert.equal(a.areaDesc, 'Waukesha, WI; Milwaukee, WI');
  assert.deepEqual(a.geocodes.map((g) => g.value), ['055133', 'WIC133', 'WIC079']);
  assert.equal(a.sent, '2026-10-07T19:05:00.000Z');
  assert.equal(a.expires, '2026-10-07T19:45:00.000Z');
  assert.equal(alertKey(a), 'w-nws.webmaster@noaa.gov|urn:oid:2.49.0.1.840.0.abc123');
});

test('a prefixed CAP document (cap:alert) parses the same', () => {
  const pref = CAP12.replace(/<(\/?)(\w+)/g, '<$1cap:$2').replace('<cap:?xml', '<?xml');
  const a = parseFeed(pref, { lang: 'en' }).alerts[0];
  assert.equal(a.event, 'Tornado Warning');
  assert.equal(a.identifier, 'urn:oid:2.49.0.1.840.0.abc123');
});

const NWS_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
  <title>Current watches, warnings, and advisories for Wisconsin</title>
  <entry>
    <id>https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.def</id>
    <updated>2026-10-07T14:10:00-05:00</updated>
    <title>Severe Thunderstorm Warning issued October 7 at 2:10PM CDT</title>
    <summary>THE NATIONAL WEATHER SERVICE HAS ISSUED A SEVERE THUNDERSTORM WARNING.</summary>
    <author><name>w-nws.webmaster@noaa.gov</name></author>
    <cap:event>Severe Thunderstorm Warning</cap:event>
    <cap:sent>2026-10-07T14:10:00-05:00</cap:sent>
    <cap:effective>2026-10-07T14:10:00-05:00</cap:effective>
    <cap:expires>2026-10-07T15:00:00-05:00</cap:expires>
    <cap:status>Actual</cap:status>
    <cap:msgType>Alert</cap:msgType>
    <cap:urgency>Immediate</cap:urgency>
    <cap:severity>Severe</cap:severity>
    <cap:certainty>Observed</cap:certainty>
    <cap:areaDesc>Dane, WI</cap:areaDesc>
    <cap:geocode><valueName>UGC</valueName><value>WIC025</value></cap:geocode>
  </entry>
</feed>`;

test('an Atom index with CAP fields inline (NWS): one alert per entry', () => {
  const r = parseFeed(NWS_ATOM);
  assert.equal(r.kind, 'index');
  assert.equal(r.alerts.length, 1);
  const a = r.alerts[0];
  assert.equal(a.event, 'Severe Thunderstorm Warning');
  assert.equal(a.severity, 'Severe');
  assert.equal(a.headline, 'Severe Thunderstorm Warning issued October 7 at 2:10PM CDT', 'title stands in for headline');
  assert.match(a.description, /SEVERE THUNDERSTORM WARNING/);
  assert.equal(a.identifier, 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.def');
  assert.equal(a.areaDesc, 'Dane, WI');
  assert.deepEqual(a.geocodes.map((g) => g.value), ['WIC025']);
});

test('an Atom index that only links to CAP documents returns the links to fetch', () => {
  const r = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>x</id><title>Red warning</title>
    <link rel="alternate" type="application/cap+xml" href="https://feeds.example.org/api/cap/abc.xml?a=1&amp;b=2"/>
    <link rel="alternate" type="text/html" href="https://example.org/warning"/></entry></feed>`);
  assert.equal(r.alerts.length, 0);
  assert.deepEqual(r.links, ['https://feeds.example.org/api/cap/abc.xml?a=1&b=2']);
});

test('NWS GeoJSON: properties map to the same fields, references included', () => {
  const r = parseFeed(JSON.stringify({
    type: 'FeatureCollection',
    features: [{ id: 'https://api.weather.gov/alerts/urn:x', properties: {
      id: 'urn:x', sender: 'w-nws.webmaster@noaa.gov', sent: '2026-10-07T19:00:00Z', status: 'Actual',
      messageType: 'Update', event: 'Winter Storm Warning', severity: 'Severe', urgency: 'Expected', certainty: 'Likely',
      headline: 'Winter Storm Warning until 6 PM', description: 'Heavy snow.', instruction: 'Travel could be very difficult.',
      areaDesc: 'Marathon; Lincoln', geocode: { SAME: ['055073'], UGC: ['WIZ018', 'WIZ019'] },
      effective: '2026-10-07T19:00:00Z', expires: '2026-10-08T03:00:00Z',
      references: [{ '@id': 'https://api.weather.gov/alerts/urn:old', identifier: 'urn:old', sender: 'w-nws.webmaster@noaa.gov', sent: '2026-10-07T12:00:00Z' }],
    } }],
  }));
  assert.equal(r.kind, 'geojson');
  const a = r.alerts[0];
  assert.equal(a.msgType, 'Update');
  assert.equal(a.event, 'Winter Storm Warning');
  assert.deepEqual(a.geocodes.map((g) => `${g.valueName}:${g.value}`), ['SAME:055073', 'UGC:WIZ018', 'UGC:WIZ019']);
  assert.equal(referenceKey(a.references[0]), 'w-nws.webmaster@noaa.gov|urn:old');
});

test('references on a CAP Cancel are split into keys', () => {
  const a = parseFeed(`<alert><identifier>c2</identifier><sender>s</sender><sent>2026-10-07T19:30:00Z</sent>
    <status>Actual</status><msgType>Cancel</msgType><references>s,c1,2026-10-07T19:00:00Z s,c0,2026-10-07T18:00:00Z</references>
    <info><event>Flood Warning</event><severity>Severe</severity></info></alert>`).alerts[0];
  assert.equal(a.msgType, 'Cancel');
  assert.deepEqual(a.references.map(referenceKey), ['s|c1', 's|c0']);
});

test('an unknown severity is Unknown, and a web page or junk is refused with a message', () => {
  const a = parseFeed('<alert><identifier>x</identifier><sender>s</sender><sent>2026-10-07T19:30:00Z</sent><info><severity>catastrophic</severity></info></alert>').alerts[0];
  assert.equal(a.severity, 'Unknown');
  assert.throws(() => parseFeed('<!doctype html><html><body>hi</body></html>'), /web page/);
  assert.throws(() => parseFeed('just text'), /did not return/);
  assert.throws(() => parseFeed('{"hello":1}'), /not a CAP/);
});

test('third-party markup in a field is kept as text, never interpreted (the card escapes it)', () => {
  const a = parseFeed(`<alert><identifier>x</identifier><sender>s</sender><sent>2026-10-07T19:30:00Z</sent><status>Actual</status>
    <info><event>Test</event><severity>Severe</severity><headline>&lt;script&gt;alert(1)&lt;/script&gt; Flood</headline></info></alert>`).alerts[0];
  assert.equal(a.headline, '<script>alert(1)</script> Flood');
  const { renderCard } = require('../lib/cap/card');
  const html = renderCard([{ ...a, expires: '2026-10-07T20:00:00.000Z' }]);
  assert.ok(!html.includes('<script>alert(1)'), 'escaped on the card');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; Flood'));
});

test('the card merges the same warning issued per zone, and shows when the hazard ends', () => {
  const { groupForDisplay, renderCard } = require('../lib/cap/card');
  const base = { event: 'Gale Warning', headline: 'Gale Warning until 5 AM', severity: 'Severe', status: 'Actual', msgType: 'Alert' };
  const g = groupForDisplay([
    { ...base, identifier: '1', areaDesc: 'Zone A', expires: '2026-10-08T06:00:00.000Z', ends: '2026-10-08T13:00:00.000Z' },
    { ...base, identifier: '2', areaDesc: 'Zone B', expires: '2026-10-08T06:00:00.000Z', ends: '2026-10-08T13:00:00.000Z' },
    { ...base, identifier: '3', headline: 'Other', areaDesc: 'Zone C' },
  ]);
  assert.equal(g.length, 2);
  assert.equal(g[0].areaDesc, 'Zone A; Zone B');
  const html = renderCard(g);
  assert.ok(html.includes('data-t="2026-10-08T13:00:00.000Z"'), '"Until" is the hazard end, not the message expiry');
  assert.ok(!html.includes('1 / 3'), 'two slides, not three');
});
