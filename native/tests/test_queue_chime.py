"""The "Now serving" queue chime on the native player: logic/queue_chime.py (the same rules as the web
player's playQueueChime and Android's QueueChime.kt / QueueChimeTest.kt), the bridge script run in a
JS engine, and the engine's decision with a recording fake app.

⚠️ SILENT: nothing here constructs ui/extras.QueueChimePlayer or any audio sink. The fake app records
the chimes the engine would play; no sound reaches a speaker and no window opens.
"""
import math
import os
import re

import pytest

from screentinker_native.logic import queue_chime as QC

QML = os.path.join(os.path.dirname(__file__), "..", "screentinker_native", "ui", "qml")


# --- the pure rules -------------------------------------------------------------------------------

def test_constants_match_the_web_player_and_android():
    assert QC.TONES == ((880.0, 0.0, 0.35), (660.0, 0.38, 0.5))
    assert QC.BRIDGE == "STQueueChime"
    assert QC.MIN_GAP_MS == 3000
    assert QC.DEFAULT_VOLUME == 0.6


@pytest.mark.parametrize("raw,want", [
    ("0.5", 0.5), ("0", 0.0), ("7", 1.0), ("-1", 0.0), (" 0.7 ", 0.7), ("1e0", 1.0), (".25", 0.25),
    (0.3, 0.3), (2, 1.0),
])
def test_volume_is_the_widgets_setting_clamped_to_zero_to_one(raw, want):
    assert QC.volume(raw) == pytest.approx(want)


@pytest.mark.parametrize("raw", [None, "", "loud", "NaN", "Infinity", "undefined", "inf", "nan", "1_0",
                                 "0x1", True, float("nan"), float("inf"), [], {}])
def test_an_unusable_volume_falls_back_to_the_default(raw):
    assert QC.volume(raw) == QC.DEFAULT_VOLUME


@pytest.mark.parametrize("url,ok", [
    ("https://s.example/api/widgets/abc-123/render?device=d&rev=4", True),
    ("http://10.0.0.5:3001/api/widgets/w1/render#panel", True),
    ("https://s.example/api/widgets/w1/render", True),
    (None, False),
    ("bundle:content-1:rev3", False),
    ("https://www.youtube.com/embed/x", False),
    ("https://s.example/api/content/c1/bundle?rev=2", False),
    ("https://evil.example/?u=/api/widgets/w1/render", False),
    ("https://s.example/api/widgets/w1/render-other", False),
    ("file:///api/widgets/w1/render", False),
    ("about:blank", False),
])
def test_only_a_widget_render_page_may_ask(url, ok):
    assert QC.is_widget_page(url) is ok


def test_same_widget_page_ignores_spelling_but_not_the_page():
    src = "http://srv:3001/api/widgets/w1/render?device=dev1&rev=3#panel=x"
    assert QC.same_widget_page("http://SRV:3001/api/widgets/w1/render?device=dev1&rev=3", src)
    assert QC.same_widget_page("http://srv:3001/api/widgets/w1/render?rev=3&device=dev1#other", src)
    assert QC.same_widget_page("https://s.example:443/api/widgets/w1/render?d=",
                               "https://s.example/api/widgets/w1/render?d=")
    assert not QC.same_widget_page("http://srv:3001/api/widgets/w2/render?device=dev1&rev=3", src)  # another widget
    assert not QC.same_widget_page("http://other:3001/api/widgets/w1/render?device=dev1&rev=3", src)  # another host
    assert not QC.same_widget_page("https://srv:3001/api/widgets/w1/render?device=dev1&rev=3", src)  # another scheme
    assert not QC.same_widget_page("https://evil.example/", src)                                   # navigated away
    assert not QC.same_widget_page(None, src)
    assert not QC.same_widget_page("http://srv:3001/api/widgets/w1/render", "https://www.youtube.com/embed/x")


def test_a_burst_of_calls_is_one_chime():
    now = [1_000_000.0]
    g = QC.Gate(clock=lambda: now[0])
    assert g.admit()
    now[0] += 500
    assert not g.admit()
    now[0] += 2_400
    assert not g.admit()                   # 2.9 s after the first
    now[0] += 100
    assert g.admit()                       # 3.0 s: a new chime
    now[0] += 10
    assert not g.admit()


