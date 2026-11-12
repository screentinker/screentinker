"""Uploaded audio playlist items (MP3, M4A, Ogg, WAV, FLAC) play like a clip on the native player.

Uploads have always accepted audio, but every routing site asked `mime_type.startswith("video/")`,
so item_dict returned None and the item was skipped as "not renderable". Audio now takes the clip
path (mute, wall-follower loop, fault on error, advance on end) and renders as Slot kind "audio":
a "now playing" card full screen, no picture in a zone.

⚠️ SILENT: the Qt case plays a generated file of digital silence, muted, at volume 0, with no
sound server reachable (PULSE_SERVER / PIPEWIRE_REMOTE point nowhere). It never touches the mixer.
"""
import os
import types
import wave

import pytest

from screentinker_native.player.items import Item

CHILD = os.environ.get("ST_AUDIO_QT_CHILD") == "1"
SLOT = os.path.join(os.path.dirname(__file__), "..", "screentinker_native", "ui", "qml", "Slot.qml")
AUDIO_MIMES = ("audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/flac")


# --- Item ------------------------------------------------------------------------------------

@pytest.mark.parametrize("mime", AUDIO_MIMES)
def test_audio_mimes_are_audio_clips(mime):
    it = Item.parse({"content_id": "c1", "mime_type": mime, "filename": "song.mp3"})
    assert it.is_audio and it.is_clip and not it.is_live


def test_video_youtube_widget_and_image_classification():
    assert Item.parse({"content_id": "c", "mime_type": "video/mp4"}).is_clip
    assert not Item.parse({"content_id": "c", "mime_type": "video/mp4"}).is_audio
    assert not Item.parse({"mime_type": "video/youtube", "remote_url": "https://youtu.be/x"}).is_clip
    assert not Item.parse({"content_id": "c", "mime_type": "image/png"}).is_clip
    # A widget arrives with no mime and Item defaults it to video/mp4: never a clip.
    assert not Item.parse({"widget_id": "w"}).is_clip
    assert not Item.parse({"widget_id": "w", "mime_type": "audio/mpeg"}).is_audio


# --- engine routing (Qt-free; the engine methods run on a stand-in) ---------------------------

def _engine():
    pytest.importorskip("PySide6.QtCore")
    from screentinker_native.player import engine
    return engine


def _fake_engine(tmp_path, cached=True):
    f = tmp_path / "c1.mp3"
    f.write_bytes(b"\0")
    shown = []
    return types.SimpleNamespace(
        config=types.SimpleNamespace(server_url="http://srv", device_id="d"),
        wall=None, mode="single", skip_tokens={}, surface_token={}, tokens={}, token_seq=0,
        fisheye_views={},
        cache=types.SimpleNamespace(cached_file=lambda cid: str(f) if cached else None),
        stage=types.SimpleNamespace(showItem=types.SimpleNamespace(emit=lambda sid, d: shown.append((sid, d)))),
        shown=shown, file=f)


def test_audio_title_drops_the_extension():
    e = _engine()
    assert e.audio_title("Morning Jazz.mp3") == "Morning Jazz"
    assert e.audio_title("track.flac") == "track"
    assert e.audio_title("no_extension") == "no_extension"
    assert e.audio_title("a.b.wav") == "a.b"


@pytest.mark.parametrize("mime", AUDIO_MIMES)
def test_cached_audio_renders_as_an_audio_slot_with_a_card(tmp_path, mime):
    e = _engine()
    fe = _fake_engine(tmp_path)
    it = Item.parse({"content_id": "c1", "mime_type": mime, "filename": "Morning Jazz.mp3", "muted": 1})
    d = e.PlaybackEngine.item_dict(fe, it, loop=True)
    assert d["kind"] == "audio" and d["source"].startswith("file://")
    assert d["card"] is True and d["title"] == "Morning Jazz"
    assert d["muted"] is True and d["loop"] is True


def test_audio_not_yet_downloaded_is_not_renderable(tmp_path):
    e = _engine()
    fe = _fake_engine(tmp_path, cached=False)
    it = Item.parse({"content_id": "c1", "mime_type": "audio/mpeg", "filename": "a.mp3"})
    assert e.PlaybackEngine.item_dict(fe, it) is None


