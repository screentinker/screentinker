"""Wall zones + hold items (logic/wall_zones.py, player/engine.py "wall zones").

The pure rules are pinned against the web player's reference implementation (server/player/index.html
wallZoneBuckets / wallZoneTarget / wallZoneRect / renderWallZones / wallZoneTick): a mixed wall only
agrees on where every zone is if every player computes the same thing. The engine tests drive the real
PlaybackEngine with a recording fake stage (no display, no QML).
"""
import pytest

from screentinker_native.logic import playlist_logic as pl
from screentinker_native.logic import wall_zones as wz
from screentinker_native.player.items import Item

ALLOW_ALL = lambda it: True  # noqa: E731


def items(*specs):
    return [Item.parse(dict(s, id=i + 1, sort_order=s.get("sort_order", i))) for i, s in enumerate(specs)]


# --- holds -------------------------------------------------------------------------------------

def test_hold_detection_and_mode():
    f = Item.parse({"mime_type": wz.HOLD_MIME, "remote_url": "hold://freeze"})
    b = Item.parse({"mime_type": wz.HOLD_MIME, "remote_url": "hold://blank"})
    junk = Item.parse({"mime_type": wz.HOLD_MIME, "remote_url": "hold://whatever"})
    assert wz.is_hold(f) and wz.is_hold(b) and wz.is_hold({"mime_type": wz.HOLD_MIME})
    assert not wz.is_hold(Item.parse({"mime_type": "video/mp4"})) and not wz.is_hold(None)
    assert wz.hold_mode(f) == "freeze" and wz.hold_mode(b) == "blank" and wz.hold_mode(junk) == "blank"


def test_a_hold_is_a_timed_item_never_an_unknown_type():
    # The solo controller schedules its advance only for ends_on_timer items; an untimed unknown type
    # is skipped, which would silently shorten a timeline.
    assert pl.ends_on_timer(wz.HOLD_MIME, False)
    assert pl.HOLD_MIME == wz.HOLD_MIME
    assert not pl.ends_on_timer("application/pdf", False)


def test_hold_slot_is_the_canonical_slot():
    assert wz.slot_ms(Item.parse({"mime_type": wz.HOLD_MIME, "duration_sec": 0})) == 10_000
    assert wz.slot_ms(Item.parse({"mime_type": wz.HOLD_MIME, "duration_sec": 4})) == 4_000
    assert wz.slot_ms({"duration_sec": 0.2}) == 1_000      # max(1, ...)


# --- activation, geometry, visibility, audio -----------------------------------------------------

Z2 = [{"id": "a", "x_percent": 0, "y_percent": 0, "width_percent": 50, "height_percent": 100},
      {"id": "b", "x_percent": 50, "y_percent": 0, "width_percent": 50, "height_percent": 100}]


def test_active_needs_canvas_layout_and_two_zones():
    assert wz.active({"canvas_layout": True}, Z2)
    assert not wz.active({"canvas_layout": True}, Z2[:1])
    assert not wz.active({}, Z2)
    assert not wz.active(None, Z2)


def test_zone_rect_is_percent_of_the_player_rect():
    pr = {"x": 100, "y": 50, "w": 3840, "h": 1080}
    assert wz.zone_rect({"x_percent": 50, "y_percent": 0, "width_percent": 25, "height_percent": 100}, pr) \
        == (100 + 1920, 50, 960, 1080)


def test_visibility_skips_zones_that_miss_this_panel():
    # Two 1920 panels side by side; zone a covers the left half of the canvas, b the right half.
    wc = {"player_rect": {"x": 0, "y": 0, "w": 3840, "h": 1080}}
    left = dict(wc, screen_rect={"x": 0, "y": 0, "w": 1920, "h": 1080})
    right = dict(wc, screen_rect={"x": 1920, "y": 0, "w": 1920, "h": 1080})
    assert wz.zone_visible(Z2[0], left) and not wz.zone_visible(Z2[1], left)
    assert wz.zone_visible(Z2[1], right) and not wz.zone_visible(Z2[0], right)
    # Edge-touching is not overlap (strict), a zone straddling the seam is on both.
    seam = {"id": "s", "x_percent": 40, "y_percent": 0, "width_percent": 20, "height_percent": 100}
    assert wz.zone_visible(seam, left) and wz.zone_visible(seam, right)


