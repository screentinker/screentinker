"""Which display the kiosk window goes on (`--display` or ST_DISPLAY).

A Mac mini or a signage PC often drives two outputs, and full screen on "the primary" is whichever one
the OS currently calls primary — which a monitor being power-cycled can change. A display that does
not exist (yet) falls back to the primary screen rather than failing to start: a sign that shows
content on the wrong output is recoverable remotely, one that never starts is not. The window moves
to the wanted display when it appears (app.py re-places on screen changes).

Three ways to name a display (#927):
  N         the Nth screen Qt lists, 0 = the first. Simple, but Windows can renumber screens when a
            monitor is off at boot.
  @X,Y      the screen whose desktop area contains the point X,Y, like Windows' display arrangement
            ("@1920,0" = the monitor to the right of a 1920-wide primary). Stable across reboots as
            long as the arrangement in Display settings is unchanged. The Xibo-style way.
  TEXT      a screen whose name, model or serial number contains TEXT (case-insensitive), for
            example "DISPLAY2" or a serial printed on the monitor.
"""

import os
import re

_POINT = re.compile(r"^@\s*(-?\d+)\s*[,x]\s*(-?\d+)$")


def wanted(arg=None, env=None):
    """Parse --display / ST_DISPLAY. Returns None, ("index", n), ("point", x, y) or ("name", text)."""
    raw = arg if arg is not None else (env if env is not None else os.environ.get("ST_DISPLAY"))
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    if re.fullmatch(r"-?\d+", s):
        n = int(s)
        return ("index", n) if n >= 0 else None
    m = _POINT.match(s)
    if m:
        return ("point", int(m.group(1)), int(m.group(2)))
    if s.startswith("@"):
        return None
    return ("name", s)


def wanted_index(arg=None, env=None):
    """Back-compat: the index form only (None for anything else)."""
    w = wanted(arg, env)
    return w[1] if w and w[0] == "index" else None


def _geom(screen):
    g = screen.geometry()
    return g.x(), g.y(), g.width(), g.height()


def _idents(screen):
    out = []
    for attr in ("name", "model", "serialNumber", "manufacturer"):
        try:
            v = getattr(screen, attr)()
        except Exception:
            v = None
        if v:
            out.append(str(v))
    return out


def find(screens, spec, geom=_geom, idents=_idents):
    """The screen `spec` names, or None when it is not connected (or spec is None)."""
    if not spec:
        return None
    kind = spec[0]
    if kind == "index":
        i = spec[1]
        return screens[i] if 0 <= i < len(screens) else None
    if kind == "point":
        px, py = spec[1], spec[2]
        for s in screens:
            x, y, w, h = geom(s)
            if x <= px < x + w and y <= py < y + h:
                return s
        return None
    if kind == "name":
        needle = spec[1].lower()
        for s in screens:
            if any(needle in v.lower() for v in idents(s)):
                return s
        return None
    return None


def pick(screens, primary, index_or_spec, geom=_geom, idents=_idents):
    """The screen to use: the wanted one, else the primary. Accepts an index (old callers) or a spec."""
    spec = index_or_spec
    if isinstance(spec, int):
        spec = ("index", spec)
    return find(screens, spec, geom, idents) or primary


def window_is_off(win, target):
    """True when a window (x, y, w, h) is not where its screen (x, y, w, h) wants it: its centre is outside
    the screen, or it no longer covers it. Small differences (a fullscreen frame a pixel off) are fine, so
    the watch in app.py never fights Windows over nothing (#927)."""
    wx, wy, ww, wh = win
    tx, ty, tw, th = target
    cx, cy = wx + ww / 2, wy + wh / 2
    if not (tx <= cx < tx + tw and ty <= cy < ty + th):
        return True
    return ww < tw * 0.9 or wh < th * 0.9
