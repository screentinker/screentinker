'use strict';

/*
 * Builds and serves the BrightSign player package (autorun.zip) for self-update.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD: the checksum in the manifest and the bytes on the
 * download route come from the SAME in-memory buffer, built once. Advertising a version whose
 * checksum does not match the bytes actually served is the classic OTA-loop condition — the player
 * downloads, fails verification, retries, forever — and it is the easiest mistake to make when the
 * manifest is computed from one source and the file from another (a file on disk that a deploy
 * replaced, say). Here it is impossible by construction: there is one buffer and both routes read
 * it.
 *
 * The zip is built deterministically from brightsign/, not read from a prebuilt artifact, because a
 * prebuilt autorun.zip is a CI output that is not present in a git-checkout deployment. Building it
 * means the manifest is always available and always describes files that actually exist.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

// The payload, mirroring scripts/build-autorun-zip.sh. autozip.brs must be present or nothing
// unpacks the archive on the player; autorun.brs must be INSIDE it and never beside it on the
// storage root, or the player refuses to process the zip at all.
const PACKAGE_FILES = ['autozip.brs', 'autorun.brs', 'offline.html', 'screentinker.json'];

// sha256 rather than sha1 because that is the algorithm BrightScript's roMessageDigest is
// documented against — the player has to be able to verify what we advertise, and an algorithm it
// cannot compute is an unverifiable package, which this whole design exists to refuse.
// Keyed by the server URL stamped into the package, because that URL changes the BYTES and
// therefore the checksum. The invariant at the top of this file is per-key: a player asking the
// manifest route and the download route hits the same key both times (both derive the URL the same
// way from the same request), so it still sees one buffer and one checksum. Bounded, because the
// key is derived from a request header — an unbounded map keyed on attacker-controlled input,
// holding a ~73KB buffer per entry, is a memory-growth primitive.
const MAX_CACHED_PACKAGES = 8;
const cache = new Map();   // serverUrl|'' -> { version, sha256, size, buffer }

/*
 * The URL to stamp, from the request that asked for the package.
 *
 * A zip fetched from alpha should point at alpha; one fetched from prod, at prod. Getting this
 * wrong is silent and expensive: the player provisions, registers against the WRONG instance, and
 * looks like a pairing bug rather than a packaging one.
 *
 * APP_URL wins where it is set, matching how every other self-referential URL in this codebase is
 * built (routes/org-sso.js, routes/auth.js, server.js). The Host fallback is what makes a
 * self-hosted deployment work with no configuration at all — the point of the feature — and it is
 * sanitised and length-capped before it can reach a config file on a player, the same treatment
 * routes/auth.js gives it.
 */
function packageServerUrl(req) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (!req) return null;
  const host = String(req.get ? req.get('host') || '' : '').trim();
  // VALIDATE, do not scrub. Stripping disallowed characters turns `a.example"; rm -rf /` into
  // `a.examplermrf` — harmless, but it ships a plausible-looking host that resolves nowhere and
  // sends the next person hunting a DNS problem. Anything that is not a clean hostname[:port]
  // yields null, and null means "ship the committed default", which is always a working answer.
  if (host.length > 100 || !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return null;
  const proto = req.protocol === 'http' ? 'http' : 'https';
  return `${proto}://${host}`;
}

/*
 * Rewrite server_url in screentinker.json.
 *
 * Parsed and re-serialised rather than string-replaced so a malformed URL cannot inject structure
 * into the config the player reads. Returns the ORIGINAL text on any failure: shipping the
 * committed default is a recoverable mistake, shipping a corrupt config is not — autorun.brs reads
 * this file at boot and a parse failure there is a player that never starts.
 */
function stampServerUrl(source, serverUrl) {
  try {
    const cfg = JSON.parse(source);
    cfg.server_url = serverUrl;
    return JSON.stringify(cfg, null, 2) + '\n';
  } catch (e) {
    return source;
  }
}

