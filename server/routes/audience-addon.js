'use strict';

/*
 * The audience-counting add-on for the native players (lib/audience-addon.js), for their installers:
 *
 *   GET /api/audience-addon/:platform
 *     -> { available, platform, version, sha256, size, download_url }
 *   GET /api/audience-addon/:platform/sha256
 *     -> the sha256 as plain text (the Windows installer verifies its download against it; Inno
 *        Setup has no JSON parser)
 *   GET /download/audience-addon/:platform
 *     -> the zip
 *
 * Unauthenticated, like /download/pi: an installer runs before anyone signs in, and the bytes are a
 * public build. The hash is withheld until it is computed (available=false, reason 'hashing') — an
 * installer that cannot verify does not install.
 *
 * The download goes through the GLOBAL download guard shared with the player packages
 * (lib/ota-download-guard): it is the same 50 MB-class file on the same event loop and disk.
 */

const addon = require('../lib/audience-addon');
const otaDownloadGuard = require('../lib/ota-download-guard');

module.exports = function mountAudienceAddon(app, deps = {}) {
  const getBand = deps.getBand || (() => require('../services/loop-lag').getBand());

  function lookup(req, res) {
    const cache = addon.forPlatform(req.params.platform);
    if (!cache) {
      res.status(404).json({ available: false, reason: 'unknown-platform', platforms: addon.PLATFORMS });
      return null;
    }
    return cache.get();
  }

  app.get('/api/audience-addon/:platform', (req, res) => {
    const pkg = lookup(req, res);
    if (!pkg) return;
    res.setHeader('Cache-Control', 'no-store');
    const platform = req.params.platform;
    if (!pkg.exists) return res.json({ available: false, reason: 'not-hosted', platform });
    if (!pkg.sha256) return res.json({ available: false, reason: 'hashing', platform, retry_after_seconds: 30 });
    res.json({
      available: true, platform, version: pkg.version, sha256: pkg.sha256, size: pkg.size,
      download_url: `/download/audience-addon/${platform}`,
    });
  });

  app.get('/api/audience-addon/:platform/sha256', (req, res) => {
    const pkg = lookup(req, res);
    if (!pkg) return;
    res.setHeader('Cache-Control', 'no-store');
    if (!pkg.exists || !pkg.sha256) return res.status(404).type('text/plain').send('');
    res.type('text/plain').send(pkg.sha256);
  });

  app.get('/download/audience-addon/:platform', (req, res) => {
    const pkg = lookup(req, res);
    if (!pkg) return;
    if (!pkg.exists) return res.status(404).type('text/plain').send('The audience-counting add-on is not hosted on this instance.');
    const verdict = otaDownloadGuard.admit(otaDownloadGuard.prodState(), getBand());
    if (!verdict.allow) {
      res.setHeader('Retry-After', String(verdict.retryAfter));
      return res.status(verdict.status).json({ error: 'download capacity reached, retry shortly', retry_after: verdict.retryAfter });
    }
    let released = false;
    const release = () => { if (released) return; released = true; otaDownloadGuard.release(otaDownloadGuard.prodState()); };
    res.on('finish', release); res.on('close', release);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${pkg.filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Package-Version', pkg.version);
    if (pkg.sha256) res.setHeader('X-Package-Sha256', pkg.sha256);
    res.sendFile(pkg.path, (err) => { if (err) release(); });
  });
};
