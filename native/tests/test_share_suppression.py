"""#845: a trigger (an emergency / automation alert) outranks a screen share on the native player.

The share is the server's /player/screen-share.js in the WebRTC page (ui/rtc_page.py, TalkVideo.qml)
and the meeting-room code is ShareCode.qml; both draw ABOVE the trigger overlay (Main.qml). While any
trigger is on screen they are hidden (QML, from stage.triggerVisible, same frame) and the share is
silent (the page, ST.shareSuppress, from logic/screen_share.Suppression at the settled state). The
sessions stay connected and come back as they were when the last trigger clears.

⚠️ SILENT: offscreen Qt, Chromium started with --mute-audio, the stub share has no media source.
The WebEngine cases are opt-in (ST_TEST_WEBENGINE=1), as in test_queue_chime_qml.py.
"""

import http.server
import json
import os
import re
import subprocess
import sys
import threading
import time

import pytest

from screentinker_native.logic import screen_share
from screentinker_native.ui.rtc_page import rtc_page

HERE = os.path.join(os.path.dirname(__file__), "..", "screentinker_native")
QML = os.path.join(HERE, "ui", "qml")
CHILD = os.environ.get("ST_SHARE_SUPPRESS_QT_CHILD") == "1"


def _read(*p):
    return open(os.path.join(HERE, *p), encoding="utf-8").read()


# ---------------------------------------------------------------- the settled-state hook
class _Rig:
    def __init__(self):
        self.visible = False
        self.sent = []
        self.queue = []
        self.s = screen_share.Suppression(lambda: self.visible, self.sent.append, self.queue.append)

    def turn(self):
        q = list(self.queue)
        self.queue.clear()
        for fn in q:
            fn()


def test_a_trigger_suppresses_and_its_clear_restores_once_each():
    r = _Rig()
    r.visible = True
    r.s.poke()
    assert r.sent == []          # deferred to the next turn, never inline
    r.turn()
    assert r.sent == [True]
    r.visible = False
    r.s.poke()
    r.turn()
    assert r.sent == [True, False]


def test_lease_expiry_into_a_held_trigger_does_not_blip():
    # TriggerController.sweep: stop() -> hide() then promote() -> show(), in one call.
    r = _Rig()
    r.visible = True
    r.s.poke()
    r.turn()
    r.visible = False
    r.s.poke()
    r.visible = True
    r.s.poke()
    r.turn()
    assert r.sent == [True]
    assert len(r.queue) == 0


def test_a_flash_inside_one_turn_sends_nothing():
    r = _Rig()
    r.visible = True
    r.s.poke()
    r.visible = False
    r.s.poke()
    r.turn()
    assert r.sent == []


def test_wanted_is_the_state_now_for_a_share_that_starts_under_a_trigger():
    r = _Rig()
    assert r.s.wanted() is False
    r.visible = True
    assert r.s.wanted() is True


def test_suppress_js():
    assert screen_share.suppress_js(True) == "ST.shareSuppress(true)"
    assert screen_share.suppress_js(False) == "ST.shareSuppress(false)"


# ---------------------------------------------------------------- wiring
def test_the_app_hooks_the_settled_trigger_state_and_starts_shares_with_it():
    app = _read("app.py")
    assert "self.stage.triggerVisibleChanged.connect(self.share_suppression.poke)" in app
    assert "QTimer.singleShot(0, fn)" in app
    body = app[app.index("    def _share_start(self, d):"):]
    body = body[:body.index("\n    def ", 10)]
    assert "suppress=self.share_suppression.wanted()" in body


def test_the_page_can_suppress_and_reports_a_share_apart_from_a_webcam():
    html = rtc_page("ws://127.0.0.1:1/frames?k=x")
    assert "shareSuppress:" in html and "shareSuppressed:" in html
    # The server's suppress() when it has one; otherwise the page hides and mutes the overlay itself.
    assert "STScreenShare.suppress(on)" in html
    assert "'rtc:share'" in html and "'rtc:video'" in html and "'rtc:idle'" in html
    assert "if ('suppress' in o) setSuppressed(o.suppress);" in html


def test_qml_hides_the_share_layers_under_a_trigger():
    talk = open(os.path.join(QML, "TalkVideo.qml"), encoding="utf-8").read()
    assert re.search(r'visible:\s*pageState === "rtc:video" \|\| \(pageState === "rtc:share" && !stage\.triggerVisible\)', talk)
    code = open(os.path.join(QML, "ShareCode.qml"), encoding="utf-8").read()
    assert "!stage.triggerVisible" in code
    main = open(os.path.join(QML, "Main.qml"), encoding="utf-8").read()
    # Both draw above the trigger overlay, which is why they must hide themselves.
    assert main.index('surfaceId: "trigger"') < main.index("ShareCode {") < main.index("TalkVideo {")


