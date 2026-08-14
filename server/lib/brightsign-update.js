'use strict';

const { preCmp } = require('./version-precedence');

/*
 * Should a BrightSign player replace its own host package (autorun.zip)?
 *
 * This is the riskiest self-update in the product. An Android OTA that goes wrong leaves a player
 * on the old APK; a BrightSign package update that goes wrong replaces the SCRIPT THAT BOOTS THE
 * PLAYER. A truncated or half-applied autorun.brs is a dark panel and a site visit — there is no
 * app underneath to fall back to.
 *
 * So the rule this module encodes is deliberately conservative: refuse unless everything lines up,
 * and treat every ambiguity as "keep running what works".
 *
 * THREE SCARS THIS EXISTS TO HONOUR:
 *
 *  1. A prerelease sorts BELOW its own release. `1.9.29-rc1` is semver-older than `1.9.29`, so a
 *     player handed a test build asks "anything newer?", is correctly told yes — the release — and
 *     updates itself straight off the build someone was asked to test. That cost a reporter an
 *     evening on the Android side. Here the same comparison decides whether to overwrite the boot
 *     script, so it is checked in one place and tested against the exact versions that burned us.
 *  2. Advertising a version that does not match the bytes served is the classic OTA-loop condition:
 *     the player installs, reports the old version, is offered the update again, forever. The
 *     manifest therefore carries a checksum, and a package whose bytes do not hash to it is never
 *     applied — a mismatch is treated as a failed download, not as a new version.
 *  3. On this platform `location.reload()` does not reliably bring the widget back, so anything
 *     that needs a restart goes through the host. Applying a package ends in a reboot, which is why
 *     it must never be triggered on a whim.
 *
 * Pure by design: no filesystem, no network, no clock beyond what the caller passes. The BrightScript
 * host asks this what to do and does exactly that.
 */

const MAX_ATTEMPTS_PER_VERSION = 3;

/*
 * Compare two semver-ish versions. Returns -1, 0 or 1.
 *
 * Prerelease handling is the whole point: 1.9.29-rc1 < 1.9.29, and 1.9.29-rc1 < 1.9.29-rc2. A
 * missing prerelease outranks a present one at equal core, which is what makes the release beat its
 * own candidate.
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v || '0.0.0').split('-');
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    return { nums: [nums[0] || 0, nums[1] || 0, nums[2] || 0], pre: pre || null };
  };
  const A = parse(a);
  const B = parse(b);

  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (A.pre === null) return 1;   // 1.9.29 beats 1.9.29-rc1
  if (B.pre === null) return -1;
  // Natural compare, NOT lexicographic: rc10 must outrank rc9. This file carried the same
  // "lexicographic is right for our naming" assumption that broke the Android OTA path.
  return preCmp(A.pre, B.pre);
}

/*
 * Is `version` a prerelease of the same core release as `release`?
 * 1.9.29-rc1 is a prerelease of 1.9.29; 1.9.29-rc1 is NOT a prerelease of 1.9.30.
 */
function isPrereleaseOf(version, release) {
  const core = (v) => String(v || '').split('-')[0];
  // `release` must be an actual RELEASE, not another prerelease of the same core. Without that
  // last clause a player on rc1 also "holds" against rc3, so an opted-in tester could never move
  // forward through rc1 -> rc2 -> rc3 — the opposite of what opting in is for. The rule exists to
  // stop a test build being dragged BACK to its release, not to freeze a tester on the first one
  // they were handed.
  return String(version || '').includes('-')
    && !String(release || '').includes('-')
    && core(version) === core(release);
}

/**
 * Decide what the host should do about a package update.
 *
 * @param {object} state
 *   currentVersion   {string}  version of the package running now
 *   manifestVersion  {string}  version the server advertises (null/absent = no manifest reachable)
 *   manifestSha256     {string}  checksum of the bytes the server will serve
 *   stagedSha256       {string}  checksum of an already-downloaded file awaiting apply (optional)
 *   attempts         {number}  failed attempts recorded for manifestVersion
 *   allowPrerelease  {boolean} opt-in, mirroring the Android beta channel
 * @returns {{action:'skip'|'download'|'apply', reason:string}}
 */
