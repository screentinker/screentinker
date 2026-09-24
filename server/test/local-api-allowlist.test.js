'use strict';

/*
 * The inbound local REST door's command allowlist exists TWICE — in Kotlin, where it is enforced,
 * and in JavaScript, where the dashboard and the docs read it. Two copies of a security decision in
 * two languages WILL drift, silently, and in the direction that matters: the panel accepting
 * something the dashboard never said it would.
 *
 * ⚠️ THE KOTLIN IS AUTHORITATIVE. This server is not in the request path at all — a LAN caller POSTs
 * straight to the panel — so `LOCAL_API_COMMANDS` here is documentation, and documentation that can
 * be wrong about a security boundary is worse than none. This test is what makes it not wrong.
 *
 * Same device the shared vector files use for the resolvers, and the same device as the source-level
 * ownership tests: it pins the thing a unit test cannot, which is that two files agree.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { ALLOWED_COMMANDS, LOCAL_API_COMMANDS } = require('../lib/device-command');

const KT = path.join(
  __dirname, '..', '..', 'android', 'app', 'src', 'main', 'java',
  'com', 'remotedisplay', 'player', 'net', 'LocalApi.kt'
);

/** Pull the `val COMMANDS: List<String> = listOf(...)` literal out of the Kotlin. */
function kotlinCommands() {
  const src = fs.readFileSync(KT, 'utf8');
  const m = /val COMMANDS: List<String> = listOf\(([\s\S]*?)\)/.exec(src);
  assert.ok(m, 'LocalApi.kt no longer declares `val COMMANDS: List<String> = listOf(...)` — if it '
    + 'moved, this test has to follow it, because the alternative is a JS list nothing checks');
  return m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

test('the JS allowlist is exactly the Kotlin one', () => {
  assert.deepStrictEqual([...LOCAL_API_COMMANDS].sort(), kotlinCommands().sort());
});

test('⚠️ every local-api command is a real command the panel already has', () => {
  // A command the panel does not implement would answer 200 and do nothing — which a control system
  // reads as success. The allowlist must be a SUBSET of the command set, never an extension of it.
  for (const c of LOCAL_API_COMMANDS) {
    assert.ok(ALLOWED_COMMANDS.includes(c), `${c} is not in ALLOWED_COMMANDS`);
  }
});

test('⚠️ the dangerous commands are absent, and stay absent', () => {
  /*
   * Named individually rather than asserted as a count, so adding one is a deliberate act that has
   * to delete a line from this test. A count would let a careless addition slide in under a number
   * nobody re-reads.
   */
  for (const c of [
    'shell',              // code execution from a credential that lives in a Crestron program
    'install_apk',        // software installation, same
    'update',             // pulls and installs an APK
    'set_server_url',     // repoints the panel: complete takeover from inside the LAN
    'http_request',       // makes every panel a request relay; the audit trail names the screen
    'launch',             // starts an arbitrary app on the panel
    'settings',           // the way out of kiosk mode
    'kiosk_unlock',       // likewise, explicitly
    'set_time',           // a wrong clock breaks every schedule and the symptom blames the schedule
    'set_timezone',
    'set_power_schedule', // a definition, not a room action
    'reboot',             // not undoable by sending the opposite — see the reasoning in LocalApi.kt
    'shutdown',
    'power_menu',
    'block_uninstall',
    'unblock_uninstall',
  ]) {
    assert.ok(!LOCAL_API_COMMANDS.includes(c), `${c} must not be reachable from the LAN door`);
  }
});

test('the Kotlin door answers only its two paths', () => {
  const src = fs.readFileSync(KT, 'utf8');
  // Anchored on the helper rather than on a grep for the strings, so a second path added anywhere
  // else in the file does not quietly become reachable.
  assert.match(src, /fun isLocalApiPath\(path: String\): Boolean = path == "\/api\/status" \|\| path == "\/api\/command"/);
});
