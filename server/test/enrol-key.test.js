'use strict';

/*
 * #313 — a display that can be identified from its URL, for players whose storage does not survive.
 *
 * ⚠️ THE REPORT. A vMix browser input deletes its entire CEF profile when vMix closes — vMix's own
 * staff, on their forum: "The Web Browser input cache is automatically cleared when closing vMix".
 * localStorage, cookies and IndexedDB go together, so the web player comes back with nothing at
 * all. Nothing is worse than it sounds: a player with no identity PROVISIONS A NEW DISPLAY ROW, so
 * every restart of the production PC left a fresh unpaired screen and the operator's dashboard
 * filled with corpses.
 *
 * ⚠️ WHAT THIS FILE IS REALLY GUARDING, and it is not the happy path. It is that the exchange
 * happens at the door and changes nothing behind it: a key resolves to device_id + device_token
 * and then the ordinary register path runs. The two failure modes that would matter are a bad key
 * falling through to provisioning (a new row per restart — the very bug), and a key overriding a
 * player that already knows who it is (a working screen silently re-pointed by editing its URL).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-enrol-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-enrol-key';

const { db } = require('../db/database');
const enrolKey = require('../lib/enrol-key');

function seedDevice(id) {
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, role) VALUES ('u-en', 'en@test.local', 'x', 'user')").run();
  db.prepare("INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES ('o-en', 'org', 'u-en')").run();
  db.prepare("INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES ('ws-en', 'o-en', 'ws')").run();
  db.prepare(`INSERT INTO devices (id, name, workspace_id, user_id, device_token, created_at, updated_at)
              VALUES (?, 'vMix input', 'ws-en', 'u-en', ?, strftime('%s','now'), strftime('%s','now'))`)
    .run(id, 'tok-' + id);
  return id;
}

test('the key is long enough to sit in a URL for years', () => {
  const k = enrolKey.generateEnrolKey();
  // 32 random bytes. The six-digit pairing code is fine on a screen behind a lockout for a few
  // minutes; as a permanent secret in a config file it is a million guesses.
  assert.ok(k.length >= 40, `too short: ${k.length}`);
  assert.match(k, /^[A-Za-z0-9_-]+$/, 'must survive a copy-paste and a query string intact');
  assert.notEqual(enrolKey.generateEnrolKey(), k, 'keys must not repeat');
});

test('junk is rejected before the database is touched', () => {
  for (const bad of [null, undefined, '', 'short', 'has spaces in it', 'x'.repeat(200), '../../etc/passwd', 123]) {
    assert.equal(enrolKey.looksLikeEnrolKey(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(enrolKey.looksLikeEnrolKey(enrolKey.generateEnrolKey()), true);
});

test('a key resolves to its display, and to the token the register path needs', () => {
  const id = seedDevice('d-resolve');
  const key = enrolKey.setEnrolKey(db, id);

  const got = enrolKey.resolveEnrolKey(db, key);
  assert.ok(got, 'the key must find its display');
  assert.equal(got.id, id);
  // The whole design: the key is exchanged for the pair the existing handler already checks,
  // rather than authenticating anything by itself.
  assert.equal(got.device_token, 'tok-d-resolve');
});

test('an unknown key resolves to nothing — it must never fall through to provisioning', () => {
  assert.equal(enrolKey.resolveEnrolKey(db, enrolKey.generateEnrolKey()), null);
  assert.equal(enrolKey.resolveEnrolKey(db, 'not-a-key'), null);
});

test('rolling the key breaks the old URL and mints a working one', () => {
  const id = seedDevice('d-roll');
  const first = enrolKey.setEnrolKey(db, id);
  assert.equal(enrolKey.resolveEnrolKey(db, first).id, id);

  const second = enrolKey.setEnrolKey(db, id);
  assert.notEqual(second, first);
  // This is the recovery when a URL leaks: roll, paste the new URL, screen never touched.
  assert.equal(enrolKey.resolveEnrolKey(db, first), null, 'the leaked URL must stop working');
  assert.equal(enrolKey.resolveEnrolKey(db, second).id, id);
});

test('revoking leaves the display working but the URL dead', () => {
  const id = seedDevice('d-revoke');
  const key = enrolKey.setEnrolKey(db, id);
  enrolKey.clearEnrolKey(db, id);

  assert.equal(enrolKey.resolveEnrolKey(db, key), null);
  // The display itself is untouched — it still holds its own token.
  assert.equal(db.prepare('SELECT device_token FROM devices WHERE id = ?').get(id).device_token, 'tok-d-revoke');
});

test('two displays cannot share a key', () => {
  const a = seedDevice('d-uniq-a');
  const b = seedDevice('d-uniq-b');
  const key = enrolKey.setEnrolKey(db, a);
  assert.throws(
    () => db.prepare('UPDATE devices SET enrol_key = ? WHERE id = ?').run(key, b),
    /UNIQUE|constraint/i,
    'the unique index is what stops one URL enrolling two screens'
  );
});

test('the player URL is pasteable and carries the key', () => {
  const key = enrolKey.generateEnrolKey();
  const url = enrolKey.playerUrl('https://signage.example.com/', key);
  assert.equal(url, `https://signage.example.com/player?k=${encodeURIComponent(key)}`);
  assert.ok(!url.includes('//player'), 'a trailing slash on the origin must not double up');
  assert.equal(new URL(url).searchParams.get('k'), key, 'the key must survive being parsed back out');
});

test('the key is never handed out in a device LIST response', () => {
  // Same rule the settings PIN and the trigger secret already follow: one consumer (the device
  // detail page), so a list that ships it to every member on every dashboard load is the same
  // data with a far wider blast radius for nothing.
  const { stripDeviceSecrets, stripDeviceSecretsForList } = require('../lib/device-sanitize');
  const row = { id: 'x', enrol_key: 'secret', device_token: 't', settings_pin: '1234' };

  assert.equal(stripDeviceSecretsForList({ ...row }).enrol_key, undefined, 'list must not carry it');
  // Detail keeps it: the operator has to be able to re-read the URL months later.
  assert.equal(stripDeviceSecrets({ ...row }).enrol_key, 'secret', 'the detail page needs it');
  assert.equal(stripDeviceSecrets({ ...row }).device_token, undefined, 'the token is still never leaked');
});

test('an unknown key is refused without poisoning the site-wide pairing lockout', () => {
  /*
   * ⚠️ THIS ASSERTION WAS INVERTED, AND THE OLD VERSION WAS THE BUG.
   *
   * It used to require recordFailure() here, reasoning that an unknown key is the same brute-force
   * shape as an unknown pairing code. It is not, in the one way that decides it: a pairing code is
   * six digits and worth guessing, an enrolment key is 256 bits and is not. So the lockout bought
   * nothing — while three ordinary operator actions (rolling the key, revoking it, deleting the
   * display) leave a player holding a dead key that it re-derives from its own URL on every load and
   * retries every few seconds forever. Five failures locks the WHOLE IP out of pairing for fifteen
   * minutes, so behind one office NAT a single stranded screen made every other display in the
   * building un-pairable, on a loop, with nothing in the dashboard to explain it.
   *
   * The key is still refused and the connection still ends — it just no longer takes the site with
   * it, and a player that also presented a pairing code can now be adopted instead of looping.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  const block = src.slice(src.indexOf('if (!device_id && data.enrol_key)'), src.indexOf('// #146: resolve identity ONCE'));

  assert.match(block, /socket\.disconnect\(true\)/, 'a player with nothing but a dead key is still told no');
  assert.match(block, /enrol_key_unknown/, 'and told WHY, so it can drop the key and ask for a pairing code');
  assert.ok(!/recordFailure/.test(block),
    'a dead player URL must not count toward the pairing lockout — it locks out the whole egress IP');
});

test('a player that already knows who it is ignores the URL key', () => {
  // Otherwise a working screen could be silently re-pointed by editing its URL.
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.match(player, /if \(!cfg\.deviceId\) \{\s*\n\s*const k = urlEnrolKey\(\);/,
    'the key is only adopted when there is no stored identity');
  assert.match(player, /if \(!data\.device_id && config\.enrolKey\) data\.enrol_key = config\.enrolKey;/,
    'and only sent when registering without one');
});

/*
 * ⚠️ BOTH PLACES A DISPLAY GETS ADDED OFFER THE SAME ESCAPE HATCH, and neither turns it on by
 * itself. A vMix operator meets the wizard on day one and the Add Display dialog forever after;
 * having the option in only one of them means the answer depends on which door you came through.
 */
