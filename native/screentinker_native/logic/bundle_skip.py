"""#649: an HTML bundle can ask the player to skip it — the pure rules, ported from
server/lib/bundle-skip.js.

    parent.postMessage({ type: 'screentinker:skip', reason: 'offline' }, '*')

CONTRACT: the same behaviour as the JS module (web, Tizen) and Android's BundleSkip.kt. All three are
checked against shared/bundle-skip-vectors.json (tests/test_bundle_skip.py here).

    is_skip_message(data) -> is this (parsed) message a skip request at all
    sanitize_reason(raw)  -> the optional reason as one short printable line, or None
    Guard(min_run_ms)     -> the anti-spin rule, one per rotation (the main playlist, or one zone)

The native player mounts a bundle as a top-level document (QtWebEngine loadHtml), so the bundle's
`parent` is its own window. inject() puts a small listener first in the document that reports a skip
on the console as "ST_BUNDLE_SKIP <token> <reason>" — the channel #624's YouTube page already uses —
but only when the message's source is the bundle's own window. The console carries every frame's
messages, so the engine honours a line only with the random token of the bundle mounted now; a
frame the bundle embeds cannot know it (the listener removes its own script element).
"""
from __future__ import annotations

import re
import secrets

MESSAGE_TYPE = "screentinker:skip"
REASON_MAX = 64
MIN_RUN_MS = 1000
CONSOLE_PREFIX = "ST_BUNDLE_SKIP "

_CONTROL = re.compile("[\u0000-\u001f\u007f-\u009f\u2028\u2029]")
# JavaScript's \s, so a reason is trimmed and collapsed exactly as the JS players do it.
_JS_SPACE = "[ \t\n\u000b\u000c\r\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]"
_SPACES = re.compile(_JS_SPACE + "+")
_TOKEN = re.compile(r"[A-Za-z0-9]{1,64}")


def is_skip_message(data) -> bool:
    return isinstance(data, dict) and data.get("type") == MESSAGE_TYPE


def sanitize_reason(raw):
    if not isinstance(raw, str):
        return None
    s = _SPACES.sub(" ", _CONTROL.sub(" ", raw)).strip(" ")   # every JS space is a " " by now
    if not s:
        return None
    return s[:REASON_MAX]          # a Python str indexes by code point: an emoji is never split


class Guard:
    """decide() -> 'skip' (honoured) or why not: 'sync' (a shared clock), 'alone' (nothing else to move
    on to), 'repeat' (already skipped since an item last ran to its normal end). ended() is called when
    an item leaves the screen any other way; a run under min_run_ms does not end the pass."""

    def __init__(self, min_run_ms=MIN_RUN_MS):
        self.min_run_ms = min_run_ms
        self.skipped = set()

    def decide(self, key, can_advance, sync_driven) -> str:
        if sync_driven:
            return "sync"
        if not can_advance:
            return "alone"
        k = str(key)
        if k in self.skipped:
            return "repeat"
        self.skipped.add(k)
        return "skip"

    def ended(self, ran_ms):
        if ran_ms is not None and ran_ms >= self.min_run_ms:
            self.skipped.clear()

    def reset(self):
        self.skipped.clear()


def ignored_text(why: str) -> str:
    return {"sync": "this screen is on a shared clock (wall or synced group)",
            "alone": "there is nothing else to play",
            "repeat": "it already skipped this pass, so it plays its duration"}.get(why, why)


def new_token() -> str:
    return secrets.token_hex(16)


def bridge_script(token: str) -> str:
    if not _TOKEN.fullmatch(token or ""):
        raise ValueError("token")
    return ("<script>(function(){var s=document.currentScript;try{if(s&&s.parentNode)s.parentNode.removeChild(s)}catch(x){}"
            "var t='%s';window.addEventListener('message',function(e){try{var d=e.data;"
            "if(e.source!==window||!d||typeof d!=='object'||d.type!=='%s')return;"
            "console.log('%s'+t+' '+(typeof d.reason==='string'?d.reason.slice(0,256):''))}catch(x){}});})();</script>"
            ) % (token, MESSAGE_TYPE, CONSOLE_PREFIX)


_HEAD = re.compile(r"<head(\s[^>]*)?>", re.I)
_HTML = re.compile(r"<html(\s[^>]*)?>", re.I)
_DOCTYPE = re.compile(r"^\s*<!doctype[^>]*>", re.I)


def inject(html: str, token: str) -> str:
    """`html` with the listener as the first thing the parser runs: after <head>, else after <html>,
    else after the doctype, else at the start. Never before a doctype (that is quirks mode)."""
    script = bridge_script(token)
    for rx in (_HEAD, _HTML, _DOCTYPE):
        m = rx.search(html)
        if m:
            return html[:m.end()] + script + html[m.end():]
    return script + html


def parse_console(message, token):
    """A console line from the bundle page -> (True, raw_reason) when it is THIS mount's skip, else
    (False, None)."""
    if not isinstance(message, str) or not message.startswith(CONSOLE_PREFIX) or not token:
        return False, None
    rest = message[len(CONSOLE_PREFIX):]
    got, _, reason = rest.partition(" ")
    if not secrets.compare_digest(got, token):
        return False, None
    return True, reason
