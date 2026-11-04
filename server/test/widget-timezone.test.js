'use strict';

/*
 * #316: a clock widget's timezone must be a real zone, checked when it is saved.
 *
 * The old guard tested the string against a character class, which answers neither question a
 * timezone field has. A Spanish operator hit both failure modes in one sitting:
 *
 *   "España" -> the 'ñ' fails the character class -> silently replaced with UTC -> the clock ran
 *               two hours behind with nothing anywhere explaining why.
 *   "Spain"  -> passes the character class, is not a zone -> toLocaleTimeString throws RangeError
 *   "GMT+2"  -> inside the generated widget script -> the clock rendered NOTHING at all.
 *
 * Both are now refused at save time with a message naming the right format. The render-time
 * fallback stays (a wrong clock beats a blank one for configs already stored), but nothing new
 * can reach it.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, jwt;
const DATA_DIR = path.join(os.tmpdir(), 'st-wtz-' + crypto.randomBytes(4).toString('hex'));
let proc;

const post = (t, o) => ({ method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const put = (t, o) => ({ method: 'PUT', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

const mk = (timezone) => post(jwt, { widget_type: 'clock', name: 'clock ' + crypto.randomBytes(3).toString('hex'), config: { timezone, format: '24h' } });

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-wtz.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise(r => setTimeout(r, 250)); }
  if (!up) throw new Error('server did not boot');
  const email = 'w' + crypto.randomBytes(4).toString('hex') + '@x.local';
  jwt = (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd123' }) })).json()).token;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('#316: a country name is refused, not silently turned into UTC', async () => {
  for (const bad of ['España', 'Spain', 'Espagne']) {
    const r = await fetch(BASE + '/api/widgets', mk(bad));
    assert.equal(r.status, 400, `${bad} must be refused`);
    const body = await r.json();
    assert.match(body.error, /not a time zone/i);
    assert.match(body.error, /Europe\/Madrid/, 'the message shows the right shape');
  }
});

test('#316: a GMT offset is refused (it is not an IANA zone)', async () => {
  const r = await fetch(BASE + '/api/widgets', mk('GMT+2'));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not a time zone/i);
});

test('real IANA zones are accepted', async () => {
  for (const good of ['Europe/Madrid', 'America/New_York', 'UTC', 'Etc/GMT-2', 'Australia/Sydney']) {
    const r = await fetch(BASE + '/api/widgets', mk(good));
    assert.equal(r.status, 201, `${good} must be accepted`);
  }
});

test('an absent or empty timezone is still fine (falls back to UTC as before)', async () => {
  assert.equal((await fetch(BASE + '/api/widgets', mk(undefined))).status, 201);
  assert.equal((await fetch(BASE + '/api/widgets', mk(''))).status, 201);
});

test('a quote cannot reach the generated widget script', async () => {
  // The value is interpolated into single-quoted JS in the render path.
  const r = await fetch(BASE + '/api/widgets', mk("UTC'; alert(1); '"));
  assert.equal(r.status, 400, 'quote-bearing value refused');
});

test('editing a widget is gated too, not just creating one', async () => {
  const created = await (await fetch(BASE + '/api/widgets', mk('Europe/Madrid'))).json();
  const bad = await fetch(BASE + '/api/widgets/' + created.id, put(jwt, { config: { timezone: 'Spain', format: '24h' } }));
  assert.equal(bad.status, 400, 'PUT must validate as POST does');
  const good = await fetch(BASE + '/api/widgets/' + created.id, put(jwt, { config: { timezone: 'Europe/Berlin', format: '24h' } }));
  assert.equal(good.status, 200);
});

test('the rendered clock carries the zone that was saved', async () => {
  const w = await (await fetch(BASE + '/api/widgets', mk('Europe/Madrid'))).json();
  const html = await (await fetch(BASE + '/api/widgets/' + w.id + '/render')).text();
  assert.match(html, /timeZone: 'Europe\/Madrid'/, 'the saved zone reaches the generated script');
  assert.doesNotMatch(html, /timeZone: 'UTC'/, 'not quietly replaced');
});

test('the clock editor can ask the server for its own timezone', async () => {
  const res = await fetch(BASE + '/api/widgets/clock-defaults', { headers: { Authorization: 'Bearer ' + jwt } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.timezone, 'string');
  assert.doesNotThrow(() => new Intl.DateTimeFormat(undefined, { timeZone: body.timezone }));
});

// ---------------------------------------------------------------------------
// #323: seconds are optional, and the clock is not hardcoded to English.
// ---------------------------------------------------------------------------

const mkClock = (cfg) => post(jwt, { widget_type: 'clock', name: 'c' + crypto.randomBytes(3).toString('hex'), config: cfg });
const renderOf = async (cfg) => {
  const w = await (await fetch(BASE + '/api/widgets', mkClock(cfg))).json();
  return (await fetch(BASE + '/api/widgets/' + w.id + '/render')).text();
};

test('#323: seconds can be turned off', async () => {
  const html = await renderOf({ timezone: 'Europe/Madrid', format: '24h', show_seconds: false });
  assert.doesNotMatch(html, /second:\s*'2-digit'/, 'no seconds requested when show_seconds is false');
  assert.match(html, /minute:\s*'2-digit'/, 'hours and minutes are still shown');
});

test('#323: seconds stay on by default, so existing widgets do not change', async () => {
  for (const cfg of [{ timezone: 'UTC', format: '24h' }, { timezone: 'UTC', format: '24h', show_seconds: true }]) {
    const html = await renderOf(cfg);
    assert.match(html, /second:\s*'2-digit'/, 'seconds present when unset or true');
  }
});

test('#323: the clock is no longer hardcoded to en-US', async () => {
  const html = await renderOf({ timezone: 'Europe/Madrid', format: '24h', locale: 'es-ES' });
  assert.match(html, /toLocaleTimeString\('es-ES'/, 'the configured locale reaches the time');
  assert.match(html, /toLocaleDateString\('es-ES'/, 'and the date');
  assert.doesNotMatch(html, /'en-US'/, 'no English fallback left behind');
});

test('#323: a blank locale means the screen decides, not English', async () => {
  const html = await renderOf({ timezone: 'Europe/Madrid', format: '24h' });
  assert.match(html, /toLocaleTimeString\(undefined/, 'undefined = the runtime locale');
  assert.doesNotMatch(html, /'en-US'/);
});

test('#323: a junk locale cannot be injected into the emitted script', async () => {
  const html = await renderOf({ timezone: 'UTC', format: '24h', locale: "es'); alert(1);//" });
  assert.doesNotMatch(html, /alert\(1\)/, 'not interpolated');
  assert.match(html, /toLocaleTimeString\(undefined/, 'falls back to the runtime locale');
});

test('clock dates can be hidden, formatted, and placed around the time', async () => {
  const hidden = await renderOf({ timezone: 'UTC', show_date: false });
  assert.doesNotMatch(hidden, /id="date"/, 'a date is not rendered when disabled');

  const left = await renderOf({
    timezone: 'UTC', date_format: 'short', date_position: 'left', date_font_size: 31, date_color: '#123456',
  });
  assert.match(left, /flex-direction:row/, 'left and right date positions use a horizontal layout');
  assert.ok(left.indexOf('id="date"') < left.indexOf('id="time"'), 'left date is placed before the time');
  assert.match(left, /year:'2-digit', month:'2-digit', day:'2-digit'/, 'the selected date format reaches Intl');
  assert.match(left, /font-size:31px/, 'the date size is independent from the time size');
  assert.match(left, /color:#123456/, 'the date color is independent from the time color');
  assert.match(left, /color:#123456; opacity:1/, 'an explicit date color is not dimmed');

  const above = await renderOf({ timezone: 'UTC', date_position: 'above' });
  assert.ok(above.indexOf('id="date"') < above.indexOf('id="time"'), 'above date is placed before the time');
});

// ---------------------------------------------------------------------------
// #324: the weather widget scales as a whole, and can speak the operator's language.
// ---------------------------------------------------------------------------

const renderWeather = async (cfg) => {
  const w = await (await fetch(BASE + '/api/widgets', post(jwt, {
    widget_type: 'weather', name: 'w' + crypto.randomBytes(3).toString('hex'), config: cfg,
  }))).json();
  return (await fetch(BASE + '/api/widgets/' + w.id + '/render')).text();
};

test('#324: every text size scales with font_size, not just the temperature', async () => {
  const small = await renderWeather({ location: 'Madrid', font_size: 20 });
  const big = await renderWeather({ location: 'Madrid', font_size: 80 });
  const sizesOf = (html) => [...html.matchAll(/font-size:(\d+)px/g)].map((m) => Number(m[1]));
  const s = sizesOf(small), b = sizesOf(big);
  assert.ok(s.length >= 4 && b.length >= 4, 'temp, location, desc and icon all carry a size');
  // Every size in the small render must be smaller than its counterpart in the big one.
  for (let i = 0; i < Math.min(s.length, b.length); i++) {
    assert.ok(b[i] > s[i], `size #${i} did not scale (${s[i]} -> ${b[i]})`);
  }
  assert.doesNotMatch(small, /font-size:64px/, 'the hardcoded 64px icon is gone');
  assert.doesNotMatch(small, /font-size:18px/, 'the hardcoded 18px location is gone');
});

test('#324: a signage widget never offers a scrollbar', async () => {
  assert.match(await renderWeather({ location: 'Madrid', font_size: 90 }), /overflow:hidden/);
});

test('#324: the city line can be hidden', async () => {
  assert.doesNotMatch(await renderWeather({ location: 'Madrid', show_location: false }), /class="location"/);
  assert.match(await renderWeather({ location: 'Madrid' }), /class="location"/);
});

test('#324: a side-by-side layout is available', async () => {
  assert.match(await renderWeather({ location: 'Madrid', layout: 'horizontal' }), /body class="horizontal"/);
});

test('#324: a locale reaches the weather provider, and junk does not', async () => {
  // Match the fetch URL, not the word anywhere in the file: the comment above the fetch contains
  // "lang=" and a bare /lang=/ therefore passes on the prose rather than on the behaviour.
  const url = /format=j1&lang=([a-z]{2})/;
  assert.match(await renderWeather({ location: 'Madrid', locale: 'es' }), url);
  assert.equal(url.exec(await renderWeather({ location: 'Madrid', locale: 'es-ES' }))[1], 'es',
    'a full BCP-47 tag is narrowed to the two-letter code the provider wants');
  const junk = await renderWeather({ location: 'Madrid', locale: "x'); alert(1);//" });
  assert.doesNotMatch(junk, /alert\(1\)/);
  assert.doesNotMatch(junk, url, 'an unusable locale is simply omitted from the request');
});