def test_bridge_token_is_checked_and_parsed():
    tok = QC.new_token()
    assert re.fullmatch(r"[0-9a-f]{32}", tok) and tok != QC.new_token()
    with pytest.raises(ValueError):
        QC.bridge_script("x'; alert(1); '")
    with pytest.raises(ValueError):
        QC.bridge_script("")
    url = "http://srv/api/widgets/w1/render?device=d&rev=1"
    assert QC.parse_console("%s 0.6 %s" % (tok, url), tok) == (True, "0.6", url)
    assert QC.parse_console("%s 0.6 %s" % (tok, url), QC.new_token())[0] is False
    assert QC.parse_console("%s 0.6 %s" % (tok, url), None)[0] is False
    assert QC.parse_console("%s 0.6" % tok, tok)[0] is False
    assert QC.parse_console(None, tok)[0] is False
    assert QC.parse_console("éé 0.6 x", tok)[0] is False      # never raises on odd input


def test_the_bridge_script_logs_one_console_line_with_the_token():
    """Run in a real JS engine (QJSEngine: no window, no network, no sound)."""
    pytest.importorskip("PySide6.QtQml")
    from PySide6.QtCore import QCoreApplication
    from PySide6.QtQml import QJSEngine
    QCoreApplication.instance() or QCoreApplication([])
    tok = QC.new_token()
    js = QJSEngine()
    js.evaluate("var window = this; var logged = []; var console = {log: function(m){ logged.push(String(m)) }};")
    r = js.evaluate(QC.bridge_script(tok))
    assert not r.isError(), r.toString()
    assert js.evaluate("typeof window.STQueueChime.chime").toString() == "function"
    js.evaluate("window.STQueueChime.chime('0.6'); window.STQueueChime.chime('0. 3\\n'); window.STQueueChime.chime({});")
    lines = js.evaluate("logged.join('|')").toString().split("|")
    assert lines[0] == QC.CONSOLE_PREFIX + tok + " 0.6"
    assert lines[1] == QC.CONSOLE_PREFIX + tok + " 0.3"         # no whitespace can split the detail
    assert lines[2].startswith(QC.CONSOLE_PREFIX + tok + " ")
    # A page that replaces console.log afterwards does not stop the report (bound at install time).
    js.evaluate("console.log = function(){}; window.STQueueChime.chime('1')")
    assert js.evaluate("logged.length").toInt() == 4


def test_the_sound_is_two_short_tones_and_never_longer():
    sr = QC.SAMPLE_RATE
    s = QC.synth(1.0, sr)
    assert 0.85 <= len(s) / sr <= 1.0
    assert len(s) == QC.total_samples(sr)
    scaled = [abs(x) * 32767 for x in s]
    assert all(v < 200 for v in scaled[:20])           # starts silent: no click
    assert all(v < 50 for v in scaled[-200:])          # ends silent: no tail
    assert max(scaled[882:4410]) > 8000                # first tone audible near its peak
    assert max(scaled[16758 + 882:16758 + 4410]) > 8000
    assert max(abs(x) for x in s) <= 0.5 + 1e-9        # 0.5 * volume at most
    # 880 Hz first: zero crossings over 0.1 s of the first tone ~ 2 * 880 * 0.1.
    seg = s[int(0.05 * sr):int(0.15 * sr)]
    zc = sum(1 for a, b in zip(seg, seg[1:]) if (a < 0) != (b < 0))
    assert abs(zc - 176) <= 4
    seg = s[int(0.45 * sr):int(0.55 * sr)]
    zc = sum(1 for a, b in zip(seg, seg[1:]) if (a < 0) != (b < 0))
    assert abs(zc - 132) <= 4                          # then 660 Hz


def test_the_envelope_rises_in_20ms_then_decays_exponentially():
    sr = QC.SAMPLE_RATE
    s = QC.synth(1.0, sr)

    def env(t, w=0.004):
        a, b = int(t * sr), int((t + w) * sr)
        return max(abs(x) for x in s[a:b])
    assert env(0.0, 0.002) < 0.01                      # 0.0001 at the start
    assert env(0.018) == pytest.approx(0.5, rel=0.1)   # the peak at 20 ms
    assert env(0.1) > env(0.2) > env(0.3)              # decaying
    # Exponential: equal steps divide by about the same factor.
    r1, r2 = env(0.1) / env(0.15), env(0.15) / env(0.2)
    assert r1 == pytest.approx(r2, rel=0.15)


