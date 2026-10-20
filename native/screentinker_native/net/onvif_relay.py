"""onvif_relay: the panel as a narrow ONVIF bridge for cameras on ITS OWN network.

The hosted server cannot reach a customer's LAN, the screen can. The server keeps ALL the ONVIF logic
(server/lib/onvif/soap.js, camera.js); it sends `device:command {type:'onvif_relay', payload}` and
waits for `device:onvif-result` (server/lib/onvif/relay.js). This side does exactly three things and
returns the bytes:

  probe  send the fixed WS-Discovery Probe (multicast, or one host's :3702) and collect replies;
  soap   POST a SOAP envelope to a private-network http(s) address;
  get    GET a snapshot image from a private-network http(s) address.

The limits are enforced HERE, independently of the server, so a server can never use a screen as a
general web proxy: http/https only, every resolved address private (RFC 1918, link-local, CGNAT,
ULA — never loopback, never public), the connection pinned to the vetted address (no second DNS
lookup), no redirects, size caps, timeouts, and at most MAX_IN_FLIGHT operations at once.

Stdlib only (http.client, socket, ssl); the blocking I/O runs in the loop's executor.
"""

import asyncio
import base64
import http.client
import ipaddress
import logging
import socket
import ssl
import time
import urllib.parse
import uuid

log = logging.getLogger("onvif")

MAX_SOAP_BODY = 64 * 1024          # the envelope the server asks us to POST
MAX_SOAP_REPLY = 1024 * 1024       # a SOAP reply (server relay.js MAX_TEXT)
MAX_IMAGE = 2 * 1024 * 1024        # a snapshot (server transport.js MAX_SNAPSHOT_BYTES)
MAX_PROBE_REPLIES = 64
MAX_DATAGRAM = 64 * 1024
MAX_IN_FLIGHT = 4

DEFAULT_HTTP_TIMEOUT_MS = 8000
MAX_HTTP_TIMEOUT_MS = 15000
DEFAULT_PROBE_TIMEOUT_MS = 3000
MAX_PROBE_TIMEOUT_MS = 10000
MIN_TIMEOUT_MS = 500

DISCOVERY_ADDR = "239.255.255.250"
DISCOVERY_PORT = 3702

# Request headers passed through to the camera; everything else in payload.headers is dropped.
PASS_HEADERS = ("content-type", "authorization")

# Where a camera may live. Loopback, 0.0.0.0, multicast and every public address are NOT here.
PRIVATE_NETS = tuple(ipaddress.ip_network(n) for n in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10",
    "fc00::/7", "fe80::/10",
))

_METADATA = ipaddress.ip_address("169.254.169.254")

# server/lib/onvif/soap.js NS — probe_message() is a byte-for-byte copy of probeMessage().
_NS_SOAP = "http://www.w3.org/2003/05/soap-envelope"
_NS_WSA = "http://schemas.xmlsoap.org/ws/2004/08/addressing"
_NS_WSD = "http://schemas.xmlsoap.org/ws/2005/04/discovery"
_NS_DN = "http://www.onvif.org/ver10/network/wsdl"


class RelayError(Exception):
    """A short, server-facing reason (the reply's `error`)."""


def _xml_escape(v):
    return "".join({"<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;"}.get(c, c) for c in str(v))


def probe_message(message_id=None):
    message_id = message_id or "uuid:%s" % uuid.uuid4()
    return ('<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="%s" xmlns:a="%s">' % (_NS_SOAP, _NS_WSA)
            + '<s:Header><a:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>'
            + "<a:MessageID>%s</a:MessageID>" % _xml_escape(message_id)
            + "<a:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>"
            + '<a:To s:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To></s:Header>'
            + '<s:Body><Probe xmlns="%s"><Types xmlns:dn="%s">dn:NetworkVideoTransmitter</Types></Probe></s:Body></s:Envelope>'
            % (_NS_WSD, _NS_DN))


def is_private_address(addr):
    """True only for an address inside PRIVATE_NETS. An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is
    judged as the IPv4 address it carries, so ::ffff:127.0.0.1 is loopback, not 'some IPv6'."""
    try:
        ip = ipaddress.ip_address(str(addr).split("%", 1)[0])   # drop an IPv6 zone id (fe80::1%eth0)
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if ip.is_loopback or ip.is_unspecified or ip.is_multicast:
        return False
    # Link-local is allowed (cameras with no DHCP use it), but never the cloud metadata address.
    if ip == _METADATA:
        return False
    return any(ip in n for n in PRIVATE_NETS if n.version == ip.version)


def resolve_private(host, port, addr_ok=is_private_address):
    """Resolve `host` once and require EVERY answer to pass addr_ok. Returns [(family, sockaddr)] to
    connect to — the caller connects to these, never to the name again (no rebinding window)."""
    try:
        infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError, OSError):
        raise RelayError("unresolvable")
    out = []
    for fam, _t, _p, _c, sa in infos:
        if fam not in (socket.AF_INET, socket.AF_INET6):
            continue
        if not addr_ok(sa[0]):
            raise RelayError("not-private")
        if (fam, sa) not in out:
            out.append((fam, sa))
    if not out:
        raise RelayError("unresolvable")
    return out


