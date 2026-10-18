"""The SPI status screen: what it says (logic/status_panel.py), which framebuffer it picks, the pixels
it writes (system/status_display.py), and the config.txt lines `screentinker-pi status-display` adds.

No panel needed: a fake /sys/class/graphics and a plain file stand in for the fbtft framebuffer."""
import importlib.machinery
import importlib.util
import os
import struct
import types

import pytest

from screentinker_native.logic import status_panel as SP

NOW = 1_800_000_000


def test_headline_states():
    assert SP.headline({"state": "no_server"}) == ("NO SERVER SET", "bad")
    assert SP.headline({"state": "pairing"}) == ("PAIR THIS DISPLAY", "warn")
    assert SP.headline({"state": "offline"}) == ("OFFLINE", "bad")
    assert SP.headline({"state": "online", "playing": "lobby.mp4"}) == ("ONLINE · PLAYING", "ok")
    assert SP.headline({"state": "online"}) == ("ONLINE · NOTHING TO PLAY", "warn")
    assert SP.headline({"state": "online", "blanked": True, "playing": "x"})[1] == "info"
    assert SP.headline({}) == ("STARTING", "muted")


def _row(rows, label):
    return next(r for r in rows if r[0] == label)


def test_rows_flag_the_likely_causes():
    snap = {"state": "online", "playing": "", "server": "https://signage.example.com/", "ip": None,
            "ssid": "Lobby", "rssi": -82, "temp_c": 81.0, "disk_free_mb": 120, "disk_total_mb": 29000,
            "last_error": (NOW - 30, "download failed: 404", "error")}
    rows = SP.rows(snap, NOW)
    assert _row(rows, "Playing") == ("Playing", "nothing", "warn")
    assert _row(rows, "Server") == ("Server", "signage.example.com", "muted")
    assert _row(rows, "IP")[2] == "bad"
    assert _row(rows, "Wi-Fi") == ("Wi-Fi", "Lobby -82 dBm", "warn")
    assert _row(rows, "Temp")[2] == "bad"
    assert _row(rows, "Disk") == ("Disk", "120 MB free of 28.3 GB", "bad")
    assert _row(rows, "Error") == ("Error", "30s ago · download failed: 404", "bad")


def test_rows_healthy_are_all_muted():
    snap = {"state": "online", "playing": "menu.png", "server": "http://10.0.0.5:3001", "ip": "10.0.0.20",
            "temp_c": 52.3, "disk_free_mb": 9000, "disk_total_mb": 29000, "ram_free_mb": 2900,
            "ram_total_mb": 3800, "uptime_s": 3 * 86400 + 4 * 3600}
    rows = SP.rows(snap, NOW)
    assert all(t == "muted" for _, _, t in rows), rows
    assert _row(rows, "Link") == ("Link", "wired", "muted")
    assert _row(rows, "Up")[1] == "3d 4h"
    assert _row(rows, "Temp")[1] == "52 °C"


def test_old_error_and_warnings():
    old = SP.rows({"last_error": (NOW - 2 * 3600, "x", "error")}, NOW)
    assert _row(old, "Error") == ("Error", "2h ago · x", "muted")
    warn = SP.rows({"last_error": (NOW - 5, "slow", "warning")}, NOW)
    assert _row(warn, "Warning")[2] == "warn"
    # The 2-tuple shape is read as an error.
    assert _row(SP.rows({"last_error": (NOW, "y")}, NOW), "Error")[2] == "bad"


def test_pairing_code_is_big_and_screen_off_keeps_what_was_playing():
    v = SP.view({"state": "pairing", "pairing_code": "482913", "version": "3.0.2"}, NOW)
    assert v["big"] == "482913" and v["footer"] == "v3.0.2"
    assert _row(v["rows"], "Code")[1] == "482913"
    assert SP.view({"state": "online", "pairing_code": "1"}, NOW)["big"] == ""
    rows = SP.rows({"blanked": True, "playing": "a.mp4"}, NOW)
    assert _row(rows, "Screen") == ("Screen", "off (was: a.mp4)", "info")


# ------------------------------------------------------------------ framebuffer discovery

