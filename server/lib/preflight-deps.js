'use strict';

/*
 * Make sure the dependencies this build needs are actually installed and loadable — BEFORE anything
 * requires them.
 *
 * The normal upgrade path (scripts/upgrade.sh) runs `npm ci --omit=dev`, so this is not for the
 * happy case. It is for the three ways a running box ends up with the wrong node_modules:
 *
 *   ROLLBACK      checking out an older tag to back out a bad release restores that tag's
 *                 package.json but not its packages, so the server dies on a MODULE_NOT_FOUND for
 *                 something the newer build had removed. That is a bad moment to be reading a
 *                 stack trace: you are already rolling back because something else broke.
 *   NODE UPGRADE  better-sqlite3 is a native module compiled against one ABI. Upgrading Node makes
 *                 every boot fail with NODE_MODULE_VERSION mismatch, which reads like database
 *                 corruption and is not.
 *
 *                 Since better-sqlite3 13 that binary is a Node-API build bundled in the package,
 *                 so a Node upgrade within Node-API 10+ no longer invalidates it. Two things still
 *                 apply. ⚠️ Below Node-API 10 (Node < 22.14) it SEGFAULTS rather than throwing, so
 *                 db/native-floor.js is asked BEFORE anything loads it. And it ships prebuilds only
 *                 for linux/darwin/win x64+arm64 (glibc 2.34+, or musl): anywhere else the repair
 *                 below is a from-source compile, which runs synchronously BEFORE the server
 *                 listens — under prod's TimeoutStartSec=90 with Restart=always a slow compile is a
 *                 boot loop rather than a self-heal. Re-check the prebuilds before changing the pin.
 *   HAND EDITS    a `git checkout`, a partly-copied tree, an interrupted install.
 *
 * All three present as a server that will not start, with an error that names a file rather than
 * the action needed. Detecting and repairing is a few seconds; diagnosing is an outage.
 *
 * ⚠️ Deliberately dependency-free — only Node builtins. Anything it required could be the very
 * thing that is missing.
 *
 * Set ST_SKIP_DEP_PREFLIGHT=1 to turn it off (air-gapped hosts, or an operator who manages
 * node_modules themselves and does not want a boot reaching for the network).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { nativeUnsupported } = require('../db/native-floor');

const SERVER_DIR = path.join(__dirname, '..');
const NODE_MODULES = path.join(SERVER_DIR, 'node_modules');
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;   // a cold install on a Pi is genuinely slow

/**
 * Which dependency names this host actually needs on disk.
 *
 * ⚠️ OPTIONAL IS NOT OPTIONAL WHERE THERE IS NOTHING TO FALL BACK TO.
 *
 * better-sqlite3 is an optionalDependency so a host with no compiler installs cleanly and lets
 * db/sqlite-driver.js drop to the built-in node:sqlite. That only works on Node 24 (23.4+); on the
 * 20.x and 22.x lines the built-in is absent or flagged off, and there a missing better-sqlite3 is
 * a server that cannot start at all.
 *
 * npm will quietly skip an optional dependency whose install script it declines to run. Observed
 * exactly that: `npm ci` reported success, left no better-sqlite3 on disk, and every test that
 * spawns the server failed with "server did not boot" — with nothing anywhere saying why.
 *
 * Split out from missingDeps so the decision can be tested on either kind of host, rather than only
 * on whichever Node happens to be running the suite.
 *
 * @param {{dependencies?: object, optionalDependencies?: object}} pkg
 * @param {boolean} builtinDriver whether this runtime has node:sqlite
 */
function requiredDeps(pkg, builtinDriver) {
  const names = Object.keys((pkg && pkg.dependencies) || {});
  /*
   * ⚠️ ONLY THE DATABASE DRIVER, NOT EVERY OPTIONAL PACKAGE. This used to require all of them,
   * which was harmless while the only other one (puppeteer-core 24) installed everywhere. 25 needs
   * Node 22.12, so on Node 20 npm SKIPS it, correctly — and this then refused to boot a server that
   * had nothing wrong with it except no Chromium rendering, after a `git pull` to the release that
   * moved to Node 22. A missing optional package is a missing feature; only a missing driver, with
   * nothing to fall back to, is a server that cannot start.
   */
  const optional = Object.keys((pkg && pkg.optionalDependencies) || {});
  if (!builtinDriver && optional.includes('better-sqlite3')) names.push('better-sqlite3');
  return names;
}

