'use strict';

/*
 * ⚠️ BUMP THIS WHEN A WIDGET'S RENDERED PAGE CHANGES (routes/widgets.js render*, lib/hour-cycle.js…).
 *
 * A player caches a widget page by URL, and the URL carries the widget's rev: its updated_at, plus a
 * place salt for widgets that follow their screen (ws/deviceSocket.js). The server marks a rev-pinned
 * render immutable for a year, so a fix to the renderer itself never reached a screen that already
 * had the page: a Raspberry Pi kept showing "00:38 pm" from a clock fixed on the server, and would
 * have until someone happened to edit that widget. Adding this to every rev makes a renderer change
 * a new URL, so each screen fetches the fixed page once and caches it again.
 *
 * Costs one reload of each widget on each screen per bump. Not used for embedded (e-paper) renders,
 * whose cache keys deliberately stay stable so panels do not redraw on an upgrade.
 *
 *   1  12-hour clocks showed 12 o'clock as "00" in 24-hour locales (lib/hour-cycle.js)
 *   2  clocks shrink to fit their zone instead of wrapping; slide widgets can fill their zone
 */
module.exports = 2;
