"""Which URLs a PLAYER may be asked to fetch — the device-side http_request guard.

Python port of server/lib/http-target-guard.js + the resolved-address re-check from
android net/HttpTargetGuard.kt (resolveAndVet).

CONTRACT: shared/http-target-vectors.json. The server checks a URL when it is saved or sent; the
player checks it again at request time, against the same file. A door stricter than its doorman is
a feature that half-works; a doorman stricter than its door is a 400 nobody can explain.

⚠️ THIS IS NOT THE SERVER'S SSRF GUARD, AND IT IS ALMOST ITS INVERSE. The server's data-source
fetcher REFUSES private addresses. Here the private address IS the feature: the panel is the thing
standing on the shop network next to the PLC, the sensor, the local Home Assistant. Refusing
RFC1918 here would delete the feature.

⚠️ WHAT IT STOPS is a change of KIND: turning "make an HTTP request and give me 64KiB of the answer"
into "read a file off this device and give me 64KiB of it" (file://, and on Android content://).
The scheme allowlist is the whole defence and it is not negotiable.

Secondary: cloud metadata. 169.254.169.254 hands IAM credentials to anything that asks; link-local
only appears when DHCP has FAILED, so blocking it costs nothing real.

⚠️ A HOSTNAME THAT RESOLVES TO A BLOCKED ADDRESS is invisible to check(); it sees only what was
typed. resolve_and_vet() is the other half and MUST run immediately before connecting — and the
caller must then connect to the vetted address (pin it), or a rebinding DNS server can answer
differently between the check and the connect (TOCTOU).
"""
from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlsplit

ALLOWED_SCHEMES = ("http:", "https:")

# Hostnames that ARE the metadata service on one cloud or another. Checked as strings because that
# is how they are typed; the resolved-address check catches the rest.
METADATA_HOSTS = ("metadata.google.internal", "metadata", "instance-data")

# Exact IPv4 metadata addresses that are not inside a range we block wholesale.
METADATA_IPS = ("100.100.100.200",)

_IPV4_RE = re.compile(r"([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})")
_LINK_LOCAL_V6_RE = re.compile(r"fe[89ab][0-9a-f]:")
# RFC 3986 scheme. Anything else ("android_asset://", a bare path, "//host/x") is malformed:
# refused rather than guessed at, because guessing a scheme is how a file read gets in through
# the side door.
_SCHEME_RE = re.compile(r"([A-Za-z][A-Za-z0-9+.\-]*):")
# WHATWG URL strips leading/trailing C0 controls + space, and removes tab/CR/LF anywhere.
_C0_SPACE = "".join(chr(c) for c in range(0x21))
# WHATWG forbidden host code points (a host containing one fails to parse in JS -> malformed).
_FORBIDDEN_HOST = set(" #%/:<>?@[\\]^|\t\n\r\x00")


def _ipv4_parts(host):
    m = _IPV4_RE.fullmatch(host)
    if not m:
        return None
    p = [int(g) for g in m.groups()]
    if any(x > 255 for x in p):
        return None
    return p


def is_blocked_address(host) -> bool:
    """Is this host a metadata / link-local address we refuse?

    Shared with resolve_and_vet() so the resolved-address re-check uses the SAME predicate as the
    static check, rather than a second list that drifts.
    """
    if not host or not isinstance(host, str):
        return False
    h = host.lower()
    if h.startswith("["):  # strip IPv6 brackets
        h = h[1:]
    if h.endswith("]"):
        h = h[:-1]

    if h in METADATA_HOSTS or h in METADATA_IPS:
        return True

    p = _ipv4_parts(h)
    if p:
        # 169.254.0.0/16 — link-local. Contains 169.254.169.254 (AWS/GCP/Azure/OpenStack) and
        # only ever appears on a real network when DHCP has failed.
        return p[0] == 169 and p[1] == 254

    # IPv6. fe80::/10 is link-local; fd00:ec2::254 is AWS's IPv6 metadata address.
    if _LINK_LOCAL_V6_RE.match(h):
        return True
    if h == "fd00:ec2::254":
        return True
    return False


def _whatwg_ipv4(host):
    """WHATWG's IPv4 host parser: "2852039166", "0xa9.0xfe.0xa9.0xfe", "169.254.43518" all mean
    169.254.169.254 to the JS URL parser. Canonicalise the same way so the static check here is no
    weaker than the server's. Returns the dotted quad, or None if `host` is not an IPv4 form."""
    parts = host.split(".")
    if parts and parts[-1] == "":
        parts = parts[:-1]
    if not parts or len(parts) > 4:
        return None
    nums = []
    for p in parts:
        if p == "":
            return None
        try:
            if p[:2].lower() == "0x":
                n = int(p[2:], 16) if p[2:] else 0
            elif len(p) > 1 and p[0] == "0":
                n = int(p[1:], 8)
            else:
                if not p.isascii() or not p.isdigit():
                    return None
                n = int(p, 10)
        except ValueError:
            return None
        nums.append(n)
    if any(n > 255 for n in nums[:-1]) or nums[-1] >= 256 ** (5 - len(nums)):
        return None
    v = nums[-1]
    for i, n in enumerate(nums[:-1]):
        v += n * 256 ** (3 - i)
    return str(ipaddress.IPv4Address(v))