def test_audio_rule_one_panel_voices_a_zone_and_item_mute_wins():
    wc = {"audio_zones": ["a"]}
    assert wz.zone_has_audio("a", wc) and not wz.zone_has_audio("b", wc)
    assert not wz.zone_muted("a", wc, False)
    assert wz.zone_muted("a", wc, True)          # per-item mute still wins
    assert wz.zone_muted("b", wc, False)
    assert wz.zone_muted("a", {}, False)         # no audio_zones -> silent


def test_config_key_includes_canvas_layout_and_audio_zones():
    base = {"wall_id": "w", "is_leader": False, "screen_rect": {"x": 0, "y": 0, "w": 1, "h": 1},
            "player_rect": {"x": 0, "y": 0, "w": 2, "h": 1}, "canvas_layout": True, "audio_zones": ["a"]}
    k = wz.config_key(base, Z2)
    assert k == wz.config_key(dict(base), [dict(z) for z in Z2])
    assert k != wz.config_key(dict(base, audio_zones=["b"]), Z2)
    assert k != wz.config_key(dict(base, canvas_layout=False), Z2)
    assert k != wz.config_key(dict(base, rotation=90), Z2)
    assert k != wz.config_key(base, [Z2[0], dict(Z2[1], width_percent=40)])


# --- bucketing (renderZones rules, layout order) -------------------------------------------------

def test_buckets_orphans_go_to_the_largest_zone_and_unassigned_to_the_first_empty_one():
    zones = [{"id": "small", "width_percent": 10, "height_percent": 10},
             {"id": "big", "width_percent": 90, "height_percent": 90},
             {"id": "empty", "width_percent": 50, "height_percent": 50}]
    its = items({"zone_id": "small", "filename": "s"},
                {"zone_id": "gone", "filename": "orphan"},
                {"filename": "u1", "sort_order": 9},
                {"filename": "u0", "sort_order": 1})
    orphans = []
    b = wz.buckets(zones, its, on_orphan=lambda it, largest: orphans.append((it.filename, largest["id"])))
    assert [i.filename for i in b["small"]] == ["s"]
    assert [i.filename for i in b["big"]] == ["orphan"]
    assert [i.filename for i in b["empty"]] == ["u0", "u1"]          # sorted by sort_order
    assert orphans == [("orphan", "big")]


def test_buckets_unassigned_only_fill_one_zone_in_layout_order():
    zones = [{"id": "z1", "width_percent": 50, "height_percent": 50},
             {"id": "z2", "width_percent": 50, "height_percent": 50}]
    b = wz.buckets(zones, items({"filename": "u"}))
    assert [i.filename for i in b["z1"]] == ["u"] and b["z2"] == []


def test_buckets_largest_tie_goes_to_the_first():
    zones = [{"id": "z1", "width_percent": 50, "height_percent": 50},
             {"id": "z2", "width_percent": 50, "height_percent": 50}]
    b = wz.buckets(zones, items({"zone_id": "nope"}))
    assert len(b["z1"]) == 1 and b["z2"] == []


# --- the shared clock ----------------------------------------------------------------------------

def test_target_lays_slots_on_the_clock():
    its = items({"duration_sec": 30}, {"mime_type": wz.HOLD_MIME, "remote_url": "hold://freeze", "duration_sec": 60})
    t = wz.target(its, 0, ALLOW_ALL)
    assert t == {"index": 0, "pos_sec": 0.0, "slot_sec": 30.0, "prev_index": 1, "cycle": 0}
    t = wz.target(its, 45_000, ALLOW_ALL)
    assert t["index"] == 1 and t["pos_sec"] == 15.0 and t["slot_sec"] == 60.0 and t["prev_index"] == 0
    t = wz.target(its, 90_000 * 3 + 29_500, ALLOW_ALL)
    assert t["index"] == 0 and t["pos_sec"] == 29.5 and t["cycle"] == 3


