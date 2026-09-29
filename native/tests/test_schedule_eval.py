"""schedule_eval against shared/schedule-vectors.json — the SAME file the JS server, the web/Tizen
players and the Kotlin JUnit suite are held to — plus the JS unit cases for play windows / play_when."""
import json
import os

import pytest

from screentinker_native.logic import schedule_eval as se
from screentinker_native.logic import power_window as pw

VECTORS_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "shared", "schedule-vectors.json")
with open(VECTORS_PATH, encoding="utf-8") as f:
    VECTORS = json.load(f)["vectors"]


def test_vector_file_is_not_truncated():
    assert len(VECTORS) >= 50


@pytest.mark.parametrize("v", VECTORS, ids=[v["description"] for v in VECTORS])
def test_conforms_to_shared_vector(v):
    got = se.is_item_active_now(v["blocks"], v["utc_now"], v["timezone"], v.get("window"))
    assert got is v["expected"], v["description"]


def test_vectors_hold_for_epoch_ms_and_datetime_instants_too():
    from screentinker_native.logic._jscompat import to_instant
    for v in VECTORS:
        dt = to_instant(v["utc_now"])
        ms = int(dt.timestamp() * 1000)
        assert se.is_item_active_now(v["blocks"], ms, v["timezone"], v.get("window")) is v["expected"]
        assert se.is_item_active_now(v["blocks"], dt, v["timezone"], v.get("window")) is v["expected"]


# ---- item-play-window.test.js ----

def test_empty_window_is_always_on():
    assert se.is_item_active_now([], "2026-06-12T00:00:00Z", "Australia/Sydney", None) is True
    assert se.is_item_active_now([], "2026-06-12T00:00:00Z", "Australia/Sydney", se.window_of({})) is True


def test_malformed_play_from_fails_open():
    assert se.is_item_active_now([], "2026-06-12T00:00:00Z", "Australia/Sydney", {"play_from": "not-a-stamp"}) is True
    # Python's `$` would accept a trailing newline; the stamp regex must not.
    assert se.is_item_active_now([], "2026-06-12T00:00:00Z", "Australia/Sydney",
                                 {"play_from": "2030-01-01T00:00\n"}) is True


def test_window_of_reads_play_from_off_an_item():
    assert se.window_of({"play_from": "2026-10-01T18:00"})["play_from"] == "2026-10-01T18:00"
    assert se.window_of({"duration_sec": 10}) is None


def test_disabled_items_never_fail_open():
    assert se.item_should_play({"enabled": 0}, "2026-06-12T00:00:00Z", "Australia/Sydney") is False
    assert se.item_should_play({"enabled": False}, "2026-06-12T00:00:00Z", "Australia/Sydney") is False
    assert se.item_should_play({"enabled": 1}, "2026-06-12T00:00:00Z", "Australia/Sydney") is True


def test_play_when_compares_a_data_source_bag_and_fails_open_without_one():
    when = {"slug": "weather", "path": "temp", "op": "gte", "value": 70}
    assert se.condition_ok(when, {"temp": 80}) is True
    assert se.condition_ok(when, {"temp": 10}) is False
    assert se.item_should_play({"play_when": when}, "2026-06-12T00:00:00Z", "UTC") is True  # no _ds
    assert se.item_should_play({"play_when": when, "_ds": {"temp": 10}}, "2026-06-12T00:00:00Z", "UTC") is False


@pytest.mark.parametrize("op", ["eq", "neq", "gt", "gte", "lt", "lte", "truthy"])
def test_play_when_fails_open_for_every_op_when_the_bag_is_missing(op):
    when = {"slug": "weather", "path": "active", "op": op, "value": 1}
    assert se.condition_ok(when, None) is True
    assert se.condition_ok(when) is True


def test_truthy_evaluates_the_field_when_there_is_a_bag():
    assert se.condition_ok({"slug": "x", "path": "on", "op": "truthy"}, {"on": True}) is True
    assert se.condition_ok({"slug": "x", "path": "on", "op": "truthy"}, {"on": 0}) is False


