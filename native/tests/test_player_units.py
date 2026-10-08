"""Units for the native player's own code (the ported logic has its own vector-driven suites).

Each test pins behaviour that is shared with another player, so a drift shows up here rather than as
a panel that disagrees with its neighbours on the wall.
"""
import asyncio
import base64
import os
import re

import pytest

from screentinker_native.player import transitions
from screentinker_native.player.items import Item, slot_ms

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
KOTLIN = os.path.join(REPO, "android", "app", "src", "main", "java", "com", "remotedisplay", "player")


# --- items -----------------------------------------------------------------------------------

def test_widget_items_do_not_share_a_continuity_key():
    # #234: keying continuity on content_id made every widget the same item.
    a = Item.parse({"widget_id": "w1", "mime_type": "text/html"})
    b = Item.parse({"widget_id": "w2", "mime_type": "text/html"})
    assert a.key != b.key and a.key == "|w1"


def test_duration_is_not_structural_but_widget_rev_is():
    base = {"content_id": "c", "mime_type": "image/png", "duration_sec": 10, "widget_rev": 1}
    assert Item.parse(base).sig() == Item.parse(dict(base, duration_sec=30)).sig()
    assert Item.parse(base).sig() != Item.parse(dict(base, widget_rev=2)).sig()
    assert Item.parse(base).sig() != Item.parse(dict(base, muted=1)).sig()
    # content_rev is deliberately NOT structural (the READY check carries a replaced asset).
    assert Item.parse(base).sig() == Item.parse(dict(base, content_rev=9)).sig()


def test_slot_ms_matches_the_cross_player_formula():
    # max(1, duration||10)*1000 — web/Tizen/Android group sync all use exactly this.
    assert slot_ms(Item.parse({"duration_sec": 0})) == 10_000
    assert slot_ms(Item.parse({"duration_sec": 7})) == 7_000
    assert slot_ms(Item.parse({})) == 10_000


def test_tolerant_parse_of_widget_assignment_without_content_id():
    it = Item.parse({"widget_id": "w", "content_id": None, "enabled": 1, "muted": 0})
    assert it.content_id == "" and it.is_widget and it.enabled and not it.muted


# --- engine helpers (Qt-free functions) -----------------------------------------------------

def _engine_helpers():
    pytest.importorskip("PySide6.QtCore")
    from screentinker_native.player import engine
    return engine


@pytest.mark.parametrize("o,portrait,deg", [
    ("landscape", False, 0), ("landscape-flipped", False, 180), ("portrait", False, 90),
    ("portrait-flipped", False, 270), ("portrait", True, 0), ("landscape", True, 90),
    ("landscape-flipped", True, 270), ("portrait-flipped", True, 180),
])
def test_orientation_rotation_matches_android(o, portrait, deg):
    assert _engine_helpers().orientation_rot(o, portrait) == deg


def test_youtube_embed_matches_android_wrapper():
    e = _engine_helpers()
    html = e.youtube_html("https://www.youtube.com/watch?v=dQw4w9WgXcQ", muted=True)
    assert 'src="https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1&controls=0&rel=0' \
           '&modestbranding=1&loop=1&playlist=dQw4w9WgXcQ&playsinline=1&enablejsapi=1"' in html
    assert e.youtube_html("https://youtu.be/dQw4w9WgXcQ?st_aspect=vertical", False).count("aspect-ratio:9/16") == 1
    assert e.youtube_html("https://example.com/", False) is None


# --- transitions -----------------------------------------------------------------------------

def test_every_library_shader_wraps_with_its_params_in_order():
    lib = os.path.join(REPO, "shared", "Transitions")
    for f in sorted(os.listdir(lib)):
        if not f.endswith(".glsl"):
            continue
        src = open(os.path.join(lib, f)).read()
        wrapped, names = transitions.wrap(src)
        declared = re.findall(r"^\s*uniform\s+float\s+(\w+)\s*;", src, re.M)
        assert names == declared[:transitions.MAX_PARAMS], f
        assert "#version 440" in wrapped and "texture2D" not in wrapped and "void main()" in wrapped, f
        for i, n in enumerate(names):
            assert "#define %s p%d" % (n, i) in wrapped


def test_transition_parse_clamps_duration_and_drops_bad_effects():
    s = transitions.parse({"effects": [{"shader": "Crossfade", "params": {"ease": 1, "bad": "x"}}, {}],
                           "durationMs": 99999})
    assert s == {"effects": [{"shader": "Crossfade", "params": {"ease": 1.0}}], "durationMs": 3000}
    assert transitions.parse({"effects": []}) is None
    assert transitions.parse(None) is None


# --- power schedule --------------------------------------------------------------------------

