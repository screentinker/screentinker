// Drives the canonical evaluator against the shared conformance vectors
// (shared/schedule-vectors.json). The same file is consumed by the Kotlin JUnit
// suite and the Tizen-JS-under-Node test, so all three implementations are held to
// one contract.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { isItemActiveNow } = require('../lib/schedule-eval');

const vectorsPath = path.join(__dirname, '..', '..', 'shared', 'schedule-vectors.json');
const data = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

test('schedule evaluator conforms to every shared vector', () => {
  const failures = [];
  for (const v of data.vectors) {
    const got = isItemActiveNow(v.blocks, v.utc_now, v.timezone);
    if (got !== v.expected) failures.push(`  [${v.utc_now} ${v.timezone}] expected ${v.expected} got ${got} :: ${v.description}`);
  }
  if (failures.length) console.error('\n' + failures.join('\n'));
  console.log(`schedule vectors: ${data.vectors.length - failures.length}/${data.vectors.length} passed`);
  assert.strictEqual(failures.length, 0, `${failures.length} vector(s) failed`);
});
