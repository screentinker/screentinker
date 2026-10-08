'use strict';

/*
 * Native macOS player — download only.
 *
 *   GET /download/mac
 *     -> the newest ScreenTinker-<ver>.dmg this instance holds (lib/mac-cache.js)
 *
 * The same factory as the Pi and Windows routes (routes/native-update.js), with selfUpdate: false. A Mac
 * is updated from this .dmg or by MDM, never by itself, so there is no /api/mac/update/check, and no
 * OTA rollout ever includes a Mac. The shared download admission guard still applies.
 */

const macCache = require('../lib/mac-cache');
const { createNativeUpdateRoutes } = require('./native-update');

const mountMacDownload = createNativeUpdateRoutes({
  kind: 'mac',
  cache: macCache,
  label: 'macOS disk image (ScreenTinker-<version>.dmg)',
  contentType: 'application/x-apple-diskimage',
  missingReason: 'dmg-missing',
  hashingReason: 'dmg-hashing',
  selfUpdate: false,
});

module.exports = mountMacDownload;
