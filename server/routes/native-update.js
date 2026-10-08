'use strict';

/*
 * Native player self-update — one factory, mounted for the Pi and Windows (routes/pi-update.js,
 * routes/win-update.js), and download-only for macOS (routes/mac-update.js):
 *
 *   GET /api/<kind>/update/check?version=&device_id=[&forced=1]
 *     -> { update_available, latest_version, current_version, download_url, sha256, size, reason }
 *   GET /download/<kind>
 *     -> the newest package this instance holds (lib/package-cache.js instance)
 *
 * Both unauthenticated, exactly like /api/update/check and /download/apk: a player checks before
 * anyone may be signed in, and the bytes are the same public package the /download page offers.
 *
 * ⚠️ DELIBERATELY THE SAME RULES AS THE ANDROID CHECK, NOT A NEW SET. Every trap the APK path has
 * already paid for applies unchanged to a native player that updates itself on a timer:
 *   - the kill switches (config.otaEnabled, devices.ota_enabled = 0) are enforced HERE, server-side,
 *     so they cover every build that will ever exist, not only builds that remember to honour them;
 *   - otaBreaker.decide() — the phantom-version guard, the rate breaker and the #341 no-progress
 *     axis. A Pi whose dpkg refuses the package (or a PC whose installer fails) would otherwise
 *     download it every poll, forever;
 *   - the GLOBAL download admission guard (lib/ota-download-guard), shared with /download/apk on
 *     purpose: the thing it protects is this process's event loop and disk, and a Pi fleet, a Windows
 *     fleet and an Android fleet updating at once are one flood, not three.
 *
 * NOT here, by design: the beta channel. It exists for Android because a prerelease sorts below its
 * own release and a test build silently reverts; that needs a second artifact slot and a column
 * written from a GET (see replica-proxy WRITING_GETS). The native players have neither yet, so this
 * route writes nothing, and a tester on a prerelease is protected by the same superseded-prerelease /
 * client-newer answers that protect an Android tester who is not opted in.
 *
 * `anonymousLookup` (Windows only): see the comment at its branch below.
 */

const config = require('../config');
const otaBreaker = require('../lib/ota-breaker');
const otaDownloadGuard = require('../lib/ota-download-guard');
const logCoalescer = require('../lib/log-coalescer');

/**
 * @param {object} spec
 * @param {string} spec.kind              'pi' | 'win' — the path segment and the log tag
 * @param {object} spec.cache             a lib/package-cache.js instance
 * @param {string} spec.label             human name for the 404 body
 * @param {string} spec.contentType       served Content-Type
 * @param {string} spec.missingReason     reason when nothing is hosted ('deb-missing')
 * @param {string} spec.hashingReason     reason while the sha256 is being computed ('deb-hashing')
 * @param {boolean} [spec.anonymousLookup] a check WITHOUT device_id is a package lookup (see below)
 * @param {boolean} [spec.selfUpdate]     false = a player that never installs itself (macOS): only the
 *                                        download is mounted — no update check, and no rollback branch,
 *                                        so no OTA rollout row is ever created for a family that cannot
 *                                        take part in one
 */
