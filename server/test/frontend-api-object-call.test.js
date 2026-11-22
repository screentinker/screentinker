'use strict';

// frontend/js/api.js exports `api` as an OBJECT of methods (api.get, api.post, ...), not a function.
// data-sources.js called api('/data-sources/weather-languages'): it threw "api is not a function"
// synchronously, before any promise existed, so its .catch never ran and the weather language list
// silently fell back to the dashboard's own languages (prod crash reports, 2026-11).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const JS = path.join(__dirname, '..', '..', 'frontend', 'js');

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('no module that imports { api } calls it as a function', () => {
  const offenders = [];
  for (const f of files(JS)) {
    const src = fs.readFileSync(f, 'utf8');
    if (!/import\s*\{[^}]*\bapi\b[^}]*\}\s*from\s*['"][./]*api\.js['"]/.test(src)) continue;
    src.split('\n').forEach((line, i) => {
      if (/(^|[^.\w$])api\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${path.relative(JS, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `api is an object; use api.get/api.post:\n  ${offenders.join('\n  ')}`);
});
