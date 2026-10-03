"""LAN triggers + the local control API — Android trigger/TriggerManager, TriggerController,
TriggerListeners and net/LocalApi, on the network thread's asyncio loop.

Three doors, ONE decision each:
  * UDP (unicast, broadcast, optional multicast group) and HTTP (GET ?m= / ?token=&secret=, POST raw
    line, JSON or form) both land in handle(); resolution is logic/trigger_resolve.evaluate, held to
    shared/trigger-vectors.json. device:trigger-wire (server-relayed) is the third door into it.
  * /api/status and /api/command on the same HTTP port are the local control API: its own secret,
    its own rate limiter (2/s burst 5, 10/s global — a trigger flood must never lock an operator out
    of screen_on), and a COMMAND ALLOWLIST that server/test/local-api-allowlist.test.js holds to the
    Kotlin copy. LOCAL_API_COMMANDS below must stay identical to LocalApi.kt's COMMANDS.

The overlay itself (what a fired trigger shows) lives in ui/trigger_overlay.py on the Qt thread; this
module calls show(trigger)/hide() through the app.
"""

import asyncio
import json
import logging
import re
import secrets
import socket
import struct
import time
import urllib.parse

from ..logic import trigger_resolve
from ..logic.rate_limiter import RateLimiter

log = logging.getLogger("triggers")

LOCAL_API_COMMANDS = ["refresh", "screen_on", "screen_off", "set_volume", "set_brightness", "set_system_brightness"]
DEFAULT_HTTP_PORT = 8079
DEFAULT_UDP_PORT = 7847
MAX_BODY = 4096
MAX_LINE = 1024
REJOIN_S = 90
_FORM_SHAPE = re.compile(r"^[^=&\s]+=[^&]*(&|$)")
_FORM_TOKEN = re.compile(r"(^|&)token=")
SWEEP_S = 5


def post_body_to_line(text):
    """A trigger POST body -> the wire line. See the note at the call site."""
    try:
        j = json.loads(text)
        if isinstance(j, dict) and j.get("token"):
            return "ST1 %s %s" % (j.get("secret") or "", j["token"])
        return text
    except ValueError:
        if _FORM_SHAPE.search(text) and _FORM_TOKEN.search(text):
            q = {k: v[0] for k, v in urllib.parse.parse_qs(text, keep_blank_values=True).items()}
            if q.get("token"):
                return "ST1 %s %s" % (q.get("secret") or "", q["token"])
        return text


def _clean(text):
    t = (text or "").replace("\x00", "").replace("﻿", "").strip()
    return t.encode()[:MAX_LINE].decode(errors="ignore")


def _opt_text(d, k):
    if not isinstance(d, dict):
        return None
    v = d.get(k)
    if v is None or v == "null" or v == "":
        return None
    return str(v)


class TriggerController:
    """Priority / hold / lease. A lower priority is dropped while a higher one shows; an
    until_cleared trigger that gets covered is HELD and restored when the cover clears."""

    def __init__(self, show, hide, now=lambda: int(time.time() * 1000)):
        self.show, self.hide, self.now = show, hide, now
        self.active = None       # {'trigger','since','source','lease_until'}
        self.held = []

    def _lease(self, t):
        ls = t.get("lease_sec")
        try:
            ls = int(ls) if ls is not None else 0
        except (TypeError, ValueError):
            ls = 0
        return self.now() + ls * 1000 if ls > 0 else None

    @staticmethod
    def _prio(t):
        try:
            return int(t.get("priority") or 0)
        except (TypeError, ValueError):
            return 0

    def on_verdict(self, v, source):
        if not v.get("ok"):
            return
        a = v.get("action")
        t = v.get("trigger")
        if a == "clear_all":
            self.held.clear()
            self.stop("clear-all")
        elif a == "clear" and t:
            if self.active and self.active["trigger"].get("id") == t.get("id"):
                self.stop("cleared")
                self.promote()
            else:
                self.held = [h for h in self.held if h["trigger"].get("id") != t.get("id")]
        elif a == "fire" and t:
            self._fire(t, source)

    def _fire(self, t, source):
        a = self.active
        if a and a["trigger"].get("id") == t.get("id"):
            a["lease_until"] = self._lease(t)
            return
        for h in self.held:
            if h["trigger"].get("id") == t.get("id"):
                h["lease_until"] = self._lease(t)
                return
        if a and self._prio(t) < self._prio(a["trigger"]):
            log.info('[trigger] "%s" (p%s) dropped: "%s" is showing', t.get("name"), self._prio(t), a["trigger"].get("name"))
            return
        if a and a["trigger"].get("mode") == "until_cleared":
            self.held.append({"trigger": a["trigger"], "source": a["source"], "lease_until": a["lease_until"]})
        self.active = {"trigger": t, "since": self.now(), "source": source, "lease_until": self._lease(t)}
        self.show(t)
        log.info('[trigger] fired "%s" via %s (%s)', t.get("name"), source, t.get("mode"))

    def stop(self, reason):
        was, self.active = self.active, None
        self.hide()
        if was:
            log.info('[trigger] cleared "%s" (%s)', was["trigger"].get("name"), reason)

    def promote(self):
        if self.active or not self.held:
            return
        best = 0
        for i in range(1, len(self.held)):
            if self._prio(self.held[i]["trigger"]) >= self._prio(self.held[best]["trigger"]):
                best = i
        h = self.held.pop(best)
        self.active = {"trigger": h["trigger"], "since": self.now(), "source": h["source"], "lease_until": h["lease_until"]}
        self.show(h["trigger"])

    def sweep(self):
        t = self.now()
        a = self.active
        if a and a["lease_until"] is not None and t > a["lease_until"]:
            log.warning('[trigger] lease expired, auto-cleared "%s"', a["trigger"].get("name"))
            self.stop("lease expired")
            self.promote()
            return
        self.held = [h for h in self.held if not (h["lease_until"] is not None and t > h["lease_until"])]