def test_eq_uses_js_string_coercion():
    # String(80) === "80", String(true) === "true", String(undefined) === "undefined"
    assert se.condition_ok({"path": "t", "op": "eq", "value": "80"}, {"t": 80}) is True
    assert se.condition_ok({"path": "t", "op": "eq", "value": 80.0}, {"t": "80"}) is True
    assert se.condition_ok({"path": "on", "op": "eq", "value": "true"}, {"on": True}) is True
    assert se.condition_ok({"path": "missing", "op": "eq", "value": "undefined"}, {}) is True
    assert se.condition_ok({"path": "a.b", "op": "eq", "value": 3}, {"a": {"b": 3}}) is True


def test_numeric_ops_fail_open_on_non_numeric_operands():
    assert se.condition_ok({"path": "t", "op": "gt", "value": 5}, {"t": "warm"}) is True
    assert se.condition_ok({"path": "t", "op": "gt", "value": 5}, {"t": ""}) is False  # Number("") = 0


# ---- content-tags.test.js ----

def test_play_when_tag_has_lacks_tags_live_on_the_item():
    has = {"type": "tag", "op": "has", "value": "promo"}
    lacks = {"type": "tag", "op": "lacks", "value": "promo"}
    assert se.condition_ok(has, None, {"tags": ["promo"]}) is True
    assert se.condition_ok(has, None, {"tags": ["lobby"]}) is False
    # JS: [] is truthy, so the item's (empty) tags win over the DS bag.
    assert se.condition_ok(has, {"temp": 1}, {"tags": []}) is False
    assert se.condition_ok(lacks, None, {"tags": ["lobby"]}) is True
    assert se.condition_ok(lacks, None, {"tags": ["promo"]}) is False
    assert se.item_should_play({"play_when": has, "tags": ["promo"]}, "2026-06-12T00:00:00Z", "UTC") is True
    assert se.item_should_play({"play_when": has, "tags": []}, "2026-06-12T00:00:00Z", "UTC") is False


def test_play_when_meta_compares_a_content_key():
    when = {"type": "meta", "path": "dept", "op": "eq", "value": "sales"}
    assert se.condition_ok(when, None, {"meta": {"dept": "sales"}}) is True
    assert se.condition_ok(when, {"dept": "sales"}, {"meta": {"dept": "hr"}}) is False  # item.meta wins
    assert se.condition_ok(when, None, {"meta": {}}) is False


# ---- JS-parity edge cases the vectors do not pin ----

def test_bad_timezone_fails_open():
    blocks = [{"days": [1], "start": "00:00", "end": "01:00", "start_date": None, "end_date": None}]
    assert se.is_item_active_now(blocks, "2026-09-22T21:00:00Z", "Not/AZone") is True


@pytest.mark.parametrize("start,end,expected", [
    ("nonsense", "24:00", True),
    ("09:00", "nonsense", True),
    ("22:00", "nonsense", False),
])
def test_a_malformed_block_time_behaves_like_js_nan(start, end, expected):
    # JS hm("nonsense") is NaN (not a throw), so every comparison against it is false and the
    # overnight branches decide. Expected values verified against server/lib/schedule-eval.js under
    # Node. (Kotlin throws on toInt() and fails open -> True for all three: a known divergence the
    # vectors do not pin.)
    blocks = [{"days": [0, 1, 2, 3, 4, 5, 6], "start": start, "end": end,
               "start_date": None, "end_date": None}]
    assert se.is_item_active_now(blocks, "2026-09-22T21:00:00Z", "UTC") is expected


def test_local_parts_agree_with_power_window():
    """The two modules each carry a localParts; pin them to each other (power-window-parity)."""
    zones = ["America/Chicago", "Europe/Berlin", "Asia/Kolkata", "Pacific/Chatham", "UTC"]
    instants = ["2026-09-22T21:00:00Z", "2026-03-08T07:30:00Z", "2026-03-08T08:30:00Z",
                "2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z", "2026-01-01T00:00:00Z"]
    for tz in zones:
        for iso in instants:
            a, b = pw.local_parts(iso, tz), se.local_parts(iso, tz)
            assert (a["dow"], a["min"]) == (b["dow"], b["min"]), (tz, iso)
