"""Hide the pointer over the kiosk window while the mouse is idle; show it again when it moves.

A sign should not carry an arrow over its content, but someone who walks up and touches the mouse
(an interactive page, a technician) needs to see where it is. So the pointer is blanked after
IDLE_MS without movement and restored on the next move, the same rule as the browser kiosk's
`unclutter -idle 3` and wayfire's `hide_delay = 3000`.

This is done from the player rather than the compositor because the compositor cannot be relied on:
eglfs (Lite) has no compositor at all, and on a Pi desktop labwc has no idle-hide setting. Wayland
lets a client set the pointer over its own surface, which a fullscreen player always is.
"""

from PySide6.QtCore import QEvent, QObject, Qt, QTimer
from PySide6.QtGui import QCursor

IDLE_MS = 3000

_MOVES = (QEvent.Type.MouseMove, QEvent.Type.HoverMove, QEvent.Type.TabletMove)


class IdleCursor(QObject):
    """Install once on the QGuiApplication. Starts hidden: a sign boots with nobody at the mouse."""

    def __init__(self, qt_app, idle_ms=IDLE_MS):
        super().__init__(qt_app)
        self._app = qt_app
        self._hidden = False
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.setInterval(idle_ms)
        self._timer.timeout.connect(self._hide)
        qt_app.installEventFilter(self)
        self._hide()

    @property
    def hidden(self):
        return self._hidden

    def _hide(self):
        if not self._hidden:
            self._app.setOverrideCursor(QCursor(Qt.CursorShape.BlankCursor))
            self._hidden = True

    def _show(self):
        # Exactly one override is ours; restoring more would pop a cursor someone else set.
        if self._hidden:
            self._app.restoreOverrideCursor()
            self._hidden = False

    def moved(self):
        self._show()
        self._timer.start()

    def eventFilter(self, obj, ev):
        if ev.type() in _MOVES:
            self.moved()
        return False
