"""#473: the playlist hold/release (Android PlaylistController.hold/release/dropHold) and the
KioskSession state machine with the web view stubbed out. The real view is exercised end to end
(Xvfb + scratch server); these pin the decisions."""
import json
import os

import pytest

QtCore = pytest.importorskip("PySide6.QtCore")

from screentinker_native.logic import kiosk as K  # noqa: E402


@pytest.fixture(scope="module")
def qapp():
    app = QtCore.QCoreApplication.instance() or QtCore.QCoreApplication([])
    yield app


def _assign(i, wid=None):
    return {"id": i, "widget_id": wid or "w%d" % i, "mime_type": "text/html", "filename": "W%d" % i, "duration_sec": 5}


def _controller(qapp, played):
    from screentinker_native.player.controller import PlaylistController
    c = PlaylistController(on_item_changed=lambda it: played.append(it.widget_id), on_playlist_empty=lambda: played.append("EMPTY"))
    return c


def test_hold_blocks_advance_and_parks_updates(qapp):
    played = []
    c = _controller(qapp, played)
    c.update_playlist([_assign(1), _assign(2)])
    c.start()
    assert played == ["w1"]
    c.hold()
    assert c.held and not c._advance.isActive()
    c.next()                                       # the advance timer / a video end: ignored
    assert played == ["w1"]
    c.update_playlist([_assign(1), _assign(3)])    # parked, not applied
    assert [i.widget_id for i in c.items] == ["w1", "w2"]
    c.release()
    assert not c.held
    assert [i.widget_id for i in c.items] == ["w1", "w3"]
    assert played == ["w1", "w3"]                  # parked update applied, then advanced off the page


def test_release_does_not_skip_when_the_parked_update_moved_playback(qapp):
    played = []
    c = _controller(qapp, played)
    c.update_playlist([_assign(1), _assign(2)])
    c.start()
    c.hold()
    c.update_playlist([_assign(4), _assign(5)])    # the held item was removed
    c.release()
    assert played == ["w1", "w4"]                  # the update restarted playback; no extra next()


def test_drop_hold_and_stop_clear_the_hold_without_advancing(qapp):
    played = []
    c = _controller(qapp, played)
    c.update_playlist([_assign(1), _assign(2)])
    c.start()
    c.hold()
    c.update_playlist([_assign(1)])
    c.drop_hold()
    assert not c.held and c.parked_update is None and played == ["w1"]
    c.hold()
    c.stop()
    assert not c.held
    c.release()                                    # not held: a no-op
    assert played == ["w1"]


class _Sig:
    def __init__(self):
        self.calls = []

    def emit(self, *a):
        self.calls.append(a)


class FakeStage:
    def __init__(self):
        self.kioskLoad, self.kioskJs = _Sig(), _Sig()
        self.kioskOverlay = ""
        self.kiosk = None

    def set(self, k, v):
        setattr(self, k, v)


def _session(tmp_path, ua="Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36"):
    from screentinker_native.ui import kiosk as ui_kiosk
    ev = {"hold": 0, "release": 0, "skip": 0, "errors": [], "sessions": []}
    stage = FakeStage()
    s = ui_kiosk.KioskSession(stage, str(tmp_path), hold=lambda: ev.__setitem__("hold", ev["hold"] + 1),
                              release=lambda: ev.__setitem__("release", ev["release"] + 1),
                              skip=lambda: ev.__setitem__("skip", ev["skip"] + 1),
                              error=lambda r, d: ev["errors"].append((r, d)),
                              session_end=lambda r: ev["sessions"].append(r), user_agent=ua)
    s._new_profile = lambda: None                  # no web engine in unit tests
    return s, stage, ev


CFG = K.parse("webpage", {"url": "https://shop.example/menu", "interactive": True, "idle_timeout_sec": 15,
                          "idle_warning_sec": 5})


def test_first_touch_holds_idle_reset_releases_and_records(qapp, tmp_path, monkeypatch):
    from screentinker_native.ui import kiosk as ui_kiosk
    now = [1_000_000]
    monkeypatch.setattr(ui_kiosk, "_now_ms", lambda: now[0])
    s, stage, ev = _session(tmp_path)
    s.show("k|1", CFG, "w1")
    assert stage.kioskShown and stage.kioskMounted and not s.session_active
    s.profile = QtCore.QObject()                         # "mounted": user input now counts
    s.media_playing()                              # media never starts a session
    assert not s.session_active and ev["hold"] == 0
    s.user_input()
    assert s.session_active and ev["hold"] == 1
    assert os.path.exists(os.path.join(str(tmp_path), "kiosk-open-session.json"))
    s.url_changed("https://shop.example/menu/item/2")
    assert stage.kioskHome is True and s.pages == 2
    now[0] += 15_000
    s._on_tick()
    assert stage.kioskOverlay.startswith("Still there?\nTap to keep browsing — resetting in 5s")
    s.overlay_tapped()
    assert stage.kioskOverlay == ""
    now[0] += 20_000
    s._on_tick()
    assert ev["release"] == 1 and not s.is_showing
    r = ev["sessions"][0]
    assert r["end_reason"] == "idle" and r["duration_sec"] == 15 and r["pages"] == 2 and r["widget_id"] == "w1"
    assert not os.path.exists(os.path.join(str(tmp_path), "kiosk-open-session.json"))


