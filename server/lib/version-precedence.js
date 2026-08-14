'use strict';

/*
 * Precedence for PRERELEASE identifiers — the `-alpha11` half of `1.9.34-alpha11`.
 *
 * ⚠️ WHY THIS EXISTS: a plain string compare is what semver specifies for a single alphanumeric
 * identifier, and it is wrong for how this project actually names builds. `"alpha11" < "alpha8"`
 * because `'1' < '8'`, so EVERY build from alpha10 onward sorted below alpha8 and alpha9. The OTA
 * check then answered `client-newer` and refused to offer the update at all — a fleet on alpha8
 * could not be moved forward, silently, with the server reporting the newer build as `latest` in
 * the same breath. Two comparators carried the same assumption, both with a comment saying lexical
 * was "fine for our naming"; it was fine only while the counter stayed below 10.
 *
 * The rule here is natural ordering: split each identifier into digit and non-digit runs and
 * compare digit runs NUMERICALLY. That gives what a human means by the name — alpha8 < alpha9 <
 * alpha10 < alpha11 — while leaving everything else alphabetical, so beta still outranks alpha and
 * rc still outranks beta.
 *
 * Dot-separated identifiers are compared one at a time per semver, and a shorter run of identifiers
 * loses when all preceding ones are equal (`alpha` < `alpha.1`), so a future move to the semver-
 * correct `-alpha.11` form keeps working without another change here.
 *
 * Deliberately NOT handled: whether a prerelease outranks a release. That is the caller's rule —
 * both callers already implement it, and each has its own exceptions (ota-breaker treats the legacy
 * `-patchN` scheme as released).
 */

// Compare one identifier, digit runs numerically. "alpha10" -> ["alpha", "10"].
function naturalCmp(x, y) {
  const rx = String(x).match(/\d+|\D+/g) || [];
  const ry = String(y).match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.max(rx.length, ry.length); i++) {
    const a = rx[i], b = ry[i];
    if (a === undefined) return -1;          // "alpha" < "alpha1"
    if (b === undefined) return 1;
    const aNum = /^\d+$/.test(a), bNum = /^\d+$/.test(b);
    if (aNum && bNum) {
      // Numeric, so 10 beats 8 — the whole point of this file.
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1;
    } else if (a !== b) {
      // A digit run sorts below a word run, matching semver's numeric-identifiers-first rule.
      if (aNum !== bNum) return aNum ? -1 : 1;
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

/* Full prerelease precedence: dot-separated identifiers, each compared naturally. */
function preCmp(a, b) {
  if (a === b) return 0;
  const as = String(a).split('.'), bs = String(b).split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (as[i] === undefined) return -1;      // "alpha" < "alpha.1"
    if (bs[i] === undefined) return 1;
    const c = naturalCmp(as[i], bs[i]);
    if (c !== 0) return c;
  }
  return 0;
}

module.exports = { preCmp, naturalCmp };
