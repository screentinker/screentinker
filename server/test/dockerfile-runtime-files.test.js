'use strict';

/*
 * ⚠️ EVERY REPO-ROOT FILE THE SERVER READS AT RUNTIME MUST BE COPIED INTO THE IMAGE.
 *
 * This class of bug has now happened three times, and it is nasty for the same reason each time: the
 * unit tests pass, because they read the file out of the source tree. Only a containerised install is
 * missing it, and a containerised install is the documented self-hosting path.
 *
 *   release-notes.json     — the API answered `current: null` and the "what's new" panel was empty on
 *                            every container. Found on alpha, on the release that introduced it.
 *   docs/openapi.yaml      — /openapi.yaml 404'd in the image while serving fine from a checkout.
 *   certified-hardware.json — the worst of the three, because it failed INVISIBLY: the route catches
 *                            the ENOENT and serves the committed static page, which looks entirely
 *                            correct. What it silently dropped was every approved community
 *                            submission, which is merged in at render time. The approve link worked,
 *                            the row went to 'approved', and the report never appeared. Found by
 *                            submitting one on alpha and watching it not show up.
 *
 * So this test stops asking "did someone remember" and asks the source instead: every path the server
 * resolves against the repository root has to appear in the Dockerfile.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const DOCKERFILE = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');

/* Directories the server walks up to the repo root to reach. `'..', '..'` from server/lib or
 * server/routes is the repository root, and that is the idiom every one of these uses. */
function runtimeRootPaths() {
  const dirs = ['lib', 'routes', 'services', 'db', 'ws'];
  const found = new Map();   // name -> the file that reads it
  for (const dir of dirs) {
    const full = path.join(__dirname, '..', dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(full, entry.name), 'utf8');
      /*
       * ⚠️ TWO IDIOMS, and missing the second is how this test first passed while being blind to the
       * very file it was written for. certified-hardware.js does NOT write the segments inline — it
       * defines `const ROOT = path.join(__dirname, '..', '..')` and then `path.join(ROOT, 'x')`. A
       * matcher that only knew the inline form reported "all clear" on a Dockerfile with the COPY
       * deleted. Found by deleting it and watching the test pass.
       */
      const rootAlias = src.match(/const\s+([A-Z_]+)\s*=\s*path\.join\(__dirname,\s*'\.\.',\s*'\.\.'\s*\)/);
      if (rootAlias) {
        const re = new RegExp(`path\\.join\\(${rootAlias[1]}((?:,\\s*'[A-Za-z0-9._-]+')+)\\)`, 'g');
        for (const m of src.matchAll(re)) {
          const rel = [...m[1].matchAll(/'([A-Za-z0-9._-]+)'/g)].map((x) => x[1]).join('/');
          if (!found.has(rel)) found.set(rel, `server/${dir}/${entry.name}`);
        }
      }

      /*
       * ⚠️ THE WHOLE JOIN, not the first segment after the root. `'..', '..', 'webos',
       * 'ScreenTinker.ipk'` is a probe for a BUILD OUTPUT that is not committed — ipk-cache treats its
       * absence as "not hosted on this instance", a supported state with its own page. Matching only
       * `webos` would flag the directory and demand it be copied, which is the wrong answer. Resolve
       * the full path and let the existence check below decide.
       */
      for (const m of src.matchAll(/'\.\.',\s*'\.\.'((?:,\s*'[A-Za-z0-9._-]+')+)/g)) {
        const segs = [...m[1].matchAll(/'([A-Za-z0-9._-]+)'/g)].map((x) => x[1]);
        const rel = segs.join('/');
        if (!found.has(rel)) found.set(rel, `server/${dir}/${entry.name}`);
      }
    }
  }
  return found;
}

/* Does git track this path? An untracked file is a build output, not repository content. */
function tracked(rel) {
  try {
    return execFileSync('git', ['ls-files', '--', rel], { cwd: REPO, encoding: 'utf8' }).trim() !== '';
  } catch (e) {
    // No git (a source tarball, some CI images). Fall back to existence, which is the old behaviour
    // and errs toward flagging rather than toward silence.
    return fs.existsSync(path.join(REPO, rel));
  }
}

test('every repo-root path the server resolves is copied into the image', () => {
  const missing = [];
  for (const [name, reader] of runtimeRootPaths()) {
    // Only the ones that actually exist in the repo. A name that is absent here is a runtime artifact
    // (a built .ipk, a mounted .wgt) that is supplied by the deployment, not by the build — those are
    // checked separately below.
    /*
     * ⚠️ TRACKED BY GIT, not merely present on disk. tizen/ScreenTinker.wgt sits in a working tree as
     * a local build output and is not committed — the Dockerfile could not copy it if it wanted to,
     * and it should not: the in-repo build is unsigned and inspection-only, while a retail Samsung
     * panel needs a partner-signed one the operator mounts at /data. Testing for existence alone
     * would demand the image carry a file that only exists on the machine running the test.
     */
    if (!tracked(name)) continue;
    // Copied directly, or inside a directory the Dockerfile copies whole.
    const candidates = [name];
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) candidates.push(parts.slice(0, i).join('/'));
    const copied = candidates.some((c) =>
      new RegExp(`^COPY\\s+(--from=\\S+\\s+)?${c.replace(/\./g, '\\.')}(/|\\s)`, 'm').test(DOCKERFILE));
    if (!copied) missing.push(`${name} (read by ${reader})`);
  }
  assert.deepEqual(missing, [],
    'these are read from the repo root at runtime but never enter the image, so they are absent in '
    + 'every containerised install while the tests pass from the source tree');
});

test('the three known instances are each covered', () => {
  // Named explicitly, because a regex that stops matching is a test that silently passes.
  for (const f of ['release-notes.json', 'certified-hardware.json', 'VERSION']) {
    assert.match(DOCKERFILE, new RegExp(`COPY ${f.replace(/\./g, '\\.')} `), `${f} is not COPYed`);
  }
  assert.match(DOCKERFILE, /COPY docs\/openapi\.yaml /);
});

test('⚠️ an artifact the DEPLOYMENT supplies is not expected in the image', () => {
  /*
   * ScreenTinker.ipk and ScreenTinker.wgt are read from the repo root too, but they are built by CI or
   * mounted by the operator — lib/ipk-cache.js and lib/wgt-cache.js both try /data first and treat
   * absence as "not hosted on this instance", which is a supported state with its own page. Copying
   * them would be wrong, so the test above skips what is not in the tree, and this records why.
   */
  for (const f of ['ScreenTinker.ipk', 'ScreenTinker.wgt']) {
    assert.ok(!fs.existsSync(path.join(REPO, f)) || DOCKERFILE.includes(`COPY ${f} `),
      `${f} is in the tree now, so decide deliberately whether it belongs in the image`);
  }
  const ipk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ipk-cache.js'), 'utf8');
  assert.match(ipk, /dataDir/, 'the operator mount is what makes absence from the image acceptable');
});

test('the certified-hardware page degrades to the static file rather than erroring', () => {
  /*
   * The fallback is correct and stays — a contractual page should degrade to "our entries only" rather
   * than to a 500. ⚠️ But it is precisely what made the missing file invisible for so long, so the
   * failure has to be loud in the log even though it is quiet on the page.
   */
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'certified-hardware.js'), 'utf8');
  assert.match(route, /res\.sendFile\(OUT\)/, 'the static fallback should remain');
  assert.match(route, /console\.error\('\[certified-hardware\] falling back/,
    'a silent fallback is how this went unnoticed');
});
