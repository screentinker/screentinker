"""Trigger wire parsing and token resolution — the decision half of the fire path.

Python port of server/lib/trigger-resolve.js (Kotlin: trigger/TriggerResolve.kt).
docs/triggers-design.md §2, §11.

⚠️ THIS IS A THIRD IMPLEMENTATION OF A SECURITY DECISION. It decides whether an unauthenticated
packet from the LAN changes what is on a screen, and implementations in different languages WILL
drift — silently, and in a direction that matters: one player accepting a payload another refuses
is a hole nobody sees until it is used. shared/trigger-vectors.json is the contract; if this
disagrees with a vector, this is wrong.

⚠️ NOTHING HERE TOUCHES THE NETWORK OR THE SCREEN. Both transports parse with parse_wire(), decide
with evaluate(), and only then call the renderer. One decision, two doors.

The per-source rate limiter (createRateLimiter in the JS) lives in rate_limiter.py.
"""
from __future__ import annotations

import re

# `ST1 <secret> <token>` — one line, ASCII, and nothing else.
MAGIC = "ST1"
MAX_BYTES = 512
# Printable ASCII, no space, because the payload is space-separated and a token with a space in it
# cannot survive the wire. Matches the server-side validator in routes/triggers.js.
TOKEN_RE = re.compile(r"[\x21-\x7E]{1,64}")
_TRAILING_EOL = re.compile(r"[\r\n]+\Z")


def parse_wire(text) -> dict:
    """Parse one raw payload -> {ok:True, secret, token} | {ok:False, reason}.

    ⚠️ THE MAGIC IS CHECKED FIRST AND CHEAPLY. On subnet broadcast this socket sees every stray
    datagram on the LAN — mDNS, discovery chatter, someone's printer. Rejecting on a 3-byte compare
    before any splitting keeps that free, and keeps `bad_magic` meaningful: it separates "the
    network is noisy" from "something is talking to us and getting it wrong".
    """
    if not isinstance(text, str):
        return {"ok": False, "reason": "malformed"}
    # Byte length, not character length: the cap exists to bound work per datagram.
    try:
        nbytes = len(text.encode("utf-8"))
    except UnicodeEncodeError:  # lone surrogate; JS would count it as 3 bytes (U+FFFD)
        nbytes = len(text.encode("utf-8", "replace")) + 2 * sum(1 for c in text if 0xD800 <= ord(c) <= 0xDFFF)
    if nbytes > MAX_BYTES:
        return {"ok": False, "reason": "too_large"}

    line = _TRAILING_EOL.sub("", text)
    if line[: len(MAGIC)] != MAGIC:
        return {"ok": False, "reason": "bad_magic"}

    # Exactly three fields. Fewer is truncated or missing a secret; more means a token contained a
    # space, which the editor refuses at save time precisely so it cannot happen here.
    parts = line.split(" ")
    if len(parts) != 3:
        return {"ok": False, "reason": "malformed"}
    _, secret, token = parts
    if not secret or not TOKEN_RE.fullmatch(token):
        return {"ok": False, "reason": "malformed"}
    return {"ok": True, "secret": secret, "token": token}


def secret_matches(given, expected) -> bool:
    """⚠️ Length-checked compare. Not because a timing attack is the threat — the secret crosses an
    unauthenticated LAN in cleartext, so anyone positioned to time it can simply read it — but
    because comparing a 4-byte string to a 64-byte one should cost the same either way and the
    habit is cheap."""
    if not isinstance(given, str) or not isinstance(expected, str):
        return False
    if len(given) != len(expected):
        return False
    diff = 0
    for a, b in zip(given, expected):
        diff |= ord(a) ^ ord(b)
    return diff == 0


def _get(t, key):
    return t.get(key) if isinstance(t, dict) else getattr(t, key, None)


def evaluate(text, triggers, device_secret, clear_all_token=None, source="http") -> dict:
    """What should happen, given a payload and the triggers this device actually holds.

    triggers:        the SYNCED, DEVICE-SCOPED list (dicts with match_token, clear_token,
                     source_http, source_udp, ...). A token valid on another screen resolves to
                     nothing here.
    device_secret:   this device's shared secret; absent/empty refuses everything (an
                     unprovisioned player is inert rather than open).
    clear_all_token: optional device-level "clear everything" token.
    source:          'http' | 'udp' — a trigger that does not accept this transport must not fire.

    Returns {ok:True, action:'fire'|'clear'|'clear_all', trigger?} or {ok:False, reason}. Every
    rejection reason is from a closed set, because those are the counters an installer reads.
    """
    parsed = parse_wire(text)
    if not parsed["ok"]:
        return {"ok": False, "reason": parsed["reason"]}

    if not device_secret or not secret_matches(parsed["secret"], device_secret):
        return {"ok": False, "reason": "bad_secret"}

    # Checked before per-trigger tokens, so a device-level stop cannot be shadowed by a trigger
    # that happens to use the same token.
    if clear_all_token and parsed["token"] == clear_all_token:
        return {"ok": True, "action": "clear_all", "trigger": None}

    for t in triggers if isinstance(triggers, (list, tuple)) else []:
        if not t:
            continue
        # ⚠️ THE TRANSPORT GATE IS PER TRIGGER, not just per device. An operator who enables only
        # UDP on an emergency trigger has said something specific — that it is fired by the panel
        # wired to the alarm, not by anything that can reach the box over HTTP. Honouring the
        # device flag alone would quietly widen that.
        accepts = _get(t, "source_udp") if source == "udp" else _get(t, "source_http")
        if not accepts:
            continue
        match, clear = _get(t, "match_token"), _get(t, "clear_token")
        if match and parsed["token"] == match:
            return {"ok": True, "action": "fire", "trigger": t}
        if clear and parsed["token"] == clear:
            return {"ok": True, "action": "clear", "trigger": t}
    return {"ok": False, "reason": "unknown_token"}


def pick_multicast_interface(interfaces):
    """Which interface address to join the multicast group on.

    ⚠️ NAMING AN INTERFACE IS NOT OPTIONAL ON A MULTI-HOMED HOST. Joining with no interface lets
    the OS choose, and with docker bridges, a VPN, or wired + wireless up at once it routinely picks
    the wrong one. The join succeeds, nothing logs, and the group is simply never received — which
    is indistinguishable from "the integrator never sent anything".

    `interfaces` is {name: [{family:'IPv4'|4, address, internal}]} (Node's os.networkInterfaces()
    shape). Skip loopback/docker/veth/bridges, take the first real IPv4. Deterministic.
    """
    for name, addrs in (interfaces or {}).items():
        if re.match(r"(lo|docker|veth|br-|virbr)", name):
            continue
        for a in addrs or []:
            if a.get("family") in ("IPv4", 4) and not a.get("internal"):
                return a.get("address")
    return None
