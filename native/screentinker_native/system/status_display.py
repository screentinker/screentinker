"""A small SPI status screen next to the main display (logic/status_panel.py decides what it says).

The panel (e.g. an ILI9341 2.4" 240x320) is driven by the kernel's fbtft driver, set up by
`screentinker-pi status-display enable`. That gives a plain framebuffer, /dev/fbN, and nothing else.
⚠️ Deliberately NOT the newer DRM drivers (panel-mipi-dbi, tiny/ili9341): those add a second DRM
card and connector, and eglfs (Lite) or the desktop compositor would then treat the little panel as
a display to draw the player on. A framebuffer is invisible to both, so the player draws its status
page into it here and the main output is untouched.

Found by name: fbtft framebuffers are called "fb_<controller>" (fb_ili9341, fb_ili9486, fb_st7789v),
so any fbtft panel works and the numbering (fb0 vs fb1 depends on probe order) does not matter.
System config `status_display` (or ST_STATUS_DISPLAY): "auto" (default: use one if present), "off",
or a device path.

Threads: the slow readings (Wi-Fi asks iwgetid, which can take seconds) are taken on a thread of
their own; drawing and writing run on the Qt thread from a timer, a few milliseconds every 2 s.
"""

import logging
import os
import threading
import time

from ..logic import status_panel

log = logging.getLogger("status-display")

