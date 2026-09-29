"""http_request + saved endpoints: the panel performs a REST call from ITS OWN network (the PLC, the
local Home Assistant) — a port of Android net/DeviceHttp.kt and EndpointPoller.kt.

Guarded exactly as Android: http/https only, the shared SSRF string check (logic/http_target_guard,
held to shared/http-target-vectors.json), then the host is RESOLVED and every address re-vetted, and
the connection is PINNED to those vetted addresses through a custom resolver — a DNS answer that
changes between the check and the connect cannot redirect the request (rebinding). No redirects
(a 302 to 169.254.169.254 is the classic bypass), timeout <= 120 s, body snippet capped at 64 KiB.
"""

import asyncio
import json
import logging
import socket
import time
import uuid
import urllib.parse

import aiohttp
from aiohttp.abc import AbstractResolver

from ..logic import http_target_guard as guard

log = logging.getLogger("http")

MAX_BODY = 64 * 1024
DEFAULT_TIMEOUT_MS = 15_000
MAX_TIMEOUT_MS = 120_000


class _PinnedResolver(AbstractResolver):
    def __init__(self, host, addrs):
        self.host = host.lower()
        self.addrs = addrs

    async def resolve(self, host, port=0, family=socket.AF_INET):
        if host.lower().strip("[]") != self.host:
            raise OSError("unexpected host %s" % host)   # never resolve anything we did not vet
        out = []
        for a in self.addrs:
            fam = socket.AF_INET6 if ":" in a else socket.AF_INET
            out.append({"hostname": host, "host": a, "port": port, "family": fam, "proto": 0,
                        "flags": socket.AI_NUMERICHOST})
        return out

    async def close(self):
        pass


def _result(rid, ok, status, snippet, truncated, started, error=None):
    r = {"id": rid, "ok": ok, "status": status, "snippet": snippet, "truncated": truncated,
         "duration_ms": int((time.monotonic() - started) * 1000)}
    if error is not None:
        r["error"] = error
    return r


async def perform(payload):
    started = time.monotonic()
    payload = payload if isinstance(payload, dict) else {}
    rid = str(payload.get("id") or "").strip() or str(uuid.uuid4())
    url = str(payload.get("url") or "")
    v = guard.check(url)
    if not v.get("allow"):
        return _result(rid, False, 0, "", False, started, guard.explain(v.get("reason")))
    url = guard.normalize_url(url)
    host = urllib.parse.urlsplit(url).hostname or ""
    port = urllib.parse.urlsplit(url).port
    loop = asyncio.get_running_loop()
    addrs = await loop.run_in_executor(None, guard.resolve_and_vet, host, port)
    if not addrs:
        return _result(rid, False, 0, "", False, started,
                       "host did not resolve, or resolves to a refused address")
    try:
        timeout_ms = max(1, min(int(payload.get("timeout_ms") or DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS))
    except (TypeError, ValueError):
        timeout_ms = DEFAULT_TIMEOUT_MS
    method = (str(payload.get("method") or "GET")).upper() or "GET"
    body = payload.get("body")
    if body is not None and not isinstance(body, str):
        body = json.dumps(body)
    body = body or ""
    headers = {}
    for k, val in (payload.get("headers") or {}).items() if isinstance(payload.get("headers"), dict) else []:
        val = "" if val is None else str(val)
        if k and val and "\n" not in val and "\r" not in val and "\n" not in k and "\r" not in k:
            headers[str(k)] = val
    if body and not any(k.lower() == "content-type" for k in headers):
        headers["Content-Type"] = "application/json"
    data = None if (method in ("GET", "HEAD", "DELETE") and not body) else body.encode()
    conn = aiohttp.TCPConnector(resolver=_PinnedResolver(host, addrs), use_dns_cache=False, force_close=True)
    try:
        async with aiohttp.ClientSession(connector=conn, timeout=aiohttp.ClientTimeout(total=timeout_ms / 1000)) as s:
            async with s.request(method, url, data=data, headers=headers, allow_redirects=False) as r:
                raw = await r.content.read(MAX_BODY + 1)
                truncated = len(raw) > MAX_BODY
                text = raw[:MAX_BODY].decode(errors="replace")
                return _result(rid, 200 <= r.status < 300, r.status, text, truncated, started)
    except Exception as e:
        log.warning("request to %s failed: %s", host, e)
        return _result(rid, False, 0, "", False, started, str(e) or e.__class__.__name__)


class EndpointPoller:
    """Saved endpoints from the payload: each runs every interval_sec, optionally only while the
    screen is on or off (run_on). Absent `endpoints` CLEARS the set (same contract as Android)."""

    SWEEP_S = 10

    def __init__(self, emit, screen_is_on, device_id):
        self.emit = emit
        self.screen_is_on = screen_is_on
        self.device_id = device_id
        self.endpoints = []
        self.last_run = {}
        self._task = None

    def update(self, endpoints):
        self.endpoints = [e for e in (endpoints or []) if isinstance(e, dict) and e.get("url")]
        ids = {str(e.get("id")) for e in self.endpoints}
        self.last_run = {k: v for k, v in self.last_run.items() if k in ids}
        if self.endpoints and self._task is None:
            self._task = asyncio.ensure_future(self._loop())

    async def _loop(self):
        while True:
            await asyncio.sleep(self.SWEEP_S)
            now = time.monotonic()
            on = self.screen_is_on()
            for e in list(self.endpoints):
                eid = str(e.get("id"))
                try:
                    interval = max(10, int(e.get("interval_sec") or 0))
                except (TypeError, ValueError):
                    continue
                if not e.get("interval_sec"):
                    continue
                run_on = e.get("run_on")
                if run_on == "screen_on" and not on or run_on == "screen_off" and on:
                    continue
                if now - self.last_run.get(eid, 0) < interval:
                    continue
                self.last_run[eid] = now
                res = await perform(e)
                res.update({"device_id": self.device_id(), "endpoint_id": e.get("id"),
                            "endpoint_name": e.get("name"), "reason": "poll"})
                self.emit("device:http-result", res)