def test_target_skips_excluded_and_dwell0_live_items():
    its = items({"duration_sec": 5, "filename": "off"}, {"duration_sec": 0, "mime_type": "video/hls"},
                {"duration_sec": 0, "filename": "ten"}, {"duration_sec": 20, "mime_type": "video/hls"})
    allow = lambda it: it.filename != "off"  # noqa: E731
    t = wz.target(its, 0, allow)
    assert t["index"] == 2 and t["slot_sec"] == 10.0 and t["prev_index"] == 3
    assert wz.target(its, 12_000, allow)["index"] == 3                 # a live item WITH a dwell has a slot
    assert wz.target(its, 0, lambda it: False) is None
    assert wz.target([], 0, ALLOW_ALL) is None


def test_target_matches_the_group_sync_scheduler():
    # Same slot rule as PlaylistController.group_schedule_target (and the web's groupScheduleSlots).
    pytest.importorskip("PySide6.QtCore")
    from screentinker_native.player.controller import PlaylistController
    c = PlaylistController(lambda it: None, lambda: None)
    raw = [{"id": 1, "duration_sec": 7}, {"id": 2, "duration_sec": 0}, {"id": 3, "duration_sec": 13}]
    c.items = [Item.parse(a) for a in raw]
    for now in (0, 6_999, 7_000, 16_999, 17_000, 29_999, 1_234_567):
        g = c.group_schedule_target(now)
        t = wz.target(c.items, now, ALLOW_ALL)
        assert (g["index"], g["pos_sec"]) == (t["index"], t["pos_sec"]), now


def test_single_slot_zone_changes_cycle_each_period():
    its = items({"duration_sec": 10})
    assert wz.target(its, 9_900, ALLOW_ALL)["cycle"] == 0
    assert wz.target(its, 10_000, ALLOW_ALL)["cycle"] == 1


# --- loop rule + drift maths ---------------------------------------------------------------------

def test_loop_only_a_clip_shorter_than_its_slot():
    assert wz.should_loop(5.0, 30.0)
    assert not wz.should_loop(29.97, 30.0)       # as long as its slot: it ENDS on its last frame
    assert not wz.should_loop(29.7, 30.0)        # within the 0.3 s margin
    assert wz.should_loop(29.6, 30.0)
    assert not wz.should_loop(None, 30.0) and not wz.should_loop(0, 30.0)


def test_video_target_wraps_only_when_looping():
    assert wz.video_target_sec(12.0, 5.0, True) == pytest.approx(2.0)
    assert wz.video_target_sec(12.0, 29.97, False) == 12.0
    # Past the end of a non-looping clip: no target (it stays on its last frame — pos % clip would
    # seek it back to frame 0 for the rest of the slot, and a following freeze would freeze that).
    assert wz.video_target_sec(29.99, 29.97, False) is None
    assert wz.video_target_sec(29.95, 29.97, False) is None       # inside the align window
    assert wz.video_target_sec(1.0, 0, True) is None


def test_drift_action_is_the_group_sync_rule():
    # First tick after a mount: align (seek only if > 0.05), rate 1.0.
    assert wz.drift_action(0.0, 3.0, True, 10_000, 0) == (3.0, 1.0)
    assert wz.drift_action(3.02, 3.0, True, 10_000, 0) == (None, 1.0)
    # Then: hard seek beyond 0.3 s, but not within 1.2 s of the last one.
    assert wz.drift_action(4.0, 3.0, False, 10_000, 0) == (3.0, 1.0)
    assert wz.drift_action(4.0, 3.0, False, 10_000, 9_500) == (None, 0.97)
    # Nudge between 0.05 and 0.3: ahead -> slower, behind -> faster.
    assert wz.drift_action(3.2, 3.0, False, 10_000, 0) == (None, 0.97)
    assert wz.drift_action(2.8, 3.0, False, 10_000, 0) == (None, 1.03)
    assert wz.drift_action(3.01, 3.0, False, 10_000, 0) == (None, 1.0)


# --- capability declaration ------------------------------------------------------------------------

