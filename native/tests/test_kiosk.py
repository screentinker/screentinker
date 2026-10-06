"""logic/kiosk.py against shared/kiosk-vectors.json — the SAME file the JS module
(server/test/kiosk-logic.test.js) and the Android KioskVectorsTest are held to — plus the native-only
pieces: the consent list equals the JS list, the usage queue, and the cookie keep from store records."""
import json
import os
import re

import pytest

from screentinker_native.logic import kiosk as K

SHARED_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "shared")

with open(os.path.join(SHARED_DIR, "kiosk-vectors.json"), encoding="utf-8") as f:
    V = json.load(f)

JS_PATH = os.path.join(SHARED_DIR, "..", "server", "lib", "kiosk-logic.js")


def test_every_vector_section_is_covered():
    # A section added to the vectors must get a test here, or this fails.
    covered = {"_comment", "parse", "isAllowed", "selectCookies", "idle", "isStartPage", "errorThrottle", "chromeMajor"}
    assert set(V) <= covered, set(V) - covered
    for k in covered - {"_comment"}:
        assert V[k], k


@pytest.mark.parametrize("v", V["parse"], ids=[v["name"] for v in V["parse"]])
def test_parse(v):
    got = K.parse(v["type"], v["config"])
    assert (got.as_dict() if got else None) == v["expect"], v["name"]


@pytest.mark.parametrize("v", V["isAllowed"], ids=[v["url"] for v in V["isAllowed"]])
def test_is_allowed(v):
    assert K.is_allowed(v["url"], v["allowed"]) is v["expect"]


@pytest.mark.parametrize("v", V["selectCookies"], ids=[v["name"] for v in V["selectCookies"]])
def test_select_cookies(v):
    pats = K.CONSENT_COOKIES if v["patterns"] == "BUILT_IN" else v["patterns"]
    assert K.select_cookies(v["header"], pats) == v["expect"]


@pytest.mark.parametrize("v", V["idle"], ids=[v["name"] for v in V["idle"]])
def test_idle_clock(v):
    k = K.Idle(v["idleMs"], v["warnMs"])
    for op, t, want in v["steps"]:
        got = k.on_touch(t) if op == "touch" else k.keep_alive(t) if op == "keepAlive" else k.tick(t)
        assert got == want, "%s: %s@%s" % (v["name"], op, t)


@pytest.mark.parametrize("v", V["isStartPage"], ids=[str(v["url"]) for v in V["isStartPage"]])
def test_is_start_page(v):
    assert K.is_start_page(v["url"], v["start"]) is v["expect"]


def test_error_throttle():
    for v in V["errorThrottle"]:
        th = K.ErrorThrottle(v["windowMs"])
        for reason, url, t, want in v["steps"]:
            assert th.should_report(reason, url, t) is want, "%s %s @%s" % (reason, url, t)
    assert K.ErrorThrottle().window_ms == 15 * 60_000


def test_chrome_major():
    for v in V["chromeMajor"]:
        assert K.chrome_major(v["ua"]) == v["expect"]
    assert K.too_old("Chrome/83.0.1", 90) is True
    assert K.too_old("Chrome/118.0.1", 90) is False
    assert K.too_old("weird", 90) is False
    assert K.too_old("Chrome/83.0.1", None) is False


def test_consent_list_is_the_js_list():
    with open(JS_PATH, encoding="utf-8") as f:
        src = f.read()
    start = src.index("var CONSENT_COOKIES = [")
    block = src[start:src.index("];", start)]
    names = re.findall(r"'([^']+)'", block)
    assert names == K.CONSENT_COOKIES


def test_keep_patterns_empty_unless_keep_consent():
    assert K.keep_patterns(K.parse("webpage", {"url": "https://a.example", "interactive": True})) == []
    p = K.keep_patterns(K.parse("webpage", {"url": "https://a.example", "interactive": True,
                                            "keep_consent": True, "keep_cookie_names": ["mine"]}))
    assert "CookieConsent" in p and "mine" in p


