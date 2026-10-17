"""Fisheye dewarp (digital PTZ): the native maths must match server/lib/fisheye.js, through the
shared vectors, so a saved view looks the same on every player."""

import json
import math
import pathlib

import pytest

from screentinker_native.logic import fisheye as F

VEC = json.loads((pathlib.Path(__file__).resolve().parents[2] / "shared" / "fisheye-vectors.json").read_text())


@pytest.mark.parametrize("case", VEC["project"], ids=lambda c: "%s(%s,%s)a%.2f" % (c["normalized"]["mount"], c["x"], c["y"], c["image_aspect"]))
def test_projection_matches_the_server(case):
    got = F.project(case["normalized"], case["x"], case["y"], case["image_aspect"])
    if case["uv"] is None:
        assert got is None
    else:
        assert got is not None
        assert got[0] == pytest.approx(case["uv"][0], abs=1e-6)
        assert got[1] == pytest.approx(case["uv"][1], abs=1e-6)


@pytest.mark.parametrize("case", VEC["normalize"], ids=lambda c: json.dumps(c["input"], sort_keys=True))
def test_settings_are_normalized_like_the_server(case):
    got = F.normalize(case["input"])
    for k, v in case["output"].items():
        if isinstance(v, float) or isinstance(v, int) and not isinstance(v, bool):
            assert got[k] == pytest.approx(v, abs=1e-3), k
        else:
            assert got[k] == v, k


def test_the_horizon_stays_level_whichever_way_a_ceiling_camera_looks():
    for pan in range(-180, 181, 15):
        for tilt in (10, 45, 80):
            d, right, up = F.basis(F.normalize({"pan": pan, "tilt": tilt}))
            # right never tips toward or away from the lens axis: a level horizon
            assert abs(right[2]) < 1e-9
            # up points away from the axis (toward the horizon) for a downward lens
            assert up[2] < 0 or tilt == 0


def test_the_view_is_never_mirrored():
    for f in ({}, {"mount": "floor", "pan": 30, "tilt": 40}, {"mount": "wall", "pan": -20, "tilt": 10}):
        d, right, up = F.basis(F.normalize(f))
        down = tuple(-c for c in up)
        rxd = (right[1] * down[2] - right[2] * down[1], right[2] * down[0] - right[0] * down[2], right[0] * down[1] - right[1] * down[0])
        assert all(math.isclose(rxd[i], d[i], abs_tol=1e-9) for i in range(3))


def test_steering_is_clamped_follows_the_finger_and_resets():
    v = F.View(F.normalize({"pan": 10, "tilt": 50, "zoom": 80, "touch": True}), "c1")
    v.set(tilt=500, zoom=500)
    assert v.current["tilt"] == 90 and v.current["zoom"] == F.ZOOM_MAX
    v.reset()
    v.drag(0.25, 0.0)
    assert v.current["pan"] == pytest.approx(10 - 0.25 * 80)
    v.pinch(2.0)
    assert v.current["zoom"] == pytest.approx(40)
    v.reset()
    assert v.current == v.saved


def test_the_qml_payload_carries_the_view_and_touch():
    q = F.View(F.normalize({"pan": 90, "touch": False})).qml()
    assert set(q) >= {"dir", "right", "up", "tanX", "lensHalf", "rot", "cx", "cy", "r", "touch"}
    assert q["touch"] is False
    assert "#version 440" in F.FRAGMENT_440 and "uRadius" in F.FRAGMENT_440


def test_an_item_parses_fisheye_only_on_a_live_item_and_a_change_reconnects():
    from screentinker_native.player.items import Item
    base = {"content_id": "c", "mime_type": "video/rtsp", "remote_url": "rtsps://h/x"}
    a = Item.parse(dict(base, fisheye={"pan": 20}))
    b = Item.parse(dict(base, fisheye={"pan": 30}))
    plain = Item.parse(base)
    assert a.fisheye["pan"] == 20 and plain.fisheye is None
    assert a.sig() != b.sig() and a.live_connection != b.live_connection
    assert plain.sig() == Item.parse(dict(base)).sig(), "no fisheye: the signature is unchanged"
    assert Item.parse({"content_id": "i", "mime_type": "image/png", "fisheye": {"pan": 1}}).fisheye is None