def test_capabilities_declared():
    pytest.importorskip("PySide6.QtCore")
    from screentinker_native import capabilities
    assert "playback.hold" in capabilities.CAPABILITIES_ALWAYS
    assert "playback.wall_zones" in capabilities.CAPABILITIES_ALWAYS


# --- the engine, driven with a recording stage ---------------------------------------------------

class _Sig:
    def __init__(self, log, name):
        self.log, self.name = log, name

    def emit(self, *a):
        self.log.append((self.name,) + a)


class FakeStage:
    def __init__(self):
        self.log = []
        self.props = {}
        self.window = None
        self.showItem = _Sig(self.log, "show")
        self.clearSurface = _Sig(self.log, "clear")
        self.control = _Sig(self.log, "control")

    def set(self, k, v):
        self.props[k] = v

    def take(self):
        out, self.log[:] = list(self.log), []
        return out


class FakeConfig:
    def __init__(self, state_dir):
        self.state_dir = state_dir
        self.server_url = "http://srv"
        self.device_id = "dev1"
        self.d = {}

    def get(self, k, default=None):
        return self.d.get(k, default)

    def set(self, k, v):
        self.d[k] = v


class FakeCache:
    def __init__(self, root):
        self.root = root
        self.files = {}

    def cached_file(self, cid):
        return self.files.get(cid)

    def is_ready(self, cid, rev):
        return cid in self.files

    def is_usable(self, cid):
        return cid in self.files


class FakeApp:
    def __init__(self, tmp):
        self.config = FakeConfig(str(tmp))
        self.stage = FakeStage()
        self.cache = FakeCache(str(tmp))
        self.transitions_dir = str(tmp)
        self.now = 0
        self.emitted = []
        self.downloads = []
        self.logs = []

    def synced_now_ms(self):
        return self.now

    def emit(self, ev, payload):
        self.emitted.append((ev, payload))

    def ensure_downloads(self, want, prune):
        self.downloads.append(want)

    def log_remote(self, level, tag, msg):
        self.logs.append((level, tag, msg))

    def hide_status(self):
        pass

    def show_status(self, *a):
        pass

    def slide_audio(self, it):
        pass

    def request_refresh(self):
        pass

    def fetch_bundle(self, *a):
        pass

    def play_event(self, *a):
        pass


@pytest.fixture
def eng(tmp_path):
    pytest.importorskip("PySide6.QtCore")
    from PySide6.QtCore import QCoreApplication
    QCoreApplication.instance() or QCoreApplication([])
    from screentinker_native.player.engine import PlaybackEngine
    app = FakeApp(tmp_path)
    e = PlaybackEngine(app)
    e.kiosk_config = lambda it: None
    return e, app


def wall_payload(screen_x, audio, assignments, leader=False, zones=None):
    return {
        "assignments": assignments,
        "wall_config": {"wall_id": "W", "is_leader": leader, "rotation": 0, "canvas_layout": True,
                        "audio_zones": audio,
                        "screen_rect": {"x": screen_x, "y": 0, "w": 1920, "h": 1080},
                        "player_rect": {"x": 0, "y": 0, "w": 3840, "h": 1080}},
        "layout": {"zones": zones or [
            dict(Z2[0], fit_mode="contain", background_color="#123456", z_index=2),
            dict(Z2[1], fit_mode="cover")]},
    }


VID_A = {"id": 1, "content_id": "A", "mime_type": "video/mp4", "duration_sec": 30, "zone_id": "a", "sort_order": 0}
HOLD_A = {"id": 2, "content_id": "H", "mime_type": wz.HOLD_MIME, "remote_url": "hold://freeze",
          "duration_sec": 60, "zone_id": "a", "sort_order": 1}
HOLD_B = {"id": 3, "content_id": "H2", "mime_type": wz.HOLD_MIME, "remote_url": "hold://blank",
          "duration_sec": 30, "zone_id": "b", "sort_order": 0}
VID_B = {"id": 4, "content_id": "B", "mime_type": "video/mp4", "duration_sec": 60, "zone_id": "b", "sort_order": 1}