def test_remote_audio_renders_as_audio(tmp_path):
    e = _engine()
    fe = _fake_engine(tmp_path)
    it = Item.parse({"mime_type": "audio/mpeg", "remote_url": "https://cdn.example/a.mp3", "filename": "a.mp3"})
    d = e.PlaybackEngine.item_dict(fe, it)
    assert d["kind"] == "audio" and d["source"] == "https://cdn.example/a.mp3"


def test_wall_follower_audio_is_muted_like_video(tmp_path):
    e = _engine()
    fe = _fake_engine(tmp_path)
    fe.wall = {"leader": False, "group": False}
    it = Item.parse({"content_id": "c1", "mime_type": "audio/ogg", "filename": "a.ogg"})
    assert e.PlaybackEngine.item_dict(fe, it)["muted"] is True


def _render(e, fe, it, surface):
    fe._new_token = types.MethodType(e.PlaybackEngine._new_token, fe)
    fe._attach_fisheye = lambda *a: None
    fe._attach_chime = lambda *a: None
    fe.shaders = types.SimpleNamespace(resolve=lambda t: None)
    fe.item_dict = types.MethodType(e.PlaybackEngine.item_dict, fe)
    return e.PlaybackEngine.render(fe, it, surface=surface)


def test_audio_in_a_zone_has_no_card_but_full_screen_does(tmp_path):
    e = _engine()
    fe = _fake_engine(tmp_path)
    it = Item.parse({"content_id": "c1", "mime_type": "audio/mpeg", "filename": "a.mp3"})
    _render(e, fe, it, "zone:z1")
    _render(e, fe, it, "main")
    (zs, zd), (ms, md) = fe.shown
    assert zs == "zone:z1" and zd["kind"] == "audio" and zd["card"] is False
    assert ms == "main" and md["kind"] == "audio" and md["card"] is True


def test_a_failed_audio_item_takes_the_clip_fault_path():
    e = _engine()
    calls = []
    it = Item.parse({"content_id": "c1", "mime_type": "audio/mpeg", "filename": "a.mp3"})
    fe = types.SimpleNamespace(
        mode="single", main_token="t1", main_item=it,
        app=types.SimpleNamespace(log_remote=lambda *a, **k: None),
        controller=types.SimpleNamespace(close_play_log=lambda c: calls.append(("close", c)),
                                         on_video_fault=lambda: calls.append("fault"),
                                         next=lambda: calls.append("next"),
                                         on_video_complete=lambda: calls.append("complete")))
    e.PlaybackEngine.on_slot_event(fe, "main", "t1", "failed", "invalid media")
    e.PlaybackEngine.on_slot_event(fe, "main", "t1", "ended", "")
    assert calls == [("close", False), "fault", "complete"]


def test_audio_does_not_end_on_a_timer():
    # Like a clip: the end of the file advances the playlist, not duration_sec.
    from screentinker_native.logic import playlist_logic as PL
    for m in AUDIO_MIMES:
        assert not PL.ends_on_timer(m, False)


def test_a_zone_waits_for_audio_to_end_and_a_lone_track_loops():
    QtCore = pytest.importorskip("PySide6.QtCore")
    QtCore.QCoreApplication.instance() or QtCore.QCoreApplication([])
    e = _engine()
    rendered = []

    def render(it, surface, loop, fit, transition, play_to_end):
        rendered.append((it.filename, loop))
        return "tok%d" % len(rendered)

    fake = types.SimpleNamespace(allows=lambda it: True, render=render,
                                 stage=types.SimpleNamespace(clearSurface=types.SimpleNamespace(emit=lambda s: None)))
    a = Item.parse({"content_id": "a", "mime_type": "audio/mpeg", "filename": "a.mp3", "duration_sec": 5})
    b = Item.parse({"content_id": "b", "mime_type": "image/png", "filename": "b.png", "duration_sec": 5})
    r = e.ZoneRunner(fake, {"id": "z1"}, [a, b])
    r.show(0)
    assert rendered[-1] == ("a.mp3", False) and not r.timer.isActive()   # waits for "ended"
    r.on_event(r.token, "ended")
    assert rendered[-1][0] == "b.png" and r.timer.isActive()
    r.stop()
    lone = e.ZoneRunner(fake, {"id": "z2"}, [a])
    lone.show(0)
    assert rendered[-1] == ("a.mp3", True)                                 # a one-item zone loops
    lone.stop()