function createNativeUpdateRoutes(spec) {
  const { kind, cache, label, contentType, missingReason, hashingReason, anonymousLookup = false, selfUpdate = true } = spec;
  const CHECK_URL = `/api/${kind}/update/check`;
  const DOWNLOAD_URL = `/download/${kind}`;
  const tag = `[ota/${kind}]`;

  function logCheck(latest, available, reason) {
    logCoalescer.record(`${kind}-ota-check:${reason}:${available}`, `${tag} update check: latest=${latest} update_available=${available} reason=${reason}`);
  }

  /**
   * @param {import('express').Express} app
   * @param {{ db?: object, getBand?: () => string }} [deps]  injectable for tests
   */
  function mount(app, deps = {}) {
    const getDb = () => deps.db || require('../db/database').db;
    const getBand = deps.getBand || (() => require('../services/loop-lag').getBand());

    if (selfUpdate) app.get(CHECK_URL, (req, res) => {
      const currentVersion = typeof req.query.version === 'string' ? req.query.version : '';
      const deviceId = typeof req.query.device_id === 'string' && req.query.device_id ? req.query.device_id : null;
      const forced = req.query.forced === '1' || req.query.forced === 'true';
      let pkg = cache.get();
      let latestVersion = pkg.version || null;
      let downloadUrl = DOWNLOAD_URL;
      const answer = (update_available, reason, extra = {}, withHash = update_available) => {
        logCheck(latestVersion, update_available, reason);
        res.setHeader('Cache-Control', 'no-store');
        return res.json(Object.assign({
          update_available, reason,
          latest_version: latestVersion, current_version: currentVersion || 'unknown',
          download_url: downloadUrl,
          sha256: withHash ? pkg.sha256 : null,
          size: withHash ? pkg.size : 0,
        }, extra));
      };

      // Kill switches first, before any breaker state is touched — same order as /api/update/check.
      // They apply to the anonymous lookup too: with OTA off globally, nothing gets a hash to verify
      // an install against, which is the point of the switch.
      if (!config.otaEnabled) return answer(false, 'ota_disabled_global');
      if (deviceId) {
        try {
          const row = getDb().prepare('SELECT ota_enabled FROM devices WHERE id = ?').get(deviceId);
          if (row && row.ota_enabled === 0) return answer(false, 'ota_disabled_device');
        } catch (_) { /* unknown device / pre-migration — treat as enabled, as the APK check does */ }
      }

      // Nothing hosted is a normal deployment, not an error. Answered BEFORE the breaker so a fleet
      // polling a server with no package cannot accumulate rate/no-progress state against a version
      // that does not exist.
      if (!pkg.exists || !latestVersion) return answer(false, missingReason);
      /*
       * Health-checked rollout (lib/ota-rollout.js). ⚠️ During a ROLLBACK the previous package IS the
       * release: it is what this check announces to everyone, including the install helper's own
       * anonymous sha256 lookup, or the helper would refuse the very package we offered.
       */
      const staged = pkg;
      const isUpgrade = (v) => !!v && (otaBreaker.cmp(v.replace(/~/g, '-'), staged.version) || 0) < 0;
      const g = require('../lib/ota-rollout').gate(kind, staged, { deviceId, currentVersion, forced });
      if (g.action === 'rollback') {
        pkg = g.release;
        latestVersion = g.release.version;
        downloadUrl = `${DOWNLOAD_URL}?version=${encodeURIComponent(g.release.version)}`;
        // A screen on the halted version is sent back now, past the breaker (it would call this a
        // downgrade and refuse it). Anything else is compared with the rollback release as usual.
        const cur = (currentVersion || '').replace(/~/g, '-');
        if (deviceId && cur && cur === staged.version) return answer(true, 'rollback');
      } else if ((g.action === 'wait' || g.action === 'halted') && deviceId && isUpgrade(currentVersion)) {
        return answer(false, g.reason, { retry_after_seconds: 1800 });
      }

      /*
       * ANONYMOUS PACKAGE LOOKUP (Windows). The Windows player is split in two: the player runs as the
       * signed-in user and never installs anything itself; the ScreenTinkerHelper service (SYSTEM)
       * does. Before running an installer the helper asks THIS endpoint — on the server the ADMIN
       * configured, never one the user-level player names — what the sha256 of the current package
       * is, and refuses any file that does not match. The helper holds no device token and is not the
       * thing that polls for updates, so it calls with ?version= only.
       *
       * So a check without device_id is answered as a lookup, not as an update poll:
       *   - the sha256 and size of the hosted package are ALWAYS returned (once hashed) — they describe
       *     a public file anyone can download and hash, so there is nothing to withhold, and a helper
       *     verifying the very version it is about to install must not be told "up-to-date, no hash";
       *   - update_available is a plain version comparison;
       *   - otaBreaker.decide() is NOT consulted. Its rate state for a device-less call keys on the
       *     VERSION ('v:<version>'), so helper lookups would share — and could trip — one bucket with
       *     every other device-less caller on that version, and a tripped breaker would withhold the
       *     hash the helper needs to finish an install the player already downloaded. The breaker's
       *     job (stopping a device from re-downloading forever) belongs to the player's own poll,
       *     which always sends device_id and still goes through it below.
       * The download itself is still admitted by the global download guard like any other.
       * The Pi route does not enable this: the Pi player installs its own .deb through a root helper
       * it runs itself, and a device-less Pi check keeps the breaker's version-keyed behaviour.
       */
      if (anonymousLookup && !deviceId) {
        if (!pkg.sha256) return answer(false, hashingReason, { retry_after_seconds: 30 });
        let newer = false;
        // `~` normalised as the package cache does, so a helper quoting a filename version compares right.
        if (currentVersion) newer = (otaBreaker.cmp(currentVersion.replace(/~/g, '-'), latestVersion) || 0) < 0;
        return answer(newer, 'package-lookup', {}, true);
      }

      const verdict = otaBreaker.decide(currentVersion || null, latestVersion, deviceId, Date.now(), false, false, forced);
      if (verdict.log) console.log(verdict.log.replace('[ota]', tag));
      if (!verdict.update_available) {
        return answer(false, verdict.reason,
          verdict.retry_after_seconds ? { retry_after_seconds: verdict.retry_after_seconds } : {});
      }
      // ⚠️ No hash yet = no offer. See lib/package-cache.js: the device verifies before installing, so
      // an offer without a checksum is a guaranteed reject-and-retry.
      if (!pkg.sha256) return answer(false, hashingReason, { retry_after_seconds: 30 });
      return answer(true, verdict.reason);
    });

    app.get(DOWNLOAD_URL, (req, res) => {
      let pkg = cache.get();
      // ?version=<previous> during a rollback: the archived previous package (lib/ota-rollout.js).
      if (req.query.version && pkg.exists && String(req.query.version) !== pkg.version) {
        if (!selfUpdate) return res.status(404).type('text/plain').send(`That ${label} version is not offered.`);
        const g = require('../lib/ota-rollout').gate(kind, pkg, {});
        if (g.action === 'rollback' && g.release.version === String(req.query.version)) pkg = g.release;
        else return res.status(404).type('text/plain').send(`That ${label} version is not offered.`);
      }
      if (!pkg.exists) {
        return res.status(404).type('text/plain').send(`No ${label} is hosted on this instance.`);
      }
      const verdict = otaDownloadGuard.admit(otaDownloadGuard.prodState(), getBand());
      if (!verdict.allow) {
        res.setHeader('Retry-After', String(verdict.retryAfter));
        return res.status(verdict.status).json({ error: 'download capacity reached, retry shortly', retry_after: verdict.retryAfter });
      }
      let released = false;
      const release = () => { if (released) return; released = true; otaDownloadGuard.release(otaDownloadGuard.prodState()); };
      res.on('finish', release); res.on('close', release);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${pkg.filename}"`);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Package-Version', pkg.version);
      if (pkg.sha256) res.setHeader('X-Package-Sha256', pkg.sha256);
      res.sendFile(pkg.path, (err) => { if (err) release(); });
    });
  }

  mount.DOWNLOAD_URL = DOWNLOAD_URL;
  mount.CHECK_URL = selfUpdate ? CHECK_URL : null;
  return mount;
}

module.exports = { createNativeUpdateRoutes };