def fake_fb(root, n, name, size="320,240", bpp=16, stride=None):
    d = root / ("fb%d" % n)
    d.mkdir(parents=True)
    (d / "name").write_text(name + "\n")
    (d / "virtual_size").write_text(size + "\n")
    (d / "bits_per_pixel").write_text("%d\n" % bpp)
    w = int(size.split(",")[0])
    (d / "stride").write_text("%d\n" % (stride or w * bpp // 8))


def test_find_panel_picks_the_fbtft_one_never_the_main_display(tmp_path):
    from screentinker_native.system.status_display import find_panel
    sysfs = tmp_path / "sys"
    fake_fb(sysfs, 0, "vc4drmfb", "1920,1080", 32)
    fake_fb(sysfs, 1, "fb_ili9341", "320,240", 16)
    p = find_panel("auto", str(sysfs), "/dev")
    assert p["path"] == "/dev/fb1" and p["name"] == "fb_ili9341"
    assert (p["width"], p["height"], p["bpp"], p["stride"]) == (320, 240, 16, 640)
    assert find_panel("off", str(sysfs)) is None
    assert find_panel("/dev/fb0", str(sysfs))["name"] == "vc4drmfb"      # explicit wins
    # Probe order can make the panel fb0: still found by name.
    sysfs2 = tmp_path / "sys2"
    fake_fb(sysfs2, 0, "fb_ili9341", "240,320")
    fake_fb(sysfs2, 1, "vc4drmfb", "1920,1080", 32)
    assert find_panel(None, str(sysfs2), "/dev")["path"] == "/dev/fb0"


def test_find_panel_without_one(tmp_path):
    from screentinker_native.system.status_display import find_panel
    sysfs = tmp_path / "sys"
    fake_fb(sysfs, 0, "vc4drmfb", "1920,1080", 32)
    assert find_panel("auto", str(sysfs)) is None
    assert find_panel("auto", str(tmp_path / "missing")) is None


# ------------------------------------------------------------------ pixels

# ⚠️ Drawing text needs a QGuiApplication, and a process has one Qt application for life: other test
# files create a plain QCoreApplication first, and a font then aborts the whole run. So the drawing
# tests (test_qt_*) run in a fresh interpreter, started by test_drawing_in_a_gui_process below.
CHILD = os.environ.get("ST_STATUS_QT_CHILD") == "1"


@pytest.fixture(scope="module")
def qapp():
    if not CHILD:
        pytest.skip("runs in its own process (test_drawing_in_a_gui_process)")
    from PySide6.QtGui import QGuiApplication
    return QGuiApplication.instance() or QGuiApplication([])


def test_drawing_in_a_gui_process():
    if CHILD:
        pytest.skip("this is the child")
    import subprocess
    import sys
    env = dict(os.environ, ST_STATUS_QT_CHILD="1", QT_QPA_PLATFORM="offscreen")
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-k", "test_qt_", __file__],
                       env=env, capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
    assert " passed" in r.stdout and "skipped" not in r.stdout.splitlines()[-1], r.stdout[-500:]


def rgb565(hexcol):
    r, g, b = (int(hexcol[i:i + 2], 16) for i in (1, 3, 5))
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)


@pytest.mark.parametrize("w,h", [(320, 240), (240, 320)])
def test_qt_render_is_native_rgb565_with_the_banner_in_the_tone(qapp, w, h):
    from screentinker_native.system.status_display import frame_bytes, render
    v = SP.view({"state": "online", "playing": "lobby.mp4", "ip": "10.0.0.20",
                 "last_error": (NOW - 9, "x" * 400, "error")}, NOW)
    img = render(v, w, h, 16, "12:34")
    assert (img.width(), img.height(), img.depth()) == (w, h, 16)
    data = frame_bytes(img, w * 2)
    assert len(data) == w * h * 2
    corner = struct.unpack_from("<H", data, 1 * w * 2 + (w - 2) * 2)[0]   # inside the banner
    assert corner == rgb565(SP.TONES["ok"])
    bottom = struct.unpack_from("<H", data, (h - 1) * w * 2)[0]
    assert bottom == rgb565("#0b1220")


def test_qt_frame_bytes_pads_to_a_longer_stride(qapp):
    from screentinker_native.system.status_display import frame_bytes, render
    img = render(SP.view({}, NOW), 240, 320, 16)
    data = frame_bytes(img, 240 * 2 + 32)
    assert len(data) == (240 * 2 + 32) * 320


def test_qt_status_display_writes_only_when_the_frame_changes(qapp, tmp_path, monkeypatch):
    from screentinker_native.system import status_display as SD
    sysfs = tmp_path / "sys"
    fake_fb(sysfs, 1, "fb_ili9341", "320,240")
    dev = tmp_path / "dev"
    dev.mkdir()
    (dev / "fb1").write_bytes(b"\0" * 320 * 240 * 2)
    monkeypatch.setattr(SD, "telemetry", lambda state_dir: {"ip": "10.0.0.20", "temp_c": 50.0})
    writes = []
    real = os.pwrite
    monkeypatch.setattr(SD.os, "pwrite", lambda fd, b, off: (writes.append(len(b)), real(fd, b, off))[1])
    snap = {"state": "pairing", "pairing_code": "123456", "server": "http://s"}
    t = [NOW]
    sd = SD.StatusDisplay(lambda: dict(snap), str(tmp_path), "auto", str(sysfs), str(dev), clock=lambda: t[0])
    try:
        assert sd.start() is True
        assert writes == [320 * 240 * 2]
        sd.tick()
        assert len(writes) == 1, "an unchanged frame is not resent"
        snap["state"] = "online"
        sd.tick()
        assert len(writes) == 2
        t[0] += SD.REWRITE_S + 1
        sd.tick()
        assert len(writes) == 3, "rewritten now and then even when unchanged"
        assert (dev / "fb1").read_bytes() != b"\0" * 320 * 240 * 2
    finally:
        sd.stop()


def test_status_display_is_off_without_a_panel(tmp_path):
    from screentinker_native.system.status_display import StatusDisplay
    sd = StatusDisplay(lambda: {}, str(tmp_path), "auto", str(tmp_path / "none"), str(tmp_path))
    assert sd.start() is False
    sd.tick()      # harmless


def test_last_problem_keeps_the_latest_warning_or_error():
    import logging
    from screentinker_native.system.status_display import LastProblem
    h = LastProblem()
    lg = logging.getLogger("st-test-lastproblem")
    lg.addHandler(h)
    try:
        lg.info("fine")
        assert h.last is None
        lg.warning("slow download\nsecond line")
        assert h.last[1:] == ("slow download", "warning")
        lg.error("decoder died")
        assert h.last[1:] == ("decoder died", "error")
    finally:
        lg.removeHandler(h)


def test_app_snapshot_states():
    from screentinker_native.app import App
    item = types.SimpleNamespace(filename="lobby.mp4")

    def fake(server="http://s", paired=True, connected=True, last=("registered", True), mode="single", on=True):
        cfg = types.SimpleNamespace(server_url=server, is_paired=paired, get=lambda k, d=None: {"pairing_code": "42"}.get(k, d))
        ctl = types.SimpleNamespace(current_item=item, has_content_on_screen=on)
        return types.SimpleNamespace(config=cfg, link=types.SimpleNamespace(connected=connected), _last_status=last,
                                     engine=types.SimpleNamespace(mode=mode, controller=ctl), blanked=False,
                                     last_problem=types.SimpleNamespace(last=None))
    snap = App.status_panel_snapshot
    assert snap(fake())["state"] == "online" and snap(fake())["playing"] == "lobby.mp4"
    assert snap(fake(server=""))["state"] == "no_server"
    assert snap(fake(paired=False))["state"] == "pairing"
    assert snap(fake(connected=False, last=("disconnected", "x")))["state"] == "offline"
    assert snap(fake(connected=False, last=None))["state"] == "starting"
    assert snap(fake(last=("unpaired", "x")))["state"] == "unpaired"
    assert snap(fake(mode="zones"))["playing"] == "multi-zone layout"
    assert snap(fake(on=False))["playing"] == ""


# ------------------------------------------------------------------ screentinker-pi status-display

LAUNCHER = os.path.join(os.path.dirname(__file__), "..", "packaging", "linux", "screentinker-pi")


@pytest.fixture
def launcher(tmp_path, monkeypatch):
    loader = importlib.machinery.SourceFileLoader("st_launcher_sd", LAUNCHER)
    spec = importlib.util.spec_from_loader("st_launcher_sd", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    mod.SYSTEM_CONFIG = str(tmp_path / "config.json")
    boot = tmp_path / "config.txt"
    boot.write_text("dtparam=audio=on\n[cm5]\ndtoverlay=dwc2,dr_mode=host\n")
    mod.BOOT_CONFIGS = (str(boot),)
    monkeypatch.setattr(mod, "need_root", lambda: None)
    return mod, boot


def run_sd(mod, action, **kw):
    a = dict(action=action, rotate=90, rgb=False, speed=32000000)
    a.update(kw)
    return mod.cmd_status_display(types.SimpleNamespace(**a))


def test_enable_adds_one_block_under_all_and_is_idempotent(launcher, capsys):
    mod, boot = launcher
    run_sd(mod, "enable")
    text = boot.read_text()
    assert text.startswith("dtparam=audio=on\n[cm5]\ndtoverlay=dwc2,dr_mode=host\n\n# >>> screentinker-pi")
    block = text.split("# >>>", 1)[1]
    assert "\n[all]\ndtparam=spi=on\ndtoverlay=fbtft,spi0-0,ili9341,bgr,speed=32000000,dc_pin=24,reset_pin=25,led_pin=18,rotate=90\n" in block
    assert (boot.parent / "config.txt.screentinker-bak").read_text().startswith("dtparam=audio=on")
    out = capsys.readouterr().out
    assert "DC/RS    18 (GPIO24)" in out and "reboot" in out
    run_sd(mod, "enable")
    assert boot.read_text() == text, "running it twice changes nothing"
    run_sd(mod, "enable", rotate=0, rgb=True)
    t2 = boot.read_text()
    assert t2.count("# >>> screentinker-pi") == 1 and ",ili9341,speed=" in t2 and "rotate=0" in t2
    import json
    assert json.load(open(mod.SYSTEM_CONFIG))["status_display"] == "auto"


def test_disable_removes_only_our_block(launcher):
    mod, boot = launcher
    original = boot.read_text()
    run_sd(mod, "enable")
    run_sd(mod, "disable")
    assert boot.read_text() == original
    import json
    assert json.load(open(mod.SYSTEM_CONFIG))["status_display"] == "off"


def test_enable_warns_about_another_spi_display(launcher, capsys):
    mod, boot = launcher
    boot.write_text(boot.read_text() + "dtoverlay=mipi-dbi-spi,spi0-0,speed=48000000\n")
    run_sd(mod, "enable")
    assert "already sets up an SPI display" in capsys.readouterr().out


def test_test_pattern_bands(launcher):
    mod, _ = launcher
    data = mod.status_test_pattern(4, 8, 16)
    assert len(data) == 4 * 8 * 2
    assert struct.unpack_from("<H", data, 0)[0] == 0xF800                    # red on top
    assert struct.unpack_from("<H", data, 2 * 4 * 2)[0] == 0x07E0            # then green
    assert struct.unpack_from("<H", data, 4 * 4 * 2)[0] == 0x001F            # blue
    assert struct.unpack_from("<H", data, 7 * 4 * 2)[0] == 0xFFFF            # white


def test_qt_the_error_is_never_pushed_off_a_landscape_panel(qapp):
    """Landscape 320x240 has room for about ten rows: uptime, RAM and the name give way to the error."""
    from PySide6.QtGui import QImage
    from screentinker_native.system.status_display import render
    full = {"state": "offline", "name": "Lobby", "playing": "a.mp4", "server": "http://s", "ip": "10.0.0.2",
            "ssid": "Office", "rssi": -60, "temp_c": 50.0, "disk_free_mb": 9000, "disk_total_mb": 29000,
            "ram_free_mb": 2000, "ram_total_mb": 3800, "uptime_s": 99999}
    ok = render(SP.view(full, NOW), 320, 240, 16).convertToFormat(QImage.Format.Format_RGB32)
    err = render(SP.view({**full, "last_error": (NOW - 5, "decoder died", "error")}, NOW), 320, 240, 16) \
        .convertToFormat(QImage.Format.Format_RGB32)
    probe = QImage(1, 1, QImage.Format.Format_RGB16)       # the tone as RGB565 can hold it
    from PySide6.QtGui import QColor
    probe.fill(QColor(SP.TONES["bad"]))
    bad = probe.convertToFormat(QImage.Format.Format_RGB32).pixel(0, 0) & 0xFFFFFF

    def red_pixels_below(img, y0):
        return sum(1 for y in range(y0, img.height() - 16) for x in range(img.width())
                   if (img.pixel(x, y) & 0xFFFFFF) == bad)
    assert red_pixels_below(ok, 40) == 0
    assert red_pixels_below(err, 40) > 20, "the error text is drawn below the banner"


def test_qt_wrap_keeps_whole_lines_and_marks_a_cut(qapp):
    from PySide6.QtGui import QFont, QFontMetrics
    from screentinker_native.system.status_display import wrap
    f = QFont()
    f.setPixelSize(13)
    fm = QFontMetrics(f)
    text = "connect failed: Cannot connect to host signage.example.com:443 ssl:default [Network is unreachable]"
    full = wrap(text, fm, 200, 10)
    assert " ".join(full) == text and all(fm.horizontalAdvance(l) <= 200 for l in full)
    two = wrap(text, fm, 200, 2)
    assert len(two) == 2 and two[0] == full[0] and two[1].endswith("…")
    assert full[1].startswith(two[1][:-1]) and fm.horizontalAdvance(two[1]) <= 200, two
    assert wrap("short", fm, 200, 1) == ["short"]
