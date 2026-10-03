'use strict';

/*
 * Native Windows player — self-update.
 *
 *   GET /api/win/update/check?version=[&device_id=][&forced=1]
 *     -> { update_available, latest_version, current_version, download_url, sha256, size, reason }
 *   GET /download/win
 *     -> the newest ScreenTinker-Setup-<ver>.exe this instance holds (lib/win-cache.js)
 *
 * An instance of routes/native-update.js — the rules (kill switches, otaBreaker, the shared download
 * guard, no beta channel) are documented there once for both native players.
 *
 * ⚠️ anonymousLookup: the ScreenTinkerHelper service (SYSTEM) calls the check WITHOUT device_id to
 * learn the sha256 it must verify an installer against before running it. That call is answered as a
 * package lookup and never touches the breaker — see the branch in native-update.js and
 * docs/windows-native-player.md ("Trust model").
 */

const winCache = require('../lib/win-cache');
const { createNativeUpdateRoutes } = require('./native-update');

const mountWinUpdate = createNativeUpdateRoutes({
  kind: 'win',
  cache: winCache,
  label: 'Windows installer (ScreenTinker-Setup-<version>.exe)',
  // Not application/x-msdownload: some proxies and AV gateways strip or quarantine that type
  // outright. The helper hashes the bytes it gets; the name comes from Content-Disposition.
  contentType: 'application/octet-stream',
  missingReason: 'exe-missing',
  hashingReason: 'exe-hashing',
  anonymousLookup: true,
});

module.exports = mountWinUpdate;
