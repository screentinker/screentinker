'use strict';

/*
 * The embedded-panel UI added with reTerminal E-Series support (#638 review, small items):
 *   - its strings go through t(), with keys in all ten locale files, instead of hard-coded English;
 *   - the dashboard card's ambient-sensor badge is for embedded panels only, so every other
 *     player's card stays as it was (other players report temperature_c too);
 *   - the E-Series test writes to a temp dir, not into the repo.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = path.join(__dirname, '..', '..', 'frontend', 'js');
const read = (f) => fs.readFileSync(path.join(FE, f), 'utf8');
const LOCALES = ['en', 'de', 'es', 'fr', 'hi', 'it', 'ja', 'nl', 'pt', 'zh'];
const keysOf = (src) => new Set([...src.matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]));

const KEYS = [
  'device.info.humidity', 'device.info.humidity_value', 'device.ctl.update_firmware',
  'device.toast.fw_queued', 'device.toast.fw_queued_unverified', 'device.toast.fw_no_firmware', 'device.toast.fw_board_mismatch',
  'device.embedded.logs_title', 'device.embedded.logs_hint', 'device.embedded.logs_request', 'device.embedded.logs_copy',
  'device.embedded.logs_none', 'device.embedded.logs_none_hint', 'device.embedded.logs_empty_buffer',
  'device.embedded.logs_meta_uploaded', 'device.embedded.logs_meta_version', 'device.embedded.logs_meta_battery',
  'device.embedded.logs_meta_rssi', 'device.embedded.logs_meta_entries', 'device.embedded.logs_received',
  'device.embedded.logs_requested', 'device.embedded.logs_request_failed', 'device.embedded.logs_nothing_to_copy',
  'device.embedded.logs_copied', 'device.embedded.logs_copy_failed',
];

test('the embedded device-page strings are not hard-coded English', () => {
  const dd = read('views/device-detail.js');
  for (const s of ["'Update Firmware'", '>Diagnostic Logs<', '>Request Diagnostic Logs<', 'id="copyDiagLogsBtn">Copy<',
    "'No diagnostic logs uploaded yet.'", '`Last upload: ', "'No logs to copy'", "'Diagnostic logs copied to clipboard'",
    "% RH'", '% RH<', '`Diagnostic logs received (']) {
    assert.ok(!dd.includes(s), `device-detail.js still hard-codes ${s}`);
  }
  assert.ok(!read('views/dashboard.js').includes("'% RH'"), 'dashboard.js still hard-codes % RH');
});

test('every embedded UI key exists in all ten locale files', () => {
  for (const loc of LOCALES) {
    const have = keysOf(read(path.join('i18n', `${loc}.js`)));
    const missing = KEYS.filter((k) => !have.has(k));
    assert.deepEqual(missing, [], `${loc}.js lacks ${missing.join(', ')}`);
  }
});

test('the dashboard card shows the sensor badge for embedded panels only', () => {
  const src = read('views/dashboard.js');
  const at = src.indexOf('data-card-field="sensors"');
  assert.ok(at > 0, 'the badge exists');
  const guard = src.slice(src.lastIndexOf('${(', at), at);
  assert.match(guard, /isEmbeddedCard\(device\)/, 'gated on the device being an embedded panel');
});

test('the reTerminal E-Series test writes into a temp dir, not the repo', () => {
  const src = fs.readFileSync(path.join(__dirname, 'reterminal-e-series.test.js'), 'utf8');
  assert.ok(!/__dirname,\s*'\.\.',\s*'data'/.test(src), 'no cache dir under server/data');
  assert.match(src.slice(0, 600), /process\.env\.DATA_DIR = /, 'DATA_DIR (and so contentDir) is a temp dir, set before config loads');
});
