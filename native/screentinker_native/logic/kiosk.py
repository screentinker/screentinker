"""Walk-up interactive web pages (#473): the pure rules, ported from server/lib/kiosk-logic.js.

CONTRACT: the same behaviour as the JS module (web/Tizen/BrightSign) and Android's KioskLogic.kt.
All three are checked against shared/kiosk-vectors.json (tests/test_kiosk.py here), so a rule changed
in one place and not the others fails a test instead of drifting.

    parse(widget_type, config)   -> None unless an interactive webpage widget with an http(s) URL
    is_allowed(url, domains)     -> may the TOP-LEVEL page navigate here (subresources never filtered)
    Idle(idle_ms, warn_ms)       -> the session clock: touch / keep_alive / tick, explicit timestamps
    select_cookies(header, pats) -> the consent cookies a wipe may keep, BY NAME ONLY
    ErrorThrottle(window_ms)     -> one dashboard incident per (reason, host) per window
    is_start_page(url, start)    -> whether the Home button should show

Plus the v2 usage queue (SessionQueue), the native twin of Android's KioskSessionQueue.

Idle actions are the JS values: "none" | "started" | {"warn": seconds_left} | "resumed" | "reset".

⚠️ Python's `$` also matches before a trailing newline; every anchored pattern here uses fullmatch.
"""
from __future__ import annotations

import json
import math
import os
import re
import tempfile
import threading
from dataclasses import dataclass, field

from ._jscompat import is_finite, number

DEFAULT_IDLE_SEC = 60
DEFAULT_WARN_SEC = 10

# Consent tools seen in the wild. Exact names, or a prefix ending in `*`. The SAME list, in the same
# order, as server/lib/kiosk-logic.js CONSENT_COOKIES and KioskLogic.kt BUILT_IN (a test compares).
CONSENT_COOKIES = [
    "CookieConsent", "CookieConsentBulkSetting-*",
    "OptanonConsent", "OptanonAlertBoxClosed",
    "euconsent-v2", "euconsent", "addtl_consent", "__cmpcc*",
    "cookieyes-consent", "CookieLawInfoConsent", "cookielawinfo-checkbox-*", "viewed_cookie_policy",
    "cmplz_*", "complianz_*",
    "borlabs-cookie", "BorlabsCookie",
    "_iub_cs-*",
    "didomi_token",
    "cookieconsent_status", "cookieconsent_*",
    "cc_cookie",
    "moove_gdpr_popup", "gdpr_consent*", "cookie_consent*", "cookie-consent*", "cookies_accepted",
    "klaro", "axeptio_cookies", "axeptio_authorized_vendors", "axeptio_all_vendors",
    "tarteaucitron", "CONSENT", "SOCS",
    "consentUUID", "consentDate", "_cookie_consent*",
]

# A kept cookie is restored with this lifetime (Android CookieKeep.MAX_AGE_SEC).
KEEP_MAX_AGE_SEC = 180 * 86400

CARD_TOO_OLD = "This page needs a newer web browser than this screen has."
HOME_LABEL = "⌂  Home"


def _clamp(n, lo, hi):
    return min(hi, max(lo, n))


def _int_or(v, d):
    """JS intOr: a number, or a non-blank string through Number(); truncated; else the default."""
    if isinstance(v, bool):
        return d
    if isinstance(v, (int, float)):
        n = float(v)
    elif isinstance(v, str) and v.strip() != "":
        n = number(v)
    else:
        return d
    return int(math.trunc(n)) if is_finite(n) else d


def _list_of(raw):
    if isinstance(raw, list):
        return [x if isinstance(x, str) else "" for x in raw]
    if isinstance(raw, str):
        return re.split(r"[,\n ]", raw)
    return []


_HOST_RE = re.compile(r"^(https?)://([^/?#:@]+)(:\d+)?(?:[/?#]|$)", re.IGNORECASE)


def host_of(url):
    if not isinstance(url, str) or not url.strip():
        return None
    m = _HOST_RE.match(url.strip())
    if not m:
        return None
    h = m.group(2).lower().rstrip(".")
    return h or None


_DOMAIN_RE = re.compile(r"[a-z0-9.-]+")


def normalize_domain(raw):
    s = ("" if raw is None else str(raw)).strip().lower()
    if not s:
        return None
    if s.startswith("http://") or s.startswith("https://"):
        s = host_of(s)
        if not s:
            return None
    s = re.sub(r"^\.+", "", s)
    s = re.sub(r"^\*+", "", s)
    s = re.sub(r"^\.+", "", s)
    s = re.sub(r"[./]+$", "", s)
    if not s or not _DOMAIN_RE.fullmatch(s) or "." not in s:
        return None
    return s


def is_allowed(url, allowed):
    if url is None:
        return False
    if url == "about:blank":
        return True
    host = host_of(url)
    if not host:
        return False
    for d in allowed or []:
        if host == d or host.endswith("." + d):
            return True
    return False


_PATTERN_RE = re.compile(r"[A-Za-z0-9_.-]+[*]?")


def valid_pattern(p):
    return isinstance(p, str) and bool(_PATTERN_RE.fullmatch(p)) and p != "*"