def test_engine_enters_wall_zones_with_only_the_visible_zones(eng):
    e, app = eng
    app.cache.files.update(A="/c/A.mp4", B="/c/B.mp4")
    e.on_payload(wall_payload(0, ["a"], [VID_A, HOLD_A, HOLD_B, VID_B]))
    st = app.stage
    assert e.mode == "wallzones" and st.props["layoutMode"] == "zones"
    assert [z["id"] for z in st.props["zones"]] == ["a"]           # b is on the other panel
    assert st.props["zones"][0]["bg"] == "#123456"
    assert st.props["wall"] == {"cw": 2.0, "ch": 1.0, "ox": 0.0, "oy": 0.0}
    # No relay on a wall layout: a follower does not ask for wall:sync, the controller is stopped.
    assert not any(ev == "wall:sync-request" for ev, _ in app.emitted)
    assert not e.controller.is_running
    # Holds are never downloaded.
    wanted = [w[0] for batch in app.downloads for w in batch]
    assert "H" not in wanted and "H2" not in wanted and "A" in wanted


def test_engine_mounts_on_the_clock_keeps_zone_fit_and_audio(eng):
    e, app = eng
    app.cache.files.update(A="/c/A.mp4", B="/c/B.mp4")
    app.now = 5_000
    e.on_payload(wall_payload(0, ["a"], [VID_A, HOLD_A]))
    app.stage.take()
    e._wz_tick()
    shows = [x for x in app.stage.take() if x[0] == "show"]
    assert len(shows) == 1
    _, sid, d = shows[0]
    assert sid == "zone:a" and d["kind"] == "video" and d["fit"] == "contain"   # not forced "fill"
    assert d["muted"] is False and d["loop"] is False
    # Same slot again: nothing remounts.
    e._wz_tick()
    assert not [x for x in app.stage.take() if x[0] == "show"]


def test_engine_zone_without_audio_is_muted(eng):
    e, app = eng
    app.cache.files.update(A="/c/A.mp4")
    e.on_payload(wall_payload(0, [], [VID_A, HOLD_A]))
    app.stage.take()
    e._wz_tick()
    d = [x for x in app.stage.take() if x[0] == "show"][0][2]
    assert d["muted"] is True


def test_engine_drift_correction_and_loop_rule(eng):
    e, app = eng
    app.cache.files.update(A="/c/A.mp4")
    app.now = 10_000                                  # 10 s into A's 30 s slot
    e.on_payload(wall_payload(0, ["a"], [VID_A, HOLD_A]))
    e._wz_tick()
    zs = e.wz_zones[0]
    app.stage.take()
    # The clip reports 2 s in, 29.97 s long: first tick aligns with a seek, no loop (as long as slot).
    e.on_slot_position("zone:a", zs.token, 2_000, 29_970)
    e._wz_tick()
    ctl = [x for x in app.stage.take() if x[0] == "control"]
    assert ctl and ctl[0][1] == "zone:a"
    assert abs(ctl[0][2]["seek_ms"] - 10_000) < 50 and ctl[0][2]["rate"] == 1.0
    assert "loop" not in ctl[0][2] and zs.loop is False
    # Slightly ahead next time: a 0.97 nudge, no seek.
    e.on_slot_position("zone:a", zs.token, 10_150, 29_970)
    e._wz_tick()
    ctl = [x for x in app.stage.take() if x[0] == "control"]
    assert ctl and ctl[0][2] == {"rate": 0.97}
    # Past the clip's end (slot 30 s, clip 29.97 s): no correction — it stays on its last frame.
    app.now = 29_990
    e.on_slot_position("zone:a", zs.token, 29_960, 29_970)
    e._wz_tick()
    assert not [x for x in app.stage.take() if x[0] == "control" and "seek_ms" in x[2]]


def test_engine_short_clip_loops(eng):
    e, app = eng
    app.cache.files.update(A="/c/A.mp4")
    app.now = 1_000
    e.on_payload(wall_payload(0, ["a"], [VID_A, HOLD_A]))
    e._wz_tick()
    zs = e.wz_zones[0]
    app.stage.take()
    e.on_slot_position("zone:a", zs.token, 500, 4_000)    # a 4 s clip in a 30 s slot
    e._wz_tick()
    ctl = [x for x in app.stage.take() if x[0] == "control"][0][2]
    assert ctl["loop"] is True and zs.loop is True


