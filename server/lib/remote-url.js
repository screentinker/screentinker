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
/*
 * A third "transport": the player's own HDMI INPUT (a cable box, a console, another signage player
 * plugged into a Fire TV Cube or an Android TV box with HDMI in). remote_url is `hdmi://<port>`, or
 * plain `hdmi://` for the first input; it names a socket on the back of the screen, not a host, so
 * there is nothing to fetch and nothing to validate beyond the shape. Android only, and only where
 * the player found an HDMI passthrough input at runtime (playback.hdmi_in) — the deviceSocket strip
 * keeps it off every other screen. Live like HLS/RTSP: duration is dwell, 0 = stay.
 *
 * ⚠️ NEVER CAPTURABLE. The picture is a hardware video plane: screenshots and the dashboard's live
 * view see black (or the OS refuses the capture outright). Verified on a Fire TV Cube 3rd gen.
 */
const HDMI_IN_MIME = 'video/hdmi-in';
const LIVE_MIMES = [LIVE_MIME, RTSP_MIME, HDMI_IN_MIME];

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

// rtsp:// or rtsps:// (RTSP over TLS, e.g. UniFi Protect's default share link). Both are video/rtsp;
// the scheme is what tells a player to open a TLS socket, and isRtspsUrl() what keeps an rtsps item
// off a player that only declares playback.rtsp (deviceSocket).
function looksLikeRtspUrl(url) {
  return typeof url === 'string' && /^rtsps?:\/\//i.test(url.trim());
}
function isRtspsUrl(url) {
  return typeof url === 'string' && /^rtsps:\/\//i.test(url.trim());
}

// Gate for an RTSP URL only the player opens. rtsp:// or rtsps://. Unlike HLS, credentials in the
// URL are ALLOWED here: rtsp://user:pass@cam is the near-universal way IP cameras are addressed, and
// the server never fetches it — the screen opens it on its own LAN. They are never shown back to
// anyone but the screen itself (maskStreamCredentials, middleware/mask-stream-credentials.js).
function validateRtspUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return { status: 400, error: 'Invalid URL format' }; }
  if (parsed.protocol !== 'rtsp:' && parsed.protocol !== 'rtsps:') {
    return { status: 400, error: 'A camera stream URL must use rtsp:// or rtsps://' };
  }
  if (parsed.password === CREDENTIAL_MASK || decodeURIComponent(parsed.password || '') === CREDENTIAL_MASK) {
    return { status: 400, error: 'Type the camera password: the stars only stand in for a saved one.' };
  }
  if (parsed.pathname.split('/').includes(CREDENTIAL_MASK)) {
    return { status: 400, error: 'Paste the full camera link: the stars only stand in for a saved stream token.' };
  }
  return null;
}

/*
 * ⚠️ CAMERA SECRETS ARE WRITE-ONLY. An rtsp(s) URL may carry the camera's username and password, or
 * (UniFi Protect, and other NVRs that share links) a random token in the PATH that alone opens the
 * stream: rtsps://nvr:7441/Ab12Cd34Ef56Gh78. The content library is readable by every workspace
 * member, API token, MCP client, the Manager app and (through the item's payload) anyone holding a
 * /view link. Only the screen that opens the stream needs the secret, so every other response
 * replaces it with CREDENTIAL_MASK; the username and the rest of the path stay visible so people can
 * tell which camera an item is.
 *
 * An edit that sends the masked URL back keeps the stored secret (restoreMaskedSecrets), but only for
 * the same camera: changing the scheme, host or port with the mask in place is refused, or an editor
 * could point the stream at a host of their own and receive the real secret from the screen.
 */
const CREDENTIAL_MASK = '********';
/*
 * Both run on ONE string value (the middleware walks the response, and parses JSON that was itself
 * put into a string, as MCP tool results are), never on serialized JSON: a URL is stored as typed, so
 * its password can hold a quote, a space or an '@', which JSON escaping would split from the match.
 * The password runs to the LAST '@' before the path, as URL parsing does (rtsp://u:p@ss@cam has the
 * password "p@ss").
 */
