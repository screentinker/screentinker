// Which URLs a PLAYER may be asked to fetch — the device-side http_request guard.
//
// CONTRACT: shared/http-target-vectors.json. The server checks a URL when it is saved or sent; the
// Kotlin port checks it again at request time, against the same file. Both must agree, because a
// door stricter than its doorman is a feature that half-works and a doorman stricter than its door
// is a 400 nobody can explain.
//
// ⚠️ THIS IS NOT THE SERVER'S SSRF GUARD, AND IT IS ALMOST ITS INVERSE.
//
// routes/data-sources.js REFUSES private addresses, and is right to: a caller who makes the SERVER
// fetch a LAN address is reaching somewhere they could not otherwise reach. Here the private
// address IS the feature. The whole point of putting the request on the panel is that the panel is
// the thing standing on the shop network next to the PLC, the sensor, the local Home Assistant.
// Refusing RFC1918 here would delete the feature and leave the command pointless.
//
// ⚠️ SO WHAT IS THIS FOR. The request is operator-initiated by someone holding a 'full' token, who
// on a device-owner panel can already run `shell`. Reaching a LAN host is not an escalation for
// them — it is what they asked for. The escalation this stops is a change of KIND: turning "make an
// HTTP request and give me 64KiB of the answer" into "read a file off this device and give me 64KiB
// of it". On Android that is `file://` and, worse, `content://`, which reads through content
// providers — the mechanism by which one app's private data is exposed to another. The scheme
// allowlist is the whole defence and it is not negotiable.
//
// Secondary: cloud metadata. A player is normally a panel on a wall, but nothing stops one running
// on a cloud VM, and 169.254.169.254 hands IAM credentials to anything that asks. Blocking
// link-local costs nothing real — that range only appears when DHCP has FAILED, so no signage
// device is legitimately addressed there.
//
// ⚠️ A HOSTNAME THAT RESOLVES TO A BLOCKED ADDRESS is not visible here; this function sees only
// what was typed. The player re-checks every RESOLVED address before connecting (see DeviceHttp),
// which is where that case is caught. This module is the static half, and says so rather than
// implying it is airtight.
//
// Dependency-free UMD: Node (require) + browser (window.HttpTargetGuard) so the dashboard can grey
// out a bad URL before anyone saves it.

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HttpTargetGuard = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ALLOWED_SCHEMES = ['http:', 'https:'];

  // Hostnames that ARE the metadata service on one cloud or another. Checked as strings because
  // that is how they are typed; the resolved-address check on the player catches the rest.
  var METADATA_HOSTS = ['metadata.google.internal', 'metadata', 'instance-data'];

  // Exact IPv4 metadata addresses that are not inside a range we block wholesale.
  var METADATA_IPS = ['100.100.100.200'];

  function ipv4Parts(host) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return null;
    var p = [+m[1], +m[2], +m[3], +m[4]];
    for (var i = 0; i < 4; i++) if (p[i] > 255) return null;
    return p;
  }

  /**
   * Is this host a metadata / link-local address we refuse?
   *
   * Exported so the player's resolved-address re-check uses the SAME predicate as the static check,
   * rather than a second list that drifts.
   */
  function isBlockedAddress(host) {
    if (!host) return false;
    var h = String(host).toLowerCase().replace(/^\[|\]$/g, '');   // strip IPv6 brackets

    if (METADATA_HOSTS.indexOf(h) !== -1) return true;
    if (METADATA_IPS.indexOf(h) !== -1) return true;

    var p = ipv4Parts(h);
    if (p) {
      // 169.254.0.0/16 — link-local. Contains 169.254.169.254 (AWS/GCP/Azure/OpenStack) and only
      // ever appears on a real network when DHCP has failed.
      if (p[0] === 169 && p[1] === 254) return true;
      return false;
    }

    // IPv6. fe80::/10 is link-local; fd00:ec2::254 is AWS's IPv6 metadata address.
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
    if (h === 'fd00:ec2::254') return true;

    return false;
  }

  /**
   * May the player fetch this URL?
   *
   * @returns {{allow:true}|{allow:false, reason:'bad_scheme'|'metadata_address'|'no_host'|'malformed'}}
   */
  function check(url) {
    if (typeof url !== 'string' || url.trim() === '') return { allow: false, reason: 'malformed' };

    var u;
    try {
      u = new URL(url.trim());
    } catch (_) {
      // Includes a bare path and a scheme-relative "//host/x": refused rather than guessed at,
      // because guessing a scheme is how a file read gets in through the side door.
      return { allow: false, reason: 'malformed' };
    }

    if (ALLOWED_SCHEMES.indexOf(u.protocol.toLowerCase()) === -1) {
      return { allow: false, reason: 'bad_scheme' };
    }
    if (!u.hostname) return { allow: false, reason: 'no_host' };
    if (isBlockedAddress(u.hostname)) return { allow: false, reason: 'metadata_address' };

    return { allow: true };
  }

  /** A sentence an operator can act on, for a 400 or a dashboard hint. */
  function explain(reason) {
    switch (reason) {
      case 'bad_scheme': return 'only http:// and https:// can be fetched by a screen';
      case 'metadata_address': return 'that address is a cloud metadata endpoint and is refused';
      case 'no_host': return 'the URL has no host';
      default: return 'that is not a valid URL';
    }
  }

  return { check: check, explain: explain, isBlockedAddress: isBlockedAddress, ALLOWED_SCHEMES: ALLOWED_SCHEMES };
});