def test_volume_scales_the_sound_and_zero_is_silent():
    loud = max(abs(x) for x in QC.synth(1.0))
    quiet = max(abs(x) for x in QC.synth(0.25))
    assert quiet < loud / 3
    assert all(x == 0.0 for x in QC.synth(0.0))
    pcm = QC.pcm16(0.6)
    assert len(pcm) == 2 * QC.total_samples()
    assert QC.pcm16(0.0) == b"\x00\x00" * QC.total_samples()


# --- QML: the console channel is wired ------------------------------------------------------------

def test_slot_forwards_the_chime_only_from_a_widget_page_with_a_bridge():
    src = open(os.path.join(QML, "Slot.qml"), encoding="utf-8").read()
    assert "signal queueChime(string detail)" in src
    m = re.search(r'if \(slot\.item && slot\.item\.kind === "web" && slot\.item\.chimeJs[^\n]*\n[^\n]*'
                  r'"ST_QUEUE_CHIME "\) === 0\) \{ slot\.queueChime\(message\.substring\(15\) \+ " " \+ web\.url\)', src)
    assert m, "Slot.qml must forward ST_QUEUE_CHIME lines from a web item with a bridge, with the view's URL"
    assert "installChime()                    // every load" in src
    sur = open(os.path.join(QML, "Surface.qml"), encoding="utf-8").read()
    assert sur.count('"queue_chime", detail)') == 2
    assert "f.installChime()" in sur                    # a reused page gets the new mount's token


# --- the engine, with a recording fake app ------------------------------------------------------

@pytest.fixture
def eng(tmp_path):
    pytest.importorskip("PySide6.QtCore")
    from PySide6.QtCore import QCoreApplication
    QCoreApplication.instance() or QCoreApplication([])
    from test_wall_zones import FakeApp
    from screentinker_native.player.engine import PlaybackEngine

    class ChimeApp(FakeApp):
        def __init__(self, tmp):
            super().__init__(tmp)
            self.chimes = []
            self.heard = True
            self.volume = 1.0

        def may_be_heard(self):
            return self.heard

        def content_volume(self):
            return self.volume

        def play_queue_chime(self, v, where):
            self.chimes.append((round(v, 4), where))

        def log_remote(self, level, tag, msg, mirror=False):
            self.logs.append((level, tag, msg))

    app = ChimeApp(tmp_path)
    e = PlaybackEngine(app)
    e.kiosk_config = lambda it: None
    now = [0.0]
    e.chime_gate = QC.Gate(clock=lambda: now[0])
    yield e, app, now
    e.controller.stop()
    for r in e.zone_runners.values():
        r.stop()
    e.wz_timer.stop()
    e.sync_timer.stop()


WIDGET = {"id": 1, "widget_id": "q1", "widget_type": "queue", "widget_rev": 2, "duration_sec": 30}


def _shown(app, sid):
    return [x[2] for x in app.stage.log if x[0] == "show" and x[1] == sid]


def _chime(e, sid, d, vol="0.5", url=None, token=None):
    tok = d["token"]
    m = re.search(r"var t='([0-9a-f]+)'", d["chimeJs"])
    e.on_slot_event(sid, tok, "queue_chime", "%s %s %s" % (token or m.group(1), vol, url or d["source"]))


def _settle():
    from PySide6.QtCore import QCoreApplication
    QCoreApplication.processEvents()


def _main(e, app, item=None):
    e.on_payload({"assignments": [dict(item or WIDGET)]})
    _settle()
    d = _shown(app, "main")[-1]
    assert d["kind"] == "web" and "/api/widgets/q1/render" in d["source"] and "chimeJs" in d
    return d


def test_full_screen_widget_chimes_at_its_volume_times_the_in_app_volume(eng):
    e, app, now = eng
    d = _main(e, app)
    app.volume = 0.5
    _chime(e, "main", d, "0.8")
    assert app.chimes == [(0.4, "main")]


def test_one_chime_per_three_seconds_and_zero_plays_nothing(eng):
    e, app, now = eng
    d = _main(e, app)
    _chime(e, "main", d)
    now[0] += 1000
    _chime(e, "main", d)
    assert len(app.chimes) == 1
    now[0] += 2000
    _chime(e, "main", d, "0")               # 0: nothing, and it does not use up the gate
    _chime(e, "main", d, "garbage")         # the default 0.6
    assert app.chimes[-1] == (0.6, "main") and len(app.chimes) == 2


