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
 *                 ⚠️ better-sqlite3 is pinned to EXACTLY 12.9.0, not a caret range, and the reason
 *                 is invisible from package.json: 12.10.0 DROPPED the prebuilt binary for Node 20
 *                 (ABI 115) while still advertising `"node": "20.x || ..."` in engines. So a caret
 *                 resolves to 12.11.x, finds no prebuild on Node 20, and silently falls through to
 *                 `node-gyp rebuild` — a from-source compile during install, and during the repair
 *                 below. That matters here: this file rebuilds synchronously BEFORE the server
 *                 listens, and prod's systemd unit has TimeoutStartSec=90 with Restart=always, so a
 *                 slow or failing compile is a boot loop rather than a self-heal. 12.9.0 is the last
 *                 version shipping prebuilds for BOTH Node 20 (115) and Node 22 (127), which is what
 *                 lets the runtime move without the module having to compile at all.
 *                 Re-check the release assets before widening the pin.
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

const SERVER_DIR = path.join(__dirname, '..');
const NODE_MODULES = path.join(SERVER_DIR, 'node_modules');
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;   // a cold install on a Pi is genuinely slow

/** Which declared dependencies are not on disk. */
function missingDeps() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8'));
  } catch {
    return [];   // no package.json is not our problem to diagnose
  }
  const declared = Object.keys(pkg.dependencies || {});
  return declared.filter((name) => {
    // A scoped or nested name is still one directory below node_modules.
    try { return !fs.existsSync(path.join(NODE_MODULES, name, 'package.json')); } catch { return true; }
  });
}

/**
 * Is the native module loadable by THIS Node?
 *
 * Checked by actually loading it, because the failure is an ABI mismatch that no version string
 * comparison catches reliably — a rebuild against the same major can still differ.
 */
function nativeModuleBroken() {
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

function run(args, label) {
  console.log(`[preflight] ${label}: npm ${args.join(' ')}`);
  execFileSync('npm', args, { cwd: SERVER_DIR, stdio: 'inherit', timeout: INSTALL_TIMEOUT_MS });
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

  const nativeProblem = nativeModuleBroken();
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

module.exports = { preflight, missingDeps, nativeModuleBroken };