# ---------------------------------------------------------------- real Qt (child processes)
def _child(select, extra_env=None):
    env = dict(os.environ, ST_SHARE_SUPPRESS_QT_CHILD="1", QT_QPA_PLATFORM="offscreen", ST_TEST_NO_SYSTEM_AUDIO="1",
               PULSE_SERVER="unix:/nonexistent", PIPEWIRE_REMOTE="/nonexistent", **(extra_env or {}))
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-k", select, __file__],
                       env=env, capture_output=True, text=True, timeout=240)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
    assert " passed" in r.stdout and "skipped" not in r.stdout.splitlines()[-1], r.stdout[-500:]


def test_share_code_in_a_gui_process():
    if CHILD:
        pytest.skip("this is the child")
    pytest.importorskip("PySide6.QtQuick")
    _child("test_qt_code_")


def test_rtc_layer_in_a_gui_process():
    if CHILD:
        pytest.skip("this is the child")
    # Opt-in: it starts a real Chromium renderer, which cannot start inside some sandboxed shells.
    if os.environ.get("ST_TEST_WEBENGINE") != "1":
        pytest.skip("set ST_TEST_WEBENGINE=1 to run the RTC page in a real QtWebEngine")
    pytest.importorskip("PySide6.QtWebEngineQuick")
    flags = (os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", "") + " --mute-audio").strip()
    _child("test_qt_rtc_", {"QTWEBENGINE_CHROMIUM_FLAGS": flags})


def _stage_class():
    from PySide6.QtCore import Property, QObject, Signal, Slot

    def prop(name, typ, default):
        sig = Signal()

        def g(self):
            return self._v.get(name, default)
        return sig, Property(typ, g, notify=sig)

    class Stage(QObject):
        rtcCommand = Signal(str)
        shareCodeChanged, shareCode = prop("shareCode", str, "")
        shareCodeUrlChanged, shareCodeUrl = prop("shareCodeUrl", str, "")
        shareCodeQrChanged, shareCodeQr = prop("shareCodeQr", str, "")
        shareActiveChanged, shareActive = prop("shareActive", bool, False)
        triggerVisibleChanged, triggerVisible = prop("triggerVisible", bool, False)
        rtcActiveChanged, rtcActive = prop("rtcActive", bool, False)
        rtcHtmlChanged, rtcHtml = prop("rtcHtml", str, "")
        rtcBaseUrlChanged, rtcBaseUrl = prop("rtcBaseUrl", str, "about:blank")

        def __init__(self):
            super().__init__()
            self._v = {}
            self.logs = []

        def set(self, name, value):
            if self._v.get(name) != value:
                self._v[name] = value
                getattr(self, name + "Changed").emit()

        @Slot(str)
        def rtcLog(self, msg):
            self.logs.append(msg)

    return Stage


def _view(qml_file, extra_init=None):
    from PySide6.QtCore import QUrl
    if extra_init:
        extra_init()
    from PySide6.QtGui import QGuiApplication
    app = QGuiApplication.instance() or QGuiApplication([])
    from PySide6.QtQuick import QQuickView
    stage = _stage_class()()
    view = QQuickView()
    view.rootContext().setContextProperty("stage", stage)
    view.setResizeMode(QQuickView.SizeRootObjectToView)
    view.resize(320, 180)
    view.setSource(QUrl.fromLocalFile(os.path.abspath(os.path.join(QML, qml_file))))
    assert view.status() == QQuickView.Ready, [e.toString() for e in view.errors()]
    view.show()
    return app, view, stage


def _pump(app, secs, until=lambda: False):
    end = time.monotonic() + secs
    while time.monotonic() < end and not until():
        app.processEvents()
        time.sleep(0.01)
    return until()


def test_qt_code_badge_hides_under_a_trigger_and_comes_back():
    if not CHILD:
        pytest.skip("runs in its own process (test_share_code_in_a_gui_process)")
    app, view, stage = _view("ShareCode.qml")
    root = view.rootObject()
    stage.set("shareCodeUrl", "s.example/share")
    stage.set("shareCode", "K7QM-3XHP")
    assert root.isVisible()
    stage.set("triggerVisible", True)
    assert not root.isVisible()          # the same frame the trigger appears
    stage.set("triggerVisible", False)
    assert root.isVisible()
    stage.set("shareActive", True)
    assert not root.isVisible()          # unchanged: hidden while a share is on screen


# A stand-in for /player/screen-share.js. OLD is a receiver from before #845 (no suppress(); its
# relayout unmutes the presenter, as the real one does on every resize). NEW has suppress().
_SHARE_JS = r"""
window.__calls = [];
window.STScreenShare = (function(){
  var o = null, a = null, sup = false;
  function relayout(){ if (a) a.muted = %(relayout_mute)s; }
  window.addEventListener('resize', relayout);
  var api = {
    isSupported: function(){ return true; },
    start: function(opts){
      o = document.createElement('div'); o.id = 'st-share-overlay';
      o.style.cssText = 'position:fixed;inset:0;background:#c00';
      if (sup) o.style.visibility = 'hidden';
      a = document.createElement('audio'); a.muted = true; o.appendChild(a);
      document.body.appendChild(o); relayout(); opts.onState('connecting', '');
    },
    stop: function(){ if (o) o.remove(); o = null; a = null; },
    relayout: relayout
  };
  %(extra)s
  return api;
})();
"""
OLD_JS = _SHARE_JS % {"relayout_mute": "false", "extra": ""}
NEW_JS = _SHARE_JS % {"relayout_mute": "sup", "extra": (
    "api.suppress = function(on){ window.__calls.push(!!on); sup = !!on;"
    " if (o) o.style.visibility = sup ? 'hidden' : ''; relayout(); };")}
_SERVE = {"share": OLD_JS}


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        body = _SERVE["share"] if path == "/player/screen-share.js" else ("" if path.startswith("/player/") else None)
        self.send_response(200 if body is not None else 404)
        self.send_header("Content-Type", "application/javascript")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write((body or "").encode())

    def log_message(self, *a):
        pass


@pytest.fixture(scope="module")
def rtc_rig():
    if not CHILD:
        pytest.skip("runs in its own process (test_rtc_layer_in_a_gui_process)")
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def init():
        from PySide6.QtWebEngineQuick import QtWebEngineQuick
        QtWebEngineQuick.initialize()
    app, view, stage = _view("TalkVideo.qml", init)
    stage.set("rtcBaseUrl", "http://127.0.0.1:%d/" % srv.server_address[1])
    stage.set("rtcHtml", rtc_page("ws://127.0.0.1:9/frames?k=x"))
    yield app, view, stage
    srv.shutdown()


def _open(app, stage, js):
    _SERVE["share"] = js
    stage.set("rtcActive", False)
    _pump(app, 0.3)
    stage.logs.clear()
    stage.set("rtcActive", True)
    assert _pump(app, 30, lambda: "[rtc] ready" in stage.logs), stage.logs


def _probe(app, stage):
    n = len(stage.logs)
    stage.rtcCommand.emit(
        "console.log('[rtc] probe ' + JSON.stringify((function(){ var o = document.getElementById('st-share-overlay');"
        " var a = o && o.querySelector('audio'); return { title: document.title, overlay: !!o,"
        " hidden: !!o && getComputedStyle(o).visibility === 'hidden', muted: !!a && a.muted,"
        " suppressed: ST.shareSuppressed(), calls: window.__calls }; })()))")
    assert _pump(app, 10, lambda: any(m.startswith("[rtc] probe ") for m in stage.logs[n:]))
    return json.loads([m for m in stage.logs[n:] if m.startswith("[rtc] probe ")][-1][len("[rtc] probe "):])


def _start(stage, sid, suppress):
    stage.rtcCommand.emit("ST.shareStart(%s)" % json.dumps({"sessionId": sid, "sharedBy": "Gail", "suppress": suppress}))


def test_qt_rtc_old_receiver_share_hidden_and_silent_under_a_trigger(rtc_rig):
    app, view, stage = rtc_rig
    root = view.rootObject()
    _open(app, stage, OLD_JS)
    _start(stage, "s1", False)
    assert _pump(app, 5, lambda: root.isVisible()), "the share-only page shows the layer"
    assert _probe(app, stage)["title"] == "rtc:share"

    stage.set("triggerVisible", True)
    assert not root.isVisible()          # same frame, before the page has heard anything
    stage.rtcCommand.emit("ST.shareSuppress(true)")
    p = _probe(app, stage)
    assert p["hidden"] and p["muted"] and p["suppressed"] and p["overlay"]
    # The old receiver unmutes its presenter on a relayout: the page mutes it straight back.
    stage.rtcCommand.emit("STScreenShare.relayout()")
    _pump(app, 0.5)
    assert _probe(app, stage)["muted"]

    stage.set("triggerVisible", False)
    assert root.isVisible()
    stage.rtcCommand.emit("ST.shareSuppress(false)")
    p = _probe(app, stage)
    assert not p["hidden"] and not p["muted"] and not p["suppressed"] and p["overlay"]

    # A share that starts while a trigger is up starts hidden and silent.
    stage.rtcCommand.emit("ST.shareStop('s1', 'stopped')")
    stage.set("triggerVisible", True)
    _start(stage, "s2", True)
    p = _probe(app, stage)
    assert p["overlay"] and p["hidden"] and p["muted"]
    _pump(app, 1)
    assert not root.isVisible()
    stage.set("triggerVisible", False)
    stage.rtcCommand.emit("ST.shareSuppress(false)")
    p = _probe(app, stage)
    assert not p["hidden"] and not p["muted"]
    assert root.isVisible()


def test_qt_rtc_new_receiver_is_told_through_its_suppress(rtc_rig):
    app, view, stage = rtc_rig
    stage.set("triggerVisible", False)
    _open(app, stage, NEW_JS)
    _start(stage, "s3", True)
    p = _probe(app, stage)
    assert p["calls"] == [True] and p["hidden"] and p["muted"]
    stage.rtcCommand.emit("ST.shareSuppress(false)")
    p = _probe(app, stage)
    assert p["calls"] == [True, False] and not p["hidden"] and not p["muted"]