def cookie_matches(name, patterns):
    for p in patterns:
        if p.endswith("*"):
            if name.startswith(p[:-1]):
                return True
        elif name == p:
            return True
    return False


def select_cookies(header, patterns):
    """`a=1; b=2` -> [[name, value], ...] for the names the patterns keep (first of a name wins)."""
    if not isinstance(header, str) or not header.strip() or not patterns:
        return []
    out, seen = [], set()
    for part in header.split(";"):
        i = part.find("=")
        if i <= 0:
            continue
        name, value = part[:i].strip(), part[i + 1:].strip()
        if not name or name in seen or not cookie_matches(name, patterns):
            continue
        seen.add(name)
        out.append([name, value])
    return out


@dataclass
class KioskConfig:
    url: str
    idle_timeout_sec: int = DEFAULT_IDLE_SEC
    warn_sec: int = DEFAULT_WARN_SEC
    allowed_domains: list = field(default_factory=list)
    min_webview: int = None
    keep_consent: bool = False
    keep_cookie_names: list = field(default_factory=list)
    home_button: bool = True
    zoom_pct: int = 100
    wipe_site_data: bool = True

    def as_dict(self):
        """The JS object's shape (camelCase), as the vectors spell it."""
        return {"url": self.url, "idleTimeoutSec": self.idle_timeout_sec, "warnSec": self.warn_sec,
                "allowedDomains": list(self.allowed_domains), "minWebView": self.min_webview,
                "keepConsent": self.keep_consent, "keepCookieNames": list(self.keep_cookie_names),
                "homeButton": self.home_button, "zoomPct": self.zoom_pct,
                "wipeSiteData": self.wipe_site_data}


def parse(widget_type, config):
    """None unless a webpage widget with `interactive: true` and a usable http(s) URL. `config` is
    the widget_config as sent to players: a JSON string or a dict."""
    if widget_type != "webpage" or config is None:
        return None
    o = config
    if isinstance(o, str):
        if not o.strip():
            return None
        try:
            o = json.loads(o)
        except ValueError:
            return None
    if not isinstance(o, dict) or o.get("interactive") is not True:
        return None
    url = o["url"].strip() if isinstance(o.get("url"), str) else ""
    host = host_of(url)
    if not host:
        return None
    domains = [host]
    for d in _list_of(o.get("allowed_domains")):
        n = normalize_domain(d)
        if n and n not in domains:
            domains.append(n)
    names = []
    for n in _list_of(o.get("keep_cookie_names")):
        n = str(n).strip()
        if valid_pattern(n) and n not in names and len(names) < 50:
            names.append(n)
    min_wv = _int_or(o.get("min_webview"), 0)
    zoom = _int_or(o.get("zoom"), 100)
    return KioskConfig(
        url=url,
        idle_timeout_sec=_clamp(_int_or(o.get("idle_timeout_sec"), DEFAULT_IDLE_SEC), 15, 3600),
        warn_sec=_clamp(_int_or(o.get("idle_warning_sec"), DEFAULT_WARN_SEC), 0, 60),
        allowed_domains=domains,
        min_webview=min_wv if min_wv > 0 else None,
        keep_consent=o.get("keep_consent") is True,
        keep_cookie_names=names,
        home_button=o.get("home_button") is not False,
        zoom_pct=100 if zoom <= 0 else _clamp(zoom, 25, 400),
        wipe_site_data=o.get("wipe_site_data") is not False,
    )


def keep_patterns(cfg):
    """The cookie patterns a wipe may keep for this config ([] when keep_consent is off)."""
    if cfg is None or not cfg.keep_consent:
        return []
    out = list(CONSENT_COOKIES)
    for n in cfg.keep_cookie_names or []:
        if n not in out:
            out.append(n)
    return out


def keeps_cookies(cfg):
    """Whether any cookie outlives a reset: keepConsent's names, or all of them with
    wipe_site_data off (this player's site STORAGE never survives — the profile is in memory)."""
    return cfg is not None and (cfg.keep_consent or not cfg.wipe_site_data)


def is_start_page(current, start):
    def norm(u):
        return re.sub(r"/+$", "", str(u).split("#")[0]).lower()
    return current is None or current == "about:blank" or norm(current) == norm(start)


_CHROME_RE = re.compile(r"Chrome/(\d+)\.")


def chrome_major(ua):
    m = _CHROME_RE.search(str(ua or ""))
    return int(m.group(1)) if m else None


def too_old(ua, minimum):
    if minimum is None:
        return False
    v = chrome_major(ua)
    return v is not None and v < minimum