def normalize_url(url: str) -> str:
    """The URL as the WHATWG parser reads it, for the parts that change WHERE a request goes:
    surrounding C0/space stripped, tab/CR/LF removed, and — for http(s) — every backslash read as
    a slash. ⚠️ Fetch THIS string, not the raw one: `http://169.254.169.254\\@x/` is host
    169.254.169.254 to a browser but host `x` to urllib, and the check and the fetch must agree."""
    u = url.strip(_C0_SPACE).replace("\t", "").replace("\r", "").replace("\n", "")
    m = _SCHEME_RE.match(u)
    if m and (m.group(1).lower() + ":") in ALLOWED_SCHEMES:
        u = u.replace("\\", "/")
    return u


def check(url) -> dict:
    """May the player fetch this URL? Never raises.

    Returns {"allow": True} or {"allow": False, "reason": bad_scheme|metadata_address|no_host|malformed}.
    """
    if not isinstance(url, str) or url.strip() == "":
        return {"allow": False, "reason": "malformed"}
    try:
        u = normalize_url(url)
        m = _SCHEME_RE.match(u)
        if not m:
            return {"allow": False, "reason": "malformed"}
        scheme = m.group(1).lower() + ":"
        if scheme not in ALLOWED_SCHEMES:
            return {"allow": False, "reason": "bad_scheme"}
        parts = urlsplit(u)  # ValueError on e.g. an unterminated "[::"
        if not parts.netloc and not parts.path.lstrip("/"):
            # "http://" — WHATWG and java.net.URI both refuse to parse this at all.
            return {"allow": False, "reason": "malformed"}
        host = parts.hostname  # lowercased, brackets stripped
        if not host:
            # Defensive; deliberately NOT pinned by a vector (URL parsers genuinely differ on
            # "http:///x"). An empty host is refused wherever a parser reports one.
            return {"allow": False, "reason": "no_host"}
        if not host.startswith("[") and ":" not in host and any(c in _FORBIDDEN_HOST for c in host):
            return {"allow": False, "reason": "malformed"}
        parts.port  # raises ValueError on a non-numeric / out-of-range port, as URL() does
        canon = _whatwg_ipv4(host) or host
        if is_blocked_address(canon) or is_blocked_address(host):
            return {"allow": False, "reason": "metadata_address"}
        return {"allow": True}
    except Exception:
        return {"allow": False, "reason": "malformed"}


def explain(reason) -> str:
    """A sentence an operator can act on, for a 400 or a dashboard hint."""
    return {
        "bad_scheme": "only http:// and https:// can be fetched by a screen",
        "metadata_address": "that address is a cloud metadata endpoint and is refused",
        "no_host": "the URL has no host",
    }.get(reason, "that is not a valid URL")


def _unwrap(addr: str) -> str:
    # getaddrinfo can return "fe80::1%eth0" and IPv4-mapped "::ffff:169.254.169.254"; judge the
    # address itself (java.net.InetAddress hands the Kotlin side an Inet4Address for the latter).
    a = addr.split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(a)
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            return str(ip.ipv4_mapped)
        return str(ip)
    except ValueError:
        return a


def resolve_and_vet(host, port=None, resolver=None):
    """Re-check every address `host` actually RESOLVES to.

    ⚠️ The half check() cannot do: `http://my-innocent-name.test/` passes a string check and can
    still point at the metadata service. Call immediately before connecting, then connect to one
    of the RETURNED addresses (pin it) — otherwise a hostile DNS server can answer differently
    between this lookup and the connect (classic TOCTOU rebinding). Not airtight; does not claim
    to be.

    `resolver(host, port)` defaults to socket.getaddrinfo (injectable for tests).
    Returns the list of vetted address strings, or None when unresolvable / empty / any address is
    refused (unresolvable is refused, not "allowed by default").
    """
    if not host or not isinstance(host, str):
        return None
    resolve = resolver or (lambda h, p: socket.getaddrinfo(h, p, proto=socket.IPPROTO_TCP))
    try:
        infos = resolve(host.strip("[]"), port)
    except Exception:
        return None
    addrs = []
    for info in infos or []:
        raw = info[4][0] if isinstance(info, tuple) else info
        a = _unwrap(str(raw))
        if is_blocked_address(a):
            return None
        if a not in addrs:
            addrs.append(a)
    return addrs or None
