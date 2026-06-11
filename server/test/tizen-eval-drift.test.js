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
  const failures = data.vectors.filter(v => isItemActiveNow(v.blocks, v.utc_now, v.timezone) !== v.expected);
  assert.strictEqual(failures.length, 0, `${failures.length} vector(s) failed in the tizen copy`);
});
