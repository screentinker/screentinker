'use strict';

/*
 * Every file the browser loads must actually parse.
 *
 * 2.0.6 shipped a schedule.js whose new block had been inserted INSIDE an unterminated
 * `import {`, so the file was a syntax error. app.js imports schedule.js statically, so the
 * whole dashboard module graph failed to evaluate: not a broken Schedule tab, a blank dashboard
 * reporting "Disconnected" for everyone. It reached production because nothing in the repo ever
 * parsed browser code — the server is covered by its own tests, and CI lints docs/openapi.yaml,
 * but frontend/ was never read by anything but a browser.
 *
 * This is deliberately a parser and nothing more. It cannot know whether a view behaves, but the
 * failure it does catch is the one that takes down every view at once, and it catches it in the
 * cheapest possible way.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SKIP = new Set(['node_modules', 'vendor', '.git', 'dist', 'build', 'coverage']);

function collect(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// A browser file is fine if it parses as EITHER an ES module or a classic script: the tree holds
// both (views are modules, brand-prime.js and orientation-style.js are plain <script> files), and
// nothing here should have to declare which it is.
function parses(file, ext) {
  const tmp = path.join(os.tmpdir(), `st-parse-${process.pid}-${path.basename(file)}${ext}`);
  fs.writeFileSync(tmp, fs.readFileSync(file));
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return null; }
  catch (err) {
    const msg = String(err.stderr || err.message).split('\n').find((l) => /Error/.test(l)) || 'parse failed';
    return msg.trim();
  } finally { fs.unlinkSync(tmp); }
}

for (const dirName of ['frontend', 'tizen']) {
  const dir = path.join(ROOT, dirName);
  if (!fs.existsSync(dir)) continue;

  test(`${dirName}/: every .js parses`, () => {
    const files = collect(dir);
    assert.ok(files.length > 0, `${dirName}/ has no .js files — the walk is wrong, not the tree`);

    const broken = [];
    for (const f of files) {
      const asModule = parses(f, '.mjs');
      if (!asModule) continue;
      const asScript = parses(f, '.cjs');
      if (!asScript) continue;
      broken.push(`${path.relative(ROOT, f)}\n      as module: ${asModule}\n      as script: ${asScript}`);
    }
    assert.deepEqual(broken, [], `these files do not parse:\n    ${broken.join('\n    ')}`);
  });
}

test('the dashboard entry point statically imports its views, so one bad view breaks all of them', () => {
  // Guards the assumption above: if these ever become dynamic imports, a syntax error stops being
  // fatal to the whole app and the comment on this file would be wrong.
  const app = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'app.js'), 'utf8');
  assert.match(app, /^import \* as schedule from '\.\/views\/schedule\.js';$/m);
});
