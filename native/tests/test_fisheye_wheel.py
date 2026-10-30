"""A fisheye camera zooms with the mouse wheel when its item allows steering (ui/qml/Slot.qml).

Loads the real Slot.qml offscreen and sends it wheel events: one notch up must ask for a 15% zoom in,
down the inverse, and nothing at all when the item does not allow steering. On the Pi this was the
only way to test it: labwc there delivered no wheel events to any client.
"""

import os

import pytest

# ⚠️ Slot.qml imports QtWebEngine, which must be initialised before the one Qt application a process
# may have (see test_status_display.py), so the test_qt_* cases run in a fresh interpreter.
CHILD = os.environ.get("ST_FISHEYE_WHEEL_QT_CHILD") == "1"
SLOT = os.path.join(os.path.dirname(__file__), "..", "screentinker_native", "ui", "qml", "Slot.qml")


def test_wheel_in_a_gui_process():
    if CHILD:
        pytest.skip("this is the child")
    pytest.importorskip("PySide6.QtWebEngineQuick")
    import subprocess
    import sys
    env = dict(os.environ, ST_FISHEYE_WHEEL_QT_CHILD="1", QT_QPA_PLATFORM="offscreen")
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-k", "test_qt_", __file__],
                       env=env, capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
    assert " passed" in r.stdout and "skipped" not in r.stdout.splitlines()[-1], r.stdout[-500:]


@pytest.fixture(scope="module")
def slot():
    if not CHILD:
        pytest.skip("runs in its own process (test_wheel_in_a_gui_process)")
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
    view.show()
    app.processEvents()
    return app, view, view.rootObject()


def _camera(touch):
    # The view as logic/fisheye.py FisheyeView.qml() hands it to QML, looking straight down the axis.
    return {"kind": "video", "source": "", "token": "cam-%s" % touch,
            "fisheye": {"qsb": "", "dir": [0, 0, 1], "right": [1, 0, 0], "up": [0, -1, 0], "tanX": 1.0,
                        "lensHalf": 1.5708, "rot": 0.0, "cx": 0.5, "cy": 0.5, "r": 0.5, "touch": touch}}


def _wheel(app, view, notches):
    from PySide6.QtCore import QPoint, QPointF, Qt
    from PySide6.QtGui import QGuiApplication, QWheelEvent
    at = QPointF(320, 180)
    ev = QWheelEvent(at, view.mapToGlobal(at), QPoint(0, 0), QPoint(0, 120 * notches),
                     Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier, Qt.ScrollPhase.NoScrollPhase, False)
    QGuiApplication.sendEvent(view, ev)
    app.processEvents()


def _load(app, root, item):
    from PySide6.QtCore import Q_ARG, QMetaObject
    QMetaObject.invokeMethod(root, "load", Q_ARG("QVariant", item))
    for _ in range(5):
        app.processEvents()


def test_qt_the_wheel_zooms_like_a_pinch(slot):
    app, view, root = slot
    got = []
    root.fisheyeTouch.connect(got.append)
    _load(app, root, _camera(True))
    _wheel(app, view, 1)
    _wheel(app, view, -1)
    _wheel(app, view, 2)
    scales = [float(d.split()[1]) for d in got]
    assert [d.split()[0] for d in got] == ["pinch"] * 3, got
    assert scales[0] == pytest.approx(1.15)
    assert scales[1] == pytest.approx(1 / 1.15)
    assert scales[2] == pytest.approx(1.15 ** 2)


def test_qt_no_steering_no_zoom(slot):
    app, view, root = slot
    got = []
    root.fisheyeTouch.connect(got.append)
    _load(app, root, _camera(False))
    _wheel(app, view, 1)
    assert got == []


def test_qt_paused_steering_takes_nothing(slot):
    # The settings menu is drawn over the camera (Surface.qml binds steeringPaused to stage.menuOpen):
    # handlers under the point get a press before the menu's buttons, so they must be off.
    app, view, root = slot
    got = []
    root.fisheyeTouch.connect(got.append)
    _load(app, root, _camera(True))
    root.setProperty("steeringPaused", True)
    app.processEvents()
    _wheel(app, view, 1)
    assert got == []
    root.setProperty("steeringPaused", False)
    app.processEvents()
    _wheel(app, view, 1)
    assert [d.split()[0] for d in got] == ["pinch"], got