def test_failure_skips_when_untouched_and_releases_in_a_session(qapp, tmp_path):
    s, stage, ev = _session(tmp_path)
    s.show("k|1", CFG, "w1")
    s.load_finished("https://shop.example/menu", False, -1, "-105 net::ERR_NAME_NOT_RESOLVED")
    s.load_finished("https://shop.example/menu", False, 404, "404")      # one failure per page
    qapp.processEvents()
    assert ev["skip"] == 1 and ev["release"] == 0
    assert ev["errors"] == [("load_error", "shop.example: load error -105 net::ERR_NAME_NOT_RESOLVED")]
    # Shown again straight away (a one-item playlist): backs off instead of remounting.
    s.show("k|1", CFG, "w1")
    assert stage.kioskShown and not stage.kioskMounted and s._mount_later.isActive()
    s.hide()
    s._fails.clear()
    s.show("k|2", CFG, "w1")
    s.profile = QtCore.QObject()
    s.user_input()
    s.load_finished("https://shop.example/menu", False, 500, "500")
    qapp.processEvents()
    assert ev["release"] == 1
    assert ev["sessions"][-1]["end_reason"] == "error"
    assert ev["errors"][-1] == ("http_error", "shop.example: HTTP 500")


def test_too_old_engine_shows_the_card_and_reports(qapp, tmp_path):
    s, stage, ev = _session(tmp_path, ua="Mozilla/5.0 Chrome/83.0.4103.106 Safari/537.36")
    cfg = K.parse("webpage", {"url": "https://a.example", "interactive": True, "min_webview": 100})
    s.show("k|1", cfg, "w")
    assert stage.kioskCard == K.CARD_TOO_OLD and not stage.kioskMounted
    assert ev["errors"] == [("webview_too_old", "a.example: Chrome 83, page needs 100")]


def test_navigation_allowlist_is_top_level_only(qapp, tmp_path):
    s, stage, ev = _session(tmp_path)
    s.show("k|1", CFG, "w")
    assert s.nav_allowed("https://www.shop.example/x", True)
    assert not s.nav_allowed("https://evil.example/", True)
    assert s.nav_allowed("https://evil.example/frame", False)          # subframes never filtered
    s.new_window("https://evil.example/")
    s.new_window("https://shop.example/pop")
    assert stage.kioskLoad.calls == [("https://shop.example/pop",)]


def test_open_session_recovered_as_interrupted(qapp, tmp_path):
    rec = K.make_session("abc", "w", 1_700_000_000, 12, "interrupted", 3)
    with open(os.path.join(str(tmp_path), "kiosk-open-session.json"), "w") as f:
        json.dump(rec, f)
    s, stage, ev = _session(tmp_path)
    s.recover()
    assert ev["sessions"] == [rec]
    assert not os.path.exists(os.path.join(str(tmp_path), "kiosk-open-session.json"))


# --- reporting (app.py): incidents held offline, sessions sent in acked batches -----------------

class _FakeApp:
    def __init__(self, tmp_path, connected):
        import collections
        import types
        self.link = types.SimpleNamespace(connected=connected)
        self.config = types.SimpleNamespace(device_id="dev1")
        self.loop = None
        self.sent = []
        self._kiosk_errors = collections.deque(maxlen=10)
        self._kiosk_in_flight = False
        self.kiosk_sessions = K.SessionQueue(path=os.path.join(str(tmp_path), "q.json"))

    def emit(self, ev, payload):
        self.sent.append((ev, payload))


def _bind(fake):
    pytest.importorskip("PySide6.QtGui")
    from screentinker_native.app import App
    for n in ("send_kiosk_error", "_flush_kiosk_errors", "_emit_web_error", "flush_kiosk_sessions", "_on_kiosk_ack",
              "_kiosk_session_end"):
        setattr(fake, n, getattr(App, n).__get__(fake))
    return fake


def test_web_errors_are_held_offline_and_sent_after_registration(tmp_path):
    a = _bind(_FakeApp(tmp_path, connected=False))
    for i in range(12):
        a.send_kiosk_error("load_error", "shop.example: load error %d" % i)
    assert a.sent == [] and len(a._kiosk_errors) == 10            # at most 10, oldest dropped
    a.link.connected = True
    a._flush_kiosk_errors()
    assert len(a.sent) == 10
    ev, p = a.sent[0]
    assert ev == "device:event" and p == {"device_id": "dev1", "type": "web_error", "reason": "load_error",
                                          "detail": "shop.example: load error 2 (while offline)"}
    a.send_kiosk_error("http_error", "x" * 900)
    assert len(a.sent[-1][1]["detail"]) == 400


