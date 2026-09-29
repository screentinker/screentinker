"""http_target_guard against shared/http-target-vectors.json (server + Kotlin read the same file),
plus the JS/Kotlin unit cases and the resolved-address re-check."""
import json
import os
import socket

import pytest

from screentinker_native.logic import http_target_guard as g

VECTORS_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "shared", "http-target-vectors.json")
with open(VECTORS_PATH, encoding="utf-8") as f:
    VECTORS = json.load(f)["vectors"]


def test_the_contract_should_not_shrink():
    assert len(VECTORS) >= 24


@pytest.mark.parametrize("v", VECTORS, ids=[v["name"] for v in VECTORS])
def test_conforms_to_shared_vector(v):
    got = g.check(v["url"])
    assert got["allow"] is v["expect"]["allow"], v["url"]
    if not v["expect"]["allow"]:
        assert got["reason"] == v["expect"]["reason"], v["url"]


@pytest.mark.parametrize("host", ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1", "127.0.0.1"])
def test_rfc1918_is_allowed_it_is_the_entire_feature(host):
    assert g.check("http://%s/x" % host)["allow"] is True


@pytest.mark.parametrize("url", [
    "file:///data/data/com.remotedisplay.player/shared_prefs/remote_display.xml",
    "content://com.android.contacts/contacts",
    "content://media/external/images/media",
    "jar:file:///x.apk!/y",
    "ftp://192.168.1.50/f",
    "ws://192.168.1.50/s",
])
def test_the_scheme_allowlist_is_the_whole_defence(url):
    assert g.check(url) == {"allow": False, "reason": "bad_scheme"}


def test_android_asset_is_refused_as_malformed():
    assert g.check("android_asset://x")["allow"] is False
    assert g.ALLOWED_SCHEMES == ("http:", "https:"), "adding a scheme here needs a security argument"


def test_link_local_goes_wholesale_and_narrowly():
    for h in ["169.254.169.254", "169.254.0.1", "169.254.255.255"]:
        assert g.check("http://%s/" % h) == {"allow": False, "reason": "metadata_address"}
    for h in ["169.253.0.1", "169.255.0.1", "100.64.0.1"]:
        assert g.check("http://%s/" % h)["allow"] is True


def test_whatwg_ipv4_shorthands_cannot_sneak_past():
    # The JS URL parser canonicalises these to 169.254.169.254; the port must refuse them too.
    for h in ["2852039166", "0xa9fea9fe", "0251.0376.0251.0376", "169.254.43518", "169.254.169.254."]:
        assert g.check("http://%s/latest" % h)["reason"] == "metadata_address", h


def test_is_blocked_address_backs_the_resolved_recheck():
    assert g.is_blocked_address("169.254.169.254") is True
    assert g.is_blocked_address("fe80::1") is True
    assert g.is_blocked_address("[fe80::1]") is True
    assert g.is_blocked_address("fd00:ec2::254") is True
    assert g.is_blocked_address("192.168.1.1") is False
    assert g.is_blocked_address("") is False
    assert g.is_blocked_address(None) is False


@pytest.mark.parametrize("junk", [None, 42, {}, [], "", " ", "http://", "http://[::", "\u0000", "nonsense",
                                  "//x/y", "http://host:99999/"])
def test_never_raises(junk):
    got = g.check(junk)
    assert isinstance(got["allow"], bool)
    if not got["allow"]:
        assert isinstance(g.explain(got["reason"]), str)


def _fake(addrs):
    def resolve(host, port):
        return [(socket.AF_INET6 if ":" in a else socket.AF_INET, socket.SOCK_STREAM, 6, "", (a, port or 0))
                for a in addrs]
    return resolve


def test_resolve_and_vet_refuses_a_hostname_pointing_at_metadata():
    # `http://innocent.test/` passes the string check and still lands on the metadata service.
    assert g.check("http://innocent.test/")["allow"] is True
    assert g.resolve_and_vet("innocent.test", 80, resolver=_fake(["169.254.169.254"])) is None


def test_resolve_and_vet_refuses_if_ANY_address_is_blocked():
    assert g.resolve_and_vet("mixed.test", 80, resolver=_fake(["192.168.1.5", "fe80::1%eth0"])) is None


def test_resolve_and_vet_sees_through_ipv4_mapped_ipv6():
    assert g.resolve_and_vet("mapped.test", 80, resolver=_fake(["::ffff:169.254.169.254"])) is None


def test_resolve_and_vet_returns_the_addresses_to_pin():
    assert g.resolve_and_vet("plc.test", 80, resolver=_fake(["192.168.1.50", "192.168.1.50"])) == ["192.168.1.50"]


def test_unresolvable_is_refused_not_allowed_by_default():
    def boom(host, port):
        raise socket.gaierror("nope")
    assert g.resolve_and_vet("nx.test", 80, resolver=boom) is None
    assert g.resolve_and_vet("empty.test", 80, resolver=lambda h, p: []) is None
    assert g.resolve_and_vet("", 80) is None


def test_resolve_and_vet_real_loopback():
    assert g.resolve_and_vet("127.0.0.1", 80) == ["127.0.0.1"]


def test_backslash_is_a_slash_for_http_like_the_js_url_parser():
    # WHATWG: host is 169.254.169.254; urllib would say host "x". Check (and fetch) the normalised form.
    assert g.check("http://169.254.169.254\\@x/") == {"allow": False, "reason": "metadata_address"}
    assert g.normalize_url("http://169.254.169.254\\@x/") == "http://169.254.169.254/@x/"
    assert g.check("http:\\\\169.254.169.254") == {"allow": False, "reason": "metadata_address"}


def test_forbidden_host_code_points_are_malformed():
    assert g.check("http://exa mple.com/") == {"allow": False, "reason": "malformed"}


def test_userinfo_does_not_hide_the_host():
    assert g.check("http://user:pw@169.254.169.254/")["reason"] == "metadata_address"
    assert g.check("http://169.254.169.254:80@example.com/")["allow"] is True  # host is example.com
