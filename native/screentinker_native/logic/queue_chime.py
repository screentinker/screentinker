"""The "Now serving" queue chime (docs/now-serving-queue.md), the pure rules on the native player.

The queue widget (server/lib/queue/widget.js chime()) asks its player to chime once per called
number. The web player hears a postMessage from the widget's iframe (server/player/index.html
playQueueChime). The native player mounts a widget as the TOP-LEVEL page of a QtWebEngine view
(engine.item_dict -> Slot.qml `url = source`), so there is no parent to tell: the page calls
window.STQueueChime.chime(volume), as on Android (QueueChime.kt, QueueChimeBridge.kt).

QtWebEngine has no Android-style JavaScript interface, so the bridge is the console channel the
player already uses for #624 (YouTube) and #649 (bundle skip): bridge_script() defines
STQueueChime on the widget page, and a call logs "ST_QUEUE_CHIME <token> <volume>". The console
carries every frame's messages, so the engine honours a line only with the random token of the
widget mounted now (a frame the widget embeds cannot read it), and only when the view's own URL is
still that widget's render page (same_widget_page). The engine then applies the screen's sound rules
and the gate below; the worst a page that slips through can do is one short chime per 3 s.

Same contract as the web player and Android:
  * one short sound of two tones (880 Hz then 660 Hz, ~0.9 s), synthesised, never looped;
  * at most one chime per MIN_GAP_MS, so a burst of calls is one chime, never a run;
  * volume 0..1 from the widget's own setting (DEFAULT_VOLUME when unusable), 0 plays nothing.

No Qt here: tests/test_queue_chime.py pins these rules without a display or a sound card.
"""
from __future__ import annotations

import array
import math
import re
import secrets
import sys
import time
import urllib.parse

BRIDGE = "STQueueChime"
CONSOLE_PREFIX = "ST_QUEUE_CHIME "
MIN_GAP_MS = 3000
DEFAULT_VOLUME = 0.6
SAMPLE_RATE = 44100
# The two tones: frequency (Hz), start (s), length (s). Identical to the web player and Android.
TONES = ((880.0, 0.0, 0.35), (660.0, 0.38, 0.5))
ATTACK_S = 0.02
TAIL_S = 0.05
FLOOR = 0.0001

_TOKEN = re.compile(r"[A-Za-z0-9]{1,64}")
# A plain decimal number, as Kotlin's toFloatOrNull reads one (Python's float() would also take
# "1_0", "inf" and "nan").
_NUMBER = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
_WIDGET_PAGE = re.compile(r"^https?://[^?#]+/api/widgets/[^/?#]+/render(?:[?#]|$)")


def volume(raw) -> float:
    """The widget's volume as 0..1. Anything that is not a finite number is DEFAULT_VOLUME."""
    if isinstance(raw, bool):
        return DEFAULT_VOLUME
    if isinstance(raw, (int, float)):
        v = float(raw)
    elif isinstance(raw, str) and _NUMBER.fullmatch(raw.strip()):
        v = float(raw.strip())
    else:
        return DEFAULT_VOLUME
    if not math.isfinite(v):
        return DEFAULT_VOLUME
    return max(0.0, min(1.0, v))


def is_widget_page(url) -> bool:
    """Whether a page at `url` may ask for a chime at all: only a widget render page (Android's rule)."""
    return isinstance(url, str) and bool(_WIDGET_PAGE.search(url))


def _origin_path(url):
    try:
        u = urllib.parse.urlsplit(url)
        port = u.port or {"http": 80, "https": 443}.get(u.scheme)
    except ValueError:
        return None
    return u.scheme.lower(), (u.hostname or "").lower(), port, u.path


def same_widget_page(url, mounted) -> bool:
    """`url` (what the view shows now) is still the widget render page that was mounted: both are
    widget pages with the same origin and path (the query and fragment may differ in spelling, QUrl
    normalises them). A page that navigated anywhere else is refused."""
    if not (is_widget_page(url) and is_widget_page(mounted)):
        return False
    a, b = _origin_path(url), _origin_path(mounted)
    return a is not None and a == b


class Gate:
    """At most one chime per `gap_ms`. `clock` (milliseconds) is injectable for tests."""

    def __init__(self, gap_ms=MIN_GAP_MS, clock=None):
        self.gap_ms = gap_ms
        self.clock = clock or (lambda: time.monotonic() * 1000.0)
        self.last = None

    def admit(self) -> bool:
        now = self.clock()
        if self.last is not None and now - self.last < self.gap_ms:
            return False
        self.last = now
        return True


def new_token() -> str:
    return secrets.token_hex(16)


def bridge_script(token: str) -> str:
    """The script the player runs in the widget page's main world after each load (Slot.qml). It
    defines window.STQueueChime.chime(volume), which only logs; Python decides everything."""
    if not _TOKEN.fullmatch(token or ""):
        raise ValueError("token")
    return ("(function(){try{var t='%s',l=console.log.bind(console);"
            "window.%s={chime:function(v){try{l('%s'+t+' '+String(v).slice(0,32).replace(/\\s+/g,''))}catch(e){}}}"
            "}catch(e){}})()") % (token, BRIDGE, CONSOLE_PREFIX)


def parse_console(detail, token):
    """Slot.qml's "<token> <volume> <view url>" -> (True, raw_volume, url) when the token is THIS
    mount's, else (False, None, None)."""
    if not isinstance(detail, str) or not token:
        return False, None, None
    parts = detail.split(" ", 2)
    if len(parts) != 3:
        return False, None, None
    got, raw, url = parts
    if not secrets.compare_digest(got.encode("utf-8", "replace"), token.encode("utf-8")):
        return False, None, None
    return True, raw, url


def total_samples(sample_rate=SAMPLE_RATE) -> int:
    return int((max(at + n for _, at, n in TONES) + TAIL_S) * sample_rate)


def synth(vol, sample_rate=SAMPLE_RATE):
    """The chime as mono float samples in -1..1: each tone rises in 20 ms from FLOOR to 0.5*vol and
    decays exponentially back to FLOOR over the rest of its length, like the web player's gain ramps
    (Android QueueChime.synth, sample for sample). `vol` 0 is silence; the caller plays nothing."""
    v = max(0.0, min(1.0, float(vol)))
    out = [0.0] * total_samples(sample_rate)
    if not v > 0.0:
        return out
    peak = max(0.0002, 0.5 * v)
    attack = int(ATTACK_S * sample_rate)
    rise = math.log(peak / FLOOR)
    fall = math.log(FLOOR / peak)
    for freq, at, length in TONES:
        start = int(at * sample_rate)
        n = int(length * sample_rate)
        w = 2.0 * math.pi * freq / sample_rate
        for i in range(n):
            idx = start + i
            if idx >= len(out):
                break
            if i < attack:
                g = FLOOR * math.exp(rise * i / attack)
            else:
                g = peak * math.exp(fall * (i - attack) / (n - attack))
            out[idx] += g * math.sin(w * i)
    return out


def pcm16(vol, sample_rate=SAMPLE_RATE) -> bytes:
    """synth() as signed 16-bit little-endian mono PCM, what the audio sink plays."""
    a = array.array("h", (int(max(-1.0, min(1.0, s)) * 32767) for s in synth(vol, sample_rate)))
    if sys.byteorder != "little":
        a.byteswap()
    return a.tobytes()