class Idle:
    """PASSIVE until the first touch; ACTIVE while touched or media plays; WARNING during the "Still
    there?" countdown; RESET returns to PASSIVE. Media keeps a session alive but never starts one."""

    def __init__(self, idle_ms, warn_ms):
        self.idle_ms = idle_ms
        self.warn_ms = warn_ms
        self.phase = "passive"
        self.last_activity = 0

    def in_session(self):
        return self.phase != "passive"

    def on_touch(self, now):
        self.last_activity = now
        if self.phase == "passive":
            self.phase = "active"
            return "started"
        if self.phase == "warning":
            self.phase = "active"
            return "resumed"
        return "none"

    def keep_alive(self, now):
        if self.phase == "passive":
            return "none"
        self.last_activity = now
        if self.phase == "warning":
            self.phase = "active"
            return "resumed"
        return "none"

    def tick(self, now):
        if self.phase == "passive":
            return "none"
        idle = now - self.last_activity
        if idle >= self.idle_ms + self.warn_ms:
            self.phase = "passive"
            return "reset"
        if idle >= self.idle_ms:
            self.phase = "warning"
            return {"warn": max(1, math.floor((self.idle_ms + self.warn_ms - idle + 999) / 1000))}
        return "none"

    def end(self):
        self.phase = "passive"


class ErrorThrottle:
    def __init__(self, window_ms=None):
        self.window_ms = 15 * 60_000 if window_ms is None else window_ms
        self.last = {}

    def should_report(self, reason, url, now):
        key = reason + "|" + (host_of(url) or "")
        prev = self.last.get(key)
        if prev is not None and now - prev < self.window_ms:
            return False
        self.last[key] = now
        return True


# ---------------------------------------------------------------------- v2 usage records

def make_session(sid, widget_id, started_at_s, duration_sec, end_reason, pages):
    """One visitor session, the wire shape of device:kiosk-sessions. duration is ENGAGED time."""
    return {"id": str(sid), "widget_id": widget_id or None, "started_at": int(started_at_s),
            "duration_sec": max(1, int(duration_sec)), "end_reason": end_reason, "pages": max(1, int(pages))}


def _session_from(o):
    if not isinstance(o, dict):
        return None
    sid = o.get("id")
    if not isinstance(sid, str) or not sid:
        return None
    try:
        return make_session(sid, o.get("widget_id") if isinstance(o.get("widget_id"), str) else None,
                            int(o.get("started_at") or 0), int(o.get("duration_sec") or 0),
                            str(o.get("end_reason") or "interrupted"), int(o.get("pages") or 1))
    except (TypeError, ValueError):
        return None


class SessionQueue:
    """Bounded (oldest dropped), ordered, deduplicated by id, removed only on the server's ack.
    load()/save() persist it at `path`, atomically (power loss mid-write is ordinary for signage)."""
    MAX = 500
    BATCH = 50

    def __init__(self, cap=MAX, path=None):
        self.cap = cap
        self.path = path
        self._items = []
        self._lock = threading.RLock()

    def size(self):
        return len(self._items)

    __len__ = size

    def add(self, r):
        r = _session_from(r)
        if r is None:
            return
        with self._lock:
            if any(i["id"] == r["id"] for i in self._items):
                return
            self._items.append(r)
            while len(self._items) > self.cap:
                self._items.pop(0)

    def peek(self, n=BATCH):
        with self._lock:
            return [dict(i) for i in self._items[:n]]

    def ack(self, ids):
        ids = {i for i in (ids or []) if isinstance(i, str)}
        if not ids:
            return
        with self._lock:
            self._items = [i for i in self._items if i["id"] not in ids]

    def to_json(self):
        with self._lock:
            return json.dumps(self._items)

    @classmethod
    def from_json(cls, raw, cap=MAX, path=None):
        q = cls(cap, path)
        try:
            for o in json.loads(raw) if raw else []:
                q.add(o)
        except (ValueError, TypeError):
            pass        # unreadable: start empty rather than wedge
        return q

    def load(self):
        if not self.path:
            return
        try:
            with open(self.path, encoding="utf-8") as f:
                raw = f.read()
        except OSError:
            return
        q = SessionQueue.from_json(raw, self.cap)
        with self._lock:
            self._items = q._items

    def save(self):
        if not self.path:
            return
        atomic_write(self.path, self.to_json())


def atomic_write(path, text):
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def kept_cookies(cookies, cfg, visited_hosts=()):
    """What survives a wipe, from the cookie store's own records (dicts with name/value/domain/path).

    Only names the patterns keep, and only cookies whose domain belongs to an allowed site (the start
    host, allowed_domains, or an allowed host the visitor reached) — never "every cookie of the
    allowed domain", which would keep the visitor's login (unless the operator turned wipe_site_data off,
    which keeps them all, for pages with nothing to protect). Later records of the same (name, domain,
    path) replace earlier ones, as a cookie store does."""
    if cfg is not None and not cfg.wipe_site_data:
        pats = None                           # wipe_site_data off: every cookie of the allowed sites
    else:
        pats = keep_patterns(cfg)
        if not pats:
            return []
    allowed = list(cfg.allowed_domains)
    for h in visited_hosts:
        if is_allowed("https://%s/" % h, cfg.allowed_domains) and h not in allowed:
            allowed.append(h)
    out = {}
    for c in cookies or []:
        name = str(c.get("name") or "")
        dom = str(c.get("domain") or "").lstrip(".").lower()
        if not name or not dom or (pats is not None and not cookie_matches(name, pats)):
            continue
        if not is_allowed("https://%s/" % dom, allowed):
            continue
        out[(name, dom, str(c.get("path") or "/"))] = c
    return list(out.values())