def test_engine_freeze_keeps_the_picture_and_blank_clears(eng):
    e, app = eng
    app.cache.files.update(A="/c/A.mp4", B="/c/B.mp4")
    app.now = 29_000
    e.on_payload(wall_payload(0, ["a"], [VID_A, HOLD_A]))
    e._wz_tick()
    app.stage.take()
    app.now = 31_000                                       # into the freeze hold
    e._wz_tick()
    log = app.stage.take()
    assert ("control", "zone:a", {"pause": True}) in log
    assert not [x for x in log if x[0] in ("show", "clear")]
    zs = e.wz_zones[0]
    assert zs.video is False                               # nothing will seek the frozen frame


def test_engine_blank_hold_releases_the_zone(eng):
    e, app = eng
    app.cache.files.update(B="/c/B.mp4")
    app.now = 35_000                                       # B playing (30..90 s)
    e.on_payload(wall_payload(1920, ["b"], [HOLD_B, VID_B]))
    e._wz_tick()
    assert [x for x in app.stage.take() if x[0] == "show" and x[1] == "zone:b"]
    app.now = 90_000 + 1_000                               # next period: the blank hold
    e._wz_tick()
    assert ("clear", "zone:b") in app.stage.take()


def test_engine_joining_mid_freeze_builds_the_previous_item_at_its_end(eng):
    e, app = eng
    app.cache.files.update(A="/c/A.mp4")
    app.now = 50_000                                       # mid-freeze, nothing mounted yet
    e.on_payload(wall_payload(0, ["a"], [VID_A, HOLD_A]))
    app.stage.take()
    e._wz_tick()
    shows = [x for x in app.stage.take() if x[0] == "show"]
    assert len(shows) == 1 and shows[0][2]["frozenEnd"] is True and shows[0][2]["kind"] == "video"


def test_engine_wall_zones_never_relay(eng):
    e, app = eng
    app.cache.files.update(A="/c/A.mp4")
    e.on_payload(wall_payload(0, ["a"], [VID_A, HOLD_A], leader=True))
    app.emitted.clear()
    e._sync_tick()
    e.on_wall_sync_request({"wall_id": "W"})
    assert not [ev for ev, _ in app.emitted if ev == "wall:sync"]
    # A follower ignores a stray relay.
    e.on_payload(wall_payload(0, ["a"], [VID_A, HOLD_A]))
    app.stage.take()
    e.on_wall_sync({"wall_id": "W", "current_index": 1, "position_sec": 3, "sent_at": 0})
    assert not app.stage.take()


def test_engine_leaving_wall_zones_tears_down(eng):
    e, app = eng
    app.cache.files.update(A="/c/A.mp4")
    e.on_payload(wall_payload(0, ["a"], [VID_A, HOLD_A]))
    e._wz_tick()
    app.stage.take()
    # Emergency / layout cleared: the same wall without canvas_layout.
    p = wall_payload(0, ["a"], [VID_A])
    del p["wall_config"]["canvas_layout"]
    e.on_payload(p)
    assert e.mode == "single" and app.stage.props["zones"] == [] and not e.wz_timer.isActive()
    assert ("clear", "zone:a") in app.stage.log
    assert e.controller.is_running


def test_engine_not_downloaded_keeps_the_zone_and_retries(eng):
    e, app = eng
    app.now = 1_000
    e.on_payload(wall_payload(0, ["a"], [VID_A, HOLD_A]))
    app.stage.take()
    app.downloads.clear()
    e._wz_tick()
    assert not [x for x in app.stage.take() if x[0] in ("show", "clear")]
    assert app.downloads and app.downloads[0][0][0] == "A"
    app.cache.files["A"] = "/c/A.mp4"
    e._wz_tick()
    assert [x for x in app.stage.take() if x[0] == "show"]