def filter_headers(headers):
    """Only Content-Type and Authorization reach the camera; anything with a line break is dropped."""
    out = {}
    if not isinstance(headers, dict):
        return out
    for k, v in headers.items():
        if not isinstance(k, str) or k.strip().lower() not in PASS_HEADERS or v is None:
            continue
        v = str(v)
        if "\r" in v or "\n" in v or not v:
            continue
        out["Content-Type" if k.strip().lower() == "content-type" else "Authorization"] = v
    return out


def clamp_timeout(value, default, cap):
    try:
        ms = int(value) if value is not None else default
    except (TypeError, ValueError):
        ms = default
    if ms <= 0:
        ms = default
    return max(MIN_TIMEOUT_MS, min(ms, cap))


def _parse_url(url):
    if not isinstance(url, str) or not url or len(url) > 4096 or any(c in url for c in "\r\n\t "):
        raise RelayError("bad-url")
    try:
        u = urllib.parse.urlsplit(url)
        port = u.port
    except ValueError:
        raise RelayError("bad-url")
    if u.scheme not in ("http", "https") or not u.hostname:
        raise RelayError("bad-url")
    host = u.hostname
    port = port or (443 if u.scheme == "https" else 80)
    target = (u.path or "/") + ("?" + u.query if u.query else "")
    # The Host header as the camera expects it; userinfo in the URL is never forwarded (the server
    # sends credentials as an Authorization header or WS-Security, not in the URL).
    host_hdr = ("[%s]" % host) if ":" in host else host
    if u.port:
        host_hdr += ":%d" % u.port
    return u.scheme, host, port, target, host_hdr


def _unverified_context():
    # Cameras on a LAN serve self-signed certificates (or ones for a name nobody resolves), so there
    # is nothing to verify against. This applies ONLY to this relay, whose destinations are already
    # held to private addresses; every other https request the player makes verifies as usual.
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