/**
 * The `engines.node` floor this host is below, or null. Only the `>=X.Y.Z` form the server uses.
 * A warning, never a refusal: a server on an older Node mostly still works, and refusing to start
 * would turn an upgrade into an outage for someone who cannot change Node today.
 */
function nodeBelowFloor(pkg, version = process.versions.node) {
  const m = String((pkg && pkg.engines && pkg.engines.node) || '').match(/^>=\s*v?(\d+)\.(\d+)\.(\d+)\s*$/);
  if (!m) return null;
  const want = m.slice(1).map(Number);
  const have = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (have[i] > want[i]) return null;
    if (have[i] < want[i]) return want.join('.');
  }
  return null;
}

/** Which declared dependencies are not on disk. */
function missingDeps() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8'));
  } catch {
    return [];   // no package.json is not our problem to diagnose
  }
  let builtinDriver = false;
  try { require('node:sqlite'); builtinDriver = true; } catch { /* absent on this runtime */ }
  const declared = requiredDeps(pkg, builtinDriver);
  return declared.filter((name) => {
    // A scoped or nested name is still one directory below node_modules.
    try { return !fs.existsSync(path.join(NODE_MODULES, name, 'package.json')); } catch { return true; }
  });
}

/**
 * Which installed PRODUCTION packages are not the version package-lock.json says (#587 follow-up).
 *
 * ⚠️ missingDeps() ONLY ASKS "IS IT ON DISK". An upgrade by `git pull` + restart (no upgrade.sh, so
 * no `npm ci`) therefore kept every package it already had: after the 2.6.2 security refresh that
 * meant nodemailer 9 under a package.json asking for ^10, and the vulnerable proxy-addr and engine.io
 * underneath, while the server booted as if nothing were wrong. Transitive packages are compared
 * too: that is where proxy-addr and engine.io live.
 *
 * Compared only where the package IS on disk: an absent optional or platform-specific package (an
 * @img/sharp-* or esbuild binary for another OS) is not stale. Dev-only entries are ignored, and so
 * are links and bundled packages, which npm does not version from the lockfile.
 * @returns {{name: string, installed: string, locked: string}[]}
 */
function staleDeps(serverDir = SERVER_DIR) {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(serverDir, 'package-lock.json'), 'utf8')); }
  catch { return []; }   // no lockfile: nothing to compare against
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key.startsWith('node_modules/') || !entry || !entry.version) continue;
    if (entry.dev || entry.link || entry.inBundle) continue;
    let installed;
    try { installed = JSON.parse(fs.readFileSync(path.join(serverDir, key, 'package.json'), 'utf8')).version; }
    catch { continue; }   // not on disk: missingDeps() owns the top-level case, absent optionals are fine
    if (installed !== entry.version) out.push({ name: key.slice(key.lastIndexOf('node_modules/') + 13), installed, locked: entry.version });
  }
  return out;
}

/** A tree installed with --omit=dev: none of package.json's devDependencies are on disk. */
function productionTree(serverDir = SERVER_DIR) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8')); } catch { return true; }
  return !Object.keys(pkg.devDependencies || {}).some((n) => fs.existsSync(path.join(serverDir, 'node_modules', n, 'package.json')));
}

/**
 * npm needs a writable home for its cache and logs. A systemd service user often has none (prod's
 * `screentinker` user has no /home directory), and then npm dies writing ~/.npm/_logs having
 * installed nothing. Point it inside the install instead, as the documented prod recipe does.
 */