function decidePackageUpdate(state) {
  const s = state || {};
  const current = s.currentVersion || '0.0.0';
  const advertised = s.manifestVersion;

  // No manifest: the server is unreachable or does not publish one. Keep running. This is the
  // common case during an outage and must never be mistaken for "no update needed, wipe yourself".
  if (!advertised) return { action: 'skip', reason: 'no manifest' };

  // A manifest without a checksum cannot be verified, and an unverifiable package is exactly the
  // truncated-download risk this module exists to refuse.
  if (!s.manifestSha256) return { action: 'skip', reason: 'manifest has no checksum' };

  const cmp = compareVersions(advertised, current);

  if (cmp <= 0) {
    return { action: 'skip', reason: cmp === 0 ? 'already current' : 'advertised version is older' };
  }

  // THE PRERELEASE TRAP, and the reason a plain "newer wins" comparison is not enough.
  //
  // A player running 1.9.29-rc1 is running something semver-OLDER than 1.9.29, so the release
  // legitimately compares as newer — and a player handed a test build would update straight off it.
  // That is exactly what happened on Android: a reporter tested an evening on a build their tablet
  // had already replaced.
  //
  // An OPTED-IN player therefore holds a prerelease of the same core instead of being pulled back to
  // its release. A player that never opted in is not testing anything and should rejoin the release
  // line, so it updates normally. Narrow by construction: only the same core is held, so a genuinely
  // newer core (1.9.30) still lands and opting in can never mean never updating again.
  if (s.allowPrerelease && isPrereleaseOf(current, advertised)) {
    return { action: 'skip', reason: 'holding prerelease of the same core (opted in)' };
  }

  const isPrerelease = String(advertised).includes('-');
  if (isPrerelease && !s.allowPrerelease) {
    return { action: 'skip', reason: 'prerelease requires opt-in' };
  }

  // Repeated failure on the SAME version means something is durably wrong — a corrupt artifact, a
  // proxy mangling the download, a full disk. Retrying forever burns the link and, on a metered
  // connection, real money. Stop and stay on the version that works.
  if ((s.attempts || 0) >= MAX_ATTEMPTS_PER_VERSION) {
    return { action: 'skip', reason: 'too many failed attempts for this version' };
  }

  // Already downloaded and the bytes hash correctly: apply it. Splitting download from apply is
  // what keeps a truncated file from ever becoming autorun.zip.
  if (s.stagedSha256) {
    if (s.stagedSha256 === s.manifestSha256) return { action: 'apply', reason: 'staged package verified' };
    return { action: 'download', reason: 'staged package failed verification' };
  }

  return { action: 'download', reason: 'newer package available' };
}

/*
 * Is a downloaded file safe to promote to autorun.zip?
 *
 * Separate from the decision above because it is answered AFTER the bytes land, and it is the last
 * gate before we overwrite the boot script. Both conditions are non-negotiable: the checksum proves
 * the file is whole, and a non-trivial size catches the case where a captive portal or an error page
 * was saved as if it were the package — a 2KB HTML error page hashes to something, just not this.
 */
function isPackageSafeToApply(actualSha256, expectedSha256, actualBytes, minBytes) {
  if (!actualSha256 || !expectedSha256) return false;
  if (actualSha256 !== expectedSha256) return false;
  const floor = typeof minBytes === 'number' ? minBytes : 1024;
  if (!(actualBytes >= floor)) return false;
  return true;
}

module.exports = {
  decidePackageUpdate,
  isPackageSafeToApply,
  compareVersions,
  MAX_ATTEMPTS_PER_VERSION
};
