'use strict';

// #473 interactive web pages on the Tizen player (framed mode): tizen/js/kiosk-session.js and its
// wiring in tizen/js/player.js, loaded into a node vm with a small DOM shim (no jsdom in the repo,
// same approach as tizen-multitasking-resume.test.js) and fake timers + a fake socket.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------------- fake clock ----------------
function clock(start) {
  let now = start || 1_700_000_000_000;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => { const id = ++seq; timers.set(id, { fn, at: now + (ms || 0), every }); return id; };
  const api = {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, ms) => add(fn, ms, ms || 1),
    clearInterval: (id) => { timers.delete(id); },
    pending: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at = now + t.every; else timers.delete(id);
        t.fn();
      }
      now = end;
    },
  };
  return api;
}

// ---------------- DOM shim ----------------
function makeDoc() {
  const doc = { activeElement: null };
  function el(tag) {
    const e = {
      tag, style: {}, className: '', attrs: {}, children: [], parentNode: null, listeners: {}, _text: '', src: '',
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); },
      fire(t, ev) { for (const fn of (this.listeners[t] || []).slice()) fn(ev || { preventDefault() {} }); },
      blur() { if (doc.activeElement === this) doc.activeElement = null; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const tags = sel.split(',').map((s) => s.trim());
        const out = [];
        (function walk(n) { for (const c of n.children) { if (tags.includes(c.tag)) out.push(c); walk(c); } })(this);
        return out;
      },
      classList: { add() {}, remove() {}, contains() { return false; } },
      pause() {}, load() {}, play() { return Promise.resolve(); },
      contentWindow: { get location() { throw new Error('SecurityError: cross-origin'); } },
    };
    if (tag === 'img') { e.complete = true; e.naturalWidth = 1920; }   // loads instantly, so an image that plays is visible on the stage
    Object.defineProperty(e, 'textContent', { get() { return this._text; }, set(v) { this._text = String(v); } });
    Object.defineProperty(e, 'innerHTML', { get() { return ''; }, set(v) { if (v === '') { for (const c of this.children) c.parentNode = null; this.children = []; } } });
    return e;
  }
  doc.createElement = el;
  doc.getElementById = () => null;
  doc.querySelector = () => null;
  doc.body = el('body');
  return doc;
}

function find(root, pred) {
  const out = [];
  (function walk(n) { for (const c of n.children) { if (pred(c)) out.push(c); walk(c); } })(root);
  return out;
}
const byClass = (root, cls) => find(root, (c) => c.className === cls)[0] || null;