function npmEnv(serverDir = SERVER_DIR, env = process.env) {
  const home = env.HOME;
  let writable = false;
  if (home) { try { fs.accessSync(home, fs.constants.W_OK); writable = true; } catch { /* not ours */ } }
  if (writable) return env;
  const base = path.join(serverDir, '..');
  return { ...env, HOME: base, npm_config_cache: path.join(base, '.npm-cache') };
}

/**
 * Is the native module loadable by THIS Node?
 *
 * Checked by actually loading it, because the failure is an ABI mismatch that no version string
 * comparison catches reliably — a rebuild against the same major can still differ.
 */
function nativeModuleBroken() {
  // ⚠️ Never load it on a Node it segfaults under: that kills this process before any catch runs.
  const tooOld = nativeUnsupported();
  if (tooOld) return tooOld;
  try {
    /*
     * ⚠️ CONSTRUCT one, do not merely require it.
     *
     * better-sqlite3's entry point is plain JavaScript and loads the compiled `.node` binding
     * lazily, so `require()` alone SUCCEEDS under a Node whose ABI the binary was not built for —
     * the first version of this check did exactly that and reported a broken install as healthy,
     * verified against a real Node 18 / Node 20 mismatch. Opening an in-memory database is what
     * actually pulls the binding in, and it touches no file.
     */
    const Database = require('better-sqlite3');
    new Database(':memory:').close();
    return null;
  } catch (e) {
    const msg = String((e && e.message) || '');
    if (/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against a different/i.test(msg)) return msg;
    if (/Cannot find module/i.test(msg)) return msg;
    // Anything else is a real error in the module, not an installation problem — let it surface
    // later with its own stack rather than being masked by an npm run.
    return null;
  }
}

/*
 * Can this host use Node's built-in driver instead?
 *
 * ⚠️ NODE 24 IN PRACTICE. node:sqlite is only usable without a flag from Node 23.4 onwards; on the
 * 22.x line — which is this project's declared floor — it exists ONLY behind --experimental-sqlite,
 * so a 22.x server started normally has no built-in driver at all.
 *
 * Hence a probe rather than a version comparison: `require` answers what this exact process can do,
 * including the 22.x-with-the-flag case, and cannot be fooled by a floor that says 22.9 while the
 * player it has to serve runs 24.15.
 */
function nodeSqliteAvailable() {
  try { require('node:sqlite'); return true; } catch { return false; }
}

/*
 * Is attempting a rebuild the right move, rather than falling back?
 *
 * Yes when there is no built-in driver to fall back TO — then a broken native module is fatal and
 * the existing loud failure is exactly right. Yes when a toolchain is present, because the native
 * driver is faster and is what production runs, so a repairable install should be repaired.
 *
 * No on a host with node:sqlite and no compiler: that is a player, and `npm rebuild` there is a
 * five-minute node-gyp failure ending in a server that never starts.
 */
function canRebuildNative() {
  // Explicitly asked for the built-in driver: nothing to rebuild, whatever the host has.
  if (String(process.env.ST_SQLITE_DRIVER || '').trim().startsWith('node')) return false;
  if (!nodeSqliteAvailable()) return true;
  for (const bin of ['python3', 'make', 'g++']) {
    try { execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 5000 }); }
    catch { return false; }
  }
  return true;
}

function run(args, label) {
  console.log(`[preflight] ${label}: npm ${args.join(' ')}`);
  execFileSync('npm', args, { cwd: SERVER_DIR, stdio: 'inherit', timeout: INSTALL_TIMEOUT_MS, env: npmEnv() });
}

/**
 * The npm arguments that bring a POPULATED tree back to the lockfile. `install` (not `ci`, which
 * deletes node_modules first: a network failure halfway would leave a server that cannot boot at
 * all), `--no-save` (a booting server does not edit package.json), and `--omit=dev` only on a
 * tree that has no dev packages, because on a developer's tree it prunes them and breaks npm test.
 */
function reconcileArgs(serverDir = SERVER_DIR) {
  return productionTree(serverDir)
    ? ['install', '--omit=dev', '--no-save', '--no-audit', '--no-fund']
    : ['install', '--no-save', '--no-audit', '--no-fund'];
}