class _PinnedConnection(http.client.HTTPConnection):
    """An HTTP(S) connection to an already-vetted socket address; `host` only feeds Host/SNI."""

    def __init__(self, host, port, sockaddr, family, timeout, tls):
        super().__init__(host, port, timeout=timeout)
        self._sockaddr = sockaddr
        self._family = family
        self._tls = tls

    def connect(self):
        s = socket.socket(self._family, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        try:
            s.connect(self._sockaddr)
            if self._tls:
                sni = None
                try:
                    ipaddress.ip_address(self.host)
                except ValueError:
                    sni = self.host
                s = _unverified_context().wrap_socket(s, server_hostname=sni)
        except Exception:
            s.close()
            raise
        self.sock = s


def _read_capped(resp, cap, deadline):
    chunks, total = [], 0
    while True:
        if time.monotonic() > deadline:
            raise RelayError("timeout")
        b = resp.read(min(65536, cap + 1 - total))
        if not b:
            return b"".join(chunks)
        chunks.append(b)
        total += len(b)
        if total > cap:
            raise RelayError("too-large")


def _resp_headers(resp):
    h = {}
    auth = resp.msg.get_all("WWW-Authenticate") or []
    if len(auth) == 1:
        h["www-authenticate"] = auth[0]
    elif auth:
        h["www-authenticate"] = list(auth)
    ct = resp.getheader("Content-Type")
    if ct:
        h["content-type"] = ct
    return h


def http_exchange(method, url, headers, body, cap, timeout_ms, addr_ok=is_private_address):
    """Blocking: one request to a private address, no redirects (http.client never follows one; a 3xx
    comes back as-is). Returns (status, headers, raw_body)."""
    scheme, host, port, target, host_hdr = _parse_url(url)
    addrs = resolve_private(host, port, addr_ok)
    deadline = time.monotonic() + timeout_ms / 1000
    hdrs = filter_headers(headers)
    hdrs["Host"] = host_hdr
    hdrs["Connection"] = "close"
    last = None
    for fam, sa in addrs:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RelayError("timeout")
        conn = _PinnedConnection(host, port, sa, fam, remaining, scheme == "https")
        try:
            try:
                conn.connect()
            except OSError as e:
                last = e
                continue                      # the next vetted address, if any
            conn.putrequest(method, target, skip_host=True, skip_accept_encoding=True)
            for k, v in hdrs.items():
                conn.putheader(k, v)
            if body is not None:
                conn.putheader("Content-Length", str(len(body)))
            conn.endheaders(body)
            resp = conn.getresponse()
            data = _read_capped(resp, cap, deadline)
            return resp.status, _resp_headers(resp), data
        except socket.timeout:
            raise RelayError("timeout")
        except ssl.SSLError as e:
            raise RelayError("tls: %s" % (e.reason or e.__class__.__name__))
        except (OSError, http.client.HTTPException) as e:
            raise RelayError("unreachable: %s" % (str(e) or e.__class__.__name__))
        finally:
            conn.close()
    if isinstance(last, socket.timeout):
        raise RelayError("timeout")
    raise RelayError("unreachable: %s" % (str(last) or "connect failed"))


def do_soap(p, addr_ok=is_private_address):
    body = p.get("body")
    if not isinstance(body, str):
        raise RelayError("bad-body")
    raw = body.encode("utf-8")
    if len(raw) > MAX_SOAP_BODY:
        raise RelayError("too-large")
    timeout_ms = clamp_timeout(p.get("timeout_ms"), DEFAULT_HTTP_TIMEOUT_MS, MAX_HTTP_TIMEOUT_MS)
    status, headers, data = http_exchange("POST", p.get("url"), p.get("headers"), raw, MAX_SOAP_REPLY,
                                          timeout_ms, addr_ok)
    # Any status is a normal answer: the server needs the 401 challenge and the SOAP fault bodies.
    return {"ok": 200 <= status < 300, "status": status, "headers": headers,
            "body": data.decode("utf-8", errors="replace")}


def do_get(p, addr_ok=is_private_address):
    timeout_ms = clamp_timeout(p.get("timeout_ms"), DEFAULT_HTTP_TIMEOUT_MS, MAX_HTTP_TIMEOUT_MS)
    status, headers, data = http_exchange("GET", p.get("url"), p.get("headers"), None, MAX_IMAGE,
                                          timeout_ms, addr_ok)
    out = {"ok": 200 <= status < 300, "status": status, "headers": headers}
    ct = str(headers.get("content-type") or "").strip().lower()
    if status == 200 and (ct.startswith("image/") or data[:3] == b"\xff\xd8\xff"):
        out["body_b64"] = base64.b64encode(data).decode("ascii")
    return out


def do_probe(p, addr_ok=is_private_address, port=DISCOVERY_PORT):
    timeout_ms = clamp_timeout(p.get("timeout_ms"), DEFAULT_PROBE_TIMEOUT_MS, MAX_PROBE_TIMEOUT_MS)
    host = p.get("host")
    if host is not None and host != "":
        if not isinstance(host, str) or len(host) > 255:
            raise RelayError("bad-host")
        fam, sa = resolve_private(host.strip("[]"), port, addr_ok)[0]
        target, family = sa, fam
    else:
        target, family = (DISCOVERY_ADDR, port), socket.AF_INET
    msg = probe_message().encode("utf-8")
    replies = []
    s = socket.socket(family, socket.SOCK_DGRAM)
    try:
        s.bind(("::", 0) if family == socket.AF_INET6 else ("0.0.0.0", 0))
        if target[0] == DISCOVERY_ADDR:
            try:
                s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)   # never past the router
            except OSError:
                pass
        deadline = time.monotonic() + timeout_ms / 1000
        resend_at = time.monotonic() + 0.3
        # Twice, a moment apart: UDP is lossy and many cameras answer a second Probe more reliably.
        s.sendto(msg, target)
        while len(replies) < MAX_PROBE_REPLIES:
            now = time.monotonic()
            if now >= deadline:
                break
            if resend_at is not None and now >= resend_at:
                resend_at = None
                try:
                    s.sendto(msg, target)
                except OSError:
                    pass
            wake = deadline if resend_at is None else min(deadline, resend_at)
            s.settimeout(max(0.01, wake - now))
            try:
                data, frm = s.recvfrom(MAX_DATAGRAM + 1)
            except socket.timeout:
                continue
            if len(data) > MAX_DATAGRAM:
                continue
            replies.append({"from": str(frm[0]).split("%", 1)[0], "xml": data.decode("utf-8", errors="replace")})
    except OSError as e:
        if not replies:
            raise RelayError("udp: %s" % (str(e) or e.__class__.__name__))
    finally:
        s.close()
    return {"ok": True, "replies": replies}


_OPS = {"soap": do_soap, "get": do_get, "probe": do_probe}
_in_flight = 0


def _reply(rid, out):
    out = dict(out)
    out["id"] = rid
    if "error" in out:
        out["error"] = str(out["error"])[:300]
    return out


async def perform(payload, addr_ok=is_private_address):
    """One relay operation -> exactly one reply dict (the caller adds device_id). Never raises.
    Runs on the net loop; the counter is only touched there, so it needs no lock."""
    global _in_flight
    payload = payload if isinstance(payload, dict) else {}
    rid = str(payload.get("id") or "")
    fn = _OPS.get(payload.get("op"))
    if fn is None:
        return _reply(rid, {"ok": False, "error": "bad-op"})
    if _in_flight >= MAX_IN_FLIGHT:
        return _reply(rid, {"ok": False, "error": "busy"})
    _in_flight += 1
    try:
        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(None, fn, payload, addr_ok)
        return _reply(rid, res)
    except RelayError as e:
        return _reply(rid, {"ok": False, "error": str(e)})
    except Exception as e:   # a reply is owed whatever happened
        log.warning("onvif_relay %s failed: %s", payload.get("op"), e)
        return _reply(rid, {"ok": False, "error": str(e) or e.__class__.__name__})
    finally:
        _in_flight -= 1