def test_power_decision_table_matches_android():
    pytest.importorskip("PySide6.QtCore")
    from screentinker_native.system.power_schedule import decide
    assert decide(False, False) == (False, True)
    assert decide(False, True) == (False, True)
    assert decide(True, True) == (False, False)
    assert decide(True, False) == (True, False)


# --- local API allowlist parity --------------------------------------------------------------

def test_local_api_allowlist_is_the_kotlin_list():
    from screentinker_native.net.triggers import LOCAL_API_COMMANDS
    kt = open(os.path.join(KOTLIN, "net", "LocalApi.kt")).read()
    m = re.search(r"val COMMANDS: List<String> = listOf\(([^)]*)\)", kt, re.S)
    assert m, "LocalApi.kt COMMANDS not found"
    assert LOCAL_API_COMMANDS == re.findall(r'"([^"]+)"', m.group(1))


# --- PTY ordering ------------------------------------------------------------------------------

def test_pty_exit_never_overtakes_the_last_output():
    from screentinker_native.platform import shell as _shell
    PtyManager = _shell.PtyManager

    async def run():
        got = []

        async def emit(ev, p):
            got.append((ev, p))
        m = PtyManager(emit)
        await m.open({"session_id": "s", "rows": 24, "cols": 80})
        await asyncio.sleep(0.5)
        m.input({"session_id": "s", "data": base64.b64encode(b"echo LAST-LINE; exit\n").decode()})
        for _ in range(60):
            await asyncio.sleep(0.1)
            if any(e == "device:pty-exit" for e, _ in got):
                break
        return got

    got = asyncio.run(run())
    events = [e for e, _ in got]
    assert events[-1] == "device:pty-exit"
    out = b"".join(base64.b64decode(p["data"]) for e, p in got if e == "device:pty-data")
    assert b"LAST-LINE\r\n" in out


# --- trigger POST bodies (Android TriggerListeners parity) ---------------------------------------

@pytest.mark.parametrize("body,line", [
    ("ST1 s3cret FIRE", "ST1 s3cret FIRE"),                        # raw line, whatever the Content-Type
    ('{"token":"FIRE","secret":"s3cret"}', "ST1 s3cret FIRE"),      # JSON envelope
    ('{"token":"","secret":"s3cret"}', '{"token":"","secret":"s3cret"}'),   # falsy token -> raw
    ("token=FIRE&secret=s3cret", "ST1 s3cret FIRE"),               # form
    ("ST1 s3cret mytoken=X", "ST1 s3cret mytoken=X"),              # ⚠️ NOT a form: anchored regexes
])
def test_trigger_post_body_shapes(body, line):
    from screentinker_native.net.triggers import post_body_to_line
    assert post_body_to_line(body) == line


# ---------------------------------------------------------------------- transition bake profile (GLES)

def test_shader_bake_profile_is_picked_from_the_gl_flavour(tmp_path):
    """A real Pi 4 (OpenGL ES 3) failed to link every transition: our .qsb offered GLSL "300 es",
    Qt's own ShaderEffect vertex shader stops at "100 es", and a mixed pair does not link. On GLES the
    bake drops 300 es (new cache name); everywhere else it is exactly what it always was (.v2)."""
    from screentinker_native.player import transitions
    lib = transitions.ShaderLibrary(str(tmp_path / "lib"), str(tmp_path / "cache"))
    assert lib.bake_profile() == ("100 es,120,150,300 es", ".v2"), "desktop GL, D3D and Metal unchanged"
    lib._baked["x"] = ("stale", [])
    lib.set_gles(True)
    glsl, suffix = lib.bake_profile()
    assert "300 es" not in glsl and "100 es" in glsl
    assert suffix != ".v2", "a GLES bake never reuses a desktop .qsb"
    assert lib._baked == {}, "switching profile drops what was resolved under the old one"
    lib.set_gles(True)
    lib._baked["y"] = ("keep", [])
    lib.set_gles(True)
    assert "y" in lib._baked, "setting the same profile again is a no-op"



def test_set_timezone_reloads_the_players_own_zone(monkeypatch):
    """The OS zone changed but the player kept the old one until it restarted (glibc loads it once):
    log times and zone-less schedules stayed hours off. After the helper succeeds, re-read it."""
    import asyncio
    from screentinker_native import app as app_mod
    calls = []
    monkeypatch.setattr(app_mod, "reload_local_zone", lambda: calls.append("reload"))

    class Holder:
        async def _op_log(self, label, coro):
            return await coro

    for ok, want in ((True, ["reload"]), (False, [])):
        calls.clear()
        async def helper(tz, ok=ok):
            return ok
        monkeypatch.setattr(app_mod.ops, "set_timezone", helper)
        assert asyncio.run(app_mod.App._set_timezone(Holder(), "America/Chicago")) is ok
        assert calls == want, "reload only after the OS change actually succeeded"