const RTSP_USERINFO_RE = /(rtsps?:\/\/[^\/?#@:\r\n]*):([^\/?#\r\n]*)@/gi;
const RTSP_PATH_RE = /(rtsps?:\/\/[^\/?#\s]*)(\/[^?#\s"'<>]*)/gi;

// A path segment that is a share token rather than a name: 16+ letters and digits in mixed case
// (UniFi's are 16). Camera paths people type (Streaming/Channels/101, h264Preview_01_main,
// cam/realmonitor) are short, lowercase or carry punctuation.
function isSecretPathSegment(seg) {
  return typeof seg === 'string' && seg.length >= 16 && /^[A-Za-z0-9]+$/.test(seg) && /[a-z]/.test(seg) && /[A-Z]/.test(seg);
}

function maskStreamCredentials(text) {
  if (typeof text !== 'string' || !/rtsps?:\/\//i.test(text)) return text;
  return text
    .replace(RTSP_USERINFO_RE, (m, head, pass) => (pass ? `${head}:${CREDENTIAL_MASK}@` : m))
    .replace(RTSP_PATH_RE, (m, head, p) => head + p.split('/').map((seg) => (isSecretPathSegment(seg) ? CREDENTIAL_MASK : seg)).join('/'));
}

/**
 * An edit's new URL, with a masked password or path token swapped back for the stored one. Returns
 * { url } or { error: { status, error } }. A URL without the mask is returned as typed.
 */
function restoreMaskedSecrets(newUrl, storedUrl) {
  if (typeof newUrl !== 'string' || !newUrl.includes(CREDENTIAL_MASK)) return { url: newUrl };
  let next, prev;
  try { next = new URL(newUrl.trim()); } catch { return { url: newUrl }; }
  const passMasked = decodeURIComponent(next.password || '') === CREDENTIAL_MASK;
  const segs = next.pathname.split('/');
  const pathMasked = segs.includes(CREDENTIAL_MASK);
  if (!passMasked && !pathMasked) return { url: newUrl };
  const refuse = { error: { status: 400, error: 'Type the camera password or paste the full camera link again: a saved one stays only while the camera address is unchanged.' } };
  try { prev = storedUrl ? new URL(String(storedUrl).trim()) : null; } catch { prev = null; }
  const same = prev && prev.protocol === next.protocol && prev.hostname === next.hostname
    && (prev.port || '') === (next.port || '');
  if (!same) return refuse;
  if (passMasked) {
    if (!prev.password) return refuse;
    next.password = prev.password;
  }
  if (pathMasked) {
    const old = prev.pathname.split('/');
    if (old.length !== segs.length) return refuse;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i] !== CREDENTIAL_MASK) continue;
      if (!isSecretPathSegment(old[i])) return refuse;
      segs[i] = old[i];
    }
    next.pathname = segs.join('/');
  }
  return { url: next.toString() };
}

// hdmi:// or hdmi://<port 1-99>. Nothing else: no host, no path, no query.
function looksLikeHdmiInUrl(url) {
  return typeof url === 'string' && /^hdmi:\/\/([1-9][0-9]?)?$/i.test(url.trim());
}

function validateHdmiInUrl(url) {
  if (!looksLikeHdmiInUrl(url)) {
    return { status: 400, error: 'A live input is hdmi:// (the first HDMI input) or hdmi://<port>, e.g. hdmi://1.' };
  }
  return null;
}

// Classify a "live stream" URL the operator typed into one Add flow: rtsp:// -> video/rtsp,
// hdmi://<port> -> video/hdmi-in, an http(s) .m3u8 -> video/hls. Returns { mime } or
// { error: { status, error } }.
function classifyLiveUrl(url) {
  if (typeof url === 'string' && /^hdmi:/i.test(url.trim())) {
    const e = validateHdmiInUrl(url);
    return e ? { error: e } : { mime: HDMI_IN_MIME };
  }
  if (looksLikeRtspUrl(url)) {
    const e = validateRtspUrl(url);
    return e ? { error: e } : { mime: RTSP_MIME };
  }
  const e = validatePlayerOpenedUrl(url);
  if (e) return { error: e };
  if (!looksLikeHlsUrl(url)) {
    return { error: { status: 400, error: 'That does not look like a live stream. Use an .m3u8 (HLS) URL, or an rtsp:// or rtsps:// camera URL.' } };
  }
  return { mime: LIVE_MIME };
}

module.exports = {
  LIVE_MIME, RTSP_MIME, HDMI_IN_MIME, LIVE_MIMES, isLiveItem, isInfiniteDwell,
  looksLikeHlsUrl, looksLikeRtspUrl, isRtspsUrl, looksLikeHdmiInUrl,
  CREDENTIAL_MASK, maskStreamCredentials, restoreMaskedSecrets, isSecretPathSegment,
  validateRemoteUrl, validatePlayerOpenedUrl, validateRtspUrl, validateHdmiInUrl, classifyLiveUrl,
};
