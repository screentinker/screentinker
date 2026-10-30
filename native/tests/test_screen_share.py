"""3.0 screen share on the native player: the event handling (logic/screen_share.py), the RTC page
glue (ui/rtc_page.py) and the capability declaration. The page itself is run end to end in Chromium
by server/test/screen-share-native-e2e.test.js."""

import base64
import os
import re

from screentinker_native.logic import screen_share
from screentinker_native.ui.rtc_page import rtc_page

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def test_start_opts_from_the_server_payload():
    o = screen_share.start_opts({"session_id": "abc_DEF-1", "shared_by": "Gail", "guest": True,
                                 "max_seconds": 1800, "ice_servers": [{"urls": "stun:x"}], "audio": True})
    assert o == {"sessionId": "abc_DEF-1", "sharedBy": "Gail", "guest": True, "maxSeconds": 1800,
                 "iceServers": [{"urls": "stun:x"}]}


def test_start_refuses_a_payload_without_a_usable_session():
    for bad in (None, [], {}, {"session_id": 5}, {"session_id": ""}, {"session_id": "../x"},
                {"session_id": "x" * 200}):
        assert screen_share.start_opts(bad) is None


def test_start_defaults():
    o = screen_share.start_opts({"session_id": "s1", "max_seconds": "junk", "ice_servers": "nope", "shared_by": 7})
    assert o["maxSeconds"] == 3600 and o["iceServers"] == [] and o["sharedBy"] == "" and o["guest"] is False


def test_a_late_stop_for_an_older_share_is_ignored():
    assert screen_share.stop_applies("s2", "s2")
    assert screen_share.stop_applies("s2", None)
    assert screen_share.stop_applies("s2", "")
    assert not screen_share.stop_applies("s2", "s1")
    assert not screen_share.stop_applies(None, "s1")


def test_code_accepts_only_a_png_data_url_as_the_qr():
    good = "data:image/png;base64," + base64.b64encode(PNG).decode()
    assert screen_share.parse_code({"code": "K7QM-3XHP", "url": "https://s.example/share", "qr": good}) == \
        ("K7QM-3XHP", "s.example/share", PNG)
    # Not a PNG, a remote URL, an SVG: no QR (the badge never fetches or renders anything else).
    for qr in ("data:image/png;base64," + base64.b64encode(b"<svg/>").decode(), "https://evil.example/x.png",
               "data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,!!!"):
        assert screen_share.parse_code({"code": "K7QM-3XHP", "qr": qr}) == ("K7QM-3XHP", "/share", None)
    assert screen_share.parse_code({"code": None}) is None
    assert screen_share.parse_code(None) is None
    assert screen_share.parse_code({"code": "x" * 40}) is None


def test_rtc_page_loads_the_servers_receiver_and_reports_per_session():
    html = rtc_page("ws://127.0.0.1:1/frames?k=abc")
    assert '<script src="/player/screen-share.js"></script>' in html
    assert "shareStart:" in html and "shareStop:" in html
    # The share overlay keeps the layer visible (rtc:video) from "Connecting to …" onwards.
    assert "st-share-overlay" in html
    # Every share line carries its session id (app.on_rtc_log ignores a replaced share's late "stopped").
    assert re.search(r"log\('share', st, sid", html)
    # The frames URL is embedded as a JSON string, never raw.
    assert 'var FRAMES = "ws://127.0.0.1:1/frames?k=abc";' in html


def test_screen_share_is_declared():
    src = open(os.path.join(os.path.dirname(__file__), "..", "screentinker_native", "capabilities.py")).read()
    assert '"remote.screen_share"' in src


def test_every_event_the_app_handles_is_subscribed():
    # net/link.py forwards only the events it names to App.on_event. The screen-share events were
    # handled in app.py but never subscribed, so no code badge or share ever reached a native player.
    here = os.path.join(os.path.dirname(__file__), "..", "screentinker_native")
    app = open(os.path.join(here, "app.py"), encoding="utf-8").read()
    body = app[app.index("    def on_event(self, event, d):"):]
    body = body[:body.index("\n    def ", 10)]
    handled = set(re.findall(r'"((?:device|wall|group):[a-z-]+)"', body))
    link = open(os.path.join(here, "net", "link.py"), encoding="utf-8").read()
    start = link.index("# Everything else is the application's business.")
    subscribed = set(re.findall(r'"((?:device|wall|group):[a-z-]+)"', link[start:link.index("async def", start)]))
    assert {"device:screenshare-start", "device:screenshare-stop", "device:screenshare-code"} <= handled
    assert handled - subscribed == set()
