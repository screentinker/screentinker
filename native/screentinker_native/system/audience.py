"""Audience counting on the native player (Pi / Windows): the camera half and the controller.

Needs the OPTIONAL add-on (OpenCV, numpy and the YuNet face model, ~50 MB to download). It is never
part of the player package: an operator chooses it at install time (the Windows installer's
"Audience counting" checkbox, `raspberry-pi-setup.sh --audience`, `screentinker-pi audience-addon
install`). Without it this module does nothing, and the player does not declare `audience.camera`,
so the dashboard says why this screen cannot count.

The SERVER decides whether to count (server/lib/audience.js). As on Android, `audience` null or
absent in a payload means OFF — camera closed, indicator hidden, counts flushed — on every payload.

⚠️ READ BEFORE CHANGING THE CAMERA CODE. Frame in, face BOXES out, frame gone:
  - a frame is read, turned grey, shrunk to ~480 px wide, and the colour frame dropped at once;
  - YuNet finds faces in the grey picture; only FRONTAL ones are kept (logic/audience.frontal):
    an impression is someone looking at the screen, not walking past it;
  - what leaves this module is a handful of numbers per face (centre and size). The pictures are
    never written to disk, logged, sent, shown, or reachable by screenshots or the live view — no
    Qt surface ever draws one. They live in one worker thread's locals until the next frame.
"""

import json
import logging
import os
import sys
import threading
import time

from ..logic.audience import NONE_ITEM, Aggregator, AudienceQueue, ScreenItem, boxes_from_detections

log = logging.getLogger("audience")

ADDON_NAME = "screentinker-audience"
FRAME_WIDTH = 480          # what the detector sees; ~3-4 m range on a 720p camera
SCORE_THRESHOLD = 0.7
NMS_THRESHOLD = 0.3


# ---------------------------------------------------------------------- the add-on

def addon_dir():
    """Where the installer puts the add-on. Root/admin-owned in both cases: the player loads code from
    here, so it must not be a directory the player user (or the dashboard's remote shell) can write."""
    env = os.environ.get("ST_AUDIENCE_ADDON_DIR")
    if env:
        return env
    if sys.platform == "win32":
        base = os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else os.path.join(
            os.environ.get("ProgramFiles", r"C:\Program Files"), "ScreenTinker")
        return os.path.join(base, "addons", "audience")
    if sys.platform.startswith("linux"):
        return "/opt/screentinker/audience-addon"
    return None                      # macOS: not offered


class Addon:
    def __init__(self, root, manifest, cv2):
        self.root = root
        self.manifest = manifest
        self.cv2 = cv2
        self.version = str(manifest.get("version") or "")
        self.model = os.path.join(root, str(manifest.get("model") or "face_detection_yunet.onnx"))


def load_addon(root=None):
    """(Addon, None) or (None, reason). Never raises: a broken add-on is a screen that cannot count,
    not a player that cannot start."""
    root = root or addon_dir()
    if not root or not os.path.isdir(root):
        return None, "not installed"
    try:
        with open(os.path.join(root, "ADDON.json"), encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError) as e:
        return None, "ADDON.json unreadable: %s" % e
    if manifest.get("name") != ADDON_NAME:
        return None, "not the audience add-on"
    want = str(manifest.get("python") or "")
    have = "%d.%d" % sys.version_info[:2]
    # ⚠️ Compiled modules (numpy) load only into the Python they were built for. A mismatch is
    # refused BEFORE importing — the failure mode otherwise can be a crash, not an ImportError.
    if want != have:
        return None, "built for Python %s, this player runs %s — reinstall the add-on" % (want or "?", have)
    if root not in sys.path:
        sys.path.insert(0, root)
    try:
        import cv2  # noqa: PLC0415 — only ever imported from the add-on, and only here
    except Exception as e:  # ImportError, or a DLL load failure
        return None, "OpenCV did not load: %s" % e
    if not hasattr(cv2, "FaceDetectorYN"):
        return None, "this OpenCV has no FaceDetectorYN"
    a = Addon(root, manifest, cv2)
    if not os.path.isfile(a.model):
        return None, "face model missing"
    return a, None


# ---------------------------------------------------------------------- cameras

