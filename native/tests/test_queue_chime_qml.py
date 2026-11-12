"""The queue chime bridge in the real Slot.qml, offscreen: a widget render page served on loopback gets
window.STQueueChime after it loads, its call comes back as Slot.queueChime("<token> <volume> <url>"),
and a page the widget navigated to never gets the bridge.

⚠️ SILENT: offscreen Qt, Chromium started with --mute-audio, no audio sink anywhere. The chime itself
is never played here (the engine decides and app.play_queue_chime plays; see test_queue_chime.py).
"""

import http.server
import os
import threading
import time

import pytest

# ⚠️ Slot.qml imports QtWebEngine, which must be initialised before the one Qt application a process
# may have (see test_fisheye_wheel.py), so the test_qt_* cases run in a fresh interpreter.
CHILD = os.environ.get("ST_QUEUE_CHIME_QT_CHILD") == "1"
SLOT = os.path.join(os.path.dirname(__file__), "..", "screentinker_native", "ui", "qml", "Slot.qml")


def test_bridge_in_a_gui_process():
    if CHILD:
        pytest.skip("this is the child")
    # Opt-in: it starts a real Chromium renderer, which cannot start inside some sandboxed shells and
    # containers (it dies with SIGTRAP). Run with ST_TEST_WEBENGINE=1 on a machine where it can.
    if os.environ.get("ST_TEST_WEBENGINE") != "1":
        pytest.skip("set ST_TEST_WEBENGINE=1 to load the widget page in a real QtWebEngine")
    pytest.importorskip("PySide6.QtWebEngineQuick")
    import subprocess
    import sys
    flags = (os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", "") + " --mute-audio").strip()
    env = dict(os.environ, ST_QUEUE_CHIME_QT_CHILD="1", QT_QPA_PLATFORM="offscreen",
               QTWEBENGINE_CHROMIUM_FLAGS=flags)
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-k", "test_qt_", __file__],
                       env=env, capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
    assert " passed" in r.stdout and "skipped" not in r.stdout.splitlines()[-1], r.stdout[-500:]


CALLER = ("<script>setInterval(function(){try{if(window.parent===window&&window.STQueueChime)"
          "window.STQueueChime.chime(String(0.7))}catch(e){}},150)</script>")
PAGES = {
    "/api/widgets/w1/render": "<!doctype html><html><body>42" + CALLER +
                              # A frame inside the widget can log the prefix, but not with the token.
                              "<iframe src=\"/frame\"></iframe></body></html>",
    "/frame": "<!doctype html><script>setInterval(function(){console.log('ST_QUEUE_CHIME forged 1 x')},150)</script>",
    "/api/widgets/w2/render": "<!doctype html><script>location.replace('/elsewhere')</script>",
    "/elsewhere": "<!doctype html><html><body>away" + CALLER.replace("window.STQueueChime.chime",
                  "console.log('has bridge '+typeof window.STQueueChime);window.STQueueChime.chime") + "</body></html>",
}


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGES.get(self.path.split("?")[0])
        self.send_response(200 if body else 404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write((body or "").encode())

    def log_message(self, *a):
        pass


@pytest.fixture(scope="module")
def rig():
    if not CHILD:
        pytest.skip("runs in its own process (test_bridge_in_a_gui_process)")
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    from PySide6.QtCore import QUrl
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    QtWebEngineQuick.initialize()
    from PySide6.QtGui import QGuiApplication
    app = QGuiApplication.instance() or QGuiApplication([])
    from PySide6.QtQuick import QQuickView
    view = QQuickView()
    view.setResizeMode(QQuickView.SizeRootObjectToView)
    view.resize(320, 180)
    view.setSource(QUrl.fromLocalFile(os.path.abspath(SLOT)))
    assert view.status() == QQuickView.Ready, [e.toString() for e in view.errors()]
    view.show()
    got = []
    view.rootObject().queueChime.connect(lambda d: got.append(d))
    yield app, view.rootObject(), "http://127.0.0.1:%d" % srv.server_address[1], got
    srv.shutdown()


def _load(app, root, item):
    from PySide6.QtCore import Q_ARG, QMetaObject
    QMetaObject.invokeMethod(root, "load", Q_ARG("QVariant", item))


def _pump(app, secs, until=lambda: False):
    end = time.monotonic() + secs
    while time.monotonic() < end and not until():
        app.processEvents()
        time.sleep(0.01)


def test_qt_the_widget_page_gets_the_bridge_and_reports_with_its_url(rig):
    from screentinker_native.logic import queue_chime as QC
    app, root, base, got = rig
    tok = QC.new_token()
    src = base + "/api/widgets/w1/render?device=dev1&rev=1"
    _load(app, root, {"kind": "web", "source": src, "token": "t1", "muted": False, "chimeJs": QC.bridge_script(tok)})
    _pump(app, 30, lambda: any(d.startswith(tok) for d in got))
    ours = [d for d in got if d.startswith(tok)]
    assert ours, got[:5]
    ok, raw, url = QC.parse_console(ours[0], tok)
    assert ok and raw == "0.7" and QC.same_widget_page(url, src)
    # The frame's forged lines reach the slot too, and the token check is what refuses them.
    forged = [d for d in got if d.startswith("forged")]
    assert all(not QC.parse_console(d, tok)[0] for d in forged)


def test_qt_a_page_the_widget_navigated_to_never_gets_the_bridge(rig):
    from screentinker_native.logic import queue_chime as QC
    app, root, base, got = rig
    got.clear()
    tok = QC.new_token()
    _load(app, root, {"kind": "web", "source": base + "/api/widgets/w2/render?d=", "token": "t2", "muted": False,
                      "chimeJs": QC.bridge_script(tok)})
    _pump(app, 4)
    assert not [d for d in got if d.startswith(tok)]


def test_qt_a_web_item_without_a_bridge_forwards_nothing(rig):
    app, root, base, got = rig
    got.clear()
    _load(app, root, {"kind": "web", "source": base + "/api/widgets/w1/render?d=", "token": "t3", "muted": False})
    _pump(app, 3)
    assert got == []
