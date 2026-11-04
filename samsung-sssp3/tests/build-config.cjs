'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const prepare = path.join(root, 'prepare.js');
const prelude = path.join(root, 'dist', 'native-prelude.js');

function run(extra) {
  return spawnSync(process.execPath, [prepare], {
    cwd: root,
    env: { ...process.env, ST_ORSAY_BASE_URL: '', ST_ORSAY_CHANNEL: '', ...extra },
    encoding: 'utf8',
  });
}

try {
  const stamped = run({ ST_ORSAY_BASE_URL: 'http://cms.example.test:3001' });
  assert.equal(stamped.status, 0, stamped.stderr);
  const source = fs.readFileSync(prelude, 'utf8');
  assert.match(source, /launcherUrl: "http:\/\/cms\.example\.test:3001\/sssp3\/"/);
  assert.doesNotMatch(source, /sssp3-native-candidate/);

  const invalid = run({ ST_ORSAY_BASE_URL: 'http://cms.example.test', ST_ORSAY_CHANNEL: '../candidate/' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /ST_ORSAY_CHANNEL/);
} finally {
  const restored = run({});
  assert.equal(restored.status, 0, restored.stderr);
}

console.log('Build-time server stamping uses the stable SSSP3 endpoint and rejects unsafe channels.');
