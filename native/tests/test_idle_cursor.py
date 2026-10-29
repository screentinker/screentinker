"""The kiosk pointer hides while the mouse is idle and comes back when it moves (ui/idle_cursor.py)."""

import os
import time

import pytest

# ⚠️ Cursors need a QGuiApplication and a process has one Qt application for life (see
# test_status_display.py), so the test_qt_* cases run in a fresh interpreter started below.
CHILD = os.environ.get("ST_IDLE_CURSOR_QT_CHILD") == "1"


@pytest.fixture(scope="module")
def qapp():
    if not CHILD:
        pytest.skip("runs in its own process (test_cursor_in_a_gui_process)")
    from PySide6.QtGui import QGuiApplication
    return QGuiApplication.instance() or QGuiApplication([])


def test_cursor_in_a_gui_process():
    if CHILD:
        pytest.skip("this is the child")
    import subprocess
    import sys
    env = dict(os.environ, ST_IDLE_CURSOR_QT_CHILD="1", QT_QPA_PLATFORM="offscreen")
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-k", "test_qt_", __file__],
                       env=env, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
    assert " passed" in r.stdout and "skipped" not in r.stdout.splitlines()[-1], r.stdout[-500:]


def _move(qapp, win):
    from PySide6.QtCore import QEvent, QPointF, Qt
    from PySide6.QtGui import QMouseEvent
    ev = QMouseEvent(QEvent.Type.MouseMove, QPointF(5, 5), QPointF(5, 5),
                     Qt.MouseButton.NoButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier)
    qapp.sendEvent(win, ev)


def _pump(qapp, seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        qapp.processEvents()
        time.sleep(0.01)


def _override_depth(qapp):
    n = 0
    while qapp.overrideCursor() is not None:
        qapp.restoreOverrideCursor()
        n += 1
    return n


def test_qt_hidden_at_start_shown_on_move_hidden_again_when_idle(qapp):
    from PySide6.QtCore import Qt
    from PySide6.QtGui import QWindow
    from screentinker_native.ui.idle_cursor import IdleCursor
    win = QWindow()
    ic = IdleCursor(qapp, idle_ms=80)
    try:
        assert ic.hidden and qapp.overrideCursor().shape() == Qt.CursorShape.BlankCursor
        _move(qapp, win)
        assert not ic.hidden and qapp.overrideCursor() is None
        _pump(qapp, 0.03)
        _move(qapp, win)  # still moving: the idle clock restarts, the pointer stays
        _pump(qapp, 0.05)
        assert not ic.hidden
        _pump(qapp, 0.2)
        assert ic.hidden and qapp.overrideCursor().shape() == Qt.CursorShape.BlankCursor
    finally:
        qapp.removeEventFilter(ic)
        _override_depth(qapp)


def test_qt_never_stacks_or_pops_someone_elses_override(qapp):
    from PySide6.QtCore import Qt
    from PySide6.QtGui import QCursor, QWindow
    from screentinker_native.ui.idle_cursor import IdleCursor
    qapp.setOverrideCursor(QCursor(Qt.CursorShape.WaitCursor))  # someone else's
    win = QWindow()
    ic = IdleCursor(qapp, idle_ms=40)
    try:
        for _ in range(5):
            _pump(qapp, 0.08)  # hide
            _move(qapp, win)   # show
        _pump(qapp, 0.15)
        assert ic.hidden
        qapp.removeEventFilter(ic)
        # Ours (blank) on top of theirs (wait), exactly one each.
        assert qapp.overrideCursor().shape() == Qt.CursorShape.BlankCursor
        assert _override_depth(qapp) == 2
    finally:
        _override_depth(qapp)