V4L2_CAP_VIDEO_CAPTURE = 0x00000001
V4L2_CAP_VIDEO_M2M = 0x00008000
V4L2_CAP_VIDEO_M2M_MPLANE = 0x00004000
V4L2_CAP_DEVICE_CAPS = 0x80000000
VIDIOC_QUERYCAP = 0x80685600            # _IOR('V', 0, struct v4l2_capability), 104 bytes
# The Pi's own camera pipeline (CSI modules through libcamera) and codec nodes: raw sensor or
# memory-to-memory devices OpenCV cannot read frames from. A USB (UVC) webcam is what counts.
_RAW_PIPELINE_DRIVERS = {"unicam", "rp1-cfe", "bcm2835-isp", "pispbe", "bcm2835-codec", "rpivid", "hevc-rpi"}


def parse_querycap(buf):
    """(driver, card, usable) from a struct v4l2_capability. Pure, for tests."""
    import struct
    driver = buf[0:16].split(b"\0", 1)[0].decode("ascii", "replace")
    card = buf[16:48].split(b"\0", 1)[0].decode("utf-8", "replace")
    caps, device_caps = struct.unpack_from("<II", buf, 84)
    eff = device_caps if caps & V4L2_CAP_DEVICE_CAPS else caps
    usable = bool(eff & V4L2_CAP_VIDEO_CAPTURE) and not (eff & (V4L2_CAP_VIDEO_M2M | V4L2_CAP_VIDEO_M2M_MPLANE)) \
        and driver not in _RAW_PIPELINE_DRIVERS
    return driver, card, usable


def _linux_cameras():
    import fcntl
    import glob
    out = []
    for dev in sorted(glob.glob("/dev/video*"), key=lambda p: int("".join(c for c in p if c.isdigit()) or 0)):
        try:
            fd = os.open(dev, os.O_RDWR | os.O_NONBLOCK)
        except OSError:
            continue
        try:
            buf = bytearray(104)
            fcntl.ioctl(fd, VIDIOC_QUERYCAP, buf)
            driver, card, usable = parse_querycap(bytes(buf))
            if usable:
                out.append((dev, card or driver))
        except OSError:
            pass
        finally:
            os.close(fd)
    return out


def _windows_cameras():
    # Listing does not open a camera (no LED). QtMultimedia is already in the player.
    try:
        from PySide6.QtMultimedia import QMediaDevices
        return [(str(i), d.description()) for i, d in enumerate(QMediaDevices.videoInputs())]
    except Exception as e:
        log.info("camera list unavailable: %s", e)
        return []


def list_cameras():
    if sys.platform.startswith("linux"):
        return _linux_cameras()
    if sys.platform == "win32":
        return _windows_cameras()
    return []


# ---------------------------------------------------------------------- the worker

