'use strict';

// In-memory cache for the latest version discovered from GHCR. Restart = fresh poll.
// 36h interval means ~1 request per deploy cycle — no persistence needed.

let latestVersion = null;   // string | null — highest semver tag found
let checkedAt = null;       // number (epoch ms) | null — last poll timestamp
let inFlight = null;        // Promise | null — dedup concurrent polls

// Extract semver x.y.z tags from a tag list array, ignoring pre-release suffixes
// and non-semver labels. Returns tags sorted descending (latest first) by numeric
// component comparison so [0] is the highest version.
function extractSemverTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return [];

  // Must match the ENTIRE string — pre-release suffixes (-beta, -rc1) are excluded
  const semverRegex = /^(\d+)\.(\d+)\.(\d+)$/;
  const parsed = [];

  for (const tag of tags) {
    const m = tag.match(semverRegex);
    if (!m) continue;
    parsed.push({ tag, major: +m[1], minor: +m[2], patch: +m[3] });
  }

  parsed.sort((a, b) => {
    if (a.major !== b.major) return b.major - a.major;
    if (a.minor !== b.minor) return b.minor - a.minor;
    return b.patch - a.patch;
  });

  return parsed.map(p => p.tag);
}

// Compare two semver strings element-wise. Returns:
//   negative  → a < b
//   0         → a == b
//   positive  → a > b
//   NaN       → one or both inputs are not semver
function compareVersions(a, b) {
  // Match the ENTIRE string — pre-release suffixes rejected
  const ra = a.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const rb = b.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!ra || !rb) return NaN;

  for (let i = 1; i <= 3; i++) {
    const diff = +ra[i] - +rb[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

// Synchronous cache reader. Returns null before the first poll completes.
function getLatestVersion() {
  return latestVersion;
}

// Hard per-request cap. Node's global fetch has NO default timeout, so a hung GHCR
// connection would otherwise never settle — leaving `inFlight` set forever (the finally
// never runs) and wedging BOTH the background poller and any awaited checkNow (e.g.
// /api/admin/check-update). AbortController makes a stalled fetch reject so the outer
// try/catch/finally always fire and the cache keeps serving.
const FETCH_TIMEOUT_MS = 10000;
async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...(opts || {}), signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Force a fresh GHCR poll (bypasses cache), fetch tags, extract the highest
// semver, and update the cache. Returns { latest, update_available }.
async function checkNow(currentVersion) {
  // De-duplicate: if a poll is already in flight, wait for it instead of
  // starting a second concurrent fetch.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      // Step 1: get anonymous OAuth token for GHCR public repo access
      const tokenRes = await fetchWithTimeout(
        'https://ghcr.io/token?scope=repository:screentinker/screentinker:pull'
      );
      if (!tokenRes.ok) throw new Error(`GHCR token endpoint returned ${tokenRes.status}`);
      const { token } = await tokenRes.json();
      if (!token) throw new Error('GHCR token response missing token field');

      // Step 2: list tags with Bearer auth
      const tagsUrl = 'https://ghcr.io/v2/screentinker/screentinker/tags/list';
      const tagsRes = await fetchWithTimeout(tagsUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      // Some registries return 401/404 if no tags exist yet — not an error,
      // just means no releases published.
      if (tagsRes.status === 401 || tagsRes.status === 404) {
        latestVersion = null;
        checkedAt = Date.now();
        return { latest: null, update_available: false };
      }

      if (!tagsRes.ok) throw new Error(`GHCR tags endpoint returned ${tagsRes.status}`);

      const body = await tagsRes.json();

      // Handle both { tags: [...] } and { name, tags: [...] } response shapes
      const tags = body.tags || [];
      if (!Array.isArray(tags) || tags.length === 0) {
        latestVersion = null;
        checkedAt = Date.now();
        return { latest: null, update_available: false };
      }

      // Extract and sort semver tags
      const semverTags = extractSemverTags(tags);
      if (semverTags.length === 0) {
        latestVersion = null;
        checkedAt = Date.now();
        return { latest: null, update_available: false };
      }

      // The highest version is the first element (sorted descending)
      const latest = semverTags[0];
      latestVersion = latest;
      checkedAt = Date.now();

      const updateAvailable = currentVersion
        ? compareVersions(latest, currentVersion) > 0
        : false;

      return { latest, update_available: updateAvailable };
    } catch (err) {
      // Network errors, DNS failures, etc. — silent, cache stays as-is.
      // The next poll will retry; the existing cache (if any) still serves.
      console.error('[ghcr-check] poll failed:', err.message);
      return { latest: latestVersion, update_available: false };
    } finally {
      // Clear in-flight guard so next poll can run
      inFlight = null;
    }
  })();

  return inFlight;
}

// Start background polling at the given interval (in hours). First poll fires
// after a 30s initial delay to let the server stabilize.
function startPolling(intervalHours, currentVersion) {
  const intervalMs = intervalHours * 60 * 60 * 1000;

  // Initial poll after 30s
  setTimeout(() => {
    checkNow(currentVersion).catch(() => {});
  }, 30000);

  // Periodic poll
  setInterval(() => {
    checkNow(currentVersion).catch(() => {});
  }, intervalMs);
}

module.exports = {
  extractSemverTags,
  compareVersions,
  getLatestVersion,
  checkNow,
  startPolling,
};