def test_a_wrong_token_a_stale_mount_or_a_foreign_page_is_refused(eng):
    e, app, now = eng
    d = _main(e, app)
    _chime(e, "main", d, token=QC.new_token())                      # a frame inside the widget
    _chime(e, "main", d, url="https://evil.example/")               # the widget navigated away
    _chime(e, "zone:x", d)                                          # reported for another surface
    assert app.chimes == []
    # A new render (the live mute toggle re-shows the same page) replaces the bridge token: the old one
    # is dead, and the new one is the item on screen (main_token).
    e.set_muted_for("", False, "q1")
    d2 = _shown(app, "main")[-1]
    _chime(e, "main", d)
    assert app.chimes == []
    _chime(e, "main", d2)
    assert len(app.chimes) == 1


def test_a_muted_item_and_the_live_mute_toggle(eng):
    e, app, now = eng
    d = _main(e, app, dict(WIDGET, muted=1))
    _chime(e, "main", d)
    assert app.chimes == [] and "muted" in app.logs[-1][2]
    # The dashboard's live toggle names a widget item by widget_id (server lib/mute-sync.js).
    e.set_muted_for("", False, "q1")
    d = _shown(app, "main")[-1]
    assert d["muted"] is False
    _chime(e, "main", d)
    assert len(app.chimes) == 1
    e.set_muted_for("", True, "q1")
    d = _shown(app, "main")[-1]
    now[0] += 5000
    _chime(e, "main", d)
    assert len(app.chimes) == 1
    # Another widget's toggle, or one with no ids at all, does not touch this item.
    e.set_muted_for("", False, "other")
    e.set_muted_for("", False, "")
    assert e.main_item.muted is True


def test_the_screen_wide_silence_refuses(eng):
    e, app, now = eng
    d = _main(e, app)
    app.heard = False                       # screen off, trigger alarm, talk/PA, screen share
    _chime(e, "main", d)
    assert app.chimes == [] and "silent" in app.logs[-1][2]
    app.heard = True
    _chime(e, "main", d)
    assert len(app.chimes) == 1


def test_a_video_wall_follower_stays_silent_and_the_leader_chimes(eng):
    e, app, now = eng
    wall = {"wall_id": "W", "is_leader": False, "rotation": 0,
            "screen_rect": {"x": 0, "y": 0, "w": 1920, "h": 1080},
            "player_rect": {"x": 0, "y": 0, "w": 3840, "h": 1080}}
    e.on_payload({"assignments": [dict(WIDGET)], "wall_config": wall})
    _settle()
    d = _shown(app, "main")[-1]
    _chime(e, "main", d)
    assert app.chimes == []
    app.stage.take()
    # Promoted to leader with the same page on screen (no re-render): the next call may chime.
    e.on_payload({"assignments": [dict(WIDGET)], "wall_config": dict(wall, is_leader=True)})
    _settle()
    _chime(e, "main", d)
    assert len(app.chimes) == 1


def test_a_widget_in_a_layout_zone_chimes_while_it_is_the_zones_item(eng):
    e, app, now = eng
    payload = {
        "assignments": [
            {"id": 1, "content_id": "A", "mime_type": "image/png", "duration_sec": 30, "zone_id": "main"},
            dict(WIDGET, zone_id="side"),
        ],
        "layout": {"zones": [
            {"id": "main", "name": "Main", "x_percent": 0, "y_percent": 0, "width_percent": 75, "height_percent": 100},
            {"id": "side", "name": "Side", "x_percent": 75, "y_percent": 0, "width_percent": 25, "height_percent": 100},
        ]},
    }
    app.cache.files.update(A="/c/A.png")
    e.on_payload(payload)
    _settle()
    d = _shown(app, "zone:side")[-1]
    img = _shown(app, "zone:main")[-1]
    assert "chimeJs" not in img             # only a widget page gets the bridge
    _chime(e, "zone:side", d)
    assert app.chimes == [(0.5, "zone:side")]
    _chime(e, "main", d)                    # the token belongs to the zone, not the main surface
    assert len(app.chimes) == 1


