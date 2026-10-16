"""#649 logic/bundle_skip.py against shared/bundle-skip-vectors.json — the SAME file the JS players
(server/test/bundle-skip.test.js) and Android (BundleSkipVectorsTest) are held to — plus the native
half: where the listener goes, the console channel's token check, and the controller's skip."""
import json
import os

import pytest

from screentinker_native.logic import bundle_skip as BS

SHARED_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "shared")
with open(os.path.join(SHARED_DIR, "bundle-skip-vectors.json"), encoding="utf-8") as f:
    V = json.load(f)


def test_constants():
    assert BS.MIN_RUN_MS == V["minRunMs"] and BS.REASON_MAX == V["reasonMax"]
    assert BS.MESSAGE_TYPE == "screentinker:skip"


@pytest.mark.parametrize("c", V["message"], ids=lambda c: c["name"])
def test_message(c):
    assert BS.is_skip_message(c["data"]) is c["expect"]


@pytest.mark.parametrize("c", V["reason"], ids=lambda c: c["name"])
def test_reason(c):
    got = BS.sanitize_reason(c["raw"])
    if "expectCodePoints" in c:
        assert len(got) == c["expectCodePoints"] and c["raw"].startswith(got)
    else:
        assert got == c["expect"]


@pytest.mark.parametrize("c", V["guard"], ids=lambda c: c["name"])
def test_guard(c):
    g = BS.Guard(V["minRunMs"])
    for i, s in enumerate(c["steps"]):
        if "ended" in s:
            g.ended(s["ended"])
            continue
        assert g.decide(s["skip"], s.get("canAdvance", True), s.get("sync", False)) == s["expect"], "step %d" % i


def test_the_listener_runs_first_but_never_before_the_doctype():
    t = "abc123"
    s = BS.bridge_script(t)
    doc = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>x</body></html>'
    out = BS.inject(doc, t)
    assert out.startswith('<!doctype html><html lang="en"><head>' + s + '<meta')
    assert out.replace(s, "") == doc
    assert BS.inject("<html><body><header>h</header></body></html>", t).startswith("<html>" + s + "<body><header>")
    assert BS.inject("<!DOCTYPE html><p>x", t) == "<!DOCTYPE html>" + s + "<p>x"
    assert BS.inject("<p>x", t) == s + "<p>x"
    assert "e.source!==window" in s and "removeChild(s)" in s
    for bad in ("", "a'b", "x;alert(1)", "a" * 65):
        with pytest.raises(ValueError):
            BS.bridge_script(bad)


def test_the_console_line_counts_only_with_this_mounts_token():
    assert BS.parse_console("ST_BUNDLE_SKIP tok1 offline", "tok1") == (True, "offline")
    assert BS.parse_console("ST_BUNDLE_SKIP tok1 ", "tok1") == (True, "")
    assert BS.parse_console("ST_BUNDLE_SKIP tok2 offline", "tok1") == (False, None), "another mount's token"
    assert BS.parse_console("ST_BUNDLE_SKIP tok1 offline", None) == (False, None), "no bundle mounted"
    assert BS.parse_console("hello", "tok1") == (False, None)
    assert BS.parse_console(None, "tok1") == (False, None)


# ------------------------------------------------------------------ the controller (needs PySide6)

def _bundle(i, dur=30):
    return {"id": i, "content_id": "b%d" % i, "mime_type": "application/vnd.screentinker.bundle+zip",
            "filename": "tile%d.zip" % i, "duration_sec": dur}


@pytest.fixture()
def ctl():
    QtCore = pytest.importorskip("PySide6.QtCore")
    QtCore.QCoreApplication.instance() or QtCore.QCoreApplication([])
    from screentinker_native.player.controller import PlaylistController
    log = {"played": [], "events": [], "lines": [], "skipped": []}
    c = PlaylistController(on_item_changed=lambda it: log["played"].append(it.content_id),
                           on_playlist_empty=lambda: None,
                           on_play_log=lambda ev, it, done: log["events"].append((ev, it.content_id, done)))
    c.on_bundle_log = log["lines"].append
    c.on_play_skipped = lambda it, ms: log["skipped"].append(it.content_id)
    return c, log


def test_a_skip_moves_on_and_retracts_the_play(ctl):
    c, log = ctl
    c.update_playlist([_bundle(1), _bundle(2)])
    c.start()
    c.on_bundle_skip("offline\n now")
    assert log["played"] == ["b1", "b2"]
    assert log["skipped"] == ["b1"]
    assert ("play_end", "b1", True) not in log["events"], "no completed play_end for the skipped item"
    assert log["lines"] == ['skipped "tile1.zip" — offline now']


def test_once_per_pass_and_a_real_run_opens_the_next(ctl):
    c, log = ctl
    c.update_playlist([_bundle(1), _bundle(2)])
    c.start()
    c.on_bundle_skip(None)
    c.on_bundle_skip(None)
    assert log["played"] == ["b1", "b2", "b1"]
    c.on_bundle_skip(None)                             # A again in the same pass
    assert log["played"] == ["b1", "b2", "b1"]
    assert any("already skipped this pass" in x for x in log["lines"])
    c.item_started_at -= 30_000                        # A ran its duration
    c.next()
    assert log["played"][-1] == "b2"
    c.on_bundle_skip(None)
    assert log["played"][-1] == "b1", "a new pass"


def test_alone_or_on_a_shared_clock_it_never_skips(ctl):
    c, log = ctl
    c.update_playlist([_bundle(1)])
    c.start()
    c.on_bundle_skip(None)
    c.on_bundle_skip(None)
    assert log["played"] == ["b1"] and not log["skipped"]
    assert [x for x in log["lines"] if "nothing else to play" in x] == ['skip ignored for "tile1.zip": there is nothing else to play']
    c.update_playlist([_bundle(1), _bundle(2)])
    c.sync_driven = lambda: True
    c.on_bundle_skip(None)
    assert not log["skipped"]
