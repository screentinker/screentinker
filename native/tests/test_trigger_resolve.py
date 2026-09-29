"""trigger_resolve against shared/trigger-vectors.json (the JS player suite and the Kotlin
TriggerResolveTest read the same file), plus the JS unit refusals."""
import json
import os

import pytest

from screentinker_native.logic import trigger_resolve as tr

VECTORS_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "shared", "trigger-vectors.json")
with open(VECTORS_PATH, encoding="utf-8") as f:
    ROOT = json.load(f)
VECTORS = ROOT["vectors"]


def test_the_contract_file_is_not_truncated():
    assert len(VECTORS) >= 25


@pytest.mark.parametrize("v", VECTORS, ids=[v["description"] for v in VECTORS])
def test_conforms_to_shared_vector(v):
    # Per-vector overrides: present-but-null clear_all_token means "none", absent means the default.
    got = tr.evaluate(
        text=v["text"],
        triggers=v["triggers"] if "triggers" in v else ROOT["triggers"],
        device_secret=v["device_secret"] if "device_secret" in v else ROOT["device_secret"],
        clear_all_token=v["clear_all_token"] if "clear_all_token" in v else ROOT["clear_all_token"],
        source=v["source"],
    )
    exp = v["expect"]
    assert got["ok"] is exp["ok"], (v["description"], got)
    if exp["ok"]:
        assert got["action"] == exp["action"]
        assert (got["trigger"]["id"] if got.get("trigger") else None) == exp["trigger_id"]
    else:
        assert got["reason"] == exp["reason"]


SECRET = "a" * 32
TRIGGERS = [
    {"id": "t1", "name": "Evac", "match_token": "EVAC", "clear_token": "EVAC_CLR", "source_http": True, "source_udp": True, "mode": "until_cleared"},
    {"id": "t2", "name": "UDP only", "match_token": "UDPONLY", "clear_token": None, "source_http": False, "source_udp": True, "mode": "once"},
    {"id": "t3", "name": "HTTP only", "match_token": "HTTPONLY", "clear_token": None, "source_http": True, "source_udp": False, "mode": "once"},
]


def ev(text, **over):
    kw = dict(text=text, triggers=TRIGGERS, device_secret=SECRET, source="udp")
    kw.update(over)
    return tr.evaluate(**kw)


def test_fire_clear_and_clear_all():
    r = ev("ST1 %s EVAC" % SECRET)
    assert (r["ok"], r["action"], r["trigger"]["id"]) == (True, "fire", "t1")
    r = ev("ST1 %s EVAC_CLR" % SECRET)
    assert (r["action"], r["trigger"]["id"]) == ("clear", "t1")
    r = ev("ST1 %s ALLSTOP" % SECRET, clear_all_token="ALLSTOP")
    assert r["action"] == "clear_all" and r["trigger"] is None


def test_the_wrong_secret_is_refused():
    assert ev("ST1 %s EVAC" % ("b" * 32)) == {"ok": False, "reason": "bad_secret"}


def test_transport_gate_is_per_trigger():
    assert ev("ST1 %s UDPONLY" % SECRET, source="http")["reason"] == "unknown_token"
    assert ev("ST1 %s UDPONLY" % SECRET, source="udp")["action"] == "fire"
    assert ev("ST1 %s HTTPONLY" % SECRET, source="udp")["reason"] == "unknown_token"
    assert ev("ST1 %s HTTPONLY" % SECRET, source="http")["action"] == "fire"


@pytest.mark.parametrize("junk", ["", "hello", '{"jsonrpc":"2.0"}', "M-SEARCH * HTTP/1.1"])
def test_broadcast_noise_is_rejected_on_the_magic(junk):
    assert tr.parse_wire(junk)["reason"] == "bad_magic"


def test_parse_wire_refusals():
    assert tr.parse_wire("ST1 " + SECRET + " " + "x" * 600)["reason"] == "too_large"
    assert tr.parse_wire("ST1 %s FIRE ALARM" % SECRET)["reason"] == "malformed"
    assert tr.parse_wire("ST1 EVAC")["reason"] == "malformed"
    assert tr.parse_wire(None)["reason"] == "malformed"
    assert tr.parse_wire(b"ST1 a b")["reason"] == "malformed"  # bytes must be decoded by the caller
    # A trailing newline inside the token is NOT tolerated (only a trailing EOL on the line).
    assert tr.parse_wire("ST1 s EV\nAC")["reason"] == "malformed"


def test_byte_length_not_character_length():
    # 200 x U+00E9 is 200 chars but 400 bytes; plus the header puts it over 512.
    assert tr.parse_wire("ST1 " + SECRET + " " + "é" * 250)["reason"] == "too_large"


def test_no_configured_device_secret_refuses_everything():
    assert ev("ST1 %s EVAC" % SECRET, device_secret="")["reason"] == "bad_secret"
    assert ev("ST1 %s EVAC" % SECRET, device_secret=None)["reason"] == "bad_secret"


def test_secret_compare_is_length_checked():
    assert tr.secret_matches("abc", "abc") is True
    assert tr.secret_matches("abc", "abcd") is False
    assert tr.secret_matches("", "") is True
    assert tr.secret_matches(None, "abc") is False


def test_pick_multicast_interface_skips_virtual_and_internal():
    ifs = {
        "lo": [{"family": "IPv4", "address": "127.0.0.1", "internal": True}],
        "docker0": [{"family": "IPv4", "address": "172.17.0.1", "internal": False}],
        "br-1234": [{"family": "IPv4", "address": "172.18.0.1", "internal": False}],
        "eth0": [{"family": "IPv6", "address": "fe80::1", "internal": False},
                 {"family": 4, "address": "192.168.1.20", "internal": False}],
    }
    assert tr.pick_multicast_interface(ifs) == "192.168.1.20"
    assert tr.pick_multicast_interface({}) is None
    assert tr.pick_multicast_interface(None) is None
