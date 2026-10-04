"""The QML-facing half of the player: every property Main.qml binds to, every signal it listens
for, and the slots it calls back. Lives on the Qt (main) thread. Nothing here decides what to play —
PlaybackEngine does — this is the switchboard between that logic and the scene.
"""

import base64
import logging

from PySide6.QtCore import (QBuffer, QByteArray, QEvent, QIODevice, QObject, QPointF, Qt, Property,
                          Signal, Slot)
from PySide6.QtGui import QGuiApplication, QKeyEvent, QMouseEvent

log = logging.getLogger("stage")


class Stage(QObject):
    # --- signals to QML --------------------------------------------------------------------
    showItem = Signal(str, "QVariantMap")
    clearSurface = Signal(str)
    control = Signal(str, "QVariantMap")
    toast = Signal(str)
    rtcCommand = Signal(str)
    openMenu = Signal(int)
    kioskLoad = Signal(str)            # #473: load this URL in the interactive page
    kioskJs = Signal(str)              # #473: run this script in the interactive page

    # property change notifications
    rotationChanged = Signal()
    layoutModeChanged = Signal()
    zonesChanged = Signal()
    wallChanged = Signal()
    backgroundChanged = Signal()
    volumeChanged = Signal()
    mutedChanged = Signal()
    dimChanged = Signal()
    blankChanged = Signal()
    triggerVisibleChanged = Signal()
    pipsChanged = Signal()
    statusVisibleChanged = Signal()
    statusTitleChanged = Signal()
    statusDetailChanged = Signal()
    pairingCodeChanged = Signal()
    footerChanged = Signal()
    hasPinChanged = Signal()
    menuActionsChanged = Signal()
    rtcActiveChanged = Signal()
    rtcHtmlChanged = Signal()
    rtcBaseUrlChanged = Signal()
    shadersSupportedChanged = Signal()
    kioskShownChanged = Signal()
    kioskMountedChanged = Signal()
    kioskProfileChanged = Signal()
    kioskZoomChanged = Signal()
    kioskOverlayChanged = Signal()
    kioskCardChanged = Signal()
    kioskHomeChanged = Signal()
    kioskSeqChanged = Signal()

    def __init__(self, engine_cb):
        super().__init__()
        self._cb = engine_cb            # object with on_slot_event / on_slot_position / on_pip_closed / ...
        self.window = None
        self.kiosk = None               # ui/kiosk.KioskSession, set by it
        # True while delivering a REMOTE (dashboard) touch/key: those must never start or keep alive
        # a visitor session (#473) — an operator testing the page would lock themselves out.
        self.synthetic_input = False

    # --- properties (QML reads; python sets via set_x) -------------------------------------
    # PyQt needs the notify signal object at class-creation time, so properties are declared
    # explicitly below rather than generated.
    def _g(name, default):  # noqa: N805
        return lambda self: getattr(self, "_" + name, default)

    rotation = Property(int, fget=_g("rotation", 0), notify=rotationChanged)
    layoutMode = Property(str, fget=_g("layoutMode", "single"), notify=layoutModeChanged)
    zones = Property("QVariantList", fget=_g("zones", []), notify=zonesChanged)
    wall = Property("QVariant", fget=_g("wall", None), notify=wallChanged)
    background = Property(str, fget=_g("background", "black"), notify=backgroundChanged)
    volume = Property(float, fget=_g("volume", 1.0), notify=volumeChanged)
    muted = Property(bool, fget=_g("muted", False), notify=mutedChanged)
    dim = Property(float, fget=_g("dim", 0.0), notify=dimChanged)
    blank = Property(bool, fget=_g("blank", False), notify=blankChanged)
    triggerVisible = Property(bool, fget=_g("triggerVisible", False), notify=triggerVisibleChanged)
    pips = Property("QVariantList", fget=_g("pips", []), notify=pipsChanged)
    statusVisible = Property(bool, fget=_g("statusVisible", True), notify=statusVisibleChanged)
    statusTitle = Property(str, fget=_g("statusTitle", "Starting…"), notify=statusTitleChanged)
    statusDetail = Property(str, fget=_g("statusDetail", ""), notify=statusDetailChanged)
    pairingCode = Property(str, fget=_g("pairingCode", ""), notify=pairingCodeChanged)
    footer = Property(str, fget=_g("footer", ""), notify=footerChanged)
    hasPin = Property(bool, fget=_g("hasPin", False), notify=hasPinChanged)
    menuActions = Property("QVariantList", fget=_g("menuActions", []), notify=menuActionsChanged)
    rtcActive = Property(bool, fget=_g("rtcActive", False), notify=rtcActiveChanged)
    rtcHtml = Property(str, fget=_g("rtcHtml", ""), notify=rtcHtmlChanged)
    rtcBaseUrl = Property(str, fget=_g("rtcBaseUrl", "about:blank"), notify=rtcBaseUrlChanged)
    shadersSupported = Property(bool, fget=_g("shadersSupported", True), notify=shadersSupportedChanged)
    # #473 interactive page (ui/kiosk.py drives these; ui/qml/KioskLayer.qml renders them)
    kioskShown = Property(bool, fget=_g("kioskShown", False), notify=kioskShownChanged)
    kioskMounted = Property(bool, fget=_g("kioskMounted", False), notify=kioskMountedChanged)
    kioskProfile = Property(QObject, fget=_g("kioskProfile", None), notify=kioskProfileChanged)
    kioskZoom = Property(float, fget=_g("kioskZoom", 1.0), notify=kioskZoomChanged)
    kioskOverlay = Property(str, fget=_g("kioskOverlay", ""), notify=kioskOverlayChanged)
    kioskCard = Property(str, fget=_g("kioskCard", ""), notify=kioskCardChanged)
    kioskHome = Property(bool, fget=_g("kioskHome", False), notify=kioskHomeChanged)
    kioskSeq = Property(int, fget=_g("kioskSeq", 0), notify=kioskSeqChanged)
    del _g

    def set(self, name, value):
        """Python-side setter for any property above; emits its change signal only on change."""
        if getattr(self, "_" + name, object()) != value:
            setattr(self, "_" + name, value)
            getattr(self, name + "Changed").emit()

    # --- slots QML calls ---------------------------------------------------------------------
    @Slot(str, str, str, str)
    def slotEvent(self, surface_id, token, event, detail):
        try:
            self._cb.on_slot_event(surface_id, token, event, detail)
        except Exception:
            log.exception("slot event")

    @Slot(str, str, float, float)
    def slotPosition(self, surface_id, token, pos_ms, dur_ms):
        try:
            self._cb.on_slot_position(surface_id, token, pos_ms, dur_ms)
        except Exception:
            log.exception("slot position")

    @Slot(str)
    def pipClosed(self, pip_id):
        self._cb.on_pip_closed(pip_id)

    @Slot(str, result=bool)
    def checkPin(self, pin):
        return self._cb.check_pin(pin)

    @Slot(str)
    def menuAction(self, action_id):
        self._cb.on_menu_action(action_id)

    @Slot(str)
    def rtcLog(self, msg):
        self._cb.on_rtc_log(msg)

    # --- #473 interactive page: KioskLayer.qml -> ui/kiosk.py --------------------------------
    @Slot(str, bool, result=bool)
    def kioskNavAllowed(self, url, main_frame):
        k = self.kiosk
        return bool(k and k.nav_allowed(url, main_frame))

    @Slot(str)
    def kioskNewWindow(self, url):
        if self.kiosk:
            self.kiosk.new_window(url)

    @Slot(str)
    def kioskUrlChanged(self, url):
        if self.kiosk:
            self.kiosk.url_changed(url)

    @Slot(str, bool, int, str)
    def kioskLoadDone(self, url, ok, status, detail):
        if self.kiosk:
            self.kiosk.load_finished(url, ok, status, detail)

    @Slot(str)
    def kioskRendererGone(self, detail):
        if self.kiosk:
            self.kiosk.renderer_gone(detail)

    @Slot()
    def kioskHomeTapped(self):
        if self.kiosk:
            self.kiosk.home(touch=not self.synthetic_input)

    @Slot()
    def kioskOverlayTapped(self):
        if self.kiosk and not self.synthetic_input:
            self.kiosk.overlay_tapped()

    @Slot(str)
    def kioskConsole(self, message):
        if self.kiosk and message == "__stkiosk:media":
            self.kiosk.media_playing()

    def eventFilter(self, obj, ev):
        """Installed on the window: every press, touch and key is activity for the interactive page's
        idle clock (it never consumes anything — the page gets every event)."""
        k = self.kiosk
        if k is not None and k.is_showing and not self.synthetic_input and ev.type() in self._INPUT_EVENTS:
            # ⚠️ Not a press while "Still there?" is up: resuming here would hide the overlay BEFORE
            # Qt delivers the press, so the tap meant for the overlay landed on the page underneath
            # (it followed a link in the first e2e run). The overlay's own MouseArea resumes instead.
            if self.kioskOverlay and ev.type() != QEvent.Type.KeyPress:
                return False
            try:
                k.user_input()
            except Exception:
                log.exception("kiosk input")
        return False

    _INPUT_EVENTS = (QEvent.Type.MouseButtonPress, QEvent.Type.TouchBegin, QEvent.Type.KeyPress,
                     QEvent.Type.Wheel)

    # --- screenshot ----------------------------------------------------------------------------
    def _grab(self):
        """The window as an image — or, while a visitor is using an interactive page (#473), a black
        frame of the same size: an operator watching the panel must not see what a visitor types."""
        if self.kiosk is not None and self.kiosk.session_active:
            from PySide6.QtGui import QImage
            img = QImage(max(1, self.window.width()), max(1, self.window.height()), QImage.Format.Format_RGB32)
            img.fill(Qt.GlobalColor.black)
            return img
        return self.window.grabWindow()

    def screenshot_jpeg_b64(self, max_width=960, quality=40, rotate=0):
        """Android ScreenshotCapture parity: JPEG q40, at most 960 px wide, base64 (no wrapping).
        grabWindow() reads back the whole scene graph — video, WebEngine textures, overlays — which
        is exactly "what the panel shows", unlike a canvas snapshot that cannot see cross-origin frames."""
        if self.window is None:
            return None
        img = self._grab()
        if img.isNull():
            return None
        if img.width() > max_width:
            img = img.scaledToWidth(max_width, Qt.TransformationMode.SmoothTransformation)
        ba = QByteArray()
        buf = QBuffer(ba)
        buf.open(QIODevice.OpenModeFlag.WriteOnly)
        img.save(buf, "JPEG", quality)
        buf.close()
        return base64.b64encode(bytes(ba)).decode()

    def frame_jpeg(self, width=1280, quality=60):
        """Raw JPEG bytes of the current frame for the live-video publisher."""
        if self.window is None:
            return None
        img = self._grab()
        if img.isNull():
            return None
        if img.width() != width:
            img = img.scaledToWidth(width, Qt.TransformationMode.FastTransformation)
        ba = QByteArray()
        buf = QBuffer(ba)
        buf.open(QIODevice.OpenModeFlag.WriteOnly)
        img.save(buf, "JPEG", quality)
        buf.close()
        return bytes(ba)

    # --- remote input --------------------------------------------------------------------------
    def inject_touch(self, x, y, action, x2=None, y2=None, duration_ms=300):
        """device:remote-touch: x/y normalised 0..1 of the screen. Delivered into our own window —
        the Pi equivalent of Android dispatching into the player's view."""
        w = self.window
        if w is None:
            return []
        W, H = w.width(), w.height()
        p = QPointF(max(0.0, min(1.0, float(x))) * W, max(0.0, min(1.0, float(y))) * H)
        steps = []
        if action in ("tap", "down"):
            steps.append((QEvent.Type.MouseButtonPress, p, 0))
        if action == "tap":
            steps.append((QEvent.Type.MouseButtonRelease, p, 60))
        elif action == "move":
            steps.append((QEvent.Type.MouseMove, p, 0))
        elif action == "up":
            steps.append((QEvent.Type.MouseButtonRelease, p, 0))
        elif action == "swipe" and x2 is not None and y2 is not None:
            p2 = QPointF(max(0.0, min(1.0, float(x2))) * W, max(0.0, min(1.0, float(y2))) * H)
            d = max(50, min(3000, int(duration_ms or 300)))
            n = max(2, d // 16)
            steps.append((QEvent.Type.MouseButtonPress, p, 0))
            for i in range(1, n + 1):
                t = i / n
                steps.append((QEvent.Type.MouseMove, QPointF(p.x() + (p2.x() - p.x()) * t,
                                                             p.y() + (p2.y() - p.y()) * t), d // n))
            steps.append((QEvent.Type.MouseButtonRelease, p2, 0))
        return steps

    def send_mouse(self, etype, pos):
        w = self.window
        if w is None:
            return
        buttons = Qt.MouseButton.LeftButton if etype != QEvent.Type.MouseButtonRelease else Qt.MouseButton.NoButton
        if etype == QEvent.Type.MouseMove:
            buttons = Qt.MouseButton.LeftButton
        ev = QMouseEvent(etype, pos, pos, Qt.MouseButton.LeftButton if etype != QEvent.Type.MouseMove else Qt.MouseButton.NoButton,
                         buttons, Qt.KeyboardModifier.NoModifier)
        self._send_synthetic(w, ev)

    def _send_synthetic(self, target, ev):
        # sendEvent delivers synchronously, so the flag covers the event filter AND any QML handler
        # (the Home button, the overlay) that runs inside this delivery.
        self.synthetic_input = True
        try:
            QGuiApplication.sendEvent(target, ev)
        finally:
            self.synthetic_input = False

    KEYMAP = {
        "KEYCODE_DPAD_UP": Qt.Key.Key_Up, "KEYCODE_DPAD_DOWN": Qt.Key.Key_Down,
        "KEYCODE_DPAD_LEFT": Qt.Key.Key_Left, "KEYCODE_DPAD_RIGHT": Qt.Key.Key_Right,
        "KEYCODE_DPAD_CENTER": Qt.Key.Key_Return, "KEYCODE_ENTER": Qt.Key.Key_Return,
        "KEYCODE_BACK": Qt.Key.Key_Escape, "KEYCODE_ESCAPE": Qt.Key.Key_Escape,
        "KEYCODE_TAB": Qt.Key.Key_Tab, "KEYCODE_SPACE": Qt.Key.Key_Space, "KEYCODE_DEL": Qt.Key.Key_Backspace,
        "KEYCODE_PAGE_UP": Qt.Key.Key_PageUp, "KEYCODE_PAGE_DOWN": Qt.Key.Key_PageDown,
        "KEYCODE_MOVE_HOME": Qt.Key.Key_Home, "KEYCODE_MOVE_END": Qt.Key.Key_End,
    }

    def inject_key(self, keycode):
        """Returns True if delivered to the window; False for keys the caller handles itself
        (HOME, POWER, VOLUME_*, APP_SWITCH, MENU)."""
        k = self.KEYMAP.get(keycode)
        if k is None and keycode.startswith("KEYCODE_") and len(keycode) == 9:
            ch = keycode[-1]
            if ch.isalnum():
                k = getattr(Qt.Key, "Key_" + ch.upper(), None)
        if k is None or self.window is None:
            return False
        for t in (QEvent.Type.KeyPress, QEvent.Type.KeyRelease):
            self._send_synthetic(self.window, QKeyEvent(t, k, Qt.KeyboardModifier.NoModifier))
        return True