def test_parse_edge_cases_follow_js_coercion():
    base = {"url": "https://a.example", "interactive": True}
    assert K.parse("webpage", dict(base, interactive=1)) is None          # strictly true
    assert K.parse("webpage", dict(base, idle_timeout_sec="120")).idle_timeout_sec == 120
    assert K.parse("webpage", dict(base, idle_timeout_sec="  ")).idle_timeout_sec == 60
    assert K.parse("webpage", dict(base, idle_timeout_sec=True)).idle_timeout_sec == 60
    assert K.parse("webpage", dict(base, zoom=150.9)).zoom_pct == 150
    assert K.parse("webpage", dict(base, keep_cookie_names="ok\n")).keep_cookie_names == ["ok"]
    assert K.valid_pattern("ok\n") is False                                 # no `$` newline trap
    assert K.parse("webpage", "[1]") is None
    assert K.parse("webpage", "") is None


def test_kept_cookies_by_name_and_allowed_domain_only():
    cfg = K.parse("webpage", {"url": "https://shop.example/", "interactive": True, "keep_consent": True,
                              "allowed_domains": "pay.example"})
    store = [
        {"name": "CookieConsent", "value": "yes", "domain": "shop.example", "path": "/"},
        {"name": "PHPSESSID", "value": "s", "domain": "shop.example", "path": "/"},
        {"name": "CookieConsent", "value": "x", "domain": ".tracker.example", "path": "/"},
        {"name": "euconsent-v2", "value": "e", "domain": ".www.shop.example", "path": "/"},
        {"name": "auth_token", "value": "t", "domain": "pay.example", "path": "/"},
    ]
    got = K.kept_cookies(store, cfg)
    assert [(c["name"], c["domain"]) for c in got] == [("CookieConsent", "shop.example"),
                                                       ("euconsent-v2", ".www.shop.example")]
    off = K.parse("webpage", {"url": "https://shop.example/", "interactive": True})
    assert K.kept_cookies(store, off) == []


def test_wipe_site_data_off_keeps_every_cookie_of_the_allowed_sites_only():
    # An info page (#473 follow-up): the banner and the chosen language survive — any name — but a
    # cookie from a site that is not allowed still goes.
    cfg = K.parse("webpage", {"url": "https://info.example/", "interactive": True, "wipe_site_data": False})
    store = [
        {"name": "lang", "value": "sl", "domain": "info.example", "path": "/"},
        {"name": "cc_cookie", "value": "{}", "domain": ".info.example", "path": "/"},
        {"name": "_ga", "value": "g", "domain": ".tracker.example", "path": "/"},
    ]
    assert K.keeps_cookies(cfg)
    assert [c["name"] for c in K.kept_cookies(store, cfg)] == ["lang", "cc_cookie"]
    on = K.parse("webpage", {"url": "https://info.example/", "interactive": True})
    assert not K.keeps_cookies(on) and K.kept_cookies(store, on) == []


def test_session_queue_cap_dedupe_ack_and_persistence(tmp_path):
    p = str(tmp_path / "kiosk-sessions.json")
    q = K.SessionQueue(cap=3, path=p)
    for i in range(5):
        q.add(K.make_session("id%d" % i, "w", 1000 + i, 0, "idle", 0))
    q.add(K.make_session("id4", "w", 1, 1, "idle", 1))         # duplicate id ignored
    q.add({"id": "", "started_at": 1})                          # no id: dropped
    assert [r["id"] for r in q.peek()] == ["id2", "id3", "id4"]
    assert q.peek()[0]["duration_sec"] == 1 and q.peek()[0]["pages"] == 1   # floors
    q.save()
    q2 = K.SessionQueue(cap=3, path=p)
    q2.load()
    assert [r["id"] for r in q2.peek()] == ["id2", "id3", "id4"]
    q2.ack(["id3", "nope"])
    assert [r["id"] for r in q2.peek(1)] == ["id2"]
    assert q2.size() == 2
    assert K.SessionQueue.from_json("garbage").size() == 0
    assert K.SessionQueue.BATCH == 50 and K.SessionQueue.MAX == 500