SYSFS = "/sys/class/graphics"
TICK_MS = 2000
TELEMETRY_S = 10
REWRITE_S = 30          # rewrite an unchanged frame now and then: heals anything else that drew on it


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def describe(fb, sysfs=SYSFS):
    """Geometry of /sys/class/graphics/<fb>: {name, width, height, bpp, stride}, or None."""
    d = os.path.join(sysfs, fb)
    try:
        w, h = (int(x) for x in (_read(os.path.join(d, "virtual_size")) or "").split(","))
        bpp = int(_read(os.path.join(d, "bits_per_pixel")) or 0)
    except ValueError:
        return None
    if w <= 0 or h <= 0 or bpp not in (16, 32):
        return None
    try:
        stride = int(_read(os.path.join(d, "stride")) or 0)
    except ValueError:
        stride = 0
    return {"name": _read(os.path.join(d, "name")) or "", "width": w, "height": h, "bpp": bpp,
            "stride": stride or w * bpp // 8}


def find_panel(setting, sysfs=SYSFS, dev="/dev"):
    """The framebuffer to draw on: {path, name, width, height, bpp, stride}, or None.

    "off" → None. A path → that device. "auto"/empty → the first fbtft framebuffer (name "fb_…");
    never the main display's own framebuffer (vc4drmfb / simple-framebuffer), whatever its number."""
    setting = (setting or "auto").strip()
    if setting.lower() in ("off", "0", "false", "no", "none"):
        return None
    if setting.lower() not in ("auto", "on", "1", "true", "yes"):
        fb = os.path.basename(setting)
        info = describe(fb, sysfs)
        if info:
            info["path"] = setting
        return info
    try:
        fbs = sorted((n for n in os.listdir(sysfs) if n.startswith("fb") and n[2:].isdigit()), key=lambda n: int(n[2:]))
    except OSError:
        return None
    for fb in fbs:
        info = describe(fb, sysfs)
        if info and info["name"].startswith("fb_"):
            info["path"] = os.path.join(dev, fb)
            return info
    return None


def render(v, width, height, bpp, clock_text=""):
    """Draw a status_panel.view() onto a QImage in the framebuffer's own pixel format."""
    from PySide6.QtCore import QRect, Qt
    from PySide6.QtGui import QColor, QFont, QFontMetrics, QImage, QPainter

    fmt = QImage.Format.Format_RGB16 if bpp == 16 else QImage.Format.Format_RGB32
    img = QImage(width, height, fmt)
    img.fill(QColor("#0b1220"))
    p = QPainter(img)
    try:
        p.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
        s = min(width, height) / 240.0          # designed for 240 px on the short side
        pad = int(6 * s)

        def font(px, bold=False):
            f = QFont()
            f.setPixelSize(max(8, int(px * s)))
            f.setBold(bold)
            return f

        # Banner: the one line to read from across the room.
        bh = int(30 * s)
        p.fillRect(0, 0, width, bh, QColor(status_panel.TONES[v["tone"]]))
        p.setPen(QColor("#0b1220"))
        p.setFont(font(16, True))
        p.drawText(QRect(pad, 0, width - 2 * pad, bh), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft,
                   QFontMetrics(p.font()).elidedText(v["title"], Qt.TextElideMode.ElideRight, width - 2 * pad))
        y = bh + pad

        # Pairing: the code, large enough to type from.
        if v.get("big"):
            p.setFont(font(44, True))
            p.setPen(QColor(status_panel.TONES["warn"]))
            ch = int(52 * s)
            p.drawText(QRect(0, y, width, ch), Qt.AlignmentFlag.AlignCenter, v["big"])
            y += ch

        fh = int(16 * s)                        # footer height
        p.setFont(font(13))
        fm = QFontMetrics(p.font())
        rh = fm.height() + int(2 * s)
        rows = [r for r in v["rows"] if r[0] != "Code"]       # the code is already shown large
        lw = max(fm.horizontalAdvance(r[0]) for r in rows) + pad * 2 if rows else 0
        # Short of room (landscape, or the pairing code above), the error needs at least two lines more
        # than uptime, RAM or the name do: those give way first, in that order.
        has_err = any(r[0] in ("Error", "Warning") for r in rows)
        room = (height - fh - y) // rh
        for drop in ("Up", "RAM", "Name", "Link"):
            if len(rows) + (1 if has_err else 0) <= room:
                break
            rows = [r for r in rows if r[0] != drop or r[2] != "muted"]
        for label, value, tone in rows:
            last = (label in ("Error", "Warning"))
            avail = height - fh - y
            if avail < rh:
                break
            p.setPen(QColor(status_panel.TONES["muted"]))
            p.drawText(QRect(pad, y, lw, rh), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop, label)
            p.setPen(QColor("#e2e8f0") if tone == "muted" else QColor(status_panel.TONES[tone]))
            vw = width - lw - 2 * pad
            if last:
                # The error is the row most worth reading whole: it wraps into whatever space is left.
                lines = wrap(value, fm, vw, max(1, avail // fm.lineSpacing()))
                for i, line in enumerate(lines):
                    p.drawText(QRect(pad + lw, y + i * fm.lineSpacing(), vw, rh),
                               Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop, line)
                y += avail
            else:
                p.drawText(QRect(pad + lw, y, vw, rh), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop,
                           fm.elidedText(value, Qt.TextElideMode.ElideRight, vw))
                y += rh

        p.setFont(font(11))
        p.setPen(QColor(status_panel.TONES["muted"]))
        p.drawText(QRect(pad, height - fh, width - 2 * pad, fh), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft,
                   "ScreenTinker " + v.get("footer", ""))
        p.drawText(QRect(pad, height - fh, width - 2 * pad, fh), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignRight,
                   clock_text)
    finally:
        p.end()
    return img


def wrap(text, fm, width, max_lines):
    """Greedy word wrap into at most max_lines whole lines; when cut, the last one ends in "…"."""
    from PySide6.QtCore import Qt
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = cur + " " + w if cur else w
        if cur and fm.horizontalAdvance(t) > width:
            lines.append(cur)
            t = w
        cur = t
    if cur:
        lines.append(cur)
    cut = len(lines) > max_lines
    lines = lines[:max_lines]
    if cut:
        t = lines[-1]
        while t and fm.horizontalAdvance(t + "…") > width:
            t = t[:-1]
        lines[-1] = t.rstrip() + "…"
    return [fm.elidedText(l, Qt.TextElideMode.ElideRight, width) for l in lines]


def frame_bytes(img, stride):
    """The QImage's pixels laid out with the framebuffer's line length."""
    bpl = img.bytesPerLine()
    raw = bytes(img.constBits())[: bpl * img.height()]
    if bpl == stride:
        return raw
    row = img.width() * img.depth() // 8
    pad = b"\0" * max(0, stride - row)
    return b"".join(raw[i * bpl: i * bpl + row] + pad for i in range(img.height()))


def telemetry(state_dir):
    """The slow OS readings, each optional (a backend may not have it)."""
    from ..platform import deviceinfo
    out = {}

    def take(fn, *a):
        f = getattr(deviceinfo, fn, None)
        try:
            return f(*a) if f else None
        except Exception:
            return None
    ips = take("local_ips")
    out["ip"] = ips[0] if ips else None
    w = take("wifi")
    if w:
        out["ssid"], out["rssi"] = w
    out["temp_c"] = take("temperature_c")
    s = take("storage_mb", state_dir)
    if s:
        out["disk_free_mb"], out["disk_total_mb"] = s
    m = take("meminfo_mb")
    if m:
        out["ram_free_mb"], out["ram_total_mb"] = m
    out["uptime_s"] = take("uptime_seconds")
    return out


class LastProblem(logging.Handler):
    """Keeps the most recent warning or error the player logged, for the panel's last row."""

    def __init__(self):
        super().__init__(logging.WARNING)
        self.last = None

    def emit(self, record):
        try:
            msg = record.getMessage().splitlines()[0][:300]
        except Exception:
            return
        self.last = (record.created, msg, "error" if record.levelno >= logging.ERROR else "warning")


class StatusDisplay:
    """Draws the status page on the panel every TICK_MS. start() is a no-op without a panel."""

    def __init__(self, snapshot, state_dir, setting="auto", sysfs=SYSFS, dev="/dev", clock=time.time):
        self.snapshot = snapshot              # () -> dict, called on the Qt thread
        self.state_dir = state_dir
        self.setting = setting
        self.sysfs, self.dev = sysfs, dev
        self.clock = clock
        self.panel = None
        self._fd = None
        self._timer = None
        self._tele = {}
        self._stop = threading.Event()
        self._last = None
        self._last_at = 0.0

    def start(self):
        self.panel = find_panel(self.setting, self.sysfs, self.dev)
        if not self.panel:
            return False
        try:
            self._fd = os.open(self.panel["path"], os.O_WRONLY)
        except OSError as e:
            log.warning("status display %s found but cannot be opened (%s); the player's user needs the "
                        "video group", self.panel["path"], e)
            self.panel = None
            return False
        log.info("status display: %s (%s, %dx%d)", self.panel["path"], self.panel["name"],
                 self.panel["width"], self.panel["height"])
        self._tele = telemetry(self.state_dir)
        threading.Thread(target=self._telemetry_loop, name="status-display", daemon=True).start()
        from PySide6.QtCore import QTimer
        self._timer = QTimer()
        self._timer.timeout.connect(self.tick)
        self._timer.start(TICK_MS)
        self.tick()
        return True

    def _telemetry_loop(self):
        while not self._stop.wait(TELEMETRY_S):
            try:
                self._tele = telemetry(self.state_dir)
            except Exception:
                log.exception("status display telemetry failed")

    def tick(self):
        if self._fd is None:
            return
        try:
            now = self.clock()
            v = status_panel.view({**self._tele, **self.snapshot()}, now)
            pnl = self.panel
            img = render(v, pnl["width"], pnl["height"], pnl["bpp"], time.strftime("%H:%M", time.localtime(now)))
            data = frame_bytes(img, pnl["stride"])
            if data == self._last and now - self._last_at < REWRITE_S:
                return
            os.pwrite(self._fd, data, 0)
            self._last, self._last_at = data, now
        except OSError as e:
            # The panel went away (driver unloaded, cable): stop, once, rather than log every 2 s.
            log.warning("status display stopped: %s", e)
            self.stop()
        except Exception:
            log.exception("status display draw failed")

    def stop(self):
        self._stop.set()
        if self._timer is not None:
            self._timer.stop()
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None