class _Udp(asyncio.DatagramProtocol):
    def __init__(self, mgr):
        self.mgr = mgr

    def datagram_received(self, data, addr):
        text = data[:2048].decode(errors="ignore")
        if text.startswith("ST1-PROBE "):
            if text.strip() == "ST1-PROBE " + self.mgr.probe_nonce:
                self.mgr.stats["multicast"] = dict(self.mgr.stats.get("multicast") or {}, self_test="ok")
            return
        self.mgr.handle(_clean(text), "udp", addr[0])


class TriggerManager:
    def __init__(self, app):
        self.app = app
        self.controller = TriggerController(app.trigger_show, app.trigger_hide)
        self.limiter = RateLimiter.trigger()
        self.api_limiter = RateLimiter.local_api()
        self.triggers = []
        self.secret = ""
        self.clear_all = None
        self.api_enabled = False
        self.api_secret = None
        self.started_with = None
        self.http_server = None
        self.udp_transport = None
        self.udp_sock = None
        self.group = None
        self.probe_nonce = secrets.token_hex(4)
        self.warned_query_secret = False
        self.stats = {"listeners": {"http": None, "udp": None}, "multicast": None, "received": 0,
                      "accepted": 0, "rejected": {}, "last_datagram_at": None}
        self._tasks = []
        self._payload_lock = asyncio.Lock()

    # ------------------------------------------------------------------ payload
    async def on_payload(self, p):
        # ⚠️ Serialised: at boot the cached payload and the first live one arrive together, and two
        # interleaved restarts each saw "not started", each bound 8079, and the second failed with
        # "address already in use" — leaving the listener state inconsistent (found in the e2e run).
        async with self._payload_lock:
            await self._on_payload(p)

    async def _on_payload(self, p):
        cfg = p.get("trigger_config") if isinstance(p.get("trigger_config"), dict) else None
        self.secret = _opt_text(cfg, "secret") or ""
        self.clear_all = _opt_text(cfg, "clear_all_token")
        self.triggers = [t for t in (p.get("triggers") or []) if isinstance(t, dict)]
        api = p.get("local_api") if isinstance(p.get("local_api"), dict) else None
        self.api_enabled = bool(api and api.get("enabled"))
        self.api_secret = _opt_text(api, "secret")
        accept_http = bool(cfg and cfg.get("accept_http"))
        accept_udp = bool(cfg and cfg.get("accept_udp"))
        http_port = int(cfg.get("http_port") or 0) if cfg else 0
        udp_port = int(cfg.get("udp_port") or 0) if cfg else 0
        group = _opt_text(cfg, "multicast_group")
        # ⚠️ The local-api flag is part of the restart key: without it, enabling the control door
        # would change nothing until some transport setting also changed.
        want = (accept_http, accept_udp, http_port, udp_port, group, self.api_enabled)
        if want != self.started_with:
            await self.stop_listeners()
            if accept_http or self.api_enabled:
                await self._start_http(http_port or DEFAULT_HTTP_PORT)
            if accept_udp:
                await self._start_udp(udp_port or DEFAULT_UDP_PORT, group)
            self.started_with = want
            self.app.log_remote("info", "trigger", "trigger listeners: http=%s udp=%s local_api=%s" % (
                accept_http, accept_udp, self.api_enabled))
        if not self._tasks:
            self._tasks.append(asyncio.ensure_future(self._sweep_loop()))
        self.report_status()

    async def stop_listeners(self):
        if self.http_server:
            self.http_server.close()
            try:
                await asyncio.wait_for(self.http_server.wait_closed(), timeout=3)
            except (asyncio.TimeoutError, Exception):
                pass
            self.http_server = None
        if self.udp_transport:
            self.udp_transport.close()
            self.udp_transport = None
        self.stats["listeners"] = {"http": None, "udp": None}

    async def _sweep_loop(self):
        n = 0
        while True:
            await asyncio.sleep(SWEEP_S)
            n += 1
            self.app.on_ui(self.controller.sweep)
            if self.group and self.udp_sock and n % (REJOIN_S // SWEEP_S) == 0:
                self._join_group(rejoin=True)
            if n % 12 == 0:
                self.report_status()

    # ------------------------------------------------------------------ decision
    def handle(self, text, source, ip):
        self.stats["received"] += 1
        self.stats["last_datagram_at"] = int(time.time() * 1000)
        if not self.limiter.allow(ip, time.time() * 1000):
            self._bump("rate_limited")
            return {"ok": False, "reason": "rate_limited"}
        v = trigger_resolve.evaluate(text, self.triggers, self.secret, self.clear_all, source if source != "server" else "http")
        if not v.get("ok"):
            self._bump(v.get("reason") or "unknown")
            return v
        self.stats["accepted"] += 1
        self.app.on_ui(lambda: self.controller.on_verdict(v, source))
        return v

    def _bump(self, k):
        self.stats["rejected"][k] = self.stats["rejected"].get(k, 0) + 1

    def status_payload(self):
        a = self.controller.active
        return dict(self.stats, definitions=len(self.triggers), held=len(self.controller.held),
                    active=({"trigger_id": a["trigger"].get("id"), "name": a["trigger"].get("name"),
                             "mode": a["trigger"].get("mode"), "since": a["since"], "source": a["source"],
                             "lease_until": a["lease_until"]} if a else None))

    def report_status(self):
        if self.app.config.device_id:
            self.app.emit("device:trigger-status", {"device_id": self.app.config.device_id,
                                                     "status": self.status_payload()})

    # ------------------------------------------------------------------ UDP
    async def _start_udp(self, port, group):
        loop = asyncio.get_running_loop()
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            s.bind(("0.0.0.0", port))
            self.udp_transport, _ = await loop.create_datagram_endpoint(lambda: _Udp(self), sock=s)
            self.udp_sock = s
            self.stats["listeners"]["udp"] = {"port": port, "bound": True}
        except OSError as e:
            self.stats["listeners"]["udp"] = {"port": port, "bound": False, "error": str(e)}
            self.app.log_remote("warn", "trigger", "UDP listener on %d failed: %s" % (port, e))
            return
        self.group = group
        if group:
            self._join_group()
            try:
                self.udp_sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
                self.udp_transport.sendto(("ST1-PROBE " + self.probe_nonce).encode(), (group, port))
            except OSError:
                pass

    def _join_group(self, rejoin=False):
        try:
            mreq = struct.pack("4s4s", socket.inet_aton(self.group), socket.inet_aton("0.0.0.0"))
            if rejoin:
                try:
                    self.udp_sock.setsockopt(socket.IPPROTO_IP, socket.IP_DROP_MEMBERSHIP, mreq)
                except OSError:
                    pass
            self.udp_sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            self.stats["multicast"] = dict(self.stats.get("multicast") or {}, group=self.group, joined=True)
        except OSError as e:
            self.stats["multicast"] = {"group": self.group, "joined": False, "error": str(e)}

    # ------------------------------------------------------------------ HTTP
    async def _start_http(self, port):
        try:
            self.http_server = await asyncio.start_server(self._on_http, host="0.0.0.0", port=port, reuse_address=True)
            self.stats["listeners"]["http"] = {"port": port, "bound": True}
        except OSError as e:
            self.stats["listeners"]["http"] = {"port": port, "bound": False, "error": str(e)}
            self.app.log_remote("warn", "trigger", "HTTP listener on %d failed: %s" % (port, e))

    async def _on_http(self, reader, writer):
        ip = (writer.get_extra_info("peername") or ("?",))[0]
        status, body, after = 400, {"ok": False, "error": "malformed"}, None
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5)
            lines = head.decode(errors="ignore").split("\r\n")
            method, target, _ = (lines[0].split(" ") + ["", "", ""])[:3]
            headers = {}
            for ln in lines[1:]:
                if ":" in ln:
                    k, v = ln.split(":", 1)
                    headers[k.strip().lower()] = v.strip()
            n = min(int(headers.get("content-length") or 0), MAX_BODY)
            raw = await asyncio.wait_for(reader.readexactly(n), timeout=5) if n else b""
            text = raw.decode(errors="ignore")
            u = urllib.parse.urlsplit(target)
            query = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
            if u.path in ("/api/status", "/api/command"):
                status, body, after = self._local_api(method, u.path, query, headers, text, ip)
            elif self.started_with and self.started_with[0]:
                status, body = self._trigger_http(method, query, headers, text, ip)
            else:
                status, body = 404, {"ok": False, "error": "not_found"}
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, ValueError, ConnectionError):
            status, body = 400, {"ok": False, "error": "malformed"}
        payload = (json.dumps(body) + "\n").encode()
        reason = {200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
                  405: "Method Not Allowed", 429: "Too Many Requests", 503: "Service Unavailable"}.get(status, "OK")
        try:
            writer.write(("HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n"
                          "Connection: close\r\n\r\n" % (status, reason, len(payload))).encode() + payload)
            await writer.drain()
        except ConnectionError:
            pass
        finally:
            writer.close()
        # The command runs AFTER the reply is on the wire (Android TriggerListeners:455): a
        # screen_off must not leave the caller waiting on a display that is already dark.
        if after:
            after()

    def _trigger_http(self, method, query, headers, text, ip):
        if method not in ("GET", "POST"):
            return 405, {"ok": False, "error": "method_not_allowed"}
        line = None
        if method == "GET":
            if "m" in query:
                line = query["m"]
            elif "token" in query and "secret" in query:
                line = "ST1 %s %s" % (query["secret"], query["token"])
        else:
            # Android TriggerListeners / the web player, verbatim, so the same bytes get the same
            # verdict on every platform. Content-Type is NOT consulted (curl -d, PLC HTTP blocks and
            # nc wrappers label a raw line as a form): JSON with a truthy token -> wire line; else the
            # two ANCHORED form regexes (a bare "token=" would also match a raw line such as
            # `ST1 <secret> mytoken=X`); else the body IS the raw wire line.
            line = post_body_to_line(text)
        if not line:
            return 400, {"ok": False, "error": "malformed"}
        v = self.handle(_clean(line), "http", ip)
        if v.get("ok"):
            return 200, {"ok": True, "action": v.get("action")}
        return 400, {"ok": False, "error": v.get("reason")}

    def _local_api(self, method, path, query, headers, body, ip):
        if not self.api_limiter.allow(ip, time.time() * 1000):
            return 429, {"ok": False, "error": "rate_limited"}, None
        if not self.api_enabled:
            return 404, {"ok": False, "error": "not_found"}, None
        if not self.api_secret:
            return 503, {"ok": False, "error": "no_secret_configured"}, None
        auth = headers.get("authorization", "").strip()
        if auth[:7].lower() == "bearer ":
            auth = auth[7:].strip()
        given = auth or query.get("secret")
        if "secret" in query and not self.warned_query_secret:
            self.warned_query_secret = True
            self.app.log_remote("warn", "trigger", "local API secret arrived in the query string from %s — it lands in "
                                "proxy logs; send it as Authorization: Bearer if the sender can" % ip)
        if not given or not trigger_resolve.secret_matches(given, self.api_secret):
            return 401, {"ok": False, "error": "bad_secret"}, None
        if method == "GET" and path == "/api/status":
            return 200, self.app.local_status(), None
        if method == "POST" and path == "/api/command":
            typ, payload = "", None
            try:
                j = json.loads(body)
                typ = str(j.get("type") or "")
                payload = j.get("payload") if isinstance(j.get("payload"), dict) else None
                if payload is None:
                    flat = {k: v for k, v in j.items() if k != "type"}
                    payload = flat or None
            except (ValueError, AttributeError):
                typ = query.get("type", "")
            if not typ:
                return 400, {"ok": False, "error": "type required"}, None
            if typ not in LOCAL_API_COMMANDS:
                return 403, {"ok": False, "error": "command_not_permitted", "type": typ}, None
            self.app.log_remote("info", "trigger", "local API: %s from %s" % (typ, ip))
            return 200, {"ok": True, "type": typ}, (lambda: self.app.dispatch_command(typ, payload or {}, source="local_api"))
        if path == "/api/status":
            return 405, {"ok": False, "error": "GET only"}, None
        return 405, {"ok": False, "error": "POST only"}, None