test('both add-a-display surfaces offer the no-storage option', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'dashboard.js'), 'utf8');
  const wiz = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'onboarding.js'), 'utf8');
  const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');

  assert.match(idx, /id="addDeviceNoStorage"/, 'the Add Display dialog needs the checkbox');
  assert.match(dash, /createWebPlayerDisplay/, 'and has to create the display when it is ticked');
  assert.match(wiz, /id="onboardNoStorage"/, 'the onboarding pair step needs the same checkbox');
  assert.match(wiz, /createWebPlayerDisplay/, 'and the same create call');

  /*
   * ⚠️ AND BOTH MUST STILL PAIR THE ORDINARY WAY. The checkbox is an alternative, not a
   * replacement: almost every display added through either surface is a real player showing a real
   * code. Adding a second mode to a form is the classic way to break the first one.
   */
  assert.match(dash, /api\.pairDevice\(code/, 'the dialog must still pair with a code');
  assert.match(wiz, /\/api\/provision\/pair/, 'the wizard must still pair with a code');
  assert.match(wiz, /code\.length !== 6/, 'and still validate that code');
});

test('nothing mints an enrolment key unless it was asked for', () => {
  // The default has to stay "no key". A display that never needed one must not be carrying a
  // durable secret because some code path helpfully made it one.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const socket = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');

  assert.ok(!/setEnrolKey/.test(socket), 'the register path must never create a key, only resolve one');

  // The ordinary pairing route must not touch it.
  const pair = server.slice(server.indexOf("app.post('/api/provision/pair'"));
  const pairBody = pair.slice(0, pair.indexOf('\napp.'));
  assert.ok(!/enrol/i.test(pairBody), 'pairing a display the ordinary way must not mint a key');

  // Exactly three mint sites, each reached only by an explicit operator action:
  //   server.js       — create-web-player
  //   routes/devices  — mint/roll from the display's page
  //   lib/device-command — #312: a web player's set_server_url move needs a key to carry its
  //                        identity across the origin boundary. Still operator-gated: it fires only
  //                        on an operator's move command, and only for a browser player (client_type
  //                        'player'), reusing an existing key rather than rolling one each time.
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'devices.js'), 'utf8');
  const command = fs.readFileSync(path.join(__dirname, '..', 'lib', 'device-command.js'), 'utf8');
  const sites = (server.match(/setEnrolKey\(/g) || []).length
    + (routes.match(/setEnrolKey\(/g) || []).length
    + (command.match(/setEnrolKey\(/g) || []).length;
  assert.equal(sites, 3, `expected 3 mint sites (create-web-player, mint/roll, web-player move), found ${sites}`);

  // The move mint is gated on set_server_url AND a browser player, never a blanket mint.
  assert.match(command, /set_server_url' && device\.client_type === 'player'/,
    'the move mint must be gated on set_server_url + a browser player');
});

test('the Web player tab is shown only for a display that has a key', () => {
  // Not "is this a web player" — an ordinary web player paired with a code has no key and no use
  // for the tab. Gating on the key is what keeps the feature off by default.
  const view = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  assert.match(view, /\$\{device\.enrol_key \? `<div class="tab" data-tab="webplayer"/,
    'the tab must be gated on device.enrol_key');
  assert.ok(!/isWebPlayer/.test(view), 'the old platform-based gate should be gone, not left dangling');
  // Revoking would strand a display whose only way back IS the URL.
  assert.ok(!/enrolRevokeBtn/.test(view), 'no revoke button: it would brick the display it belongs to');
});

/*
 * ⚠️ THE RESULT PANEL MUST NOT EAT THE FORM.
 *
 * The Add Display dialog's markup lives in index.html and is reused for every open — it is not
 * re-rendered. The first version of this feature showed the new URL by overwriting the modal body,
 * which left the dialog permanently stuck on the result panel: reopening it showed no checkbox, no
 * code field, and the open handler then threw clearing inputs that no longer existed. NORMAL
 * PAIRING WENT WITH IT, which is a much worse bug than the feature is a feature.
 */
test('showing the new URL does not destroy the Add Display form', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'dashboard.js'), 'utf8');

  // The two panels are siblings in the static markup, toggled rather than rebuilt.
  assert.match(idx, /id="addDeviceForm"/, 'the form needs its own container to hide');
  assert.match(idx, /id="addDeviceResult"/, 'and the result panel has to exist alongside it');

  // Nothing may overwrite the dialog's body.
  assert.ok(!/#addDeviceModal .modal-body[^\n]*innerHTML\s*=/.test(dash),
    'the modal body must never be overwritten — it is the markup every reopen depends on');

  // And every open puts it back, so one create cannot strand the next.
  assert.match(dash, /resetAddDeviceDialog\(\)/, 'the dialog must be reset when it opens');
  assert.match(dash, /function resetAddDeviceDialog/, 'and that reset has to exist');
});