function brightsignDir() {
  return path.join(__dirname, '..', '..', 'brightsign');
}

function readVersion() {
  try {
    return fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim();
  } catch (e) {
    return null;
  }
}

/*
 * Rewrite the stamped version line in autorun.brs.
 *
 * Anchored on the ST_PACKAGE_VERSION marker rather than on the literal, so a hand-edited default
 * cannot cause a silent miss. If the marker is ever removed the stamp is skipped and the package
 * ships reporting "0.0.0-dev", which reads as permanently out of date — noisy, but noisy in the
 * direction of "someone look at this" rather than a silent update loop.
 */
function stampVersion(source, version) {
  return source.replace(
    /return "[^"]*"(\s*'\s*ST_PACKAGE_VERSION)/,
    `return "${version}"$1`
  );
}

/*
 * Build the archive in memory. Entries are added in a fixed order with a fixed timestamp so the
 * bytes are reproducible: a checksum that changed on every server restart would make every player
 * re-download the same package after every deploy.
 *
 * Reproducibility is per serverUrl — same URL in, same bytes out. A player only ever sees one URL
 * (its own), so from its point of view nothing changed.
 */
function buildZip(serverUrl) {
  return new Promise((resolve, reject) => {
    const dir = brightsignDir();
    const chunks = [];
    // STORED, no compression — not a size/speed choice. A player could not open our first
    // deflated archive: BrightSign's automated deployment copied it across and then reported it
    // invalid. The bootstrap extracts autozip.brs before any script runs, and roBrightPackage
    // supports a specific set of methods, of which "no compression" is the universally safe one.
    // A compressed package deploys perfectly and then fails to open, which reads as a broken
    // deployment rather than a broken zip.
    const archive = archiver('zip', { store: true });

    archive.on('data', (c) => chunks.push(c));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));

    const version = readVersion();
    for (const name of PACKAGE_FILES) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) return reject(new Error(`package file missing: ${name}`));
      let body = fs.readFileSync(p);
      // Stamp the version into the host so the script REPORTS the version it actually is. Ship it
      // unstamped and the player applies the update, still reports the old version, and is offered
      // the same package forever — the OTA loop, arriving by the back door.
      if (name === 'autorun.brs') body = Buffer.from(stampVersion(body.toString('utf8'), version), 'utf8');
      // Point the package at the server it was fetched FROM, so a zip pulled from alpha provisions
      // against alpha. scripts/build-autorun-zip.sh --server does the same thing for the offline
      // path (an SD card written with no server in the loop); this covers the online one.
      if (name === 'screentinker.json' && serverUrl) {
        body = Buffer.from(stampServerUrl(body.toString('utf8'), serverUrl), 'utf8');
      }
      // date fixed for reproducibility; the player never reads it.
      archive.append(body, { name, date: new Date(0) });
    }
    archive.finalize();
  });
}

/*
 * Get the package, building once and caching. Returns null when the package cannot be built (a
 * deployment without the brightsign/ directory, for instance) — callers must treat that as "no
 * manifest", which the update decision reads as "keep running", never as "wipe yourself".
 */
async function getPackage(serverUrl) {
  const key = serverUrl || '';
  const hit = cache.get(key);
  if (hit) return hit;
  const version = readVersion();
  if (!version) return null;
  try {
    const buffer = await buildZip(serverUrl || null);
    const built = {
      version,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      size: buffer.length,
      buffer
    };
    // Evict oldest-first. Map preserves insertion order, and the realistic working set is one or
    // two hostnames — the bound exists for the pathological case, not the normal one.
    if (cache.size >= MAX_CACHED_PACKAGES) cache.delete(cache.keys().next().value);
    cache.set(key, built);
    return built;
  } catch (e) {
    return null;
  }
}

/* Test seam: drop the cache so a changed file is picked up without a restart. */
function _reset() { cache.clear(); }

module.exports = { getPackage, packageServerUrl, _reset, PACKAGE_FILES };
