'use strict';

/*
 * Three 3.0.0 gaps found filming the release video, pinned here.
 *
 *   1. "Switch to ScreenTinker" → Screens to pair asked for the code in the browser's window.prompt,
 *      the one pairing step in the product that did not use the app's own dialog: untranslatable
 *      chrome, no inline error (a wrong code was a toast and the prompt was gone), and at a plan limit
 *      a red toast instead of the upgrade prompt.
 *   2. Declining a content request asked for the reason in window.prompt too. The reason is required
 *      server-side and mailed to the requester, so the dialog must refuse to send without one.
 *   3. The Simple view's "Add a screen" guide (views/onboarding.js) paired with a raw
 *      fetch('/api/provision/pair'). The upgrade prompt is raised by api.js's requestError, so the
 *      raw fetch never reached it: at the Free limit the guide only printed "Device limit reached
 *      (2 on Free plan)" while the Advanced Add screen dialog explained the plans.
 *
 * ⚠️ SOURCE ASSERTIONS for the views, deliberately — same reasoning as content-picker-upload.test.js:
 * there is no DOM harness in this project. The one piece that CAN run without a DOM — api.js raising
 * the prompt for a pair refused at the device limit — is driven for real below, because it is the
 * contract the guide now relies on.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');
const read = (p) => fs.readFileSync(path.join(FRONTEND, p), 'utf8');

// Strip line-leading block comments and // comments, so prose about prompt() or fetch() does not count.
function code(src) {
  return src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1');
}
/** The body of a named function, from its declaration to the first column-0 `}`. */
function fnBody(src, name) {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `${name}() is gone`);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end === -1 ? undefined : end);
}

const MIGRATE = code(read('views/migrate.js'));
const REQUESTS = code(read('views/requests.js'));
const ONBOARDING = code(read('views/onboarding.js'));
const SIMPLE = code(read('views/simple-home.js'));