// ---------------- loader ----------------
function load({ withPlayer = false, ua = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36' } = {}) {
  const c = clock();
  const doc = makeDoc();
  const store = new Map();
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const winListeners = {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, JSON, Math, Date, Promise,
    setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, setInterval: c.setInterval, clearInterval: c.clearInterval,
    localStorage, navigator: { language: 'en', userAgent: ua, onLine: true },
    document: doc,
    addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
    removeEventListener(t, fn) { winListeners[t] = (winListeners[t] || []).filter((f) => f !== fn); },
    focus() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('tizen/js/kiosk-logic.js'), sandbox, { filename: 'kiosk-logic.js' });
  vm.runInContext(read('tizen/js/kiosk-session.js'), sandbox, { filename: 'kiosk-session.js' });
  if (withPlayer) vm.runInContext(read('tizen/js/player.js'), sandbox, { filename: 'player.js' });
  return { sb: sandbox, c, doc, store, fireWindow: (t) => (winListeners[t] || []).slice().forEach((f) => f({})) };
}

function cfgOf(sb, extra) {
  return sb.KioskLogic.parse('webpage', Object.assign({ url: 'https://shop.example/menu', interactive: true, idle_timeout_sec: 20, idle_warning_sec: 10 }, extra || {}));
}

function makeSession(env, over) {
  const calls = { hold: 0, release: 0, skip: 0, errors: [], sessions: [], wiped: 0, logs: [] };
  let fetchImpl = () => Promise.resolve({});
  const stage = env.doc.createElement('div');
  const k = new env.sb.KioskSession(Object.assign({
    container: stage, document: env.doc, window: env.sb, storage: env.sb.localStorage,
    now: env.c.now, setTimeout: env.c.setTimeout, clearTimeout: env.c.clearTimeout,
    setInterval: env.c.setInterval, clearInterval: env.c.clearInterval,
    log: (l, m) => calls.logs.push(m),
    onHold: () => calls.hold++, onRelease: () => calls.release++, onSkip: () => calls.skip++,
    onError: (r, d) => calls.errors.push([r, d]), onSessionEnd: (r) => calls.sessions.push(r),
    websetting: () => ({ removeAllCookies(ok) { calls.wiped++; if (ok) ok(); } }),
    fetch: (u, o) => fetchImpl(u, o),
    userActivation: () => env.activation,
  }, over || {}));
  return { k, stage, calls, setFetch: (f) => { fetchImpl = f; } };
}
const frameOf = (stage) => find(stage, (c) => c.tag === 'iframe')[0] || null;
const flush = () => new Promise((r) => setImmediate(r));
// The first tap into a cross-origin frame: focus moves into it, the window blurs.
// A real tap carries transient user activation (navigator.userActivation.isActive) into the parent.
function tapIntoFrame(env, stage) {
  env.activation = { isActive: true };
  env.doc.activeElement = frameOf(stage); env.fireWindow('blur');
  env.activation = { isActive: false };
  env.c.advance(1);
}

// ---------------- the shared file ----------------
test('tizen kiosk-logic.js is byte-identical to the canonical module, and build-wgt.sh re-copies it', () => {
  const a = fs.readFileSync(path.join(ROOT, 'server/lib/kiosk-logic.js'));
  const b = fs.readFileSync(path.join(ROOT, 'tizen/js/kiosk-logic.js'));
  assert.ok(a.equals(b), 'tizen/js/kiosk-logic.js has drifted — re-copy it (build-wgt.sh does this)');
  assert.match(read('tizen/build-wgt.sh'), /cp \.\.\/server\/lib\/kiosk-logic\.js js\/kiosk-logic\.js/);
  const html = read('tizen/index.html');
  const i = (s) => html.indexOf(s);
  assert.ok(i('js/kiosk-logic.js') > 0 && i('js/kiosk-logic.js') < i('js/kiosk-session.js') && i('js/kiosk-session.js') < i('js/player.js'),
    'index.html loads kiosk-logic, then kiosk-session, before player.js');
});

test('the bundled copy passes the shared vectors (parse)', () => {
  const env = load();
  const V = JSON.parse(read('shared/kiosk-vectors.json'));
  for (const v of V.parse) assert.deepEqual(JSON.parse(JSON.stringify(env.sb.KioskLogic.parse(v.type, v.config))), v.expect, v.name);
});

test('capabilities: framed mode only, never playback.web_interactive', () => {
  const sb = { console, window: null, MediaCache: null };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(read('tizen/js/capabilities.js'), sb);
  assert.ok(!sb.STCapabilities.detect().includes('playback.web_interactive_framed'), 'absent when the modules did not load');
  sb.KioskLogic = {}; sb.KioskSession = function () {};
  const caps = sb.STCapabilities.detect();
  assert.ok(caps.includes('playback.web_interactive_framed'));
  assert.ok(!caps.includes('playback.web_interactive'));
});

// ---------------- zoom ----------------
test('zoom is a layout zoom: frame at 100/zoom % scaled by zoom (server renderWebpage model)', () => {
  const env = load();
  const css150 = env.sb.KioskSession.zoomCss(150);
  assert.match(css150, /width:66\.66+\d*%/);
  assert.match(css150, /height:66\.66+\d*%/);
  assert.match(css150, /transform:scale\(1\.5\)/);
  assert.match(css150, /transform-origin:0 0/);
  const css50 = env.sb.KioskSession.zoomCss(50);
  assert.match(css50, /width:200%/);
  assert.match(css50, /scale\(0\.5\)/);
  assert.match(env.sb.KioskSession.zoomCss(100), /width:100%.*scale\(1\)/);
});

// ---------------- mount, hold, idle, reset ----------------
test('mounts the SITE in its own frame (not the server render), sandboxed against top-navigation and popups', () => {
  const env = load();
  const { k, stage } = makeSession(env);
  k.show('w1|0', cfgOf(env.sb, { zoom: 125 }), 'w1');
  const f = frameOf(stage);
  assert.ok(f, 'an iframe was mounted');
  assert.equal(f.src, 'https://shop.example/menu');
  const sb = f.attrs.sandbox;
  assert.match(sb, /allow-scripts/); assert.match(sb, /allow-same-origin/); assert.match(sb, /allow-forms/);
  assert.doesNotMatch(sb, /allow-top-navigation/); assert.doesNotMatch(sb, /allow-popups/);
  assert.match(f.style.cssText, /scale\(1\.25\)/);
  assert.equal(k.sessionActive(), false, 'passive until touched');
  // Same item re-issued (playlist refresh): the page is kept, not remounted.
  k.show('w1|0', cfgOf(env.sb), 'w1');
  assert.equal(frameOf(stage), f);
});

test('first touch holds; idle shows "Still there?"; a tap resumes; idle again resets, wipes and releases', () => {
  const env = load();
  const { k, stage, calls } = makeSession(env);
  k.show('w1|0', cfgOf(env.sb), 'w1');
  frameOf(stage).fire('load');
  env.c.advance(5000);
  assert.equal(calls.hold, 0, 'a page that just sits there never starts a session');

  tapIntoFrame(env, stage);
  assert.equal(calls.hold, 1);
  assert.equal(k.sessionActive(), true);
  assert.ok(calls.logs.includes('session started — playlist held'));
  assert.ok(env.store.get('st_kiosk_open_session'), 'open session persisted for crash recovery');
  assert.equal(env.store.get('st_kiosk_dirty'), '1');

  env.c.advance(20_000);                                   // idle_timeout 20 s
  const ov = byClass(stage, 'kiosk-still-there');
  assert.ok(ov, 'overlay shown');
  assert.equal(ov.textContent, 'Still there?\nTap to keep browsing — resetting in 10s');
  env.c.advance(3000);
  assert.match(ov.textContent, /resetting in [67]s/);
  ov.fire('click');
  assert.equal(byClass(stage, 'kiosk-still-there'), null, 'tap resumes');
  assert.equal(calls.release, 0);

  env.c.advance(29_000);
  assert.equal(calls.release, 0, 'the resumed clock counts from the tap on the overlay');
  env.c.advance(1_500);                                   // 20 idle + 10 warn after that tap
  assert.equal(calls.release, 1, 'reset releases the playlist');
  assert.equal(calls.wiped, 1, 'removeAllCookies on reset');
  assert.equal(frameOf(stage), null, 'frame removed');
  assert.equal(k.sessionActive(), false);
  assert.equal(calls.sessions.length, 1);
  const r = calls.sessions[0];
  assert.equal(r.end_reason, 'idle');
  assert.equal(r.widget_id, 'w1');
  assert.equal(r.pages, 1);
  assert.ok(r.duration_sec >= 23 && r.duration_sec <= 24, `engaged time first touch -> last tap, got ${r.duration_sec}`);
  assert.match(r.id, /^[A-Za-z0-9-]{1,64}$/);
  assert.equal(env.store.get('st_kiosk_open_session'), undefined);
  assert.equal(env.store.get('st_kiosk_dirty'), '0');
  assert.ok(calls.logs.some((m) => /^session ended \(idle\) after \d+s, 1 page\(s\)$/.test(m)));
});

test('navigations inside the frame count pages, keep the session alive, and show Home', () => {
  const env = load();
  const { k, stage, calls } = makeSession(env);
  k.show('w1|0', cfgOf(env.sb), 'w1');
  const f = frameOf(stage);
  f.fire('load');
  assert.equal(byClass(stage, 'kiosk-home'), null, 'no Home on the start page');
  // A self-refreshing page navigates without a visitor: keeps alive, but never STARTS a session.
  f.fire('load');
  assert.equal(calls.hold, 0);
  tapIntoFrame(env, stage);
  env.c.advance(15_000);
  f.fire('load'); f.fire('load');                          // visitor browses two pages
  const home = byClass(stage, 'kiosk-home');
  assert.ok(home && home.style.display !== 'none', 'Home shown off the start page');
  assert.equal(home.textContent, '⌂  Home');
  assert.equal(env.doc.activeElement, null, 'focus reclaimed after a navigation so the next tap is seen');
  env.c.advance(15_000);
  assert.equal(byClass(stage, 'kiosk-still-there'), null, 'the navigation kept the session alive');
  home.fire('click');
  assert.equal(f.src, 'https://shop.example/menu');
  assert.equal(home.style.display, 'none');
  f.fire('load');
  assert.equal(home.style.display, 'none', 'back on the start page');
  k.hide();
  assert.equal(calls.sessions[0].pages, 3, '1 + two navigations (the Home load is not a page)');
  assert.equal(calls.sessions[0].end_reason, 'interrupted');
  assert.equal(calls.wiped, 1, 'leaving a used page wipes');
});

test('home_button:false never shows Home', () => {
  const env = load();
  const { k, stage } = makeSession(env);
  k.show('w1|0', cfgOf(env.sb, { home_button: false }), 'w1');
  const f = frameOf(stage); f.fire('load'); f.fire('load');
  assert.equal(byClass(stage, 'kiosk-home'), null);
});

test('activity polling: document.activeElement on the frame counts as a touch even without a blur event', () => {
  const env = load();
  const { k, stage, calls } = makeSession(env);
  k.show('w1|0', cfgOf(env.sb), 'w1');
  env.activation = { isActive: true };
  env.doc.activeElement = frameOf(stage);
  env.c.advance(600);
  assert.equal(calls.hold, 1);
});

test('a page nobody used is not wiped when it leaves', () => {
  const env = load();
  const { k, calls } = makeSession(env);
  k.show('w1|0', cfgOf(env.sb), 'w1');
  k.hide();
  assert.equal(calls.wiped, 0);
  assert.equal(calls.sessions.length, 0);
});

// ---------------- failures ----------------
test('network failure with nobody using it: load_error incident and skip; throttled per host', async () => {
  const env = load();
  const { k, calls, setFetch } = makeSession(env);
  setFetch(() => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')));
  k.show('w1|0', cfgOf(env.sb), 'w1');
  await flush(); env.c.advance(1);
  assert.deepEqual(calls.errors, [['load_error', 'shop.example: load error: net::ERR_NAME_NOT_RESOLVED']]);
  assert.equal(calls.skip, 1);
  assert.ok(calls.logs.includes('interactive page unavailable (load error: net::ERR_NAME_NOT_RESOLVED)'));
  k.show('w1|1', cfgOf(env.sb), 'w1');
  await flush(); env.c.advance(1);
  assert.equal(calls.errors.length, 1, 'same reason+host inside 15 min: not reported again');
  assert.equal(calls.skip, 2, 'but still skipped');
});

test('failure during a session ends it (error) and releases instead of skipping', async () => {
  const env = load();
  const { k, stage, calls, setFetch } = makeSession(env);
  let rejectIt;
  setFetch(() => new Promise((_, rej) => { rejectIt = rej; }));
  k.show('w1|0', cfgOf(env.sb), 'w1');
  frameOf(stage).fire('load');
  tapIntoFrame(env, stage);
  rejectIt(new Error('Failed to fetch'));
  await flush(); env.c.advance(1);
  assert.equal(calls.release, 1); assert.equal(calls.skip, 0);
  assert.equal(calls.sessions[0].end_reason, 'error');
  assert.equal(calls.wiped, 1);
});

test('no load event within 30 s is a load_error', () => {
  const env = load();
  const { k, calls } = makeSession(env);
  k.show('w1|0', cfgOf(env.sb), 'w1');
  env.c.advance(30_001);
  assert.equal(calls.errors[0][0], 'load_error');
  assert.match(calls.errors[0][1], /no response in 30s/);
  assert.equal(calls.skip, 1);
});

test('min_webview: Tizen UA without a Chrome token maps through Samsung\'s engine table; too old -> card + incident', () => {
  const env = load();
  assert.equal(env.sb.KioskSession.engineMajor('Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/5.0 TV Safari/537.36'), 63);
  assert.equal(env.sb.KioskSession.engineMajor('Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.31 TV Safari/537.36'), 94);
  assert.equal(env.sb.KioskSession.engineMajor('Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1'), 0);
  const { k, stage, calls } = makeSession(env, { userAgent: () => 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36 Version/5.0 TV Safari/537.36' });
  k.show('w1|0', cfgOf(env.sb, { min_webview: 70 }), 'w1');
  assert.equal(frameOf(stage), null);
  assert.equal(byClass(stage, 'kiosk-card').textContent, 'This page needs a newer web browser than this screen has.');
  assert.deepEqual(calls.errors, [['webview_too_old', 'shop.example: Chromium 63, page needs 70']]);
});

// ---------------- crash recovery ----------------
test('a session open when the app died is queued as interrupted, and the cookies are wiped on start', () => {
  const env = load();
  const { k, stage } = makeSession(env);
  k.show('w1|0', cfgOf(env.sb), 'w1');
  tapIntoFrame(env, stage);                     // session open, then "power cut": no hide()
  const open = JSON.parse(env.store.get('st_kiosk_open_session'));
  assert.equal(open.end_reason, 'interrupted');

  const added = []; let wiped = 0;
  env.sb.KioskSession.recover(env.sb.localStorage, { addSession: (r) => added.push(r) }, { removeAllCookies(ok) { wiped++; ok && ok(); } }, () => {});
  assert.equal(added.length, 1);
  assert.equal(added[0].id, open.id);
  assert.equal(added[0].end_reason, 'interrupted');
  assert.equal(wiped, 1);
  assert.equal(env.store.get('st_kiosk_open_session'), undefined);
  env.sb.KioskSession.recover(env.sb.localStorage, { addSession: (r) => added.push(r) }, { removeAllCookies() { wiped++; } }, () => {});
  assert.equal(added.length, 1, 'recovered once'); assert.equal(wiped, 1, 'not dirty any more');
});

// ---------------- usage queue + incidents over the socket ----------------
function fakeSocket() { const sent = []; return { sent, connected: true, emit: (ev, d) => sent.push([ev, JSON.parse(JSON.stringify(d))]) }; }
function rec(i) { return { id: 'id-' + i, widget_id: 'w1', started_at: 1_700_000_000 + i, duration_sec: 5, end_reason: 'idle', pages: 1 }; }

test('usage queue: cap 500 drop-oldest, dedupe by id, persisted, batches of 50 acked by id', () => {
  const env = load();
  const sock = fakeSocket();
  let online = false;
  const ob = new env.sb.KioskOutbox({ storage: env.sb.localStorage, getSocket: () => sock, getDeviceId: () => 'dev1', canSend: () => online,
    setTimeout: env.c.setTimeout, clearTimeout: env.c.clearTimeout });
  for (let i = 0; i < 520; i++) ob.addSession(rec(i));
  ob.addSession(rec(519));
  assert.equal(ob.queue.size(), 500);
  assert.equal(ob.queue.peek(1)[0].id, 'id-20', 'oldest dropped');
  assert.equal(sock.sent.length, 0, 'offline: nothing sent');

  // Survives a restart.
  const ob2 = new env.sb.KioskOutbox({ storage: env.sb.localStorage, getSocket: () => sock, getDeviceId: () => 'dev1', canSend: () => online,
    setTimeout: env.c.setTimeout, clearTimeout: env.c.clearTimeout });
  assert.equal(ob2.queue.size(), 500);

  online = true;
  ob2.onRegistered();
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0][0], 'device:kiosk-sessions');
  assert.equal(sock.sent[0][1].device_id, 'dev1');
  assert.equal(sock.sent[0][1].sessions.length, 50);
  ob2.flush();
  assert.equal(sock.sent.length, 1, 'one batch in flight at a time');

  // Partial ack: only named ids leave; the next batch follows.
  const ids = sock.sent[0][1].sessions.slice(0, 40).map((r) => r.id);
  ob2.onAck({ ids, written: 40 });
  assert.equal(ob2.queue.size(), 460);
  assert.equal(sock.sent.length, 2);
  assert.equal(sock.sent[1][1].sessions[0].id, 'id-60', 'unacked ids stay at the head');

  // No ack in 30 s: a retry is allowed.
  ob2.flush(); assert.equal(sock.sent.length, 2);
  env.c.advance(30_001);
  ob2.flush(); assert.equal(sock.sent.length, 3);
  assert.equal(JSON.parse(env.store.get('st_kiosk_sessions')).length, 460, 'persisted after ack');
});

test('web_error incidents: sent as device:event when online, held (max 10) while offline, sent after registration', () => {
  const env = load();
  const sock = fakeSocket();
  let online = true;
  const ob = new env.sb.KioskOutbox({ storage: env.sb.localStorage, getSocket: () => sock, getDeviceId: () => 'dev1', canSend: () => online });
  ob.reportError('load_error', 'shop.example: load error: offline');
  assert.deepEqual(sock.sent[0], ['device:event', { device_id: 'dev1', type: 'web_error', reason: 'load_error', detail: 'shop.example: load error: offline' }]);
  online = false;
  for (let i = 0; i < 12; i++) ob.reportError('load_error', 'h' + i + '.example: x'.repeat(i === 11 ? 300 : 1));
  assert.equal(sock.sent.length, 1);
  assert.equal(ob.pendingErrors.length, 10);
  online = true;
  ob.onRegistered();
  const evs = sock.sent.filter((s) => s[0] === 'device:event');
  assert.equal(evs.length, 11);
  assert.match(evs[1][1].detail, /^h2\.example: x \(while offline\)$/);
  for (const e of evs) assert.ok(e[1].detail.length <= 400);
});

// ---------------- the player: hold / park / release, fullscreen only ----------------
function playerEnv() {
  const env = load({ withPlayer: true });
  const stage = env.doc.createElement('div');
  const p = new env.sb.PlaylistPlayer(stage, () => 'http://server', () => 'dev1');
  const s = makeSession(env, { container: stage, onHold: () => p.hold(), onRelease: () => p.release(), onSkip: () => p.skipSoon() });
  p.setKiosk(s.k);
  return { env, p, stage, s };
}
const WIDGET = { widget_id: 'w1', widget_type: 'webpage', widget_config: JSON.stringify({ url: 'https://shop.example/menu', interactive: true, idle_timeout_sec: 20, idle_warning_sec: 10 }), duration_sec: 30, sort_order: 0 };
const IMAGE = { content_id: 'c1', mime_type: 'image/jpeg', duration_sec: 10, sort_order: 1, filename: 'a.jpg' };

test('player: interactive item mounts the site, holds on touch, parks updates, releases and advances on reset', () => {
  const { env, p, stage, s } = playerEnv();
  p.load([WIDGET, IMAGE]);
  const f = frameOf(stage);
  assert.ok(f && f.src === 'https://shop.example/menu', 'the site itself, not /api/widgets/.../render');
  f.fire('load');
  assert.equal(p.getIndex(), 0);

  env.c.advance(5000);
  tapIntoFrame(env, stage);
  assert.equal(p.isHeld(), true);
  assert.equal(p.kioskSessionActive(), true);
  env.c.advance(25_000);                                   // past the item's 30 s duration
  assert.equal(p.getIndex(), 0, 'held: the playlist did not advance');
  assert.ok(frameOf(stage), 'page still up');

  // A playlist update while held is parked, not applied.
  const IMAGE2 = Object.assign({}, IMAGE, { content_id: 'c2', filename: 'b.jpg' });
  p.load([WIDGET, IMAGE, IMAGE2]);
  assert.equal(p.items.length, 2, 'parked');
  p.advance();
  assert.equal(p.getIndex(), 0, 'advance() refused while held');

  env.c.advance(10_000);                                   // finishes 20 idle + 10 warn -> reset
  assert.equal(p.isHeld(), false);
  assert.equal(p.items.length, 3, 'parked update applied on release');
  assert.notEqual(p.getIndex(), 0, 'moved off the page the visitor used');
  assert.equal(s.calls.sessions.length, 1);
  assert.equal(s.calls.sessions[0].end_reason, 'idle');
});

test('player: untouched interactive item plays like any item (advances on its duration)', () => {
  const { env, p, stage } = playerEnv();
  p.load([WIDGET, IMAGE]);
  assert.ok(frameOf(stage));
  frameOf(stage).fire('load');
  env.c.advance(30_001);
  assert.equal(p.getIndex(), 1);
  assert.equal(p.kiosk.isShowing(), false, 'leaving the item hides the page');
});

test('player: walls, synced groups and followers render the page passively (fullscreen only)', () => {
  const { p, stage } = playerEnv();
  p.setInteractiveAllowed(false);                           // app.js: payload has wall_config / group_sync
  p.load([WIDGET, IMAGE]);
  const f = frameOf(stage);
  assert.match(f.src, /^http:\/\/server\/api\/widgets\/w1\/render/, 'server render, passive');
  assert.equal(p.kiosk.isShowing(), false);

  const b = playerEnv();
  b.p.setWallFollower(true);
  b.p.load([WIDGET, IMAGE]);
  assert.match(frameOf(b.stage).src, /\/api\/widgets\/w1\/render/);
  const g = playerEnv();
  g.p.setScheduleDriven(true);
  g.p.load([WIDGET, IMAGE]);
  assert.match(frameOf(g.stage).src, /\/api\/widgets\/w1\/render/);
});

test('player: a non-interactive webpage widget is unchanged', () => {
  const { p, stage } = playerEnv();
  p.load([Object.assign({}, WIDGET, { widget_config: JSON.stringify({ url: 'https://shop.example' }) }), IMAGE]);
  assert.match(frameOf(stage).src, /\/api\/widgets\/w1\/render/);
});

test('player: stop() during a session ends it (interrupted), wipes and drops the hold', () => {
  const { env, p, stage, s } = playerEnv();
  p.load([WIDGET, IMAGE]);
  tapIntoFrame(env, stage);
  assert.equal(p.isHeld(), true);
  p.stop();
  assert.equal(p.isHeld(), false);
  assert.equal(s.calls.sessions[0].end_reason, 'interrupted');
  assert.equal(s.calls.wiped, 1);
});

test('player: release with a parked update that already moved playback does not skip a second item', () => {
  const { env, p, stage } = playerEnv();
  p.load([WIDGET, IMAGE]);
  frameOf(stage).fire('load');
  tapIntoFrame(env, stage);
  const C3 = { content_id: 'c3', mime_type: 'image/jpeg', duration_sec: 10, sort_order: 0, filename: 'c.jpg' };
  p.load([C3, IMAGE]);                                      // the interactive item was removed
  env.c.advance(30_001);                                    // 20 idle + 10 warn -> reset -> release
  assert.equal(p.isHeld(), false);
  assert.equal(p.items.length, 2);
  // The parked list no longer has the page: playback continues at its successor (IMAGE), and the
  // release does NOT advance again on top of that.
  assert.equal(p.items[p.getIndex()].content_id, 'c1', 'continued at the successor, no extra advance');
  assert.equal(p.getIndex(), 1);
});

// ---------------- app.js privacy wiring (source-level: app.js is an IIFE over the real DOM) ----------------
test('app.js: blank screenshot and refused remote touch/key during a session; usage + incidents wired', () => {
  const src = read('tizen/js/app.js');
  const touch = src.slice(src.indexOf("socket.on('device:remote-touch'"), src.indexOf("socket.on('device:remote-key'"));
  assert.match(touch, /kioskSessionActive\(\)\) \{ kioskLog\('info', 'remote touch refused: interactive session in progress'\); return; \}/);
  const key = src.slice(src.indexOf("socket.on('device:remote-key'"), src.indexOf("socket.on('device:mute-changed'"));
  assert.match(key, /kioskSessionActive\(\)\) \{ kioskLog\('info', 'remote key refused: interactive session in progress'\); return; \}/);
  const cap = src.slice(src.indexOf('function captureAndSend'), src.indexOf('function startStreaming'));
  assert.ok(cap.indexOf('kioskSessionActive()') < cap.indexOf("elStage.querySelector('img')"), 'blank before any capture');
  assert.match(src, /socket\.on\('device:kiosk-sessions-ack'/);
  assert.match(src, /kioskOutbox\.onRegistered\(\)/);
  assert.match(src, /player\.park\(function \(\) \{ onPlaylist\(payload\); \}\)/);
  assert.match(src, /var interactiveOk = !payload\.wall_config && !payload\.group_sync;/);
});

// ---------------- review fixes ----------------
test('REGRESSION #10: a page that focuses itself (no user activation) does not start a session; a real tap still does', () => {
  const env = load();
  const { k, stage, calls } = makeSession(env);
  k.show('w1|0', cfgOf(env.sb), 'w1');
  frameOf(stage).fire('load');
  env.c.advance(3000);
  env.activation = { isActive: false };                      // script focus(): focus moves, no gesture
  env.doc.activeElement = frameOf(stage); env.fireWindow('blur'); env.c.advance(600);
  assert.equal(calls.hold, 0, 'no session from a scripted focus');
  assert.equal(k.sessionActive(), false);
  assert.equal(env.doc.activeElement, null, 'focus handed back so the real first tap is still seen');
  assert.ok(calls.logs.includes('page took focus without a tap — not a session'));
  tapIntoFrame(env, stage);
  assert.equal(calls.hold, 1);
});

test('REGRESSION #10: engines without navigator.userActivation ignore focus within 1.5 s of a frame load', () => {
  const env = load();
  const { k, stage, calls } = makeSession(env, { userActivation: () => null });
  k.show('w1|0', cfgOf(env.sb), 'w1');
  frameOf(stage).fire('load');
  env.c.advance(200);
  env.doc.activeElement = frameOf(stage); env.fireWindow('blur'); env.c.advance(600);
  assert.equal(calls.hold, 0, 'focus right after load = the page autofocusing');
  env.c.advance(2000);
  env.doc.activeElement = frameOf(stage); env.fireWindow('blur'); env.c.advance(1);
  assert.equal(calls.hold, 1, 'later focus counts (no better signal on these engines)');
});

function asyncWiper() {
  const w = { pending: [], calls: 0 };
  w.ws = { removeAllCookies(ok) { w.calls++; w.pending.push(ok); } };
  w.finish = () => { const p = w.pending.splice(0); p.forEach((f) => f()); };
  return w;
}

test('REGRESSION #7: release and the remount wait for the async cookie wipe; dirty cleared only on success', () => {
  const env = load({ withPlayer: true });
  const stage = env.doc.createElement('div');
  const p = new env.sb.PlaylistPlayer(stage, () => 'http://server', () => 'dev1');
  const w = asyncWiper();
  const s = makeSession(env, { container: stage, onHold: () => p.hold(), onRelease: () => p.release(), onSkip: () => p.skipSoon(), websetting: () => w.ws });
  p.setKiosk(s.k);
  p.load([WIDGET]);                                          // one-item playlist: the SAME page remounts after reset
  frameOf(stage).fire('load');
  tapIntoFrame(env, stage);
  env.c.advance(30_001);                                     // 20 idle + 10 warn -> reset
  assert.equal(w.calls, 1, 'wipe started');
  assert.equal(frameOf(stage), null, 'page removed');
  assert.equal(p.isHeld(), true, 'not released while cookies may still exist');
  assert.equal(env.store.get('st_kiosk_dirty'), '1', 'dirty until the wipe answers');
  env.c.advance(1000);
  assert.equal(frameOf(stage), null, 'nothing loads the start URL with visitor 1\'s cookies');
  w.finish();
  assert.equal(env.store.get('st_kiosk_dirty'), '0');
  assert.equal(p.isHeld(), false);
  const f = frameOf(stage);
  assert.ok(f && f.src === 'https://shop.example/menu', 'fresh page only after the wipe');
});

test('REGRESSION #7: a wipe that never answers gives up after 5 s (dirty stays set); show() during a wipe waits', () => {
  const env = load();
  const w = asyncWiper();
  const { k, stage, calls } = makeSession(env, { websetting: () => w.ws });
  k.show('w1|0', cfgOf(env.sb), 'w1');
  frameOf(stage).fire('load');
  tapIntoFrame(env, stage);
  env.c.advance(30_001);
  assert.equal(calls.release, 0);
  k.show('w1|0', cfgOf(env.sb), 'w1');                        // the next appearance, while the wipe runs
  assert.equal(frameOf(stage), null, 'no frame while the wipe is outstanding');
  assert.equal(k.isShowingItem('w1|0'), true, 'placeholder holds the slot, so a re-render does not stack mounts');
  env.c.advance(5001);
  assert.equal(calls.release, 1, 'moved on after the timeout');
  assert.ok(frameOf(stage), 'mounted after the timeout');
  assert.equal(env.store.get('st_kiosk_dirty'), '1', 'next start retries the wipe');
  assert.ok(calls.logs.some((m) => /did not answer in 5s/.test(m)));
  w.finish();                                                 // a late answer changes nothing
  assert.equal(calls.release, 1);
});

test('REGRESSION #2: a parked update that switches to zones stops the player; release must not advance the old list over it', () => {
  const { env, p, stage } = playerEnv();
  p.load([WIDGET, IMAGE]);
  frameOf(stage).fire('load');
  tapIntoFrame(env, stage);
  // What app.js onPlaylist does for a layout payload while the stage was the player's: stop + zones.
  let zonesRendered = 0;
  p.park(() => { p.stop(); stage.innerHTML = ''; stage.appendChild(env.doc.createElement('section')); zonesRendered++; });
  env.c.advance(30_001);                                     // reset -> release -> parked update
  assert.equal(zonesRendered, 1);
  assert.equal(p.isHeld(), false);
  assert.deepEqual(stage.children.map((c) => c.tag), ['section'], 'only the zones on the stage');
  env.c.advance(120_000);
  assert.deepEqual(stage.children.map((c) => c.tag), ['section'], 'the old playlist never comes back over the layout');
  assert.equal(p.timer, null, 'no advance timer left armed');
});

test('REGRESSION #6: a page removed from the playlist (deferred rotation) cannot hold; the deferral still advances', () => {
  const { env, p, stage, s } = playerEnv();
  p.load([WIDGET, IMAGE]);
  frameOf(stage).fire('load');
  const C3 = { content_id: 'c3', mime_type: 'image/jpeg', duration_sec: 10, sort_order: 0, filename: 'c.jpg' };
  p.load([C3, IMAGE]);                                        // page removed while untouched -> deferred rotation
  assert.equal(p._deferredRotation, true);
  tapIntoFrame(env, stage);
  assert.equal(p.isHeld(), false, 'the stale page may not hold');
  assert.equal(p._deferredRotation, true, 'deferral kept');
  env.c.advance(30_001);                                     // the page's own duration -> advance -> rotation applied
  assert.notEqual(p.kiosk.isShowing(), true);
  assert.equal(p.isHeld(), false);
  assert.equal(s.calls.sessions.length, 1, 'the visitor\'s session is still recorded');
  assert.ok(p.items.every((it) => it.widget_id !== 'w1'), 'the rotation to the new list was applied');
  assert.equal(p.kiosk.isShowing(), false);
});

test('REGRESSION #6: the page leaving by another path (resume / screen_on re-render) releases the hold without advancing', () => {
  const { env, p, stage } = playerEnv();
  p.load([WIDGET, IMAGE]);
  frameOf(stage).fire('load');
  tapIntoFrame(env, stage);
  assert.equal(p.isHeld(), true);
  const IMAGE2 = Object.assign({}, IMAGE, { content_id: 'c2', filename: 'b.jpg' });
  p.load([WIDGET, IMAGE, IMAGE2]);                             // parked
  p.index = 1; p.playCurrent();                               // something re-renders a different item
  assert.equal(p.kiosk.isShowing(), false);
  assert.equal(p.isHeld(), false, 'no hold without a page behind it');
  assert.equal(p.getIndex(), 1, 'released without advancing');
  env.c.advance(1);
  assert.equal(p.items.length, 3, 'parked update applied after the render');
  assert.equal(p.isHeld(), false);
});

// ───────────────────────────────────────────── emergency alerts cut in (interrupt: true)
// QA: an alert card appeared only after the current item finished (#157 deferral, up to 60 s). The
// server marks the card interrupt:true; a change to the SET of those applies at once, mid-item.
const CARD = { widget_id: 'w-cap', widget_type: 'cap_alert', duration_sec: 60, sort_order: 0, interrupt: true };
const IMG_A = { content_id: 'ca', mime_type: 'image/jpeg', duration_sec: 30, sort_order: 0, filename: 'a.jpg' };
const IMG_B = { content_id: 'cb', mime_type: 'image/jpeg', duration_sec: 30, sort_order: 1, filename: 'b.jpg' };
const IMG_C = { content_id: 'cc', mime_type: 'image/jpeg', duration_sec: 30, sort_order: 2, filename: 'c.jpg' };

test('interrupt: the set comparison is on interrupt items only, by identity', () => {
  const { p } = playerEnv();
  assert.equal(p.interruptChanged([IMG_A], [CARD]), true, 'raised');
  assert.equal(p.interruptChanged([CARD], [IMG_A, IMG_B]), true, 'cleared');
  assert.equal(p.interruptChanged([CARD], [Object.assign({}, CARD, { duration_sec: 90 })]), false, 'the same alert re-sent');
  assert.equal(p.interruptChanged([IMG_A], [IMG_B]), false, 'an ordinary edit');
  assert.equal(p.interruptChanged([IMG_A], [Object.assign({}, CARD, { interrupt: undefined })]), false, 'the flag is the contract, not the widget');
});

test('interrupt: clearing an alert swaps at once, where an ordinary edit still defers (#157 unchanged)', () => {
  // Ordinary: [A,B] playing A, edited to [B,C] -> A removed while live -> deferred.
  let { p } = playerEnv();
  p.load([IMG_A, IMG_B]);
  p.load([IMG_B, IMG_C]);
  assert.equal(p._deferredRotation, true, 'an ordinary edit keeps the deferral');
  // Alert clear: [CARD] playing, the loop comes back with 2+ items -> would defer; must not.
  ({ p } = playerEnv());
  p.load([IMG_A, IMG_B]);
  p.load([CARD]);
  assert.equal(p.items[p.getIndex()].widget_id, 'w-cap', 'raised: the card is on screen now');
  p.load([IMG_B, IMG_C]);
  assert.equal(p._deferredRotation, false, 'cleared: not deferred');
  assert.equal(p.items[p.getIndex()].content_id, 'cb', 'the loop is back immediately');
});

test('interrupt: an alert is never parked behind an interactive session; the session is ended', () => {
  const { env, p, stage, s } = playerEnv();
  p.load([WIDGET, IMAGE]);
  frameOf(stage).fire('load');
  tapIntoFrame(env, stage);
  assert.equal(p.isHeld(), true);
  p.load([IMAGE, Object.assign({}, IMAGE, { content_id: 'c2' })]);
  assert.equal(p.items.length, 2, 'an ordinary update is still parked');
  assert.equal(p.items[0].widget_id, 'w1');
  p.load([CARD]);
  assert.equal(p.isHeld(), false, 'the hold is dropped');
  assert.equal(p.kiosk.isShowing(), false, 'the page is closed');
  assert.equal(p.items[p.getIndex()].widget_id, 'w-cap', 'the card is on screen now');
  assert.equal(s.calls.sessions.length, 1, 'the visitor\'s session is still recorded');
  env.c.advance(1);
  assert.equal(p.items[0].widget_id, 'w-cap', 'the dropped parked update never comes back over the card');
});

// ───────────────────────────────────────────── #157 deferral reads the OUTGOING playlist
// load() replaced this.items with the incoming list and THEN asked "does the outgoing item ever
// advance?" of this.items, so it measured the NEW list. The web player asks oldPlaylist.length <= 1.
const onScreen = (stage) => {
  const imgs = stage.querySelectorAll('img');
  if (!imgs.length) return null;
  const m = /\/(c[a-z])(?:[/?]|$)/.exec(imgs[imgs.length - 1].src);   // /api/content/<id>/...
  return m ? m[1] : imgs[imgs.length - 1].src;
};

test('deferral: a ONE-item playlist replaced by a longer one swaps at once (no solo timer to wait for)', () => {
  const { env, p, stage } = playerEnv();
  p.load([IMG_A]);                                            // solo image: rendered `single`, no timer
  assert.equal(onScreen(stage), 'ca');
  p.load([IMG_B, IMG_C]);                                     // A replaced while live
  assert.equal(p._deferredRotation, false, 'not deferred: the outgoing solo item never advances');
  assert.equal(onScreen(stage), 'cb', 'the new playlist is on screen now, not after the 60 s deadline');
  env.c.advance(30_001);
  assert.equal(onScreen(stage), 'cc', 'and it rotates normally');
});

test('deferral: a playing MULTI-item list replaced by a one-item list is deferred, not cut mid-item', () => {
  const { env, p, stage } = playerEnv();
  p.load([IMG_A, IMG_B]);                                     // A playing, 30 s dwell armed
  env.c.advance(10_000);
  p.load([Object.assign({}, IMG_C, { sort_order: 0 })]);      // A removed while live; new list has one item
  assert.equal(p._deferredRotation, true, 'deferred: A has a dwell timer that will advance');
  assert.equal(onScreen(stage), 'ca', 'A keeps playing to the end of its dwell');
  env.c.advance(20_001);                                      // A's dwell ends -> deferred rotation applied
  assert.equal(p._deferredRotation, false);
  assert.equal(onScreen(stage), 'cc', 'swapped at the natural advance');
});

test('deferral: an ordinary edit of a multi-item list still waits for the current item, then continues at the successor', () => {
  const { env, p, stage } = playerEnv();
  p.load([IMG_A, IMG_B]);
  p.load([Object.assign({}, IMG_B, { sort_order: 0 }), Object.assign({}, IMG_C, { sort_order: 1 })]);
  assert.equal(p._deferredRotation, true);
  env.c.advance(29_000);
  assert.equal(onScreen(stage), 'ca', 'A still up before its dwell ends');
  env.c.advance(1_001);
  assert.equal(onScreen(stage), 'cb', 'continues at the preserved successor B');
});

test('deferral: interrupt items cut in at once from a one-item and from a multi-item list', () => {
  let { p, stage } = playerEnv();
  p.load([IMG_A]);
  p.load([CARD, Object.assign({}, IMG_B, { sort_order: 1 })]);
  assert.equal(p._deferredRotation, false, 'one-item -> alert: not deferred');
  assert.equal(p.items[p.getIndex()].widget_id, 'w-cap');
  ({ p, stage } = playerEnv());
  p.load([IMG_A, IMG_B]);
  assert.equal(onScreen(stage), 'ca');
  p.load([CARD]);                                             // multi -> one-item alert
  assert.equal(p._deferredRotation, false, 'multi -> alert: not deferred');
  assert.equal(p.items[p.getIndex()].widget_id, 'w-cap', 'the card is on screen now');
});