class CameraWorker(threading.Thread):
    """Reads frames at `fps`, hands face boxes to on_faces(boxes, now_ms). Its own thread, so a slow
    camera or detector never stalls playback."""

    def __init__(self, addon, source, fps, on_faces):
        super().__init__(name="audience-camera", daemon=True)
        self.addon = addon
        self.source = source
        self.fps = max(1, min(5, int(fps)))
        self.on_faces = on_faces
        self._halt = threading.Event()
        self.running = False

    def stop(self):
        self._halt.set()

    def set_fps(self, fps):
        self.fps = max(1, min(5, int(fps)))

    def _open(self):
        cv2 = self.addon.cv2
        src = self.source
        is_file = isinstance(src, str) and os.path.isfile(src) and not src.startswith("/dev/")
        if is_file:
            return cv2.VideoCapture(src), True                       # a test clip (ST_AUDIENCE_CAMERA)
        if sys.platform == "win32":
            idx = int(src) if str(src).isdigit() else 0
            for api in (cv2.CAP_DSHOW, cv2.CAP_MSMF):
                cap = cv2.VideoCapture(idx, api)
                if cap.isOpened():
                    break
        else:
            cap = cv2.VideoCapture(src, cv2.CAP_V4L2)
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap, False

    def run(self):
        cv2 = self.addon.cv2
        detector, size, cap, is_file, failures = None, None, None, False, 0
        try:
            while not self._halt.is_set():
                t0 = time.monotonic()
                if cap is None or not cap.isOpened():
                    cap, is_file = self._open()
                    if not cap.isOpened():
                        failures += 1
                        if failures in (1, 10) or failures % 100 == 0:
                            log.warning("camera %s did not open (%d attempt(s))", self.source, failures)
                        cap = None
                        self._halt.wait(min(30, 2 * failures))
                        continue
                    log.info("camera %s open", self.source)
                    failures = 0
                if not is_file:
                    cap.grab()                         # drop the frame that has waited in the buffer
                ok, frame = cap.read()
                if not ok:
                    if is_file:                        # a test clip loops
                        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                        continue
                    log.warning("camera %s stopped delivering frames; reopening", self.source)
                    cap.release()
                    cap = None
                    self._halt.wait(2)
                    continue
                self.running = True
                h, w = frame.shape[:2]
                tw = min(FRAME_WIDTH, w)
                th = max(1, int(round(h * tw / float(w))))
                grey = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                del frame                              # the colour frame goes first
                grey = cv2.resize(grey, (tw, th), interpolation=cv2.INTER_AREA)
                inp = cv2.cvtColor(grey, cv2.COLOR_GRAY2BGR)   # YuNet takes 3 channels; still grey
                del grey
                if detector is None or size != (tw, th):
                    size = (tw, th)
                    detector = cv2.FaceDetectorYN.create(self.addon.model, "", size, SCORE_THRESHOLD, NMS_THRESHOLD, 100)
                _, rows = detector.detect(inp)
                inp[:] = 0
                del inp
                boxes = boxes_from_detections(rows, tw)
                try:
                    self.on_faces(boxes, int(time.time() * 1000))
                except Exception:
                    log.exception("audience frame handler failed")
                self._halt.wait(max(0.0, 1.0 / self.fps - (time.monotonic() - t0)))
        except Exception:
            log.exception("audience camera worker failed")
        finally:
            self.running = False
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass


# ---------------------------------------------------------------------- the controller