function fail(reason, hint) {
  console.error(`[preflight] ${reason}`);
  console.error(`[preflight] ${hint}`);
  console.error('[preflight] Set ST_SKIP_DEP_PREFLIGHT=1 to boot without this check.');
  process.exit(1);
}

function preflight() {
  // Same spellings as every other boolean the server accepts, so an operator who writes `true`
  // does not silently get a boot that reaches for the registry anyway.
  if (['1', 'true', 'yes'].includes(String(process.env.ST_SKIP_DEP_PREFLIGHT || '').toLowerCase())) return;

  try {
    const floor = nodeBelowFloor(JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8')));
    if (floor) {
      console.warn(`[preflight] ⚠️ Node ${process.versions.node} is older than this release needs (>= ${floor}).`);
      console.warn('[preflight]    The native SQLite driver needs Node 22.14+, so the server starts only where Node\'s built-in node:sqlite can stand in, and Chromium rendering (puppeteer-core) may be missing.');
      console.warn('[preflight]    Upgrade Node: see "Upgrading Node.js" in docs/operations.md.');
    }
  } catch { /* no package.json: missingDeps() reports nothing either */ }

  const missing = missingDeps();
  const nodeModulesAbsent = !fs.existsSync(NODE_MODULES);

  if (missing.length || nodeModulesAbsent) {
    const what = nodeModulesAbsent
      ? 'node_modules is missing'
      : `${missing.length} dependency/dependencies missing: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}`;
    console.warn(`[preflight] ${what} — installing before start.`);
    try {
      /*
       * `npm ci` when there is a lockfile and nothing installed: it is reproducible and it is what
       * upgrade.sh uses. Otherwise `npm install`, because `ci` DELETES node_modules first and would
       * throw away a working tree to fix one missing package.
       */
      const hasLock = fs.existsSync(path.join(SERVER_DIR, 'package-lock.json'));
      if (hasLock && nodeModulesAbsent) {
        /*
         * Nothing installed, so `ci` has nothing to destroy and gives a reproducible tree.
         *
         * `--omit=dev` ONLY when this is plainly a production boot. Applying it unconditionally
         * meant a cold start on a developer machine installed 307 packages and left `npm test`
         * broken — js-yaml, puppeteer-core and socket.io-client absent — which is the same class of
         * surprise as the prune this file already warns about, arriving through the other branch of
         * the same `if`.
         */
        const prod = process.env.NODE_ENV === 'production';
        run(prod ? ['ci', '--omit=dev', '--no-audit', '--no-fund'] : ['ci', '--no-audit', '--no-fund'], 'installing');
      } else {
        /*
         * ⚠️ Install ONLY what is missing, by name, and never `--omit=dev` on a populated tree.
         *
         * `npm install --omit=dev` reconciles the whole tree, which PRUNES devDependencies — so
         * merely starting the server deleted socket.io-client, puppeteer-core and js-yaml, and broke
         * `npm test`. A review watched it happen. A boot-time repair that quietly removes packages
         * is worse than the failure it fixes, so this touches nothing it was not asked to.
         *
         * `--no-save` because a server starting up has no business editing package.json.
         */
        run(['install', '--no-save', '--no-audit', '--no-fund', ...missing], 'installing missing packages');
      }
    } catch (e) {
      /*
       * An install can fail because ANOTHER server started at the same moment and won the race —
       * observed as `ENOTEMPTY … rename node_modules/fs-extra`. The tree is complete by the time we
       * see the error, so exiting here killed a process that had nothing wrong with it. Re-check
       * before giving up; only a genuinely incomplete tree is fatal.
       */
      const afterFailure = missingDeps();
      if (afterFailure.length) {
        fail(`could not install dependencies: ${e && e.message}`,
          'Run `npm ci --omit=dev` in the server directory, or check network access to the npm registry.');
      }
      console.warn(`[preflight] install reported an error but the tree is complete (${e && e.message}) — continuing.`);
    }
    const still = missingDeps();
    if (still.length) {
      fail(`still missing after install: ${still.join(', ')}`, 'Check the npm output above.');
    }
    console.log('[preflight] dependencies installed.');
  }

  /*
   * Installed but OUT OF DATE: an upgrade by `git pull` + restart. Brought back to the lockfile in
   * place, so the security fixes an upgrade carries are actually running, not merely on disk.
   */
  const stale = staleDeps();
  if (stale.length) {
    const sample = stale.slice(0, 5).map((d) => `${d.name} ${d.installed} → ${d.locked}`).join(', ');
    console.warn(`[preflight] ${stale.length} installed package(s) differ from package-lock.json (${sample}${stale.length > 5 ? ', …' : ''}) — updating before start.`);
    try {
      run(reconcileArgs(), 'updating to the lockfile');
    } catch (e) {
      // Not fatal: the old versions still run. Say so loudly instead of refusing to boot.
      console.error(`[preflight] could not update dependencies (${e && e.message}). The server will start with the versions it has.`);
      console.error('[preflight] Run `npm ci --omit=dev` in the server directory to install the versions this release expects.');
    }
    const left = staleDeps();
    if (left.length) console.error(`[preflight] still out of date: ${left.slice(0, 5).map((d) => `${d.name} ${d.installed} (wants ${d.locked})`).join(', ')}`);
    else console.log('[preflight] dependencies match package-lock.json.');
  }

  /*
   * ⚠️ A HOST WITH NO NATIVE MODULE IS NOT A BROKEN HOST ANY MORE.
   *
   * db/sqlite-driver.js falls back to node:sqlite when better-sqlite3 is absent or unloadable, which
   * is how the server runs on a BrightSign player: no compiler, no node-gyp, no prebuild for aarch64.
   * Rebuilding — let alone failing the boot — would be wrong there, so if the built-in driver can
   * serve, say so and carry on. Where a toolchain DOES exist the native module is still preferred and
   * still repaired, because it is faster and it is what production runs.
   */
  const nativeProblem = nativeModuleBroken();
  /*
   * ⚠️ TOO OLD A NODE IS NOT A BROKEN INSTALL. A rebuild cannot give Node 20 or 22.13 the Node-API
   * the module needs, so skip straight to the built-in driver, or stop with the actual fix.
   */
  const tooOld = nativeUnsupported();
  if (tooOld) {
    if (nodeSqliteAvailable()) {
      console.log('[preflight] better-sqlite3 cannot run on this Node; using the built-in node:sqlite driver.');
      console.log(`[preflight]   ${tooOld}`);
      return;
    }
    fail(tooOld, 'Upgrade Node to 22.14 or newer: see "Upgrading Node.js" in docs/operations.md.');
  }
  if (nativeProblem && !canRebuildNative()) {
    console.log('[preflight] better-sqlite3 is unavailable; using the built-in node:sqlite driver.');
    console.log(`[preflight]   ${String(nativeProblem).split('\n')[0]}`);
    return;
  }
  if (nativeProblem) {
    console.warn(`[preflight] better-sqlite3 will not load under Node ${process.version} — rebuilding.`);
    console.warn(`[preflight]   ${nativeProblem.split('\n')[0]}`);
    try {
      run(['rebuild', 'better-sqlite3'], 'rebuilding native module');
    } catch (e) {
      fail(`could not rebuild better-sqlite3: ${e && e.message}`,
        `Run \`npm rebuild better-sqlite3\` in the server directory. This usually means Node changed version (now ${process.version}) and the module needs recompiling; a build toolchain (python3, make, g++) must be present.`);
    }
    if (nativeModuleBroken()) {
      fail('better-sqlite3 still will not load after a rebuild.',
        'Delete server/node_modules and run `npm ci --omit=dev`.');
    }
    console.log('[preflight] native module rebuilt.');
  }
}

module.exports = { preflight, missingDeps, nativeModuleBroken, requiredDeps, nodeBelowFloor, staleDeps, productionTree, npmEnv, reconcileArgs };
