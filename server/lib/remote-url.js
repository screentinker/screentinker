'use strict';

// URL gates for remote content, split by WHO opens the URL.
//
// validateRemoteUrl      — for URLs the SERVER may retrieve (YouTube oEmbed, web
//                          pages, remote images/video the proxy touches). Blocks
//                          RFC1918 / loopback / link-local / .local / .internal:
//                          an SSRF gate.
// validatePlayerOpenedUrl — for URLs only the PLAYER opens on its own LAN, never
//                          the server (video/hls live streams). Private hosts are
//                          REQUIRED here (hotel/venue IPTV is 10.x / .local), so
//                          this ALLOWS them. Still http/https only, and still
//                          rejects credentials-in-URL and every non-web scheme.
//
// The server never fetches an HLS stream (no proxy, no restream), so opening a
// private address carries no SSRF: the request leaves the SCREEN, on the same LAN
// the operator already trusts, not our backend.

// A live item is content with a live mime + a remote_url the PLAYER opens (no widget,
// no live_sources table). Two live transports: HLS over http(s) (cross-platform), and
// RTSP (Android/ExoPlayer only — browsers cannot open rtsp://; the deviceSocket strip
// keeps an rtsp item off any screen that does not declare playback.rtsp).
const LIVE_MIME = 'video/hls';      // kept as the canonical name; HLS is the portable transport
const RTSP_MIME = 'video/rtsp';
const LIVE_MIMES = [LIVE_MIME, RTSP_MIME];

function isLiveItem(item) {
  return !!(item && LIVE_MIMES.indexOf(item.mime_type) !== -1);
}

// Dwell lives on the PLAYLIST ITEM's duration_sec. 0 / null / absent = infinite
// dwell (stay on the channel until it is skipped). Used to keep a dwell-0 live
// item out of the clock scheduler, which would treat an infinite slot as broken.
function isInfiniteDwell(item) {
  const d = item && item.duration_sec;
  return d == null || Number(d) <= 0;
}

// The player fails a junk URL to a skip (P4), so this only checks SHAPE, never the
// network: a path or query that names an HLS playlist. No HEAD/GET — that would be
// both SSRF and a WAN pull of a live stream.
function looksLikeHlsUrl(url) {
  try {
    const u = new URL(url);
    const path = (u.pathname || '').toLowerCase();
    const q = (u.search || '').toLowerCase();
    return path.endsWith('.m3u8') || path.includes('.m3u8') || q.includes('.m3u8')
      || q.includes('m3u8') || /(^|[^a-z])hls([^a-z]|$)/.test(path);
  } catch { return false; }
}

// SSRF gate for a server-retrievable remote_url. Returns null if valid, else
// { status, error }. Unchanged from the original in-content.js definition.
function validateRemoteUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return { status: 400, error: 'Invalid URL format' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { status: 400, error: 'URL must use http or https' };
  }
  const hostname = parsed.hostname.toLowerCase();
  const isPrivate = hostname === 'localhost' || hostname === '0.0.0.0' ||
    hostname.startsWith('127.') || hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') || hostname.startsWith('169.254.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
    hostname.startsWith('fc') || hostname.startsWith('fd') || hostname === '::1' ||
    hostname.endsWith('.local') || hostname.endsWith('.internal');
  if (isPrivate) return { status: 400, error: 'Internal URLs are not allowed' };
  return null;
}

// Gate for an HLS URL only the player opens. http/https only (no file:/javascript:/
// ftp:/udp:/rtsp:), private hosts ALLOWED, credentials-in-URL rejected (they would
// travel in the published snapshot to every screen). Returns null if valid, else
// { status, error }.
function validatePlayerOpenedUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return { status: 400, error: 'Invalid URL format' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { status: 400, error: 'A live stream URL must use http or https' };
  }
  if (parsed.username || parsed.password) {
    return { status: 400, error: 'A live stream URL must not embed a username or password' };
  }
  return null;
}

function looksLikeRtspUrl(url) {
  return typeof url === 'string' && /^rtsp:\/\//i.test(url.trim());
}

// Gate for an RTSP URL only the player opens (Android/ExoPlayer). rtsp:// only. Unlike HLS,
// credentials in the URL are ALLOWED here: rtsp://user:pass@cam is the near-universal way IP
// cameras are addressed, and the server never fetches it — the screen opens it on its own LAN.
function validateRtspUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return { status: 400, error: 'Invalid URL format' }; }
  if (parsed.protocol !== 'rtsp:') {
    return { status: 400, error: 'A camera stream URL must use rtsp://' };
  }
  return null;
}

// Classify a "live stream" URL the operator typed into one Add flow: rtsp:// -> video/rtsp,
// an http(s) .m3u8 -> video/hls. Returns { mime } or { error: { status, error } }.
function classifyLiveUrl(url) {
  if (looksLikeRtspUrl(url)) {
    const e = validateRtspUrl(url);
    return e ? { error: e } : { mime: RTSP_MIME };
  }
  const e = validatePlayerOpenedUrl(url);
  if (e) return { error: e };
  if (!looksLikeHlsUrl(url)) {
    return { error: { status: 400, error: 'That does not look like a live stream. Use an .m3u8 (HLS) URL, or an rtsp:// camera URL.' } };
  }
  return { mime: LIVE_MIME };
}

module.exports = {
  LIVE_MIME, RTSP_MIME, LIVE_MIMES, isLiveItem, isInfiniteDwell,
  looksLikeHlsUrl, looksLikeRtspUrl,
  validateRemoteUrl, validatePlayerOpenedUrl, validateRtspUrl, classifyLiveUrl,
};
