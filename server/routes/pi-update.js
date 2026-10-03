'use strict';

/*
 * Native Raspberry Pi player — self-update.
 *
 *   GET /api/pi/update/check?version=&device_id=[&forced=1]
 *     -> { update_available, latest_version, current_version, download_url, sha256, size, reason }
 *   GET /download/pi
 *     -> the newest screentinker-pi_<ver>_all.deb this instance holds (lib/deb-cache.js)
 *
 * An instance of routes/native-update.js — the rules (kill switches, otaBreaker, the shared download
 * guard, no beta channel) are documented there once for both native players.
 */

const debCache = require('../lib/deb-cache');
const { createNativeUpdateRoutes } = require('./native-update');

const mountPiUpdate = createNativeUpdateRoutes({
  kind: 'pi',
  cache: debCache,
  label: 'Raspberry Pi package (screentinker-pi_<version>_all.deb)',
  contentType: 'application/vnd.debian.binary-package',
  missingReason: 'deb-missing',
  hashingReason: 'deb-hashing',
  /*
   * ⚠️ The Pi's root helper (native/packaging/linux/st-helper install-deb) calls the check WITHOUT
   * device_id to learn the sha256 of the release it is about to install, exactly as the Windows
   * SYSTEM helper does. Before this, the helper trusted any .deb whose Package field said
   * "screentinker-pi" — a name the player user can put on any package, i.e. dashboard shell to root.
   */
  anonymousLookup: true,
});

module.exports = mountPiUpdate;
