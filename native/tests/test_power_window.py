"""power_window against shared/power-window-vectors.json (the file server/lib/power-window.js and
the Kotlin PowerWindowTest read), plus the JS unit cases."""
import json
import os

import pytest

from screentinker_native.logic import power_window as pw
from screentinker_native.logic import schedule_eval as se

VECTORS_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "shared", "power-window-vectors.json")
with open(VECTORS_PATH, encoding="utf-8") as f:
    VECTORS = json.load(f)["vectors"]

ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]


def test_the_contract_should_not_shrink():
    assert len(VECTORS) >= 20


@pytest.mark.parametrize("v", VECTORS, ids=[v["name"] for v in VECTORS])
def test_conforms_to_shared_vector(v):
    got = pw.is_off({"enabled": v["enabled"], "timezone": v["timezone"], "windows": v["windows"]}, v["utc_now"])
    assert got is v["expect"]["off"], v["name"]


def test_fails_to_on_the_inverse_of_schedule_eval_deliberately():
    always_off = {"enabled": True, "timezone": "Not/AZone",
                  "windows": [{"days": ALL_DAYS, "start": "00:00", "end": "24:00"}]}
    assert pw.is_off(always_off, "2026-09-22T21:00:00Z") is False, "a bad zone must leave the screen lit"
    # ...whereas the item scheduler, given an equally bad zone, keeps PLAYING.
    assert se.is_item_active_now([{"days": [1], "start": "00:00", "end": "01:00", "start_date": None,
                                   "end_date": None}], "2026-09-22T21:00:00Z", "Not/AZone") is True
    for junk in [None, 42, "nonsense", {"windows": "no"}, {"windows": [None, 7]}]:
        assert pw.is_off(junk, "2026-09-22T21:00:00Z") is False, junk
    good = {"enabled": True, "timezone": "UTC", "windows": [{"days": ALL_DAYS, "start": "00:00", "end": "24:00"}]}
    assert pw.is_off(good, "not-a-date") is False


def test_a_malformed_window_never_suppresses_a_good_one_beside_it():
    s = {"enabled": True, "timezone": "America/Chicago",
         "windows": [{"days": [2], "start": "2500", "end": "17:00"}, {"days": [2], "start": "16:00", "end": "17:00"}]}
    assert pw.is_off(s, "2026-09-22T21:00:00Z") is True


def test_overnight_windows_anchor_to_the_day_they_start():
    s = {"enabled": True, "timezone": "America/Chicago", "windows": [{"days": [1, 2, 3, 4, 5], "start": "22:00", "end": "06:00"}]}
    assert pw.is_off(s, "2026-09-26T06:00:00Z") is True, "Sat 01:00 is the tail of Friday night"
    assert pw.is_off(s, "2026-09-27T06:00:00Z") is False, "Sun 01:00 is not"


def test_next_edge_is_advisory_bounded_and_never_raises():
    s = {"enabled": True, "timezone": "America/Chicago", "windows": [{"days": [1, 2, 3, 4, 5], "start": "22:00", "end": "06:00"}]}
    assert pw.next_edge(s, "2026-09-22T02:59:00Z") == {"at": "22:00", "to": "scheduled_off", "minutes_until": 1}
    w = pw.next_edge(s, "2026-09-22T03:00:00Z")
    assert (w["to"], w["at"]) == ("on", "06:00")
    assert pw.next_edge({"enabled": True, "timezone": "UTC", "windows": [{"days": ALL_DAYS, "start": "00:00", "end": "24:00"}]},
                        "2026-09-22T21:00:00Z") is None
    assert pw.next_edge({"enabled": False, "windows": []}, "2026-09-22T21:00:00Z") is None
    assert pw.next_edge(None, "2026-09-22T21:00:00Z") is None
    assert pw.next_edge({"enabled": True, "timezone": "Not/AZone", "windows": [{"days": [1], "start": "01:00", "end": "02:00"}]},
                        "2026-09-22T21:00:00Z") is None


def test_state_of_gives_the_two_telemetry_strings_and_only_those():
    off = {"enabled": True, "timezone": "UTC", "windows": [{"days": ALL_DAYS, "start": "00:00", "end": "24:00"}]}
    assert pw.state_of(off, "2026-09-22T21:00:00Z") == "scheduled_off"
    assert pw.state_of({"enabled": False}, "2026-09-22T21:00:00Z") == "on"


def test_hm():
    assert pw.hm("24:00") == 1440
    assert pw.hm("24:30") is None
    assert pw.hm("7:00") is None
    assert pw.hm("07:00\n") is None  # fullmatch: no trailing-newline leniency
