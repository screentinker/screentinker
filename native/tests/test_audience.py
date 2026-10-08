"""Audience counting on the native player: logic/audience.py (a port of Android's AudienceAggregator,
held to the same cases as AudienceAggregatorTest.kt) and the parts of system/audience.py that need no
camera or OpenCV: the add-on gate, the V4L2 probe parser, and the controller's on/off rules."""
import json
import re
import struct
import sys
import threading

import pytest

from screentinker_native.logic import audience as A
from screentinker_native.system import audience as S

PROMO = A.ScreenItem("content", "c-1")
CLOCK = A.ScreenItem("widget", "w-1")
FACE = A.FaceBox(0.5, 0.5, 0.2)
T0 = 1_700_000_040_000          # the start of a minute (1_700_000_040 % 60 == 0)


def run(a, faces, from_ms, ms, fps=2):
    out, t = [], from_ms
    while t < from_ms + ms:
        out += a.on_frame(faces, t)
        t += 1000 // fps
    return out


def test_a_single_frame_flicker_counts_as_nobody():
    a = A.Aggregator()
    a.item = PROMO
    a.on_frame([FACE], T0)
    run(a, [], T0 + 500, 5_000)
    [b] = a.flush_all(T0 + 6_000)
    assert b.arrivals == 0 and b.present_max == 0


def test_a_look_is_one_arrival_one_impression_counted_when_it_ends():
    a = A.Aggregator(min_dwell_ms=1000)
    a.item = PROMO
    run(a, [FACE], T0, 4_000)
    run(a, [], T0 + 4_000, 3_000)
    [b] = a.flush_all(T0 + 8_000)
    assert (b.arrivals, b.impressions, b.present_max) == (1, 1, 1)
    assert b.dwell[1] == 1                      # 2-5s
    assert 40 <= b.present_avg_x100() <= 70


def test_a_glance_shorter_than_min_dwell_is_an_arrival_not_an_impression():
    a = A.Aggregator(min_dwell_ms=2000)
    a.item = PROMO
    run(a, [FACE], T0, 1_000)
    run(a, [], T0 + 1_000, 3_000)
    [b] = a.flush_all(T0 + 5_000)
    assert (b.arrivals, b.impressions, b.dwell[0]) == (1, 0, 1)


def test_two_people_are_two_tracks():
    a = A.Aggregator()
    a.item = PROMO
    run(a, [FACE, A.FaceBox(0.15, 0.4, 0.15)], T0, 3_000)
    run(a, [], T0 + 3_000, 3_000)
    [b] = a.flush_all(T0 + 7_000)
    assert (b.arrivals, b.present_max) == (2, 2)


def test_a_face_moving_slowly_stays_one_track():
    a = A.Aggregator()
    a.item = PROMO
    t = T0
    for i in range(10):
        a.on_frame([A.FaceBox(0.4 + i * 0.01, 0.5, 0.2)], t)
        t += 500
    run(a, [], t, 3_000)
    [b] = a.flush_all(t + 4_000)
    assert b.arrivals == 1


