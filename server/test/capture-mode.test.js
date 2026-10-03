'use strict';

// devices.capture_mode — which screen-capture tier a panel can actually use.
//
// The bug it exists for: MediaProjection consent does not survive the app restarting, and an OTA
// restarts the app. A panel silently drops from whole-screen capture to drawing only the player's
// own window — the remote view shows the playlist and goes blank over Settings, with no error
// anywhere. Reported by a customer on two panels at once after one update. The tier was
// unobservable from the server, so nobody could tell a permission state from a broken screenshot.

const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-capmode-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { db } = require('../db/database');

test('the column exists and is nullable', () => {
  const col = db.prepare("SELECT * FROM pragma_table_info('devices') WHERE name='capture_mode'").get();
  assert.ok(col, 'devices.capture_mode is migrated');
  assert.equal(col.notnull, 0, 'NULL means "not reported" — every non-Android player, and older builds');
});

test('the writer accepts only the four real tiers, and NULLs anything else', () => {
  // Absent or junk must not become a bogus tier the dashboard would then explain to an operator.
  const src = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  assert.match(src, /\['projection', 'accessibility', 'view', 'none'\]\.includes\(di\.capture_mode\)/,
    'the persist path validates against the known tiers');
  assert.match(src, /capture_mode = \?/, 'and actually writes the column');
});

test('⚠️ EVERY device_info emit site carries the tier, not just the first', () => {
  // device_info is emitted from three places (register, re-register, heartbeat). Adding the field
  // at one call site is how a panel reports a tier on connect and none on the next heartbeat.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'com',
      'remotedisplay', 'player', 'service', 'WebSocketService.kt'), 'utf8');
  assert.equal((src.match(/deviceInfo\.getDeviceInfo\(\)/g) || []).length, 1,
    'exactly one call to the raw builder — inside deviceInfoPayload()');
  assert.ok((src.match(/deviceInfoPayload\(\)/g) || []).length >= 4,
    'and every emit site goes through the wrapper that adds capture_mode');
});

test('the tier definition matches the capture fallback order', () => {
  const root = path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'com',
    'remotedisplay', 'player', 'service');
  const mode = fs.readFileSync(path.join(root, 'CaptureMode.kt'), 'utf8');
  const order = [...mode.matchAll(/^\s*(ScreenCaptureService\.isReady|accessibilityCaptureAvailable\(\)|hasActivityCapture)/gm)]
    .map((m) => m[1]);
  assert.deepEqual(order, ['ScreenCaptureService.isReady', 'accessibilityCaptureAvailable()', 'hasActivityCapture'],
    'projection, then accessibility, then view — the same order captureScreen() tries');
});

test('restore-on-start is gated on device owner, so no dialog lands over live content', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'com',
      'remotedisplay', 'player', 'ScreenCapturePermissionActivity.kt'), 'utf8');
  const fn = src.slice(src.indexOf('fun restoreIfPreviouslyGranted'));
  assert.match(fn, /screen_capture_granted/, 'it reads the flag that was previously write-only');
  assert.match(fn, /isDeviceOwner\(\)/, 'and only re-requests where the grant is dialog-free');
  const guard = fn.indexOf('isDeviceOwner()');
  // The restore launches the activity directly rather than via requestPermission(), which would
  // clear a pending live-video request — see the publish test below.
  const request = fn.indexOf('context.startActivity');
  assert.ok(guard > 0 && request > 0 && guard < request,
    'the ownership check comes BEFORE the launch');
});

test('the dashboard notice fires on exactly the tiers that need it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  const start = src.indexOf('function captureModeNotice');
  assert.ok(start > 0, 'device-detail.js no longer defines captureModeNotice');
  const fn = src.slice(start, src.indexOf('// Mirrors platformFamily'));
  // Run the REAL function rather than pattern-matching its source: a regex over the body passes
  // just as happily when the branches are wrong.
  const notice = vm.runInNewContext(fn + '; captureModeNotice', { t: (k) => k });

  // NULL is "this panel has not told us" — every non-Android player and every older Android build.
  // Rendering a fault there would put a warning on hundreds of displays that have nothing wrong.
  assert.equal(notice({}), '', 'an unreported tier says nothing');
  assert.equal(notice({ capture_mode: null }), '', 'and neither does an explicit null');
  assert.equal(notice(null), '', 'nor a missing device');
  // Accessibility is the durable path. A panel already on it needs no nudge toward it.
  assert.equal(notice({ capture_mode: 'accessibility' }), '', 'the durable tier needs no nudge');

  // The degraded tier is the whole point: this is the state harp's panels were left in.
  const view = notice({ capture_mode: 'view' });
  assert.match(view, /device\.remote\.capture_view/, 'the degraded tier is called out');
  assert.match(view, /var\(--warning\)/, 'and as a warning, not as a note');

  // Capturing fine, but the grant dies on the next update — worth saying, not worth alarming.
  const projection = notice({ capture_mode: 'projection' });
  assert.match(projection, /device\.remote\.capture_projection/);
  assert.match(projection, /var\(--text-muted\)/, 'projection is working, so it is not a warning');

  assert.match(notice({ capture_mode: 'none' }), /device\.remote\.capture_none/);

  for (const [mode, html] of [['view', view], ['projection', projection]]) {
    assert.equal((html.match(/<span/g) || []).length, (html.match(/<\/span>/g) || []).length,
      `${mode} renders balanced markup`);
  }
});