test('no native prompt() is left in the migrate or content-request views', () => {
  for (const [name, src] of [['migrate.js', MIGRATE], ['requests.js', REQUESTS]]) {
    assert.ok(!/(^|[^.\w])prompt\s*\(/m.test(src) && !/window\.prompt\s*\(/.test(src),
      `${name} still calls the browser's prompt(), which cannot be translated or styled`);
  }
});

test('pairing an imported screen asks for the code in the app dialog, keyboard first', () => {
  const pair = fnBody(MIGRATE, 'pairPlaceholder');
  assert.match(MIGRATE, /import \{ openModal \} from '\.\.\/components\/corporate-ui\.js';/);
  assert.match(pair, /openModal\(\{/, 'the code must be asked for in the shared dialog skeleton');
  assert.match(pair, /t\('migrate\.ph_pair_title'/, 'the dialog title is translated');
  assert.match(pair, /class="pairing-input"/, 'the same code field as the Add screen dialog');
  assert.match(pair, /inputmode="numeric"/);
  assert.match(pair, /maxlength="6"/);
  assert.match(pair, /e\.key === 'Enter'/, 'Enter pairs, as in a form');
  assert.match(pair, /input\.focus\(\)/, 'the field is focused when the dialog opens');
  assert.match(pair, /api\.pairDevice\(input\.value\.trim\(\), p\.name\)/, 'still the ordinary pairing call');
  assert.match(pair, /e\.planPromptShown\) \{ m\.close\(\); return; \}/,
    'at a plan limit the dialog gets out of the way of the upgrade prompt');
  assert.match(pair, /errEl\.textContent = e\.message/, 'a wrong code is answered inside the dialog');
});

test('declining a content request needs a reason before Decline can be pressed', () => {
  const dlg = fnBody(REQUESTS, 'openDecline');
  assert.match(REQUESTS, /import \{ openModal \} from '\.\.\/components\/corporate-ui\.js';/);
  assert.match(REQUESTS, /hasAttribute\('data-reject'\)\) \{ openDecline\(r,/, 'Decline opens the dialog');
  assert.match(dlg, /openModal\(\{/);
  assert.match(dlg, /t\('creq\.reject_title'\)/);
  assert.match(dlg, /<textarea id="creqReason"[^>]*maxlength="1000"/, 'the server caps the reason at 1000');
  assert.match(dlg, /data-creq-decline disabled>/, 'Decline starts disabled');
  assert.match(dlg, /go\.disabled = busy \|\| !input\.value\.trim\(\)/, 'and is enabled only by a non-blank reason');
  assert.match(dlg, /if \(busy \|\| !reason\) return;/, 'and a blank reason is never sent');
  assert.match(dlg, /\/reject`, \{ reason, version: r\.submission && r\.submission\.version \}\)/,
    'Decline must send the version it was looking at, as Approve does, so a concurrent decision conflicts');
  assert.match(REQUESTS, /\/approve`, \{ version: r\.submission && r\.submission\.version \}/, 'Approve still sends it too');
  assert.match(dlg, /catch \(err\) \{[\s\S]*?errEl\.textContent = err\.message;/, 'a conflict is shown inside the dialog');
  assert.match(dlg, /e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)/, 'Ctrl/Cmd+Enter declines from the keyboard');
});

test('the guide pairs through api.pairDevice, the call that raises the upgrade prompt', () => {
  assert.ok(!/fetch\(\s*['"`]\/api\/provision\/pair/.test(ONBOARDING),
    'onboarding.js pairs with a raw fetch, which never reaches the upgrade prompt in api.js');
  assert.match(ONBOARDING, /data = await api\.pairDevice\(code, name \|\| undefined\)/);
  assert.match(ONBOARDING, /if \(err\.planPromptShown\) \{ if \(status\) status\.textContent = ''; return; \}/,
    'the step must not repeat the limit under the upgrade prompt');
});

test('no Simple-view guide calls a plan-limited route with a raw fetch', () => {
  // Every route the server guards with checkDeviceLimit / checkStorageLimit (middleware/subscription.js).
  const LIMITED = ['/api/provision/pair', '/api/devices/web-player', '/api/content', '/api/stock-media/import', '/api/canva/import'];
  for (const [name, src] of [['onboarding.js', ONBOARDING], ['simple-home.js', SIMPLE], ['migrate.js', MIGRATE]]) {
    for (const m of src.matchAll(/fetch\(\s*['"`]([^'"`$?]+)/g)) {
      const hit = LIMITED.find((p) => m[1] === p || m[1].startsWith(p + '/'));
      assert.ok(!hit, `${name} calls ${m[1]} with a raw fetch; at a plan limit nobody sees the upgrade prompt`);
    }
  }
});

test('the new strings exist in every locale file', () => {
  const dir = path.join(FRONTEND, 'i18n');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const k of ['migrate.ph_pair_title', 'creq.reject_title']) {
      assert.match(src, new RegExp(`^\\s*'${k.replace('.', '\\.')}':`, 'm'), `${f} is missing ${k}`);
    }
  }
});

test('api.pairDevice refused at the device limit raises the upgrade prompt and says so', async () => {
  const API = pathToFileURL(path.join(FRONTEND, 'api.js')).href;
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const seen = [];
  globalThis.window = {
    location: { hash: '', reload() {} },
    // What plan-nudges.js does on a hosted instance: take over and preventDefault.
    dispatchEvent(ev) { seen.push(ev); if (ev.type === 'st:plan-limit') ev.preventDefault(); return !ev.defaultPrevented; },
  };
  let asked = null;
  globalThis.fetch = async (url, opts) => {
    asked = { url, opts };
    return { ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ error: 'Device limit reached (2 on Free plan)', code: 'DEVICE_LIMIT' }) };
  };
  try {
    const m = await import(`${API}?t=${Math.random()}`);
    await assert.rejects(m.api.pairDevice('123456', 'Lobby'), (e) => {
      assert.equal(e.code, 'DEVICE_LIMIT');
      assert.equal(e.planPromptShown, true);
      assert.equal(e.message, 'Device limit reached (2 on Free plan)', 'the self-hosted message is unchanged');
      return true;
    });
    assert.equal(asked.url, '/api/provision/pair');
    assert.equal(JSON.parse(asked.opts.body).pairing_code, '123456');
    assert.deepEqual(seen.map((e) => e.type), ['st:plan-limit']);
  } finally {
    delete globalThis.window; delete globalThis.fetch; delete globalThis.localStorage;
  }
});
