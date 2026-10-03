'use strict';

/*
 * Tiny constraint check for plugin.json "screentinker". Only `>=x.y.z` is
 * understood — that is the one operators actually write. Anything else is a
 * warning and a pass, so a future `^2` does not refuse to load on a parser
 * that was never taught it.
 */

function parse(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

function satisfies(constraint, version) {
  if (!constraint || !String(constraint).trim()) return true;
  const raw = String(constraint).trim();
  const ge = raw.match(/^>=\s*(\d+\.\d+\.\d+)/);
  if (!ge) return true;
  const need = parse(ge[1]);
  const have = parse(version);
  if (!need || !have) return true;
  return cmp(have, need) >= 0;
}

module.exports = { satisfies, parse, cmp };