test('⚠️ a failed silent re-arm WITHDRAWS the dialog, and finish() alone does not', () => {
  // Verified on an emulator, and this is the half that was wrong the first time. The consent dialog
  // belongs to systemui and is started for a RESULT INTO OUR TASK, so finishing this activity
  // leaves the dialog parked over live signage exactly as before — which is the outcome the whole
  // probe exists to avoid. finishActivity(requestCode) is the call that ends it.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'com',
      'remotedisplay', 'player', 'ScreenCapturePermissionActivity.kt'), 'utf8');
  const probe = src.slice(src.indexOf('private fun armSilentGrantProbe'));
  // Comments only, stripped: the body below explains WHY finish() is not enough, and an ordering
  // check over the raw text would happily match the word "finish()" inside that explanation.
  const body = probe.slice(0, probe.indexOf('override fun onActivityResult'))
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.match(body, /finishActivity\(REQUEST_CODE\)/, 'the child consent activity is finished');
  assert.ok(body.indexOf('finishActivity(REQUEST_CODE)') < body.indexOf('finish()'),
    'and withdrawn BEFORE this activity goes away, while it can still be addressed');
  assert.match(body, /putBoolean\(PREF_AUTO_RESTORE, false\)/,
    'a panel that raised a dialog never auto-retries');
  // The probe must not fire for an operator-initiated request; someone is looking at that panel.
  assert.match(body, /if \(!isProbe\) return/);
  // ⚠️ The timeout asks whether THIS request was answered. It used to read Companion.hasPermission,
  // which is sticky for the life of the process: after any earlier grant it reads true forever, so
  // the probe would conclude that a dialog it can see had already been answered and leave it parked.
  assert.match(body, /!resultArrived/);
  assert.doesNotMatch(body, /Companion\.hasPermission/);
});

test('⚠️ the probe cannot be inherited by a live-video request', () => {
  // This activity has the default launchMode, so every request starts a NEW instance. When the probe
  // role lived in a process-wide flag, a device:live-publish arriving while a restore was in flight
  // read that flag as still true and withdrew the OPERATOR'S consent dialog 1500ms later — live
  // video failing to start, silently. The role now travels on the launch intent instead.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'com',
      'remotedisplay', 'player', 'ScreenCapturePermissionActivity.kt'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');

  assert.doesNotMatch(code, /restoreAttempt/, 'no process-wide flag decides who is a probe');
  assert.match(code, /isProbe = intent\?\.getBooleanExtra\(EXTRA_PROBE, false\)/,
    'the role is read from the launch that carried it');
  // Only the restore path may set it. requestPermission (the dashboard button) and requestForLive
  // must not, or their dialogs get withdrawn under the operator.
  assert.equal((code.match(/putExtra\(EXTRA_PROBE/g) || []).length, 1,
    'exactly one launch site marks itself a probe');
  const restore = code.slice(code.indexOf('fun restoreIfPreviouslyGranted'), code.indexOf('fun requestPermission'));
  assert.match(restore, /putExtra\(EXTRA_PROBE, true\)/, 'and it is the automatic restore');
});

test('⚠️ an automatic restore never steals a live-video publish', () => {
  // requestPermission() clears pendingLive, so a restore routed through it while a live publish was
  // being set up sent that grant to the screenshot service and the publish never started. A restore
  // is the lowest-priority request here: if live video is already asking, it stands aside.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'com',
      'remotedisplay', 'player', 'ScreenCapturePermissionActivity.kt'), 'utf8');
  const restore = src.slice(src.indexOf('fun restoreIfPreviouslyGranted'), src.indexOf('fun requestPermission'));
  const code = restore.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');

  assert.match(code, /if \(pendingLive != null\)[\s\S]*?return/, 'it stands aside for a pending publish');
  assert.doesNotMatch(code, /requestPermission\(context\)/, 'and does not route through the path that clears it');
  assert.ok(code.indexOf('pendingLive != null') < code.indexOf('startActivity'),
    'the check comes BEFORE the launch');
});
