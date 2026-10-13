'use strict';

/*
 * Strip every trailing `ch` from a string: the linear replacement for `.replace(/\/+$/, '')`.
 *
 * The regex form is quadratic on a value it does not end in. `$` is unanchored on the left, so V8
 * retries `\/+` from every slash in a run and each attempt walks the rest of the run before failing
 * on the character after it: 50k slashes then an `x` is ~1.25e9 steps. These calls sit on request
 * bodies, Origin/Host headers and email addresses, so that is one request pinning the event loop.
 * A single backwards scan does the same job in one pass.
 */
function trimTrailing(s, ch) {
  const str = String(s);
  let end = str.length;
  while (end > 0 && str[end - 1] === ch) end--;
  return end === str.length ? str : str.slice(0, end);
}

module.exports = { trimTrailing };
