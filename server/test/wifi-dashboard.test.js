'use strict';

/*
 * #720 The Wi-Fi section of the device page (frontend/js/components/wifi-networks.js).
 *
 * The server never sends a password back, so the one way the dashboard could still leak one is by
 * rendering something it should not: a value in the password field, a mask at the real length, a
 * row field it invented. And the section has to say the uncomfortable things plainly — that
 * suggestions are not enforced, and why a list was not delivered — or the operator believes a van
 * panel has a network it does not.
 *
 * Rendered from the real source in a bare VM (imports stubbed, as device-controls-hidden does), so
 * a later edit to the template is what gets tested.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'components', 'wifi-networks.js'), 'utf8');

const ctx = (() => {
  const code = SRC
    .replace(/^import .*$/gm, '')
    .replace(/^export function /gm, 'function ');
  const sandbox = {
    t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    api: {}, showToast: () => {}, on: () => {}, off: () => {}, canWrite: () => true,
  };
  vm.createContext(sandbox);
  vm.runInContext(code + '\n;globalThis.__listHtml = listHtml;', sandbox);
  return sandbox;
})();
const render = (state, editing = null, canEdit = true) => ctx.__listHtml(state, editing, canEdit);

const NET = {
  id: 'n1', ssid: 'Depot <Uplink>', security: 'wpa2', hidden: false, priority: 4, has_password: true,
  status: 'applied', status_reason: null,
};
const state = (over = {}) => ({ supported: true, mode: 'direct', connection: { online: true, tls: true, allow_insecure: false }, networks: [NET], ...over });

test('⚠️ the edit form never carries a password — the field is empty, "unchanged" is a placeholder', () => {
  const html = render(state(), 'n1');
  const field = html.match(/<input id="wifiPassword"[^>]*>/);
  assert.ok(field, 'the password field is there');
  assert.ok(!/\svalue=/.test(field[0]), 'the password field was pre-filled');
  assert.match(field[0], /type="password"/);
  assert.match(field[0], /autocomplete="new-password"/, 'the browser must not offer a saved login here');
  assert.match(field[0], /placeholder="wifi.password_keep"/);
});

test('the source never reads a password off a row (the server sends none; this keeps it that way)', () => {
  assert.doesNotMatch(SRC, /\b(n|net|network|row)\.password\b/);
  assert.doesNotMatch(SRC, /'\*'\.repeat|•/, 'no mask anywhere');
});

test('an SSID is escaped — it is text an operator typed, shown to everyone in the workspace', () => {
  const html = render(state());
  assert.ok(html.includes('Depot &lt;Uplink&gt;'));
  assert.ok(!html.includes('<Uplink>'));
});

test('suggestions mode says "suggested, not enforced"; owner and direct do not warn', () => {
  assert.match(render(state({ mode: 'suggestions' })), /wifi\.mode\.suggestions/);
  assert.match(render(state({ mode: 'suggestions' })), /var\(--warning\)/);
  assert.match(render(state({ mode: 'owner' })), /wifi\.mode\.owner/);
  assert.equal(render(state({ mode: null })).includes('wifi.mode.'), false, 'an older player: say nothing');
});

test('⚠️ a plain connection is called out with what to change; a secure one is not', () => {
  assert.match(render(state({ connection: { online: true, tls: false, allow_insecure: false } })), /wifi\.not_https/);
  assert.equal(render(state()).includes('wifi.not_https'), false);
  assert.equal(render(state({ connection: { online: false, tls: null, allow_insecure: false } })).includes('wifi.not_https'), false,
    'offline is not "not HTTPS" — it simply has not connected');
  const opted = render(state({ connection: { online: true, tls: false, allow_insecure: true } }));
  assert.match(opted, /wifi\.insecure_allowed/, 'the opt-out is never silent');
  assert.equal(opted.includes('wifi.not_https'), false);
});

test('the en strings name the real fix (there is no TRUSTED_PROXIES setting)', () => {
  const en = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
  const line = en.split('\n').find((l) => l.includes("'wifi.not_https'"));
  assert.ok(line);
  assert.match(line, /X-Forwarded-Proto: https/);
  assert.match(line, /WIFI_ALLOW_INSECURE=1/);
  assert.doesNotMatch(line, /TRUSTED_PROXIES/);
});

test('status and reason codes render as words; an unknown reason is shown as the code, not dropped', () => {
  const html = render(state({ networks: [{ ...NET, status: 'deferred', status_reason: 'connected_network_in_use' }] }));
  assert.match(html, /wifi\.status\.deferred/);
  assert.match(html, /wifi\.reason\.connected_network_in_use/);
  const odd = render(state({ networks: [{ ...NET, status: 'failed', status_reason: 'some_new_code' }] }));
  assert.match(odd, /some_new_code/);
  const bogus = render(state({ networks: [{ ...NET, status: '<script>' }] }));
  assert.ok(!bogus.includes('<script>'), 'an unknown status falls back, it is never echoed');
});

test('a view-only member sees the list without the buttons', () => {
  const html = render(state(), null, false);
  assert.ok(html.includes('Depot &lt;Uplink&gt;'));
  for (const id of ['wifiAdd']) assert.equal(html.includes(`id="${id}"`), false);
  assert.equal(html.includes('wifi-edit'), false);
  assert.equal(html.includes('wifi-remove'), false);
});

test('every reason code the player can send has words in the dashboard (Kotlin ↔ JS parity)', () => {
  const kt = ['WifiPlan.kt', 'WifiNetworkManager.kt']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'com', 'remotedisplay', 'player', 'net', f), 'utf8'))
    .join('\n');
  // snake_case string literals with an underscore; the ones below are JSON/prefs keys and a prefs file name.
  const codes = new Set([...kt.matchAll(/"([a-z0-9]+(?:_[a-z0-9]+)+)"/g)].map((m) => m[1]));
  for (const notAReason of ['net_id', 'device_id', 'wifi_networks_secure']) codes.delete(notAReason);
  assert.ok(codes.size >= 6, `found only ${[...codes].join(', ')}`);
  const reasons = SRC.match(/const REASONS = \[([\s\S]*?)\];/)[1];
  const en = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
  for (const c of codes) {
    assert.ok(reasons.includes(`'${c}'`), `the player sends ${c}, the dashboard does not know it`);
    assert.ok(en.includes(`'wifi.reason.${c}'`), `no English words for ${c}`);
  }
});