def test_sessions_flush_in_batches_and_leave_only_on_ack(tmp_path):
    a = _bind(_FakeApp(tmp_path, connected=True))
    for i in range(60):
        a.kiosk_sessions.add(K.make_session("s%02d" % i, "w", 1_700_000_000 + i, 3, "idle", 1))
    a.flush_kiosk_sessions()
    a.flush_kiosk_sessions()                       # in flight: no second batch until the ack
    assert len(a.sent) == 1
    ev, p = a.sent[0]
    assert ev == "device:kiosk-sessions" and p["device_id"] == "dev1" and len(p["sessions"]) == 50
    a._on_kiosk_ack({"ids": [r["id"] for r in p["sessions"]], "written": 50})
    assert len(a.sent) == 2 and len(a.sent[1][1]["sessions"]) == 10   # the ack sends the rest
    a._on_kiosk_ack({"ids": [r["id"] for r in a.sent[1][1]["sessions"]]})
    assert a.kiosk_sessions.size() == 0
    with open(os.path.join(str(tmp_path), "q.json")) as f:
        assert json.load(f) == []
    a.link.connected = False
    a._kiosk_session_end(K.make_session("late", "w", 1_700_000_100, 2, "idle", 1))
    assert len(a.sent) == 2 and a.kiosk_sessions.size() == 1        # queued, persisted, sent later


# --- review fixes -------------------------------------------------------------------------------

def test_release_with_a_rev_bumped_held_item_advances_without_remounting_it(qapp):
    played = []
    c = _controller(qapp, played)
    c.update_playlist([_assign(1), _assign(2)])
    c.start()
    c.hold()
    c.update_playlist([dict(_assign(1), widget_rev=7), _assign(2)])   # the held page was edited
    c.release()
    assert played == ["w1", "w2"]                  # straight on, no transient remount of w1
    assert c.items[0].widget_rev == 7


class _FakeKiosk:
    def __init__(self):
        self.shown, self.hidden = [], 0

    def show(self, key, cfg, wid):
        self.shown.append(key)

    def hide(self):
        self.hidden += 1


def _engine(tmp_path):
    import types
    from screentinker_native.player.engine import PlaybackEngine

    class Cfg(dict):
        device_id = "dev1"
        server_url = "http://srv"
        state_dir = str(tmp_path)

        def set(self, k, v):
            self[k] = v

    st = FakeStage()
    st.showItem, st.clearSurface, st.control, st.window = _Sig(), _Sig(), _Sig(), None
    app = types.SimpleNamespace(config=Cfg(), stage=st, cache=types.SimpleNamespace(), transitions_dir=str(tmp_path),
                                request_refresh=lambda: None, emit=lambda *a: None, ensure_downloads=lambda *a, **k: None,
                                hide_status=lambda: None, show_status=lambda *a: None, slide_audio=lambda it: None,
                                log_remote=lambda *a, **k: None, play_event=lambda *a: None, synced_now_ms=lambda: 0)
    app.kiosk = _FakeKiosk()
    return PlaybackEngine(app), app


KW = {"widget_type": "webpage", "widget_config": json.dumps({"url": "https://shop.example", "interactive": True})}


def test_joining_a_group_mid_session_applies_the_new_playlist(qapp, tmp_path):
    e, app = _engine(tmp_path)
    e.on_payload({"assignments": [dict(_assign(1), **KW), _assign(2)]})
    assert app.kiosk.shown == ["|w1|0"]           # fullscreen: interactive
    e.controller.hold()                            # a visitor is using it
    e.on_payload({"assignments": [_assign(3), _assign(4)], "group_sync": {"group_id": "g-123456789"}})
    assert not e.controller.held and e.controller.parked_update is None
    # The group runs the NEW list: applied, or staged as the ordinary deferred rotation-out of a
    # removed live item (the same path an unheld panel takes) — never silently dropped.
    staged = e.controller.pending_items or e.controller.items
    assert [i.widget_id for i in staged] == ["w3", "w4"]
    assert app.kiosk.hidden >= 1


def test_interactive_item_is_passive_in_a_group(qapp, tmp_path):
    e, app = _engine(tmp_path)
    e.on_payload({"assignments": [dict(_assign(1), **KW)], "group_sync": {"group_id": "g-123456789"}})
    e._sync_tick()
    assert app.kiosk.shown == []
    assert any(c[1].get("kind") == "web" for c in app.stage.showItem.calls)


def test_remote_input_never_starts_a_visitor_session(qapp, tmp_path):
    from PySide6.QtCore import QEvent, QPointF, Qt
    from PySide6.QtGui import QMouseEvent
    from screentinker_native.ui.stage import Stage
    stage = Stage(object())
    s, _, ev = _session(tmp_path)
    s.stage = stage
    stage.kiosk = s
    s.show("k|1", CFG, "w")
    s.profile = QtCore.QObject()
    press = QMouseEvent(QEvent.Type.MouseButtonPress, QPointF(1, 1), QPointF(1, 1), Qt.MouseButton.LeftButton,
                        Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
    target = QtCore.QObject()
    target.installEventFilter(stage)
    stage._send_synthetic(target, press)           # the dashboard's remote tap
    assert not s.session_active and ev["hold"] == 0
    QtCore.QCoreApplication.sendEvent(target, press)   # a real touch on the panel
    assert s.session_active and ev["hold"] == 1