class AudienceController:
    """Payload in, counts out. Thread-safe: on_payload/set_item/set_visible from the Qt thread, frames
    from the camera worker, acks from the network thread."""

    def __init__(self, state_dir, on_buckets, set_indicator, camera_override=None):
        self.on_buckets = on_buckets           # there is something to send (any thread)
        self.set_indicator = set_indicator     # bool -> the corner camera icon (any thread)
        self.queue = AudienceQueue(path=os.path.join(state_dir, "audience-queue.json"))
        self.queue.load()
        self._lock = threading.RLock()
        self._config = None
        self._agg = None
        self._worker = None
        self._item = NONE_ITEM
        self._visible = True
        self.addon, self.reason = load_addon()
        self.cameras = list_cameras() if self.addon else []
        self.source = camera_override or os.environ.get("ST_AUDIENCE_CAMERA") or (self.cameras[0][0] if self.cameras else None)
        if self.addon and not self.cameras and not self.source:
            self.reason = ("no camera found (a USB webcam is needed; a Pi camera module is not supported)"
                           if sys.platform.startswith("linux") else
                           "no camera found (plug in a USB webcam, and allow desktop apps to use the camera "
                           "in Settings > Privacy & security > Camera)")
        if self.available:
            log.info("audience add-on %s ready, camera %s", self.addon.version, self.source)
        elif self.reason != "not installed":
            log.warning("audience counting unavailable: %s", self.reason)

    @property
    def available(self):
        """Declared as the 'audience.camera' capability: this player COULD count if the org asked."""
        return self.addon is not None and bool(self.source)

    def on_payload(self, payload):
        a = payload.get("audience") if isinstance(payload, dict) else None
        nxt = None
        if isinstance(a, dict) and a.get("enabled") is True:
            nxt = {
                "fps": max(1, min(5, _int(a.get("fps"), 2))),
                "min_dwell_ms": max(500, min(10_000, _int(a.get("min_dwell_ms"), 1000))),
                "show_indicator": a.get("show_indicator") is not False,
            }
        with self._lock:
            if nxt == self._config:
                return
            prev, self._config = self._config, nxt
            if nxt is None:
                self._stop_counting()
                return
            if prev is None or prev["min_dwell_ms"] != nxt["min_dwell_ms"]:
                self._stop_counting()
                self._agg = Aggregator(min_dwell_ms=nxt["min_dwell_ms"])
                self._agg.item = self._item
            if self._worker:
                self._worker.set_fps(nxt["fps"])
            if self._visible:
                self._start_camera()
            self._update_indicator()

    def set_item(self, kind, item_id):
        it = ScreenItem(kind, item_id) if item_id else NONE_ITEM
        with self._lock:
            self._item = it
            if self._agg:
                self._agg.item = it

    def set_visible(self, visible):
        """The screen is showing content (not blanked by the power schedule or the dashboard)."""
        with self._lock:
            if visible == self._visible:
                return
            self._visible = visible
            if visible and self._config:
                self._start_camera()
            elif not visible:
                self._stop_camera(flush=True)

    def shutdown(self):
        with self._lock:
            self._stop_counting()

    # -- send / ack (the app's link does the emitting)
    def peek(self):
        return self.queue.peek()

    def ack(self, ids):
        self.queue.ack(ids)
        self._save()
        return self.queue.size()

    # -- internals (called with the lock held)
    def _start_camera(self):
        if not self.available or (self._worker and self._worker.is_alive()):
            return
        if self._agg is None:
            self._agg = Aggregator(min_dwell_ms=self._config["min_dwell_ms"])
            self._agg.item = self._item
        self._worker = CameraWorker(self.addon, self.source, self._config["fps"], self._on_faces)
        self._worker.start()
        self._update_indicator()

    def _stop_camera(self, flush):
        w, self._worker = self._worker, None
        if w:
            w.stop()
        if flush and self._agg:
            self._queue(self._agg.flush_all(int(time.time() * 1000)))
        self._update_indicator()

    def _stop_counting(self):
        self._stop_camera(flush=True)
        self._agg = None

    def _on_faces(self, boxes, now_ms):
        with self._lock:
            if self._agg is None or self._worker is None:
                return
            done = self._agg.on_frame(boxes, now_ms)
        self._queue(done)

    def _queue(self, buckets):
        if not buckets:
            return
        self.queue.add_all(buckets)
        self._save()
        try:
            self.on_buckets()
        except Exception:
            log.exception("audience flush trigger failed")

    def _save(self):
        try:
            self.queue.save()
        except OSError as e:
            log.warning("audience queue not saved: %s", e)

    def _update_indicator(self):
        show = bool(self._config and self._config["show_indicator"] and self._worker is not None)
        try:
            self.set_indicator(show)
        except Exception:
            pass


def _int(v, default):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def self_check(clip=None, seconds=8.0):
    """`screentinker-pi run --audience-check [CLIP]` / `ScreenTinker.exe --audience-check [CLIP]`: does
    the add-on load in THIS player, which cameras does it see, and (with a clip) what does it count?
    For an operator checking a screen; the result goes to stdout and the player log."""
    out = {"addon_dir": addon_dir()}
    addon, reason = load_addon()
    out["addon"] = addon.version if addon else None
    out["reason"] = reason
    if sys.platform == "win32":
        from PySide6.QtCore import QCoreApplication
        if QCoreApplication.instance() is None:
            out["_qt"] = QCoreApplication([])      # QMediaDevices needs an application object
    out["cameras"] = [{"id": i, "name": n} for i, n in list_cameras()] if addon else []
    out.pop("_qt", None)
    if addon and clip:
        agg = Aggregator()
        agg.item = ScreenItem("content", "check")
        frames = []
        lock = threading.Lock()

        def on_faces(boxes, now_ms):
            with lock:
                frames.append(len(boxes))
                agg.on_frame(boxes, now_ms)
        w = CameraWorker(addon, clip, 5, on_faces)
        w.start()
        time.sleep(seconds)
        w.stop()
        w.join(5)
        with lock:
            buckets = agg.flush_all(int(time.time() * 1000))
        out["frames"] = len(frames)
        out["faces_per_frame_max"] = max(frames) if frames else 0
        out["arrivals"] = sum(b.arrivals for b in buckets)
        out["impressions"] = sum(b.impressions for b in buckets)
    return out