def test_buckets_close_at_the_minute_and_go_to_the_item_they_came_for():
    a = A.Aggregator()
    a.item = PROMO
    run(a, [FACE], T0 + 50_000, 5_000)          # confirmed while the promo is on screen
    a.item = CLOCK                              # the item changes mid-look
    closed = run(a, [FACE], T0 + 55_000, 10_000)
    assert [b for b in closed if b.start == T0 // 1000], "the first minute closed once the next began"
    run(a, [], T0 + 65_000, 3_000)
    rest = a.flush_all(T0 + 70_000)
    [promo_next] = [b for b in rest if b.item == PROMO]
    assert promo_next.arrivals == 1, "counted in the minute it ENDED, for the item it came to look at"
    assert promo_next.start == (T0 + 60_000) // 1000
    assert any(b.item == CLOCK and b.frames > 0 for b in rest)


def test_every_bucket_is_a_shape_the_server_accepts():
    a = A.Aggregator()
    a.item = PROMO
    run(a, [FACE, A.FaceBox(0.2, 0.2, 0.1)], T0, 30_000)
    run(a, [], T0 + 30_000, 3_000)
    a.item = A.NONE_ITEM
    run(a, [FACE], T0 + 33_000, 1_000)
    allowed = {"id", "start", "seconds", "item_kind", "item_id", "present_max", "present_avg_x100",
               "arrivals", "impressions", "dwell", "segment", "observed_ms"}
    for b in a.flush_all(T0 + 40_000):
        o = b.to_json()
        assert set(o) <= allowed, set(o) - allowed
        assert o["start"] % 60 == 0
        assert o["impressions"] <= o["arrivals"]
        assert o["present_avg_x100"] <= o["present_max"] * 100
        assert len(o["dwell"]) == 6
        assert 0 <= o["segment"] <= 9999 and 0 <= o["observed_ms"] <= o["seconds"] * 1000
        assert re.match(r"^[A-Za-z0-9:_-]{1,80}$", o["id"])
        assert all(isinstance(v, int) for k, v in o.items() if k not in ("id", "item_kind", "item_id", "dwell"))
        if o["item_kind"] == "none":
            assert "item_id" not in o


def test_the_wire_format_equals_androids():
    # The same bucket Android would build, field for field (AudienceBucket.toJson).
    b = A.Bucket(T0 // 1000, 60, PROMO, segment=17)
    b.present_max, b.present_sum, b.frames = 2, 3, 4
    b.arrivals, b.impressions, b.dwell = 3, 2, [1, 1, 1, 0, 0, 0]
    b.observed_ms = 1500
    assert b.to_json() == {"id": "m1700000040-s17-content-c-1", "start": 1700000040, "seconds": 60,
                           "item_kind": "content", "item_id": "c-1", "present_max": 2,
                           "present_avg_x100": 75, "arrivals": 3, "impressions": 2,
                           "dwell": [1, 1, 1, 0, 0, 0], "segment": 17, "observed_ms": 1500}
    long = A.Bucket(T0 // 1000, 60, A.ScreenItem("content", "x" * 100), segment=9999)
    assert len(long.id) == 80 and long.id.startswith("m1700000040-s9999-content-xxx")
    long.observed_ms = 10 ** 9
    assert long.to_json()["observed_ms"] == 60_000


def test_a_run_that_restarts_mid_minute_sends_a_new_id_not_a_duplicate():
    # Regression: blank at :20, unblank at :40 — the second run's bucket for the same minute and item
    # had the first one's id, so the server dropped it as already received.
    first = A.Aggregator(segment=4)
    first.item = PROMO
    run(first, [FACE], T0, 5_000)
    [a] = first.flush_all(T0 + 20_000)
    second = A.Aggregator(segment=5)
    second.item = PROMO
    run(second, [FACE], T0 + 40_000, 5_000)
    [b] = second.flush_all(T0 + 50_000)
    assert (a.start, a.item) == (b.start, b.item) and a.id != b.id
    q = A.AudienceQueue()
    q.add_all([a, b])
    assert q.size() == 2


def test_observed_ms_is_time_on_screen_while_counting_with_stalls_capped():
    a = A.Aggregator(frame_interval_ms=500)
    a.item = PROMO
    run(a, [], T0, 10_000)                     # 20 frames 500 ms apart: 19 gaps
    a.item = CLOCK
    a.on_frame([], T0 + 10_500)
    a.on_frame([], T0 + 30_000)                # the camera stalled 19.5 s: counts as 2 frame intervals
    out = {b.item: b for b in a.flush_all(T0 + 31_000)}
    assert out[PROMO].observed_ms == 19 * 500
    assert out[CLOCK].observed_ms == 1000 + 1000
    a2 = A.Aggregator()
    a2.item = PROMO
    run(a2, [FACE], T0 + 56_000, 3_000)
    a2.item = CLOCK
    a2.on_frame([], T0 + 61_000)               # the look ends in the next minute, on the clock
    later = {b.item: b for b in a2.flush_all(T0 + 62_000)}
    # The promo's bucket in that minute exists only for the departure: it was never on screen there.
    assert (later[PROMO].frames, later[PROMO].arrivals, later[PROMO].observed_ms) == (0, 1, 0)
    assert later[CLOCK].observed_ms == 1000


def test_dwell_buckets_match_the_server_labels():
    assert [A.dwell_index(ms) for ms in (1_999, 2_000, 14_999, 15_000, 59_999, 600_000)] == [0, 1, 2, 3, 4, 5]


def test_the_queue_round_trips_dedupes_acks_and_is_bounded(tmp_path):
    a = A.Aggregator()
    a.item = PROMO
    run(a, [FACE], T0, 3_000)
    run(a, [], T0 + 3_000, 3_000)
    bs = a.flush_all(T0 + 7_000)
    q = A.AudienceQueue(cap=3, path=str(tmp_path / "q.json"))
    q.add_all(bs)
    q.add_all(bs)
    assert q.size() == len(bs)
    q.save()
    back = A.AudienceQueue(cap=3, path=q.path)
    back.load()
    assert back.peek() == q.peek(), "a persisted bucket sends exactly what it would have"
    back.ack([bs[0].id])
    assert back.size() == q.size() - 1
    many = [A.Bucket(T0 // 1000 + i * 60, 60, PROMO) for i in range(5)]
    q.add_all(many)
    assert q.size() == 3
    assert q.peek()[-1]["id"] == many[-1].id, "oldest dropped first"
    assert A.AudienceQueue.from_json("not json").size() == 0


def test_a_bucket_queued_by_an_older_player_keeps_its_id():
    old = {"id": "m1700000040-content-c-1", "start": 1700000040, "seconds": 60, "item_kind": "content",
           "item_id": "c-1", "present_max": 1, "present_avg_x100": 50, "arrivals": 1, "impressions": 1,
           "dwell": [0, 1, 0, 0, 0, 0]}
    q = A.AudienceQueue.from_json(json.dumps([old]))
    assert q.peek() == [old], "the same id (and shape) it may already have been sent under"
    q.ack([old["id"]])
    assert q.size() == 0


def test_concurrent_saves_never_corrupt_the_queue(tmp_path):
    # Regression: the camera and network threads both saved through one shared .tmp file, unlocked.
    q = A.AudienceQueue(path=str(tmp_path / "q.json"))
    q.add_all([A.Bucket(T0 // 1000 + i * 60, 60, PROMO, segment=i) for i in range(300)])
    errors = []

    def saver():
        try:
            for _ in range(20):
                q.save()
        except Exception as e:   # noqa: BLE001 — any failure is the bug
            errors.append(e)
    ts = [threading.Thread(target=saver) for _ in range(6)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert not errors
    back = A.AudienceQueue(path=q.path)
    back.load()
    assert back.peek(1000) == q.peek(1000)
    assert not [p for p in tmp_path.iterdir() if p.name.endswith(".tmp")]


# ---------------------------------------------------------------------- detector rows -> boxes

def _row(x, y, w, h, re_x, le_x, nose_x, score=0.9):
    return [x, y, w, h, re_x, y + h * 0.4, le_x, y + h * 0.4, nose_x, y + h * 0.6, 0, 0, 0, 0, score]


def test_only_frontal_faces_count():
    frontal = _row(100, 100, 50, 60, 112, 138, 125)
    profile = _row(100, 100, 50, 60, 130, 140, 150)   # eyes bunched, nose outside them
    assert A.frontal(frontal) and not A.frontal(profile)
    [b] = A.boxes_from_detections([frontal, profile], 480)
    assert b == pytest.approx(A.FaceBox(125 / 480, 130 / 480, 60 / 480))
    assert A.boxes_from_detections(None, 480) == []


# ---------------------------------------------------------------------- the add-on gate

def _addon(tmp_path, **manifest):
    d = tmp_path / "audience"
    d.mkdir()
    m = {"name": "screentinker-audience", "version": "1.0.0", "python": "%d.%d" % sys.version_info[:2],
         "model": "face.onnx"}
    m.update(manifest)
    (d / "ADDON.json").write_text(json.dumps(m))
    return str(d)


def test_no_addon_is_quietly_not_installed(tmp_path):
    assert S.load_addon(str(tmp_path / "missing")) == (None, "not installed")


def test_an_addon_for_another_python_is_refused_before_import(tmp_path, monkeypatch):
    d = _addon(tmp_path, python="2.7")
    before = list(sys.path)
    a, reason = S.load_addon(d)
    assert a is None and "Python 2.7" in reason
    assert sys.path == before, "never put on sys.path"


def test_something_else_in_the_addon_dir_is_refused(tmp_path):
    d = _addon(tmp_path, name="not-us")
    assert S.load_addon(d) == (None, "not the audience add-on")


def test_a_broken_opencv_is_a_reason_not_a_crash(tmp_path, monkeypatch):
    d = _addon(tmp_path)
    (tmp_path / "audience" / "cv2.py").write_text("raise ImportError('DLL load failed')\n")
    monkeypatch.delitem(sys.modules, "cv2", raising=False)
    monkeypatch.setattr(sys, "path", list(sys.path))
    a, reason = S.load_addon(d)
    assert a is None and "DLL load failed" in reason
    sys.modules.pop("cv2", None)


# ---------------------------------------------------------------------- V4L2 probe

def _cap(driver, caps, device_caps=0):
    buf = bytearray(104)
    buf[0:len(driver)] = driver.encode()
    buf[16:21] = b"Cam X"
    struct.pack_into("<III", buf, 80, 0, caps, device_caps)
    return bytes(buf)


def test_v4l2_probe_keeps_usb_cameras_and_drops_codecs_and_raw_pipelines():
    usb = _cap("uvcvideo", S.V4L2_CAP_DEVICE_CAPS | 0x1 | 0x04000000, 0x1 | 0x04000000)
    meta = _cap("uvcvideo", S.V4L2_CAP_DEVICE_CAPS | 0x1, 0x00800000)      # the UVC metadata node
    codec = _cap("bcm2835-codec", S.V4L2_CAP_DEVICE_CAPS | 0x8000, 0x8000)
    unicam = _cap("unicam", S.V4L2_CAP_DEVICE_CAPS | 0x1, 0x1)
    assert S.parse_querycap(usb) == ("uvcvideo", "Cam X", True)
    assert not S.parse_querycap(meta)[2]
    assert not S.parse_querycap(codec)[2]
    assert not S.parse_querycap(unicam)[2]


# ---------------------------------------------------------------------- controller on/off

class FakeWorker:
    started = []

    def __init__(self, addon, source, fps, on_faces, rescan=None):
        self.fps, self.on_faces, self.alive, self.rescan = fps, on_faces, False, rescan
        FakeWorker.started.append(self)

    def start(self):
        self.alive = True

    def is_alive(self):
        return self.alive

    def stop(self):
        self.alive = False

    def set_fps(self, fps):
        self.fps = fps


@pytest.fixture
def ctl(tmp_path, monkeypatch):
    FakeWorker.started = []
    monkeypatch.setattr(S, "CameraWorker", FakeWorker)
    monkeypatch.setattr(S, "load_addon", lambda root=None: (S.Addon("/x", {"version": "1.0.0"}, None), None))
    monkeypatch.setattr(S, "list_cameras", lambda: [("/dev/video0", "USB cam")])
    sent, ind = [], []
    c = S.AudienceController(str(tmp_path), on_buckets=lambda: sent.append(1), set_indicator=ind.append)
    c.sent, c.ind = sent, ind
    return c


ON = {"audience": {"enabled": True, "fps": 3, "min_dwell_ms": 1000, "show_indicator": True}}


def test_off_unless_the_payload_says_on_and_null_switches_off(ctl):
    assert ctl.available
    ctl.on_payload({})
    assert FakeWorker.started == []
    ctl.on_payload(ON)
    [w] = FakeWorker.started
    assert w.alive and w.fps == 3 and ctl.ind[-1] is True
    ctl.set_item("content", "c-1")
    for i in range(6):
        w.on_faces([FACE], T0 + i * 500)
    ctl.on_payload({"audience": None})
    assert not w.alive and ctl.ind[-1] is False
    sent = ctl.peek()
    assert all(b["item_id"] == "c-1" for b in sent)
    # The face still in view leaves at switch-off: counted in THAT (real) minute.
    assert sum(b["arrivals"] for b in sent) == 1, "faces in view are counted as leaving at switch-off"
    assert ctl.sent


def test_a_blanked_screen_does_not_count(ctl):
    ctl.on_payload(ON)
    [w] = FakeWorker.started
    ctl.set_visible(False)
    assert not w.alive
    ctl.set_visible(True)
    assert len(FakeWorker.started) == 2 and FakeWorker.started[1].alive


def test_every_counting_run_is_a_new_segment_and_a_restart_does_not_reuse_one(ctl, tmp_path, monkeypatch):
    ctl.on_payload(ON)
    ctl.set_item("content", "c-1")
    for _ in range(2):                          # count, blank, unblank — all inside one minute
        w = FakeWorker.started[-1]
        for i in range(6):
            w.on_faces([FACE], T0 + i * 500)
        ctl.set_visible(False)
        ctl.set_visible(True)
    mine = [b for b in ctl.peek() if b["start"] == T0 // 1000]   # (departures land in the real minute)
    ids = [b["id"] for b in mine]
    segs = [b["segment"] for b in mine]
    assert len(ids) == 2 and len(set(ids)) == 2 and segs[1] == (segs[0] + 1) % 10000
    ctl.shutdown()
    again = S.AudienceController(str(tmp_path), on_buckets=lambda: None, set_indicator=lambda on: None)
    again.on_payload(ON)
    FakeWorker.started[-1].on_faces([FACE], T0)
    again.shutdown()
    assert again.peek()[-1]["segment"] not in segs, "the number is persisted across a restart"


def test_only_an_unpinned_camera_is_rescanned(ctl, tmp_path, monkeypatch):
    ctl.on_payload(ON)
    w = FakeWorker.started[-1]
    monkeypatch.setattr(S, "list_cameras", lambda: [("/dev/video2", "USB cam")])
    assert w.rescan() == "/dev/video2" and ctl.source == "/dev/video2"
    pinned = S.AudienceController(str(tmp_path), on_buckets=lambda: None, set_indicator=lambda on: None,
                                  camera_override="/dev/video7")
    pinned.on_payload(ON)
    assert FakeWorker.started[-1].rescan is None


def test_the_indicator_can_be_turned_off_and_an_ack_empties_the_queue(ctl):
    ctl.on_payload({"audience": dict(ON["audience"], show_indicator=False)})
    assert ctl.ind[-1] is False
    w = FakeWorker.started[0]
    for i in range(6):
        w.on_faces([FACE], T0 + i * 500)
    ctl.shutdown()
    ids = [b["id"] for b in ctl.peek()]
    assert ids and ctl.ack(ids) == 0


def test_without_the_addon_nothing_is_declared(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "load_addon", lambda root=None: (None, "not installed"))
    c = S.AudienceController(str(tmp_path), on_buckets=lambda: None, set_indicator=lambda on: None)
    c.on_payload(ON)
    assert not c.available and c.reason == "not installed"


def _fake_lstat(tree):
    """lstat over a fake tree {path: (uid, mode)}, for the ownership gate (tests cannot chown to root)."""
    import os
    import types

    def lstat(p):
        if p not in tree:
            raise FileNotFoundError(p)
        uid, mode = tree[p]
        return types.SimpleNamespace(st_uid=uid, st_mode=mode)
    return lstat


def test_the_addon_dir_and_every_parent_must_be_root_only():
    import stat as st
    D = st.S_IFDIR
    good = {"/": (0, D | 0o755), "/usr": (0, D | 0o755), "/usr/lib": (0, D | 0o755),
            "/usr/lib/a": (0, D | 0o755)}
    assert S.untrusted_component("/usr/lib/a", _fake_lstat(good)) is None
    for path, val, why in [("/usr/lib/a", (1000, D | 0o755), "not owned by root"),
                           ("/usr/lib", (0, D | 0o775), "writable by others"),     # group-writable
                           ("/usr", (0, D | 0o757), "writable by others"),         # world-writable
                           ("/usr/lib", (0, st.S_IFLNK | 0o777), "symlink")]:
        bad = dict(good, **{path: val})
        assert why in S.untrusted_component("/usr/lib/a", _fake_lstat(bad)), path


def test_the_player_refuses_an_addon_dir_its_user_could_change(tmp_path, monkeypatch):
    d = _addon(tmp_path)
    (tmp_path / "audience" / "cv2.py").write_text("raise SystemExit('imported!')\n")
    monkeypatch.delenv("ST_AUDIENCE_ADDON_DIR", raising=False)
    monkeypatch.setattr(S, "addon_dir", lambda: d)
    monkeypatch.setattr(sys, "path", list(sys.path))
    a, reason = S.load_addon()
    assert a is None and "not admin-only" in reason
    assert d not in sys.path, "refused before anything in it is imported"
    assert S.LINUX_ADDON_DIR == "/usr/lib/screentinker-pi-audience"
    assert not S.LINUX_ADDON_DIR.startswith("/opt/screentinker"), "the Pi setup chowns that to the player user"


def test_the_dev_override_skips_the_ownership_check_and_says_so(tmp_path, monkeypatch, caplog):
    d = _addon(tmp_path, python="2.7")          # stops right after the gate, before any import
    monkeypatch.setenv("ST_AUDIENCE_ADDON_DIR", d)
    with caplog.at_level("WARNING", logger="audience"):
        a, reason = S.load_addon()
    assert "Python 2.7" in reason, "got past the ownership gate"
    assert "WITHOUT the ownership check" in caplog.text


def test_the_windows_addon_must_be_inside_the_install_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(S.sys, "platform", "win32")
    monkeypatch.setattr(S, "_windows_base", lambda: str(tmp_path / "ScreenTinker"))
    (tmp_path / "ScreenTinker" / "addons" / "audience").mkdir(parents=True)
    (tmp_path / "elsewhere").mkdir()
    assert S.addon_dir_untrusted(str(tmp_path / "ScreenTinker" / "addons" / "audience")) is None
    assert "not inside" in S.addon_dir_untrusted(str(tmp_path / "elsewhere"))
    assert "not inside" in S.addon_dir_untrusted(str(tmp_path / "ScreenTinker-evil"))


class _FakeCV2:
    CAP_V4L2 = CAP_DSHOW = CAP_MSMF = CAP_PROP_FOURCC = CAP_PROP_FRAME_WIDTH = 0
    CAP_PROP_FRAME_HEIGHT = CAP_PROP_BUFFERSIZE = CAP_PROP_POS_FRAMES = 0

    def __init__(self, opens=True):
        self.opens, self.opened = opens, []

    def VideoCapture(self, src, *a):
        self.opened.append(src)
        opens = self.opens

        class Cap:
            def isOpened(self):
                return opens

            def set(self, *a):
                pass

            def grab(self):
                pass

            def read(self):
                return False, None              # opens, but never a frame

            def release(self):
                pass
        return Cap()

    @staticmethod
    def VideoWriter_fourcc(*a):
        return 0


class _Halt:
    """Stands in for the worker's Event: records each wait, ends the run after `n` of them."""
    def __init__(self, n):
        self.n, self.waits = n, []

    def is_set(self):
        return len(self.waits) >= self.n

    def set(self):
        self.n = 0

    def wait(self, t):
        self.waits.append(t)


@pytest.mark.parametrize("opens", [True, False])
def test_a_camera_that_fails_backs_off_logs_rarely_and_is_looked_for_again(tmp_path, caplog, opens):
    # Regression: a camera that opened but delivered nothing was reopened every 2 s forever, with a
    # warning (mirrored to the server under set_debug) each time; the camera list was never rebuilt.
    cv2 = _FakeCV2(opens)
    rescans = []

    def rescan():
        rescans.append(1)
        return "/dev/video2"
    w = S.CameraWorker(S.Addon(str(tmp_path), {"version": "1"}, cv2), "/dev/video0", 2, lambda b, t: None,
                       rescan=rescan)
    w._halt = _Halt(40)
    with caplog.at_level("WARNING", logger="audience"):
        w.run()
    assert w._halt.waits[:3] == [2, 4, 6] and max(w._halt.waits) == S.MAX_BACKOFF_S
    assert len([r for r in caplog.records if r.levelname == "WARNING"]) == 2     # the 1st and the 10th
    assert len(rescans) == 40 // S.RESCAN_AFTER
    assert w.source == "/dev/video2" and cv2.opened[-1] == "/dev/video2", "switched to the camera found"


def test_the_camera_worker_stops_and_joins_even_with_no_camera(tmp_path):
    # Regression: an attribute named _stop shadowed threading.Thread._stop and broke join().
    class Cap:
        def isOpened(self):
            return False

    class CV2:
        CAP_V4L2 = CAP_DSHOW = CAP_MSMF = CAP_PROP_FOURCC = CAP_PROP_FRAME_WIDTH = 0
        CAP_PROP_FRAME_HEIGHT = CAP_PROP_BUFFERSIZE = 0

        @staticmethod
        def VideoCapture(*a):
            return Cap()

        @staticmethod
        def VideoWriter_fourcc(*a):
            return 0

    w = S.CameraWorker(S.Addon(str(tmp_path), {"version": "1"}, CV2), "/dev/video9", 2, lambda b, t: None)
    w.start()
    w.stop()
    w.join(5)
    assert not w.is_alive()
