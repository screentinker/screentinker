'use strict';

/*
 * Remote LED settings (lib/embedded-led-config.js, routes/device-led.js): validation, the
 * X-ST-Led-Config header on every render answer for LED screens only, the X-ST-Led-State report
 * stored only when it changes, and the dashboard API's access rules. Real schema.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const led = require('../lib/embedded-led-config');

const h = require('./helpers/embedded-real-db').boot({
  configure(app) {
    const { requireAuth } = require('../middleware/auth');
    const { resolveTenancy } = require('../lib/tenancy');
    app.use('/api/device-led', requireAuth, resolveTenancy, require('../routes/device-led'));
  },
});
after(async () => { await h.close(); });

const LED_PROFILE = { preset: 'seeed-xiao-led', width: 64, height: 8 };
const poll = (base, p, headers = {}) =>
  fetch(`${base}/render?device_id=${p.id}`, { headers: { Authorization: `Bearer ${p.token}`, ...headers } });
const api = async (base, method, deviceId, body) => {
  const res = await fetch(base.replace('/api/embedded', '') + `/api/device-led/${deviceId}`, {
    method, headers: { Authorization: `Bearer ${h.sessionToken()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const parseHeader = (v) => Object.fromEntries(String(v).split(';').map((kv) => kv.split('=')));

test('normalise: defaults, ranges and names, with the bad field named', () => {
  assert.deepEqual(led.normalise({}).value, { ...led.DEFAULTS });
  assert.equal(led.normalise({ brightness: 256 }).field, 'brightness');
  assert.equal(led.normalise({ brightness: 1.5 }).field, 'brightness');
  assert.equal(led.normalise({ color_order: 'XYZ' }).field, 'color_order');
  assert.equal(led.normalise({ color_order: 'rgb' }).value.color_order, 'RGB', 'case-insensitive, stored canonical');
  assert.equal(led.normalise({ power_limit_ma: 50 }).field, 'power_limit_ma', 'below the controller\'s own draw');
  assert.equal(led.normalise({ power_limit_ma: 0 }).value.power_limit_ma, 0, '0 = no limit');
  assert.equal(led.normalise({ auto_protect: 'yes' }).field, 'auto_protect');
  assert.equal(led.normalise({ wiring: 'progressive' }, { ...led.DEFAULTS, brightness: 40 }).value.brightness, 40, 'partial update keeps the rest');
});

test('the header carries every setting, the frame size, and a rev that moves only when they do', () => {
  const a = led.header(led.DEFAULTS, 64, 8);
  const kv = parseHeader(a);
  assert.equal(kv.v, '1');
  assert.match(kv.rev, /^[0-9a-f]{8}$/);
  assert.equal(kv.b, '180');
  assert.equal(kv.o, 'GRB');
  assert.equal(kv.w, '64');
  assert.equal(kv.h, '8');
  assert.equal(kv.pl, '3000');
  assert.equal(kv.auto, '1');
  assert.equal(led.header(led.DEFAULTS, 64, 8), a, 'deterministic');
  assert.notEqual(parseHeader(led.header({ ...led.DEFAULTS, brightness: 40 }, 64, 8)).rev, kv.rev);
  assert.notEqual(parseHeader(led.header(led.DEFAULTS, 32, 8)).rev, kv.rev, 'a resize is a change too');
});

test('parseState takes what the firmware reports and ignores junk', () => {
  const s = led.parseState('rev=0a1b2c3d;b=40;pl=2550;lpl=2550;bo=2;est=1800;rr=brownout');
  assert.deepEqual(s, { rev: '0a1b2c3d', brightness: 40, effective_limit_ma: 2550, learned_limit_ma: 2550,
    brownouts: 2, frame_estimate_ma: 1800, reset_reason: 'brownout',
    color_order: null, wiring: null, axis: null, origin: null });
  assert.equal(led.parseState(''), null);
  assert.equal(led.parseState('garbage'), null);
  assert.equal(led.parseState('x'.repeat(600)), null);
  assert.equal(led.parseState('b=999;rr=<script>'), null, 'nothing valid in it at all');
  assert.equal(led.parseState('b=999;pl=2000').brightness, null, 'a bad field is dropped, the good one kept');
  assert.equal(led.parseState('b=999;pl=2000').effective_limit_ma, 2000);
});

test('an LED screen gets X-ST-Led-Config on its render answer; an e-paper panel does not', async () => {
  const base = await h.ready();
  const ledPanel = await h.mkPanel(LED_PROFILE, { w: 64, h: 8 });
  const epd = await h.mkPanel('waveshare-2.9in-v2');
  const r1 = await poll(base, ledPanel);
  assert.equal(r1.status, 200);
  const kv = parseHeader(r1.headers.get('x-st-led-config'));
  assert.equal(kv.w, '64');
  assert.equal(kv.h, '8');
  assert.equal(kv.b, '180', 'defaults until the operator changes something');
  const r2 = await poll(base, epd);
  assert.equal(r2.headers.get('x-st-led-config'), null);
});

test('the header rides a 304 too, so a change reaches a screen whose picture did not change', async () => {
  const base = await h.ready();
  const p = await h.mkPanel(LED_PROFILE, { w: 64, h: 8 });
  const first = await poll(base, p);
  const etag = first.headers.get('etag');
  h.db.prepare('UPDATE devices SET led_config = ? WHERE id = ?').run(JSON.stringify({ ...led.DEFAULTS, brightness: 30 }), p.id);
  const again = await poll(base, p, { 'If-None-Match': etag });
  assert.equal(again.status, 304);
  assert.equal(parseHeader(again.headers.get('x-st-led-config')).b, '30');
});

test('the firmware report is stored, and not rewritten on every poll when nothing changed', async () => {
  const base = await h.ready();
  const p = await h.mkPanel(LED_PROFILE, { w: 64, h: 8 });
  await poll(base, p, { 'X-ST-Led-State': 'rev=0a1b2c3d;b=30;pl=3000;lpl=0;bo=0;est=900;rr=poweron' });
  const row = () => h.db.prepare('SELECT led_state, led_state_at FROM devices WHERE id = ?').get(p.id);
  const a = row();
  assert.equal(JSON.parse(a.led_state).effective_limit_ma, 3000);
  h.db.prepare('UPDATE devices SET led_state_at = led_state_at - 10 WHERE id = ?').run(p.id);
  const marked = row().led_state_at;
  await poll(base, p, { 'X-ST-Led-State': 'rev=0a1b2c3d;b=30;pl=3000;lpl=0;bo=0;est=1200;rr=poweron' });
  assert.equal(row().led_state_at, marked, 'only the per-frame estimate moved: no write');
  await poll(base, p, { 'X-ST-Led-State': 'rev=0a1b2c3d;b=30;pl=2550;lpl=2550;bo=1;est=1200;rr=brownout' });
  const b = JSON.parse(row().led_state);
  assert.equal(b.learned_limit_ma, 2550);
  assert.equal(b.reset_reason, 'brownout');
});

test('dashboard API: read, partial update, validation, reset of the learned limit', async () => {
  const base = await h.ready();
  const p = await h.mkPanel(LED_PROFILE, { w: 64, h: 8 });
  let r = await api(base, 'GET', p.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.supported, true);
  assert.equal(r.body.config.brightness, 180);
  r = await api(base, 'PUT', p.id, { brightness: 40, power_limit_ma: 2500 });
  assert.equal(r.status, 200);
  assert.equal(r.body.config.brightness, 40);
  assert.equal(r.body.config.color_order, 'GRB', 'untouched fields keep their value');
  r = await api(base, 'PUT', p.id, { brightness: 999 });
  assert.equal(r.status, 400);
  assert.equal(r.body.field, 'brightness');
  r = await api(base, 'PUT', p.id, { reset_learned: true });
  assert.equal(r.body.config.learned_reset, 1);
  assert.equal(r.body.config.brightness, 40);
  const hdr = parseHeader((await poll(base, p)).headers.get('x-st-led-config'));
  assert.equal(hdr.lr, '1');
  assert.equal(hdr.pl, '2500');
});

test('dashboard API refuses a non-LED screen and an unknown one', async () => {
  const base = await h.ready();
  const epd = await h.mkPanel('waveshare-2.9in-v2');
  const r = await api(base, 'PUT', epd.id, { brightness: 10 });
  assert.equal(r.status, 400);
  assert.equal((await api(base, 'GET', 'nope')).status, 404);
});

test('wiring and colour order are not sent until an operator sets them, so a wall keeps its own', async () => {
  const base = await h.ready();
  const p = await h.mkPanel(LED_PROFILE, { w: 64, h: 8 });
  const has = async (k) => k in parseHeader((await poll(base, p)).headers.get('x-st-led-config'));
  assert.equal(await has('wir'), false);
  assert.equal(await has('o'), false);
  // The wall reports its local layout; the device page shows it.
  await poll(base, p, { 'X-ST-Led-State': 'rev=0a1b2c3d;b=180;pl=3000;o=RGB;wir=progressive;ax=vertical;org=bottom_left' });
  let r = await api(base, 'GET', p.id);
  assert.equal(r.body.config.wiring, 'progressive');
  assert.equal(r.body.config.axis, 'vertical');
  assert.deepEqual(r.body.layout_set, []);
  // Saving brightness does not start overriding the wiring.
  r = await api(base, 'PUT', p.id, { brightness: 50 });
  assert.deepEqual(r.body.layout_set, []);
  assert.equal(await has('wir'), false);
  // Setting the wiring does.
  r = await api(base, 'PUT', p.id, { wiring: 'serpentine' });
  assert.deepEqual(r.body.layout_set, ['wiring']);
  const kv = parseHeader((await poll(base, p)).headers.get('x-st-led-config'));
  assert.equal(kv.wir, 'serpentine');
  assert.equal(kv.ax, undefined, 'the axis is still the wall\'s own');
  assert.equal(kv.b, '50');
});
