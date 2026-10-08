'use strict';

/*
 * #473 interactive walk-up web pages in the WEB player (browser, webOS shell, BrightSign widget).
 *
 * The rules are KioskLogic (kiosk-logic.test.js holds them to shared/kiosk-vectors.json). This file
 * covers what the web player adds around them:
 *   - server/player/kiosk-player.js: the session engine (framed + BrightSign host surfaces), the
 *     usage queue, the held-error buffer, and the script injected into the site's pages on
 *     BrightSign — whose inline copies of four rules are held to the SAME vectors here;
 *   - the wiring in server/player/index.html (hold / park / release, privacy, capabilities);
 *   - brightsign/st-bridge.js's kiosk calls and brightsign/autorun.brs's kiosk host.
 *
 * The engine runs against a tiny fake DOM and a manual clock, so every timing below is exact.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const L = require('../lib/kiosk-logic');
const KP = require('../player/kiosk-player');
const V = JSON.parse(read('shared/kiosk-vectors.json'));
const PLAYER = read('server/player/index.html');
const BRS = read('brightsign/autorun.brs');

// ───────────────────────────────────────────────────────────── inline rule copies vs the vectors
test('the injected script\'s inline isAllowed matches every vector', () => {
  for (const v of V.isAllowed) assert.equal(KP.kIsAllowed(v.url, v.allowed), v.expect, v.url);
});
test('the injected script\'s inline selectCookies matches every vector', () => {
  for (const v of V.selectCookies) {
    const pats = v.patterns === 'BUILT_IN' ? L.CONSENT_COOKIES : v.patterns;
    assert.deepEqual(KP.kSelectCookies(v.header, pats), v.expect, v.name);
  }
});
test('the injected script\'s inline isStartPage and hostOf match the vectors and KioskLogic', () => {
  for (const v of V.isStartPage) assert.equal(KP.kIsStartPage(v.url, v.start), v.expect, String(v.url));
  for (const v of V.isAllowed) assert.equal(KP.kHostOf(v.url), L.hostOf(v.url), v.url);
});
test('the inline copies are self-contained (they are serialised into a page with nothing else)', () => {
  for (const f of [KP.kHostOf, KP.kIsAllowed, KP.kSelectCookies, KP.kIsStartPage]) {
    const g = new Function(`return (${f.toString()})`)();
    assert.equal(typeof g, 'function');
  }
  assert.equal(new Function(`return (${KP.kIsAllowed.toString().replace('kHostOf', '(' + KP.kHostOf.toString() + ')')})`)()('https://a.example/x', ['a.example']), true);
});

// ───────────────────────────────────────────────────────────── usage queue + held errors
function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
const rec = (i) => ({ id: 'id-' + i, widget_id: 'w', started_at: 1000 + i, duration_sec: 5, end_reason: 'idle', pages: 1 });

test('session queue: capped at 500 (oldest dropped), deduped by id, batches of 50, ack by id, persisted', () => {
  const st = memStore();
  const q = new KP.SessionQueue(st, 'q');
  for (let i = 0; i < 510; i++) q.add(rec(i));
  q.add(rec(509));
  assert.equal(q.size(), 500);
  assert.equal(q.peek()[0].id, 'id-10');
  assert.equal(q.peek().length, 50);
  q.ack(['id-10', 'id-11', 'nope']);
  assert.equal(q.size(), 498);
  const again = new KP.SessionQueue(st, 'q');
  assert.equal(again.size(), 498);
  assert.equal(again.peek(1)[0].id, 'id-12');
});
test('session queue: unreadable storage starts empty instead of wedging', () => {
  const st = memStore(); st.setItem('q', '{not json');
  assert.equal(new KP.SessionQueue(st, 'q').size(), 0);
  assert.equal(new KP.SessionQueue(null, 'q').size(), 0);
});
test('held errors: at most 10, newest kept, marked offline, <= 400 chars of detail', () => {
  const h = new KP.ErrorHold();
  for (let i = 0; i < 12; i++) h.add('load_error', 'x'.repeat(500) + i);
  const out = h.drain();
  assert.equal(out.length, 10);
  assert.ok(out.every((x) => x[1].length <= 400));
  h.add('load_error', 'short');
  assert.equal(h.drain()[0][1], 'short (while offline)');
  assert.equal(h.drain().length, 0);
});

// ───────────────────────────────────────────────────────────── a tiny DOM + clock
function fakeDom() {
  const listeners = new Map();
  class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.style = { cssText: '' }; this._l = {}; this.textContent = ''; this.src = ''; }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
    removeEventListener(t, f) { this._l[t] = (this._l[t] || []).filter((x) => x !== f); }
    fire(t, ev) { for (const f of (this._l[t] || []).slice()) f(ev || { preventDefault() {} }); }
    all() { return [this, ...this.children.flatMap((c) => c.all())]; }
  }
  const doc = { activeElement: null, createElement: (t) => new El(t) };
  const stage = new El('div');
  const win = {
    navigator: { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36' },
    addEventListener: (t, f) => { (listeners.get(t) || listeners.set(t, []).get(t)).push(f); },
    removeEventListener: (t, f) => listeners.set(t, (listeners.get(t) || []).filter((x) => x !== f)),
    fire: (t) => (listeners.get(t) || []).slice().forEach((f) => f({})),
    fetch: null,
  };
  return { doc, win, stage, El };
}

function clock() {
  let t = 1_000_000;
  let q = [];
  let seq = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; q.push({ id, at: t + (ms || 0), fn }); return id; },
    clearTimeout: (id) => { q = q.filter((x) => x.id !== id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at || a.id - b.id);
        const n = q[0];
        if (!n || n.at > end) break;
        q.shift();
        t = n.at;
        n.fn();
      }
      t = end;
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

function cfgOf(extra) {
  return L.parse('webpage', Object.assign({ url: 'https://shop.example/menu', interactive: true, idle_timeout_sec: 30, idle_warning_sec: 10 }, extra || {}));
}

function engine(opts = {}) {
  const d = fakeDom();
  const c = clock();
  const calls = { hold: 0, release: 0, skip: 0, reports: [], sessions: [], logs: [], broken: 0 };
  const st = opts.storage || memStore();
  let n = 0;
  if (opts.fetch) d.win.fetch = opts.fetch;
  if (opts.userActivation) d.win.navigator.userActivation = opts.userActivation;
  const e = KP.create({
    logic: L, win: d.win, doc: d.doc, container: () => d.stage,
    hold: () => calls.hold++, release: () => calls.release++, skip: () => calls.skip++,
    report: (r, det) => calls.reports.push([r, det]),
    sessionEnd: (r) => calls.sessions.push(r),
    storage: st, log: (l, m) => calls.logs.push(l + ' ' + m),
    now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
    uuid: () => 'uuid-' + (++n), ua: opts.ua, origin: opts.origin || 'https://signage.example',
    host: opts.host || null, onHostBroken: () => calls.broken++,
  });
  const frame = () => d.stage.all().find((x) => x.tagName === 'IFRAME');
  const byText = (s) => d.stage.all().find((x) => x.textContent && x.textContent.indexOf(s) === 0);
  return { e, d, c, calls, st, frame, byText };
}

// ───────────────────────────────────────────────────────────── FRAMED engine
test('framed: the site loads in its own frame — real origin, no escape hatches, no camera/mic/geo', () => {
  const { e, frame } = engine();
  e.show('k1', cfgOf(), 'w1');
  const f = frame();
  assert.equal(f.src, 'https://shop.example/menu');
  const sb = f.getAttribute('sandbox').split(' ');
  for (const need of ['allow-scripts', 'allow-forms', 'allow-same-origin']) assert.ok(sb.includes(need), need);
  for (const never of ['allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-popups',
    'allow-popups-to-escape-sandbox', 'allow-modals', 'allow-downloads']) assert.ok(!sb.includes(never), never);
  assert.ok(!/camera|microphone|geolocation/.test(f.getAttribute('allow')));
  assert.equal(e.capability(), 'playback.web_interactive_framed');
});

test('framed: a page on the PLAYER\'s own origin never gets allow-same-origin (it could read the device token)', () => {
  const { e, frame } = engine({ origin: 'https://shop.example' });
  e.show('k1', cfgOf(), 'w1');
  assert.ok(!frame().getAttribute('sandbox').includes('allow-same-origin'));
});

test('framed: zoom is a LAYOUT zoom — frame at 100/zoom % scaled back up (the server render\'s model)', () => {
  const { e, frame } = engine();
  e.show('k1', cfgOf({ zoom: 150 }), 'w1');
  const css = frame().style.cssText;
  assert.match(css, /width:66\.666/);
  assert.match(css, /height:66\.666/);
  assert.match(css, /transform:scale\(1\.5\)/);
  assert.match(css, /transform-origin:0 0/);
});

test('framed: the first tap (focus moving into the frame) starts a session and holds the playlist once', () => {
  const { e, d, c, calls, frame } = engine();
  e.show('k1', cfgOf(), 'w1');
  assert.equal(e.sessionActive(), false);
  d.doc.activeElement = frame();
  d.win.fire('blur');
  c.advance(1);
  assert.equal(e.sessionActive(), true);
  assert.equal(calls.hold, 1);
  assert.ok(calls.logs.some((l) => l.includes('session started — playlist held')));
  d.win.fire('blur'); c.advance(1);
  assert.equal(calls.hold, 1, 'a later touch does not re-hold');
});

test('framed: user activation counts only after it was seen idle — a tap BEFORE the page appeared does not start a session', () => {
  const ua = { isActive: true };
  const { e, c, calls } = engine({ userActivation: ua });
  e.show('k1', cfgOf(), 'w1');
  c.advance(2000);
  assert.equal(calls.hold, 0, 'activation left over from before the mount');
  ua.isActive = false; c.advance(600);
  ua.isActive = true; c.advance(600);
  assert.equal(calls.hold, 1, 'a fresh activation inside the frame starts the session');
});

test('framed: idle countdown, a tap on the overlay resumes, then reset ends the session and releases', () => {
  const { e, d, c, calls, frame, byText } = engine();
  e.show('k1', cfgOf(), 'w1');
  frame().fire('load');
  d.doc.activeElement = frame(); d.win.fire('blur'); c.advance(1);
  c.advance(30_000);
  const o = byText('Still there?');
  assert.ok(o, 'the overlay is up at idleTimeoutSec');
  assert.equal(o.textContent, 'Still there?\nTap to keep browsing — resetting in 10s');
  assert.ok(calls.logs.some((l) => l.includes('idle — "Still there?" countdown 10s')));
  o.fire('pointerdown');
  c.advance(1);
  assert.equal(byText('Still there?'), undefined, 'a tap resumes');
  c.advance(39_999);
  assert.equal(calls.release, 0);
  c.advance(1000);
  assert.equal(calls.release, 1, 'reset releases the playlist');
  assert.equal(e.isShowing(), false);
  assert.equal(calls.sessions.length, 1);
  const r = calls.sessions[0];
  assert.equal(r.end_reason, 'idle');
  assert.equal(r.widget_id, 'w1');
  assert.equal(r.pages, 1);
  assert.ok(r.duration_sec >= 30 && r.duration_sec <= 31, `engaged time first touch -> last activity, got ${r.duration_sec}`);
  assert.ok(calls.logs.some((l) => l.includes('session idle — wiping and moving on')));
  assert.ok(calls.logs.some((l) => l.includes('web storage NOT wiped')), 'framed mode says it cannot wipe');
});

test('framed: a navigation inside the frame counts a page, shows Home; Home reloads the start page and hides itself', () => {
  const { e, d, c, frame, byText, calls } = engine();
  e.show('k1', cfgOf(), 'w1');
  const f = frame();
  f.fire('load');
  assert.equal(byText('⌂'), undefined, 'no Home on the start page');
  d.doc.activeElement = f; d.win.fire('blur'); c.advance(1);
  f.fire('load');
  const h = byText('⌂');
  assert.ok(h && h.style.display !== 'none', 'Home appears after leaving the start page');
  assert.equal(e._state().pages, 2);
  f.src = 'https://shop.example/menu/item/3';
  h.fire('click');
  assert.equal(f.src, 'https://shop.example/menu');
  assert.equal(h.style.display, 'none');
  assert.ok(calls.logs.some((l) => l.includes('home button — back to https://shop.example/menu')));
  f.fire('load');
  assert.equal(h.style.display, 'none', 'arriving home keeps it hidden');
});

test('framed: a page that refreshes itself never STARTS a session (navigation is keepAlive only)', () => {
  const { e, frame, calls } = engine();
  e.show('k1', cfgOf(), 'w1');
  frame().fire('load'); frame().fire('load'); frame().fire('load');
  assert.equal(calls.hold, 0);
});

test('framed: no load at all within 20s is a load_error, the item is skipped, and it is reported once per window', () => {
  const { e, c, calls } = engine();
  e.show('k1', cfgOf(), 'w1');
  c.advance(20_001);
  assert.equal(calls.skip, 1);
  assert.equal(calls.reports.length, 1);
  assert.equal(calls.reports[0][0], 'load_error');
  assert.match(calls.reports[0][1], /^shop\.example: no page load within 20s/);
  e.show('k1', cfgOf(), 'w1');
  c.advance(20_001);
  assert.equal(calls.skip, 2);
  assert.equal(calls.reports.length, 1, 'throttled: one incident per reason+host per 15 min');
});

test('framed: evidence from fetch — unreachable is load_error, a CORS-readable 500 is http_error, opaque is silent', async () => {
  const dead = engine({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  dead.e.show('k1', cfgOf(), 'w1');
  await flush(); await flush(); dead.c.advance(1);
  assert.equal(dead.calls.reports[0][0], 'load_error');
  assert.match(dead.calls.reports[0][1], /unreachable/);
  assert.equal(dead.calls.skip, 1);

  const err = engine({ fetch: () => Promise.resolve({ status: 500 }) });
  err.e.show('k1', cfgOf(), 'w1');
  await flush(); err.c.advance(1);
  assert.deepEqual(err.calls.reports[0], ['http_error', 'shop.example: HTTP 500']);

  let n = 0;
  const opaque = engine({ fetch: (u, o) => (++n, o.mode === 'cors' ? Promise.reject(new TypeError('cors')) : Promise.resolve({ status: 0, type: 'opaque' })) });
  opaque.e.show('k1', cfgOf(), 'w1');
  await flush(); await flush(); opaque.c.advance(1);
  assert.equal(n, 2);
  assert.equal(opaque.calls.reports.length, 0, 'reachable without CORS: nothing is claimed');
});

test('framed: an http:// page inside an https player is reported as mixed content (loopback exempt)', () => {
  const { e, c, calls } = engine();
  e.show('k1', cfgOf({ url: 'http://shop.example/' }), 'w1');
  c.advance(1);
  assert.match(calls.reports[0][1], /mixed content/);
  const ok = engine();
  ok.e.show('k1', cfgOf({ url: 'http://localhost:8080/' }), 'w1');
  ok.c.advance(1);
  assert.equal(ok.calls.reports.length, 0);
});

test('a failure DURING a session ends it as `error` and releases instead of skipping', () => {
  const { e, d, c, calls, frame } = engine({ fetch: () => new Promise(() => {}) });
  e.show('k1', cfgOf(), 'w1');
  d.doc.activeElement = frame(); d.win.fire('blur'); c.advance(1);
  c.advance(20_001);   // never loaded
  assert.equal(calls.release, 1);
  assert.equal(calls.skip, 0);
  assert.equal(calls.sessions[0].end_reason, 'error');
});

test('min_webview too old: a clear card, a webview_too_old incident, no frame', () => {
  const { e, calls, frame, byText } = engine({ ua: 'Mozilla/5.0 Chrome/79.0.1 Safari/537.36' });
  e.show('k1', cfgOf({ min_webview: 90 }), 'w1');
  assert.equal(frame(), undefined);
  assert.ok(byText(KP.CARD_TOO_OLD));
  assert.deepEqual(calls.reports[0], ['webview_too_old', 'shop.example: Chrome 79, page needs 90']);
});

test('the same item re-issued keeps the visitor\'s page; another item ends the session as interrupted', () => {
  const { e, d, c, calls, frame } = engine();
  e.show('k1', cfgOf(), 'w1');
  const f = frame();
  d.doc.activeElement = f; d.win.fire('blur'); c.advance(1);
  e.show('k1', cfgOf(), 'w1');
  assert.equal(frame(), f, 'no remount');
  e.hide();
  assert.equal(calls.sessions[0].end_reason, 'interrupted');
  assert.equal(e.sessionActive(), false);
});

test('an open session is persisted and recovered on the next start as interrupted', () => {
  const st = memStore();
  const a = engine({ storage: st });
  a.e.show('k1', cfgOf(), 'w1');
  a.d.doc.activeElement = a.frame(); a.d.win.fire('blur'); a.c.advance(1);
  a.c.advance(12_000); a.d.win.fire('blur'); a.c.advance(1);   // activity after >10s re-persists
  // the app dies here: no hide()
  const b = engine({ storage: st });
  const r = b.e.recoverOpenSession();
  assert.equal(r.id, 'uuid-2');
  assert.equal(r.end_reason, 'interrupted');
  assert.equal(r.widget_id, 'w1');
  assert.ok(r.duration_sec >= 12);
  assert.equal(b.e.recoverOpenSession(), null, 'recovered once');
});

// ───────────────────────────────────────────────────────────── HOST (BrightSign top-level)
function fakeHost(answer = true) {
  const h = { opened: [], closed: [], closeSessions: [], beats: [], events: [], gotos: [], fn: null, avail: true };
  h.api = {
    available: () => h.avail,
    open: (p) => { h.opened.push(p); return Promise.resolve(answer); },
    close: (w, sess) => { h.closed.push(w); h.closeSessions.push(sess); },
    keepAlive: (sess) => h.beats.push(sess),
    event: (code) => h.events.push(code),
    goto: (u) => h.gotos.push(u),
    onMessage: (fn) => { h.fn = fn; },
  };
  h.send = (m) => h.fn(Object.assign({ session: h.opened[h.opened.length - 1].session }, m));
  return h;
}
function decodeInject(p) { return Buffer.from(p.inject.split('base64,')[1], 'base64').toString('utf8'); }

test('host: opens the site top-level with the injected script, declares the FULL capability', async () => {
  const h = fakeHost();
  const { e, frame } = engine({ host: h.api });
  assert.equal(e.capability(), 'playback.web_interactive');
  e.show('k1', cfgOf({ zoom: 125 }), 'w1');
  await flush();
  assert.equal(frame(), undefined, 'no iframe in host mode');
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].url, 'https://shop.example/menu');
  assert.equal(h.opened[0].zoom, '1.25');
  assert.ok(/^data:text\/javascript;charset=utf-8;base64,/.test(h.opened[0].inject));
  const src = decodeInject(h.opened[0]);
  assert.ok(src.includes('"domains":["shop.example"]'));
  assert.ok(src.includes(h.opened[0].session));
  assert.doesNotThrow(() => new vm.Script(src), 'the injected source parses');
});

test('host: touches, pages, the countdown in the kiosk page, and a reset that closes + wipes', async () => {
  const h = fakeHost();
  const { e, c, calls } = engine({ host: h.api });
  e.show('k1', cfgOf(), 'w1');
  await flush();
  h.send({ type: 'kiosk-nav', url: 'https://shop.example/menu', reload: '0' });
  h.send({ type: 'kiosk-activity', media: '1' });
  assert.equal(calls.hold, 0, 'media never starts a session');
  h.send({ type: 'kiosk-activity', touch: '1' });
  assert.equal(calls.hold, 1);
  h.send({ type: 'kiosk-nav', url: 'https://shop.example/menu/2', reload: '0' });
  h.send({ type: 'kiosk-nav', url: 'https://shop.example/menu/2', reload: '1' });
  assert.equal(e._state().pages, 2, 'a reload is not a page');
  h.fn({ type: 'kiosk-activity', touch: '1', session: 'someone-else' });
  c.advance(30_000);
  assert.ok(h.events.some((x) => x.includes('CustomEvent') && x.includes('Still there?')), 'the overlay is drawn IN the kiosk page');
  c.advance(10_000);
  assert.equal(calls.release, 1);
  assert.deepEqual(h.closed, [true], 'closed with wipe');
  assert.equal(calls.sessions[0].pages, 2);
  h.fn({ type: 'kiosk-closed', wiped: '1', session: h.opened[0].session });
  c.advance(10_000);
  assert.deepEqual(h.closed, [true], 'acknowledged: not retried');
  assert.ok(calls.logs.some((l) => l.includes('web storage wiped')));
});

test('host: a page that keeps bouncing off-site is sent home; a new window loads in place only if allowed', async () => {
  const h = fakeHost();
  const { e, calls } = engine({ host: h.api });
  e.show('k1', cfgOf(), 'w1');
  await flush();
  for (let i = 0; i < 3; i++) h.send({ type: 'kiosk-blocked', url: 'https://evil.example/' });
  assert.deepEqual(h.gotos, ['https://shop.example/menu']);
  assert.ok(calls.logs.some((l) => l.includes('navigation blocked: https://evil.example/')));
  h.send({ type: 'kiosk-newwindow', url: 'https://www.shop.example/basket' });
  h.send({ type: 'kiosk-newwindow', url: 'https://ads.example/' });
  assert.deepEqual(h.gotos.slice(1), ['https://www.shop.example/basket']);
});

test('host: kiosk-error from the host is a failure with the right incident', async () => {
  const h = fakeHost();
  const { e, c, calls } = engine({ host: h.api });
  e.show('k1', cfgOf(), 'w1');
  await flush();
  h.send({ type: 'kiosk-error', reason: 'load_error', url: 'https://shop.example/menu', detail: 'load error net::ERR_NAME_NOT_RESOLVED' });
  c.advance(1);
  assert.equal(calls.skip, 1);
  assert.deepEqual(calls.reports[0], ['load_error', 'shop.example: load error net::ERR_NAME_NOT_RESOLVED']);
});

test('host: consent cookies are kept BY NAME and restored into the next session\'s page', async () => {
  const h = fakeHost();
  const st = memStore();
  const { e } = engine({ host: h.api, storage: st });
  e.show('k1', cfgOf({ keep_consent: true }), 'w1');
  await flush();
  h.send({ type: 'kiosk-consent', host: 'shop.example', cookies: 'CookieConsent=yes; PHPSESSID=secret' });
  h.send({ type: 'kiosk-consent', host: 'evil.example', cookies: 'CookieConsent=1' });
  e.hide();
  e.show('k2', cfgOf({ keep_consent: true }), 'w1');
  await flush();
  const src = decodeInject(h.opened[1]);
  assert.ok(src.includes('["shop.example","CookieConsent","yes"]'));
  assert.ok(!src.includes('PHPSESSID'), 'a login cookie is never kept');
  assert.ok(!src.includes('evil.example","CookieConsent'), 'only allowed hosts');
  e.hide();
  e.show('k3', cfgOf({ keep_consent: false }), 'w1');
  await flush();
  assert.ok(!decodeInject(h.opened[2]).includes('CookieConsent","yes'), 'keep_consent off restores nothing');
});

test('host: a host that never answers kiosk-open falls back to FRAMED and downgrades the capability', async () => {
  const h = fakeHost(false);
  const { e, calls, frame } = engine({ host: h.api });
  e.show('k1', cfgOf(), 'w1');
  await flush();
  assert.ok(frame(), 'framed instead');
  assert.equal(calls.broken, 1);
  assert.equal(e.capability(), 'playback.web_interactive_framed');
  e.hide();
  e.show('k2', cfgOf(), 'w1');
  await flush();
  assert.equal(h.opened.length, 1, 'not retried this run');
});

test('host: a page script that never reports in (javascript_injection ignored) falls back to FRAMED', async () => {
  const h = fakeHost(true);
  const { e, c, calls, frame } = engine({ host: h.api });
  e.show('k1', cfgOf(), 'w1');
  await flush();
  c.advance(15_001);
  assert.ok(frame());
  assert.equal(calls.broken, 1);
});

// ───────────────────────────────────────────────────────────── the injected page script itself
function runInject(url, opts = {}) {
  const posted = [];
  const docL = {};
  const winL = {};
  const cookies = opts.cookies || [];
  const loc = { href: url, replace: (u) => { loc.replaced = u; } };
  const history = { length: opts.historyLength || 1, back: () => { history.wentBack = true; }, pushState() {} };
  const doc = {
    readyState: 'complete',
    addEventListener: (t, f) => { (docL[t] = docL[t] || []).push(f); },
    createElement: (t) => ({ tagName: t.toUpperCase(), setAttribute() {}, addEventListener() {}, style: {}, textContent: '' }),
    documentElement: { appendChild() {} }, head: { appendChild() {} }, body: { appendChild(el) { (doc.mounted = doc.mounted || []).push(el); } },
    querySelectorAll: () => [],
    get cookie() { return cookies.join('; '); },
    set cookie(v) { cookies.push(v.split(';')[0]); doc.cookieWrites = (doc.cookieWrites || []).concat(v); },
  };
  const win = {
    BSMessagePort: function () { return { PostBSMessage: (m) => posted.push(m) }; },
    BSDeviceInfo: function () {}, BSControlPort: function () {},
    location: loc, history, document: doc,
    addEventListener: (t, f) => { (winL[t] = winL[t] || []).push(f); },
    setInterval: () => 1, performance: { getEntriesByType: () => [{ type: 'navigate', responseStatus: opts.status || 200 }] },
    Date, URL, Object,
  };
  win.top = win; win.window = win;
  const cfg = cfgOf(opts.cfg);
  const src = KP.buildInjectSource(cfg, { session: 'S', evt: 'evt-x', patterns: L.keepPatterns(cfg), consent: opts.consent || [] });
  const ctx = vm.createContext(win);
  vm.runInContext(src, ctx);
  return { posted, win, doc, docL, winL, loc, history };
}

test('injected: takes the message port first and hides every BS* object from the site', () => {
  const r = runInject('https://shop.example/menu');
  assert.equal(r.win.BSMessagePort, undefined);
  assert.equal(r.win.BSDeviceInfo, undefined);
  assert.equal(r.win.BSControlPort, undefined);
  assert.ok(r.posted.some((m) => m.type === 'kiosk-nav' && m.url === 'https://shop.example/menu' && m.session === 'S'));
});

test('injected: a document outside the allowlist is reported and left (back, or the start page)', () => {
  const a = runInject('https://evil.example/', { historyLength: 3 });
  assert.deepEqual(a.posted.map((m) => m.type), ['kiosk-blocked']);
  assert.equal(a.history.wentBack, true);
  const b = runInject('https://evil.example/');
  assert.equal(b.loc.replaced, 'https://shop.example/menu');
});

test('injected: an off-site link is stopped before the request; window.open loads in place when allowed', () => {
  const r = runInject('https://shop.example/menu');
  let prevented = false;
  const a = { nodeType: 1, tagName: 'A', href: 'https://evil.example/x', hasAttribute: () => false, getAttribute: () => null, parentNode: null };
  r.docL.click[0]({ target: a, preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  assert.ok(r.posted.some((m) => m.type === 'kiosk-blocked' && m.url === 'https://evil.example/x'));
  r.win.open('/basket');
  assert.equal(r.loc.href, 'https://shop.example/basket');
});

test('injected: kept consent cookies are restored on their own host only; a 4xx document is reported', () => {
  const r = runInject('https://www.shop.example/menu', { consent: [['shop.example', 'CookieConsent', 'yes'], ['other.example', 'X', '1']], status: 404 });
  assert.deepEqual(r.doc.cookieWrites.map((c) => c.split(';')[0]), ['CookieConsent=yes']);
  assert.ok(r.posted.some((m) => m.type === 'kiosk-error' && m.reason === 'http_error' && m.detail === 'HTTP 404'));
});

test('injected: touches post activity (throttled to one a second)', () => {
  const r = runInject('https://shop.example/menu');
  r.winL.pointerdown[0]({}); r.winL.pointerdown[0]({});
  assert.equal(r.posted.filter((m) => m.type === 'kiosk-activity' && m.touch === '1').length, 1);
});

// ───────────────────────────────────────────────────────────── index.html wiring
test('index.html loads the rules and the engine, and the server serves the rules from lib/', () => {
  assert.ok(PLAYER.includes('<script src="/player/kiosk-logic.js"></script>'));
  assert.ok(PLAYER.includes('<script src="/player/kiosk-player.js"></script>'));
  assert.ok(PLAYER.indexOf('/player/kiosk-logic.js') < PLAYER.indexOf('/player/kiosk-player.js'));
  const srv = read('server/server.js');
  assert.match(srv, /app\.get\('\/player\/kiosk-logic\.js'[\s\S]{0,200}'lib', 'kiosk-logic\.js'/);
});

test('index.html: the kiosk state is declared ABOVE Boot (an interactive first item must not hit a TDZ)', () => {
  const boot = PLAYER.indexOf('==================== Boot ====================');
  for (const d of ['let kioskHeld = false;', 'let kioskParkedUpdate = null;', 'const kiosk = (window.KioskPlayer', 'const kioskQueue =']) {
    const at = PLAYER.indexOf(d);
    assert.ok(at > 0 && at < boot, `${d} must be declared before Boot`);
  }
});

test('index.html: fullscreen only — the kiosk path is skipped in zones, walls, groups and preview', () => {
  assert.match(PLAYER, /const kioskCfg = \(!isZones && !wallConfig && !groupSync && !PREVIEW_MODE && typeof kioskConfigFor === 'function'\s*&& !kioskCovered\(\)\) \? kioskConfigFor\(item\) : null;/);
});

test('index.html: while held nothing advances, and a playlist update is parked (a suspension is not)', () => {
  const ni = PLAYER.slice(PLAYER.indexOf('function nextItem() {'), PLAYER.indexOf('function nextItem() {') + 400);
  assert.match(ni, /if \(typeof kioskHeld !== 'undefined' && kioskHeld\) \{/);
  const hp = PLAYER.slice(PLAYER.indexOf('function handlePlaylistUpdate(data) {'), PLAYER.indexOf('function handlePlaylistUpdate(data) {') + 1200);   // room for the emergency-alert branch before the park
  assert.match(hp, /data\.suspended[\s\S]*kioskDropHold\(\)[\s\S]*else if \(typeof kioskHeld !== 'undefined' && kioskHeld\) \{\s*kioskParkedUpdate = data;/);
});

function extract(name) {
  const at = PLAYER.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found`);
  let i = PLAYER.indexOf('{', at), depth = 0, end = i;
  for (; end < PLAYER.length; end++) {
    if (PLAYER[end] === '{') depth++;
    else if (PLAYER[end] === '}' && --depth === 0) { end++; break; }
  }
  return PLAYER.slice(at, end);
}

// The playlist half of the session (hold / release / end-without-advance / leave-the-stage), run
// for real against a stand-in player: the functions are extracted from index.html as they ship.
function holdHarness() {
  const src = ['kioskKeyOf', 'kioskHold', 'kioskRelease', 'kioskEndHold', 'kioskArmDeferredDeadline', 'kioskLeaveStage'].map(extract).join('\n');
  const log = [];
  const timers = [];
  const P = {
    playlist: [{ widget_id: 'w', widget_rev: 1 }, { content_id: 'c' }],
    currentIndex: 0,
    mounted: null,                 // the key the engine is showing
    hidden: 0,
  };
  const kiosk = {
    isShowing: () => P.mounted != null,
    isShowingItem: (k) => P.mounted === k,
    hide: () => { P.hidden++; P.mounted = null; },
  };
  const fn = new Function('P', 'kiosk', 'console', 'itemIdentity', 'handlePlaylistUpdate', 'nextItem', 'startPlaybackAt', 'setTimeout', 'clearTimeout', `
    let kioskHeld = false, kioskHeldKey = null, kioskParkedUpdate = null;
    let advanceTimer = 7, deferredRotation = false, deferredRotationDeadline = null, deferredSuccessorId = null;
    let playlist = P.playlist;
    Object.defineProperty(P, 'cur', { get: () => P.currentIndex });
    const currentIndexOf = () => P.currentIndex;
    ${src.replace(/\bcurrentIndex\b/g, 'P.currentIndex')}
    return {
      hold: kioskHold, release: kioskRelease, leave: kioskLeaveStage, key: kioskKeyOf,
      park: (d) => { kioskParkedUpdate = d; },
      defer: (on, deadline) => { deferredRotation = on; deferredRotationDeadline = deadline; },
      state: () => ({ kioskHeld, advanceTimer, deferredRotation, deadline: deferredRotationDeadline, parked: kioskParkedUpdate }),
    };`);
  const api = fn(P, kiosk, { log() {}, warn() {} }, (x) => `${x.content_id || ''}|${x.widget_id || ''}`,
    (d) => { log.push('update ' + d.n); if (d.moveTo != null) P.currentIndex = d.moveTo; if (d.defer) api.defer(true, null); },
    () => log.push('next'), (i) => log.push('start ' + i),
    (f, ms) => { timers.push({ f, ms }); return timers.length; }, (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; });
  const runTimers = (ms) => timers.filter((t) => !t.cleared && !t.ran && t.ms <= ms).forEach((t) => { t.ran = true; t.f(); });
  return { api, P, log, timers, runTimers };
}

test('index.html: release applies the parked update, then advances only if the held item is still on screen', () => {
  const { api, P, log } = holdHarness();
  P.mounted = api.key(P.playlist[0]);
  api.hold();
  assert.equal(api.state().kioskHeld, true);
  assert.equal(api.state().advanceTimer, null, 'the advance timer is cancelled');
  api.park({ n: 1 });
  api.release();
  assert.deepEqual(log, ['update 1', 'next']);
  api.hold(); api.park({ n: 2, moveTo: 1 }); api.release();
  assert.deepEqual(log.slice(2), ['update 2'], 'the parked update moved playback: no extra skip');
});

test('REGRESSION A: a tap on the OUTGOING page (the next item already current) never holds the new item', () => {
  const { api, P, log } = holdHarness();
  P.mounted = api.key(P.playlist[0]);   // the kiosk page is still on screen...
  P.currentIndex = 1;                   // ...but the buffered swap already made the next item current
  api.hold();
  assert.equal(api.state().kioskHeld, false, 'holding here would pin the next item forever');
  api.leave('the stage was torn down');
  api.release();
  assert.deepEqual(log, [], 'nothing to release, nothing advanced');
});

test('REGRESSION A: the page torn down mid-session clears the hold WITHOUT advancing and still applies the parked update', () => {
  const { api, P, log, runTimers } = holdHarness();
  P.mounted = api.key(P.playlist[0]);
  api.hold();
  api.park({ n: 7 });
  assert.equal(api.leave('the stage was torn down'), true);
  assert.equal(P.hidden, 1);
  assert.equal(api.state().kioskHeld, false, 'no hold survives the page');
  assert.deepEqual(log, [], 'deferred: never re-entrant from inside a teardown');
  runTimers(0);
  assert.deepEqual(log, ['update 7'], 'the parked update is applied, and nothing advances');
});

test('REGRESSION B: the #157 deadline cannot tear the page down mid-session; it is re-armed if the session is cut off', () => {
  const { api, P, log, timers } = holdHarness();
  P.mounted = api.key(P.playlist[0]);
  api.defer(true, 42);                   // the operator removed the item; the 60 s deadline is armed
  api.hold();
  assert.equal(api.state().deadline, null, 'the hold suspends the deadline');
  assert.equal(api.state().deferredRotation, true, '...but keeps the deferral itself');
  api.leave('trigger');
  assert.ok(api.state().deadline, 'cut off: the safety net is armed again');
  assert.equal(timers[timers.length - 1].ms, 60000);
  api.defer(true, null);
  P.mounted = api.key(P.playlist[0]);
  api.hold();
  api.release();
  assert.deepEqual(log, ['next'], 'a normal release takes the deferred rotation through nextItem');
});

test('#11: a parked update that REMOVED the held item advances on release instead of waiting 60 s', () => {
  const { api, P, log } = holdHarness();
  P.mounted = api.key(P.playlist[0]);
  api.hold();
  api.park({ n: 3, defer: true });       // handlePlaylistUpdate saw the held item gone: #157 deferral
  api.release();
  assert.deepEqual(log, ['update 3', 'next']);
});

test('index.html: covers end the session and close the page; an interactive item under a cover renders passively', () => {
  const at = (needle, len = 1500) => { const i = PLAYER.indexOf(needle); assert.ok(i > 0, needle); return PLAYER.slice(i, i + len); };
  assert.match(at('function triggerFire(', 4000), /kioskYield\('trigger/);
  assert.match(at('function pipShow('), /kiosk\.mode\(\) === 'host'\) kioskYield\('PiP shown'\)/);
  assert.match(at('function showStatus('), /kioskYield\('status card'\)/);
  assert.match(at('function toggleScreenOff('), /kioskYield\('screen off'\)/);
  assert.match(at('function enterRepairMode('), /kioskYield\('re-pairing'\)/);
  assert.match(at('function unpairThisPlayer(', 3000), /kioskYield\('unpaired at the panel'\)/);
  assert.match(at('function triggerStop('), /kioskResume\(\)/);
  assert.match(at('function pipClear('), /kioskResume\(\)/);
  assert.match(PLAYER, /PREVIEW_MODE && typeof kioskConfigFor === 'function'\s*&& !kioskCovered\(\)\) \? kioskConfigFor\(item\) : null;/);
  // kioskCovered reads two `let`s declared below Boot: it must answer, never throw, at boot.
  const covered = new Function(`${extract('kioskCovered')}; return kioskCovered();`);
  assert.equal(covered(), false, 'undeclared trigger/screen state reads as "nothing covers it"');
  assert.equal(new Function('triggerActive', 'screenIsOff', 'pipCurrent', 'kiosk', `${extract('kioskCovered')}; return kioskCovered();`)({ trigger: 1 }, false, null, null), true);
  assert.equal(new Function('triggerActive', 'screenIsOff', 'pipCurrent', 'kiosk', `${extract('kioskCovered')}; return kioskCovered();`)(null, false, 'p1', { capability: () => 'playback.web_interactive_framed' }), false, 'a framed page stays under a PiP');
});

test('index.html: during a session screenshots are blank and remote touch/key/live view are refused', () => {
  const cap = extract('captureAndSend');
  assert.match(cap, /kioskPrivacy\(\)\) \{ sendBlankFrame\(\); return; \}/);
  for (const ev of ['device:remote-touch', 'device:remote-key']) {
    const at = PLAYER.indexOf(`socket.on('${ev}'`);
    assert.match(PLAYER.slice(at, at + 300), /if \(kioskPrivacy\(\)\) \{[^}]*refused[^}]*return; \}/, ev);
  }
  const lp = PLAYER.indexOf("socket.on('device:live-publish'");
  assert.match(PLAYER.slice(lp, lp + 800), /kioskPrivacy\(\)/);
});

test('index.html: sessions flush after registration and on ack; errors are held offline and flushed', () => {
  const reg = PLAYER.slice(PLAYER.indexOf("socket.on('device:registered'"), PLAYER.indexOf("socket.on('device:registered'") + 900);
  assert.match(reg, /flushKioskSessions\(\);\s*flushKioskErrors\(\);/);
  assert.match(PLAYER, /socket\.on\('device:kiosk-sessions-ack'/);
  const send = [];
  const fn = new Function('socket', 'config', 'emitDeviceEvent', 'kioskHeldErrors', `${extract('sendKioskError')}; ${extract('flushKioskErrors')}; return { sendKioskError, flushKioskErrors };`);
  const sock = { connected: false };
  const held = new KP.ErrorHold();
  const api = fn(sock, { deviceId: 'd1' }, (t, r, d) => send.push([t, r, d]), held);
  api.sendKioskError('load_error', 'shop.example: x');
  assert.equal(send.length, 0);
  sock.connected = true;
  api.flushKioskErrors();
  assert.deepEqual(send, [['web_error', 'load_error', 'shop.example: x (while offline)']]);
});

test('index.html: the session batch goes out as device:kiosk-sessions {device_id, sessions} and waits for the ack', () => {
  const emitted = [];
  const fn = new Function('socket', 'config', 'kioskQueue', 'window', `let kioskFlushInFlight = false, kioskFlushTimer = null;
    ${extract('flushKioskSessions')}; ${extract('onKioskSessionsAck')}; return { flushKioskSessions, onKioskSessionsAck };`);
  const q = new KP.SessionQueue(memStore(), 'q');
  for (let i = 0; i < 60; i++) q.add(rec(i));
  const api = fn({ connected: true, emit: (e, d) => emitted.push([e, d]) }, { deviceId: 'd1' }, q, { KioskPlayer: KP });
  api.flushKioskSessions();
  api.flushKioskSessions();
  assert.equal(emitted.length, 1, 'one batch in flight');
  assert.equal(emitted[0][0], 'device:kiosk-sessions');
  assert.equal(emitted[0][1].device_id, 'd1');
  assert.equal(emitted[0][1].sessions.length, 50);
  api.onKioskSessionsAck({ ids: emitted[0][1].sessions.map((r) => r.id), written: 50 });
  assert.equal(q.size(), 10);
});

test('declaredCapabilities: exactly one of the two interactive capabilities, from the engine', () => {
  const src = extract('declaredCapabilities');
  const run = (kiosk) => new Function('kiosk', 'BS', 'HOST', 'swRegistrationFailed', 'triggerStats', 'window', 'navigator', 'document',
    `${src}; return declaredCapabilities();`)(kiosk, null, null, false, undefined, {}, {}, { createElement: () => ({ getContext: () => ({}), toDataURL() {} }) });
  const framed = run({ capability: () => 'playback.web_interactive_framed' });
  assert.ok(framed.includes('playback.web_interactive_framed'));
  assert.ok(!framed.includes('playback.web_interactive'));
  const full = run({ capability: () => 'playback.web_interactive' });
  assert.ok(full.includes('playback.web_interactive') && !full.includes('playback.web_interactive_framed'));
  assert.ok(!run(null).some((c) => c.startsWith('playback.web_interactive')), 'no engine, no claim');
});

// ───────────────────────────────────────────────────────────── BrightSign bridge + host
function loadBridge(probeRes) {
  const posted = [];
  const handlers = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    navigator: { userAgent: 'BrightSign/9.0.189 (XT245) Chrome/120' },
    location: { search: '' }, setInterval: () => 1,
    setTimeout: (fn, ms) => { if (ms === 3000 || ms === 0) fn(); return 1; }, clearTimeout: () => {},
    Promise, Object, Array, Uint8Array, Math, Date, RegExp, String, Number, parseInt, isNaN, isFinite, decodeURIComponent, Error,
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.window = sandbox;
  sandbox.require = (name) => {
    if (name !== '@brightsign/messageport') throw new Error('no ' + name);
    return function () {
      return {
        PostBSMessage: (m) => {
          posted.push(m);
          if (m.type === 'probe' && probeRes) handlers.forEach((h) => h(Object.assign({ type: 'probe-result' }, probeRes)));
          if (m.type === 'kiosk-open' && probeRes && probeRes.answer) handlers.forEach((h) => h({ type: 'kiosk-opened', session: m.session, ok: probeRes.answer }));
        },
        addEventListener: (evt, fn) => { if (evt === 'bsmessage') handlers.push(fn); },
      };
    };
  };
  vm.createContext(sandbox);
  vm.runInContext(read('brightsign/st-bridge.js'), sandbox);
  return { api: sandbox.ScreenTinkerBS, posted };
}

test('bridge: top-level kiosk only when the host announced it; open resolves on the host\'s answer', async () => {
  assert.equal(loadBridge(null).api.kioskSupported(), false, 'no probe answer = framed');
  assert.equal(loadBridge({ storage_present: false }).api.kioskSupported(), false, 'an older autorun.brs');
  const yes = loadBridge({ kiosk_toplevel: true, answer: '1' });
  assert.equal(yes.api.kioskSupported(), true);
  assert.equal(await yes.api.kioskOpen({ url: 'https://a.example', zoom: '1', inject: 'data:x', session: 'S' }, 50), true);
  const open = yes.posted.find((m) => m.type === 'kiosk-open');
  for (const v of Object.values(open)) assert.equal(typeof v, 'string', 'flat strings only — PostBSMessage carries nothing nested');
  const no = loadBridge({ kiosk_toplevel: true, answer: '0' });
  assert.equal(await no.api.kioskOpen({ session: 'S' }, 50), false);
  yes.api.kioskClose(true); yes.api.kioskGoto('https://a.example/b'); yes.api.kioskEval('1');
  assert.deepEqual(yes.posted.slice(-3).map((m) => m.type), ['kiosk-close', 'kiosk-goto', 'kiosk-eval']);
});

function brsCode() { return BRS.split('\n').filter((l) => !/^\s*'/.test(l)).join('\n'); }
function brsBlock(name) {
  const src = brsCode();
  const at = src.search(new RegExp(`(Sub|Function) ${name}\\(`));
  assert.ok(at >= 0, `${name} not found`);
  return src.slice(at, src.indexOf('\nEnd ', at));
}

test('autorun.brs: the kiosk widget has its own port, no Node, fresh storage, and the injected script', () => {
  const open = brsBlock('KioskOpenWidget');
  assert.ok(!/nodejs_enabled/.test(open), 'a third-party site must never get require()');
  assert.match(open, /storage_path: dir\$/);
  assert.match(open, /port: kport/);
  assert.match(open, /javascript_injection = \{ document_creation: \[\{ source: inject\$ \}\] \}/);
  assert.match(open, /HasFindMember\(\) then\s*if FindMemberFunction\(w, "SetZoomLevel"\)/);
  const main = brsBlock('Main');
  assert.match(main, /kport = CreateObject\("roMessagePort"\)/);
  assert.ok(main.indexOf('KioskWipeAll()') < main.indexOf('MakeWidget('), 'leftover session storage is wiped before the player starts');
  assert.match(main, /KioskPump\(ks, kport, widget\)/);
  assert.match(brsBlock('SendProbeResult'), /kiosk_toplevel: kioskOk/);
});

test('autorun.brs: only kiosk-* messages are relayed, field by field, as strings', () => {
  const relay = brsBlock('KioskRelay');
  assert.match(relay, /if type\(req\) <> "roAssociativeArray" then return/);
  assert.match(relay, /t\$ <> "kiosk-activity" and t\$ <> "kiosk-nav"/);
  assert.match(relay, /v\$ = KioskStr\(req\[k\]\)/);
  // every page-supplied value goes through KioskStr before it is compared or used
  const fromPage = brsBlock('KioskFromPage');
  assert.ok(!/req\.\w+\s*[<>=]/.test(fromPage), 'a raw page value compared to a literal is a type mismatch that aborts the script');
});

test('held errors: the 400-char cap includes the offline suffix', () => {
  const h = new KP.ErrorHold();
  h.add('load_error', 'x'.repeat(400));
  assert.equal(h.drain()[0][1].length, 400);
});

test('host: a lost kiosk-close is retried (3 times, 2 s apart) and every attempt names its session', async () => {
  const h = fakeHost();
  const { e, c, calls } = engine({ host: h.api });
  e.show('k1', cfgOf(), 'w1');
  await flush();
  e.hide();
  c.advance(10_000);
  assert.equal(h.closed.length, 3);
  assert.ok(h.closeSessions.every((x) => x === h.opened[0].session));
  assert.ok(calls.logs.some((l) => l.includes('never confirmed closing')));
});

test('host: the player keeps an open kiosk page alive every 5 s, and stops when it closes', async () => {
  const h = fakeHost();
  const { e, c } = engine({ host: h.api });
  e.show('k1', cfgOf(), 'w1');
  await flush();
  c.advance(15_000);
  assert.ok(h.beats.length >= 3 && h.beats.every((x) => x === h.opened[0].session), `beats ${h.beats.length}`);
  e.hide();
  const n = h.beats.length;
  c.advance(20_000);
  assert.equal(h.beats.length, n);
});

test('framed: an allowlist that covers the PLAYER\'s host drops allow-same-origin', () => {
  const { e, frame } = engine({ origin: 'https://signage.example' });
  e.show('k1', cfgOf({ allowed_domains: 'signage.example' }), 'w1');
  assert.ok(!frame().getAttribute('sandbox').includes('allow-same-origin'));
});

test('framed: a frame that ends up on the player\'s own origin (readable) is closed and reported', () => {
  const { e, c, calls, frame } = engine();
  e.show('k1', cfgOf(), 'w1');
  const f = frame();
  f.contentWindow = { location: { href: 'https://signage.example/player' } };   // readable = same origin as us
  f.fire('load');
  c.advance(1);
  assert.equal(calls.skip, 1);
  assert.match(calls.reports[0][1], /player's own origin/);
  assert.equal(e.isShowing(), false);
});

test('autorun.brs: top-level mode is OFF unless screentinker.json / the registry opts in', () => {
  const load = brsBlock('LoadConfig');
  assert.match(load, /kiosk_toplevel: false/);
  assert.match(load, /t\$ = type\(json\.kiosk_toplevel\)\s*if t\$ = "Boolean" or t\$ = "roBoolean" then cfg\.kiosk_toplevel = json\.kiosk_toplevel/);
  const main = brsBlock('Main');
  assert.match(main, /SendProbeResult\(widget, cfg\.kiosk_toplevel and \(widget2 = invalid\)\)/);
  assert.match(main, /KioskFromPage\(ks, m, rect, kport, widget, cfg\.kiosk_toplevel and \(widget2 = invalid\)\)/);
});

test('autorun.brs: keep-alive silence closes the page; a retried close never shuts a newer one', () => {
  const main = brsBlock('Main');
  assert.match(main, /ks\.alive\.TotalMilliseconds\(\) > KIOSK_SILENCE_MS[\s\S]{0,200}KioskClose\(ks, widget, true\)/);
  const fromPage = brsBlock('KioskFromPage');
  assert.match(fromPage, /if s\$ <> "" and s\$ <> ks\.session then\s*player\.PostJSMessage\(\{ type: "kiosk-closed", session: s\$/);
  assert.match(fromPage, /t\$ = "kiosk-keepalive"[\s\S]{0,120}ks\.alive\.Mark\(\)/);
});

test('bridge: close carries the session and the keep-alive exists', () => {
  const b = loadBridge({ kiosk_toplevel: true, answer: '1' });
  b.api.kioskClose(true, 'S9'); b.api.kioskKeepAlive('S9');
  assert.deepEqual(JSON.parse(JSON.stringify(b.posted.slice(-2))), [{ type: 'kiosk-close', wipe: '1', session: 'S9' }, { type: 'kiosk-keepalive', session: 'S9' }]);
});

// ───────────────────────────────────────────── emergency alerts cut in (interrupt: true)
// QA: an alert card appeared only after the current item finished (#157 deferral, up to 60 s). The
// server marks the card interrupt:true; a change to the SET of those is applied at once, mid-item.
function interruptFns() {
  const src = ['itemIdentity', 'interruptKeysOf', 'interruptChanged'].map(extract).join('\n');
  return new Function(`${src}; return { interruptChanged };`)();
}
const CAP_CARD = { widget_id: 'w-cap', widget_type: 'cap_alert', interrupt: true };
const PLAIN_A = { content_id: 'a', filepath: 'a.png' }, PLAIN_B = { content_id: 'b', filepath: 'b.png' };

test('index.html interruptChanged: raised, cleared and swapped feeds change the set; edits and re-sends do not', () => {
  const { interruptChanged } = interruptFns();
  assert.equal(interruptChanged([PLAIN_A, PLAIN_B], [CAP_CARD]), true, 'raised');
  assert.equal(interruptChanged([CAP_CARD], [PLAIN_A, PLAIN_B]), true, 'cleared');
  assert.equal(interruptChanged([CAP_CARD], [{ ...CAP_CARD, widget_id: 'w-cap-2' }]), true, 'another feed took over');
  assert.equal(interruptChanged([CAP_CARD], [{ ...CAP_CARD, duration_sec: 90 }]), false, 'the same alert re-sent');
  assert.equal(interruptChanged([PLAIN_A, PLAIN_B], [PLAIN_B]), false, 'an ordinary edit keeps #157');
  assert.equal(interruptChanged([PLAIN_A], [{ ...CAP_CARD, interrupt: undefined }]), false, 'the flag is the contract');
  assert.equal(interruptChanged([PLAIN_A], undefined), false, 'a malformed payload is not an alert');
});

test('index.html: an interrupt change skips the #157 deferral and is never parked behind a kiosk session', () => {
  const body = extract('handlePlaylistUpdate');
  // The hold branch: an alert closes the page and drops the hold BEFORE the ordinary park.
  const bypass = body.indexOf("kioskHeld && interruptChanged(playlist, data && data.assignments)");
  const park = body.indexOf('kioskParkedUpdate = data;');
  assert.ok(bypass > 0 && park > bypass, 'the interrupt check runs before the park');
  assert.match(body.slice(bypass, park), /kiosk\.hide\(\);[\s\S]*kioskDropHold\(\);/);
  // The deferral: gated on the interrupt set, compared old-vs-new.
  assert.match(body, /const interruptNow = interruptChanged\(oldPlaylist, playlist\);/);
  assert.match(body, /if \(isPlaying && !scheduleDriven && !outgoingNeverAdvances && !interruptNow\) \{\s*deferredRotation = true;/);
});
