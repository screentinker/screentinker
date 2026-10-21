/*
 * Is this host one that a phone outside the building cannot reach?
 *
 * A QR code holds whatever address the dashboard was opened at, so a code made while the dashboard
 * was open at localhost, a LAN address or a .local name scans to nothing on a visitor's phone.
 * The QR codes page and the slide editor both warn about it, and both ask here, so the two can
 * never disagree about what counts as private.
 *
 * Covers: localhost (and *.localhost), *.local (mDNS), IPv4 loopback / RFC 1918 / link-local /
 * 0.0.0.0, and IPv6 loopback, unique-local (fc00::/7), link-local (fe80::/10) and IPv4-mapped
 * forms of the private IPv4 ranges. Accepts a bare hostname or a bracketed IPv6 literal as
 * location.hostname and URL.hostname give it.
 */
const PRIVATE_V4 = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0$)/;

export function isPrivateHost(hostname) {
  let h = String(hostname || '').trim().toLowerCase();
  if (!h) return false;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (PRIVATE_V4.test(h)) return true;
  if (!h.includes(':')) return false;
  // IPv6 literal.
  if (h === '::1' || h === '::') return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true;           // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;            // fe80::/10 link-local
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);   // ::ffff:192.168.1.5
  if (mapped) return PRIVATE_V4.test(mapped[1]);
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/); // URL() writes it as ::ffff:c0a8:105
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16); const lo = parseInt(mappedHex[2], 16);
    return PRIVATE_V4.test(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

/* The host of a URL-shaped string, or '' when it is not a URL (a phone number, plain text). */
export function urlHost(text) {
  try { return new URL(String(text || '').trim()).hostname; } catch { return ''; }
}