# --- Slot.qml, offscreen and silent ----------------------------------------------------------

def test_audio_slot_in_a_gui_process():
    if CHILD:
        pytest.skip("this is the child")
    pytest.importorskip("PySide6.QtWebEngineQuick")
    pytest.importorskip("PySide6.QtMultimedia")
    import subprocess
    import sys
    env = dict(os.environ, ST_AUDIO_QT_CHILD="1", QT_QPA_PLATFORM="offscreen", ST_TEST_NO_SYSTEM_AUDIO="1",
               PULSE_SERVER="unix:/nonexistent", PIPEWIRE_REMOTE="/nonexistent")
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-k", "test_qt_", __file__],
                       env=env, capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
    assert " passed" in r.stdout and "skipped" not in r.stdout.splitlines()[-1], r.stdout[-500:]


@pytest.fixture(scope="module")
def slot():
    if not CHILD:
        pytest.skip("runs in its own process (test_audio_slot_in_a_gui_process)")
    from PySide6.QtCore import QUrl
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    QtWebEngineQuick.initialize()
    from PySide6.QtGui import QGuiApplication
    app = QGuiApplication.instance() or QGuiApplication([])
    from PySide6.QtQuick import QQuickView
    view = QQuickView()
    view.setResizeMode(QQuickView.SizeRootObjectToView)
    view.resize(640, 360)
    view.setSource(QUrl.fromLocalFile(os.path.abspath(SLOT)))
    assert view.status() == QQuickView.Ready, [e.toString() for e in view.errors()]
    root = view.rootObject()
    root.setProperty("forceMute", True)
    root.setProperty("volume", 0.0)
    view.show()
    app.processEvents()
    return app, view, root


def _silence(path, sec=0.6):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\0\0" * int(8000 * sec))


def _wait(app, cond, ms):
    from PySide6.QtCore import QElapsedTimer
    t = QElapsedTimer()
    t.start()
    while not cond() and t.elapsed() < ms:
        app.processEvents()
    return cond()


def _load(app, root, item):
    from PySide6.QtCore import Q_ARG, QMetaObject
    QMetaObject.invokeMethod(root, "load", Q_ARG("QVariant", item))
    app.processEvents()


def _find(root, name):
    from PySide6.QtQuick import QQuickItem
    return root.findChild(QQuickItem, name)


@pytest.mark.parametrize("card", [True, False])
def test_qt_audio_is_ready_without_a_frame_and_reports_its_end(slot, tmp_path, card):
    app, view, root = slot
    f = tmp_path / "Morning Jazz.wav"
    _silence(f)
    got = []
    root.ready.connect(lambda: got.append("ready"))
    root.ended.connect(lambda: got.append("ended"))
    root.failed.connect(lambda m: got.append("failed:" + m))
    from PySide6.QtCore import QUrl
    _load(app, root, {"kind": "audio", "token": "a-%s" % card, "source": QUrl.fromLocalFile(str(f)).toString(),
                      "muted": True, "loop": False, "card": card, "title": "Morning Jazz"})
    # Audio paints no video frame: ready must come from playback, long before the 15 s fault timer.
    assert _wait(app, lambda: got, 8000), "no ready/failed within 8 s"
    assert got[0] == "ready", got
    cardItem = _find(root, "audioCard")
    assert cardItem is not None and cardItem.isVisible() == card
    assert _find(root, "audioTitle").property("text") == "Morning Jazz"
    assert _wait(app, lambda: "ended" in got or any(g.startswith("failed") for g in got), 8000), got
    assert "ended" in got and not any(g.startswith("failed") for g in got), got
    root.ready.disconnect()
    root.ended.disconnect()
    root.failed.disconnect()
    _unload(root)


def _unload(root):
    from PySide6.QtCore import QMetaObject
    QMetaObject.invokeMethod(root, "unload")