def test_wall_zones_chime_only_from_the_panel_and_zone_with_the_audio(eng):
    e, app, now = eng
    zones = [{"id": "a", "name": "A", "x_percent": 0, "y_percent": 0, "width_percent": 50, "height_percent": 100},
             {"id": "b", "name": "B", "x_percent": 50, "y_percent": 0, "width_percent": 50, "height_percent": 100}]

    def payload(audio):
        return {"assignments": [dict(WIDGET, zone_id="a")],
                "wall_config": {"wall_id": "W", "is_leader": False, "rotation": 0, "canvas_layout": True,
                                "audio_zones": audio,
                                "screen_rect": {"x": 0, "y": 0, "w": 1920, "h": 1080},
                                "player_rect": {"x": 0, "y": 0, "w": 3840, "h": 1080}},
                "layout": {"zones": zones}}
    e.on_payload(payload([]))
    e._wz_tick()
    assert e.mode == "wallzones"
    d = _shown(app, "zone:a")[-1]
    _chime(e, "zone:a", d)
    assert app.chimes == [] and "another screen" in app.logs[-1][2]
    e._stop_wall_zones()
    e.mode = "single"
    app.stage.take()
    e.on_payload(payload(["a"]))
    e._wz_tick()
    d = _shown(app, "zone:a")[-1]
    _chime(e, "zone:a", d)
    assert app.chimes == [(0.5, "zone:a")]


def test_youtube_and_bundles_never_get_the_bridge(eng):
    e, app, now = eng
    from screentinker_native.player.items import Item
    yt = Item.parse({"id": 9, "content_id": "Y", "mime_type": "video/youtube",
                     "remote_url": "https://www.youtube.com/watch?v=abcdefghijk"})
    e.render(yt, "main")
    d = _shown(app, "main")[-1]
    assert "chimeJs" not in d and d["token"] not in e.chime_mounts


def test_the_chime_player_is_never_built_by_the_engine():
    """The engine only asks app.play_queue_chime: tests can never make a sound through it."""
    src = open(os.path.join(os.path.dirname(QC.__file__), "..", "player", "engine.py"), encoding="utf-8").read()
    assert "QueueChimePlayer" not in src and "QAudioSink" not in src
    assert math.isclose(QC.volume("0.6"), 0.6)


# --- the player, with the audio classes replaced (nothing reaches a sound card) --------------------

def test_the_chime_player_plays_once_through_a_sink_and_lets_go(monkeypatch):
    pytest.importorskip("PySide6.QtMultimedia")
    from PySide6.QtCore import QCoreApplication
    QCoreApplication.instance() or QCoreApplication([])
    import PySide6.QtMultimedia as QtM
    from PySide6.QtMultimedia import QAudio
    from screentinker_native.ui import extras

    class FakeDevice:
        def __init__(self, mono_ok):
            self.mono_ok = mono_ok

        def isNull(self):
            return False

        def isFormatSupported(self, f):
            return self.mono_ok or f.channelCount() == 2

        def preferredFormat(self):
            f = QtM.QAudioFormat()
            f.setSampleRate(48000)
            f.setChannelCount(2)
            return f

    sinks = []

    class FakeSink:
        def __init__(self, device, fmt):
            self.fmt, self.data, self.stopped, self.deleted = fmt, None, False, False
            self.slots = []
            self.stateChanged = self
            sinks.append(self)

        def connect(self, fn):
            self.slots.append(fn)

        def start(self, buf):
            self.data = bytes(buf.data())

        def error(self):
            return QAudio.Error.NoError

        def stop(self):
            self.stopped = True

        def deleteLater(self):
            self.deleted = True

    class FakeDevices:
        device = FakeDevice(True)

        @staticmethod
        def defaultAudioOutput():
            return FakeDevices.device

    monkeypatch.setattr(QtM, "QMediaDevices", FakeDevices)
    monkeypatch.setattr(QtM, "QAudioSink", FakeSink)
    p = extras.QueueChimePlayer()
    assert p.play(0.6) is True
    s = sinks[-1]
    assert s.fmt.sampleRate() == QC.SAMPLE_RATE and s.fmt.channelCount() == 1
    assert s.data == QC.pcm16(0.6)                          # exactly the synthesised chime, once
    assert len(p._live) == 1
    for fn in s.slots:
        fn(QAudio.State.IdleState)                           # played to the end
    QCoreApplication.processEvents()
    assert s.stopped and s.deleted and p._live == []
    # A device that wants stereo at 48 kHz gets the same chime on both channels.
    FakeDevices.device = FakeDevice(False)
    assert p.play(1.0) is True
    s = sinks[-1]
    mono = QC.pcm16(1.0, 48000)
    assert s.fmt.channelCount() == 2 and len(s.data) == 2 * len(mono) and s.data[:4] == mono[:2] * 2
