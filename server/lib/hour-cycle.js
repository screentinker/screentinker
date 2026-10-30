'use strict';

/*
 * ⚠️ hour12: true IS NOT "12-hour" EVERYWHERE. Under ECMA-402 a locale whose default clock is 24-hour
 * (en-GB, de, fr…) resolves hour12: true to hourCycle 'h11', which counts 0-11: 12:38 PM showed as
 * "00:38:22 pm" on a Raspberry Pi left on the installer's en-GB locale (2026-10-30). hourCycle 'h12'
 * is the real fix, but Chrome < 73 (Tizen 3, webOS 4, the legacy player) ignores hourCycle and would
 * show 24-hour time instead, so hour12 stays and is swapped only where it resolved wrong. 'h24'
 * (1-24, midnight as 24) is the same mistake on the 24-hour side.
 * ES5 on purpose: it is inlined into widget pages and slides that old players run.
 */
function fixHourCycle(loc, o) {
  if (typeof o.hour12 !== 'boolean') return o;
  try {
    var hc = new Intl.DateTimeFormat(loc, o).resolvedOptions().hourCycle;
    if (hc === 'h11' || hc === 'h24') { var want = o.hour12 ? 'h12' : 'h23'; delete o.hour12; o.hourCycle = want; }
  } catch (e) { /* an old engine: hour12 as given */ }
  return o;
}

// The source, for the pages that inline it (routes/widgets.js clock, lib/slide-render.js live clocks).
const FIX_HOUR_CYCLE_JS = fixHourCycle.toString();

module.exports = { FIX_HOUR_CYCLE_JS, fixHourCycle };
