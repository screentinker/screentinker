'use strict';

/*
 * THE NAMES BOTH SIDES OF A SOCKET MUST AGREE ON.
 *
 * A socket.io event or a command name that one side sends and the other never handles is not an
 * error anywhere: it is just dropped. That is how the live debug log stayed broken for two months
 * (#908). These checks read the source on both sides and fail when they stop matching:
 *
 *  1. Dashboard: every dashboard:* event the frontend emits has a server handler, and every one it
 *     listens for is something the server sends.
 *  2. Players: every device:* event the Android, web and Tizen players emit has a server handler,
 *     and every one they listen for is something the server sends.
 *  3. Commands: every command the server would deliver to a player (ungated, or gated on a
 *     capability in that player's baseline) has a handler in that player.
 *
 * KNOWN lists hold today's deliberate exceptions, each with its reason. Adding to one is a decision,
 * not a fix: the point of the test is that a new gap has to be argued for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function files(dir, exts) {
  const out = [];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  if (fs.statSync(abs).isFile()) return [dir];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['vendor', 'i18n', 'node_modules', 'test', 'tests', 'build'].includes(e.name)) out.push(...files(rel, exts)); } else if (exts.some((x) => e.name.endsWith(x))) out.push(rel);
  }
  return out;
}
function grab(paths, re) {
  const out = new Set();
  for (const p of paths) for (const m of read(p).matchAll(re)) out.add(m[1]);
  return out;
}
const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort();

const SERVER = [...files('server/ws', ['.js']), ...files('server/lib', ['.js']), ...files('server/routes', ['.js']), 'server/server.js'];
const serverMentions = (prefix) => grab(SERVER, new RegExp(`['"\`](${prefix}:[a-z0-9:_-]+)['"\`]`, 'g'));
const serverHandles = (prefix) => grab(SERVER, new RegExp(`\\.on\\(\\s*['"](${prefix}:[a-z0-9:_-]+)['"]`, 'g'));

test('dashboard events: the frontend and the server agree', () => {
  const fe = files('frontend/js', ['.js']);
  const emits = grab(fe, /\.emit\(\s*'(dashboard:[a-z0-9:_-]+)'/g);
  const listens = grab(fe, /\.on\(\s*'(dashboard:[a-z0-9:_-]+)'/g);
  assert.ok(emits.size > 5 && listens.size > 5, 'the scan found the dashboard socket calls');
  assert.deepEqual(minus(emits, serverHandles('dashboard')), [], 'the frontend emits these and the server never handles them');
  assert.deepEqual(minus(listens, serverMentions('dashboard')), [], 'the frontend waits for these and the server never sends them');
});

// device:* events a player listens for that the server does not send, and why that is acceptable.
const KNOWN_PLAYER_LISTENS = {
  // Never sent, not even in the first release: deleted content reaches screens through
  // playlist-update. Harmless dead listener on Android and the native player.
  'device:content-delete': 'never emitted; removal arrives via playlist-update',
};
const KNOWN_PLAYER_EMITS = {
  // Tizen also reports each command's outcome on this event; the server takes the same report from
  // the device:log line sent beside it (tizen/js/app.js reportCmd).
  'device:command-result': 'Tizen extra; the outcome also goes out as device:log',
};

for (const [name, dirs] of Object.entries({
  android: ['android/app/src/main'],
  web: ['server/player/index.html'],
  tizen: ['tizen/js'],
  native: ['native/screentinker_native'],
})) {
  test(`player events: ${name} and the server agree`, () => {
    const src = dirs.flatMap((d) => files(d, ['.kt', '.java', '.js', '.html', '.py']));
    const mentioned = grab(src, /['"](device:[a-z0-9:_-]+)['"]/g);
    const emits = grab(src, /emit\(\s*['"](device:[a-z0-9:_-]+)['"]/g);
    assert.ok(mentioned.size > 3, 'the scan found the player\'s socket events');
    const handled = serverHandles('device');
    const sent = serverMentions('device');
    const unhandledEmits = minus(emits, handled).filter((e) => !KNOWN_PLAYER_EMITS[e]);
    assert.deepEqual(unhandledEmits, [], `${name} emits these and the server never handles them`);
    // A name the player mentions that the server neither sends nor handles is a listener for
    // something that never arrives.
    const orphans = [...mentioned].filter((e) => !sent.has(e) && !handled.has(e) && !KNOWN_PLAYER_LISTENS[e] && !KNOWN_PLAYER_EMITS[e]).sort();
    assert.deepEqual(orphans, [], `${name} waits for these and the server never sends them`);
  });
}

// Commands the server would deliver to a player that has no handler for them, and why.
const KNOWN_UNHANDLED = {
  upload_logs: 'embedded boards only; the dashboard shows the button only for them',
  'web:enable_system_capture': 'Android consent prompt; the button is shown only for Android',
  'tizen:enable_system_capture': 'Android consent prompt; the button is shown only for Android',
  'web:settings': 'opens Android settings; the button is shown only for Android',
  'tizen:settings': 'opens Android settings; the button is shown only for Android',
};

test('commands: every player handles what the server would deliver to it', () => {
  const caps = require('../lib/player-capabilities');
  const { ALLOWED_COMMANDS } = require('../lib/device-command');
  const handlers = {
    android: grab(files('android/app/src/main/java', ['.kt']), /^\s*"([a-z_]+)"(?:\s*,\s*"[a-z_]+")*\s*->/gm),
    web: grab(['server/player/index.html'], /(?:case '|type === ')([a-z_]+)'/g),
    tizen: new Set([...grab(['tizen/js/app.js'], /type === '([a-z_]+)'/g), ...grab(['tizen/js/device-control.js'], /case '([a-z_]+)'/g)]),
    native: grab(['native/screentinker_native/app.py'], /_cmd_([a-z_]+)\b/g),
  };
  // Android's multi-name branches ("a", "b" ->) list every name on the line.
  for (const m of read('android/app/src/main/java/com/remotedisplay/player/service/WebSocketService.kt').matchAll(/^\s*((?:"[a-z_]+"\s*,\s*)+"[a-z_]+")\s*->/gm)) {
    for (const n of m[1].matchAll(/"([a-z_]+)"/g)) handlers.android.add(n[1]);
  }
  const platforms = { android: 'android', web: 'web', tizen: 'tizen', linux: 'native', windows: 'native', macos: 'native' };
  const gaps = [];
  for (const [plat, player] of Object.entries(platforms)) {
    assert.ok(handlers[player].size > 5, `the scan found ${player}'s command handlers`);
    const baseline = new Set(caps.BASELINE[plat] || []);
    for (const cmd of ALLOWED_COMMANDS) {
      const need = [].concat(caps.capabilitiesForCommand(cmd) || []).filter(Boolean);
      const delivered = need.length === 0 || need.some((c) => baseline.has(c));
      if (!delivered || handlers[player].has(cmd)) continue;
      if (KNOWN_UNHANDLED[cmd] || KNOWN_UNHANDLED[`${player}:${cmd}`]) continue;
      gaps.push(`${plat}: ${cmd}`);
    }
  }
  assert.deepEqual(gaps, [], 'the server delivers these and the player silently drops them');
});