def test_engine_hold_in_single_mode(eng):
    e, app = eng
    app.cache.files.update(A="/c/A.mp4")
    e.on_payload({"assignments": [
        {"id": 1, "content_id": "A", "mime_type": "video/mp4", "duration_sec": 5, "sort_order": 0},
        {"id": 2, "content_id": "H", "mime_type": wz.HOLD_MIME, "remote_url": "hold://freeze",
         "duration_sec": 3, "sort_order": 1}]})
    assert e.mode == "single"
    app.stage.take()
    e.controller.goto_index(1)
    log = app.stage.take()
    assert ("control", "main", {"pause": True}) in log and not [x for x in log if x[0] == "show"]
    assert e.main_token is None                         # nothing seeks the frozen frame
    assert e.controller._advance.isActive()             # it lasts its duration, then moves on
    assert 2_900 <= e.controller._advance.interval() <= 3_000


def test_engine_hold_blank_in_normal_zones(eng):
    e, app = eng
    app.cache.files.update(A="/c/A.mp4")
    e.on_payload({"assignments": [
        {"id": 1, "content_id": "A", "mime_type": "image/png", "duration_sec": 5, "zone_id": "a", "sort_order": 0},
        {"id": 2, "content_id": "H", "mime_type": wz.HOLD_MIME, "remote_url": "hold://blank",
         "duration_sec": 2, "zone_id": "a", "sort_order": 1}],
        "layout": {"zones": Z2}})
    assert e.mode == "zones"
    r = e.zone_runners["a"]
    app.stage.take()
    r.show(1)
    log = app.stage.take()
    assert ("clear", "zone:a") in log and r.token is None
    assert r.timer.isActive() and r.timer.interval() == 2_000


def test_engine_cold_boot_restores_the_wall_slice_from_the_cached_payload(eng):
    # The whole payload (wall_config + the wall's layout) is cached, so an offline reboot comes back
    # as this panel's slice of the wall zones — not the wall's zones squeezed onto one screen.
    e, app = eng
    app.cache.files.update(A="/c/A.mp4")
    e.on_payload(wall_payload(0, ["a"], [VID_A, HOLD_A]))
    cached = app.config.get("cached_payload")
    assert cached and cached["wall_config"]["canvas_layout"] is True
    from screentinker_native.player.engine import PlaybackEngine
    e2 = PlaybackEngine(app)
    e2.kiosk_config = lambda it: None
    assert e2.restore_cached() and e2.mode == "wallzones"
    assert app.stage.props["wall"]["cw"] == 2.0 and [z["id"] for z in app.stage.props["zones"]] == ["a"]


def test_non_looping_video_holds_its_last_frame(eng):
    # holdEnd: a clip that does not loop pauses on its last frame (Slot.qml) instead of reaching
    # EndOfMedia, where the FFmpeg backend blanks and rewinds — a FREEZE after it froze frame 0.
    e, app = eng
    app.cache.files.update(A="/c/A.mp4")
    v = Item.parse({"content_id": "A", "mime_type": "video/mp4"})
    assert e.item_dict(v, loop=False)["holdEnd"] is True
    assert e.item_dict(v, loop=True)["holdEnd"] is False
    live = Item.parse({"content_id": "L", "mime_type": "video/hls", "remote_url": "http://x/s.m3u8"})
    assert e.item_dict(live)["holdEnd"] is False


def test_hold_items_are_not_renderable_media(eng):
    e, app = eng
    h = Item.parse({"content_id": "H", "mime_type": wz.HOLD_MIME, "remote_url": "hold://blank"})
    assert e.item_dict(h) is None          # never a "video"/"image" load of hold://
    assert e._ready(h)                     # and never "waiting for download"


def test_a_room_display_widget_carries_its_panel_capability_in_the_fragment(eng):
    # The server gives a meeting-room display's screen a capability to book the room (widget_panel);
    # it must reach the page, and only in the fragment, which never travels to a server log.
    e, app = eng
    w = Item.parse({"widget_id": "W1", "widget_type": "room-display", "widget_rev": 3, "widget_panel": "a+b/c="})
    src = e.item_dict(w)["source"]
    assert src.endswith("&rev=3#panel=a%2Bb%2Fc%3D")
    plain = Item.parse({"widget_id": "W2", "widget_type": "clock", "widget_rev": 1})
    assert "#" not in e.item_dict(plain)["source"]
