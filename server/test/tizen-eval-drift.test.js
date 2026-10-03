// Drift guard (#74/#75): the Tizen player bundles the evaluator, and per the
// design directive it must be the BYTE-IDENTICAL canonical UMD (server/lib/
// schedule-eval.js), not a hand-port. This test (run by `npm test`, i.e. in CI)
// fails the moment tizen/js/schedule-eval.js diverges from the source, and also
// re-checks that the bundled copy still passes every shared vector.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const canonical = path.join(__dirname, '..', 'lib', 'schedule-eval.js');
const tizenCopy = path.join(__dirname, '..', '..', 'tizen', 'js', 'schedule-eval.js');

test('tizen evaluator is byte-identical to the canonical evaluator', () => {
  assert.ok(fs.existsSync(tizenCopy), `tizen copy missing: ${tizenCopy}`);
  const a = fs.readFileSync(canonical);
  const b = fs.readFileSync(tizenCopy);
  assert.ok(a.equals(b), 'tizen/js/schedule-eval.js has drifted from server/lib/schedule-eval.js — re-copy it (the .wgt build does this automatically)');
});

test('bundled tizen evaluator passes every shared vector', () => {
  const { isItemActiveNow } = require(tizenCopy);
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'schedule-vectors.json'), 'utf8'));
  const failures = data.vectors.filter(v => isItemActiveNow(v.blocks, v.utc_now, v.timezone, v.window || null) !== v.expected);
  assert.strictEqual(failures.length, 0, `${failures.length} vector(s) failed in the tizen copy`);
});

/*
 * ⚠️ Tizen must not claim a trigger capability it cannot possibly have.
 *
 * External triggers need the player to LISTEN, and a Tizen web app has no raw socket and no way to
 * accept an inbound connection — there is nothing to probe. Declaring it anyway would repeat the
 * offline.cache mistake: a capability that passes a presence check, is advertised to the fleet, and
 * cannot do one byte of the work. An integrator picking screens for a Crestron install needs the
 * absence to be TRUE, because the alternative is finding out on site.
 */
test('the Tizen player declares no trigger capability, because it cannot listen', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'tizen', 'js', 'capabilities.js'), 'utf8');
  const declared = src.slice(src.indexOf('function detect()'));
  assert.doesNotMatch(declared, /caps\.push\('trigger\.|'trigger\.http'|'trigger\.udp'/,
    'Tizen cannot bind a port — a declared trigger capability here would be a lie to the fleet');
});
