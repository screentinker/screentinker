"""Two (or more) independent players on one PC (#927): each its own pairing, its own monitor, and back
on that monitor after a reboot.

  - --display: N, @X,Y (the monitor containing that desktop point) or part of a name/serial
  - --instance: its own state dir, fingerprint and lock; only the first player self-updates
  - the Windows helper's "players" list: one supervised player per entry, nothing unsafe on a
    command line, and no list = exactly the one argument-less player every install has today
"""
import os

from screentinker_native.ui import screen_pick as sp
from screentinker_native.winhelper import service


class Screen:
    def __init__(self, name, x, y, w, h, model="", serial=""):
        self._n, self._g, self._m, self._s = name, (x, y, w, h), model, serial

    def name(self):
        return self._n

    def model(self):
        return self._m

    def serialNumber(self):
        return self._s

    def manufacturer(self):
        return ""


def geom(s):
    return s._g


LEFT = Screen(r"\\.\DISPLAY1", 0, 0, 1920, 1080, "GT710 left", "SN-AAA")
RIGHT = Screen(r"\\.\DISPLAY2", 1920, 0, 1920, 1080, "LG 24MK", "SN-BBB")
SCREENS = [RIGHT, LEFT]          # Qt's order is not the desktop order


def pick(arg):
    return sp.pick(SCREENS, LEFT, sp.wanted(arg), geom=geom)


def test_display_forms_parse():
    assert sp.wanted(None, env=None) is None and sp.wanted("  ") is None
    assert sp.wanted("1") == ("index", 1)
    assert sp.wanted("-1") is None
    assert sp.wanted("@1920,0") == ("point", 1920, 0)
    assert sp.wanted("@ -1280 , 0") == ("point", -1280, 0), "a monitor LEFT of the primary has negative X"
    assert sp.wanted("@1920x0") == ("point", 1920, 0)
    assert sp.wanted("@nope") is None
    assert sp.wanted("DISPLAY2") == ("name", "DISPLAY2")
    assert sp.wanted(None, env="@0,0") == ("point", 0, 0), "ST_DISPLAY works the same"


def test_back_compat_index_api():
    assert sp.wanted_index("1") == 1 and sp.wanted_index("@1920,0") is None
    assert sp.pick(["a", "b"], "a", 1) == "b"
    assert sp.pick(["a", "b"], "a", 5) == "a"
    assert sp.pick(["a"], "a", None) == "a"


def test_a_desktop_point_names_the_monitor_whatever_order_qt_lists_them_in():
    assert pick("@1920,0") is RIGHT
    assert pick("@2500,700") is RIGHT
    assert pick("@0,0") is LEFT
    assert pick("@1919,1079") is LEFT, "the right/bottom edge belongs to the next monitor"


def test_a_name_or_serial_names_the_monitor():
    assert pick("display2") is RIGHT
    assert pick("SN-AAA") is LEFT
    assert pick("24mk") is RIGHT


def test_a_monitor_that_is_not_there_falls_back_to_the_primary_and_find_says_so():
    assert pick("@5000,0") is LEFT
    assert sp.find(SCREENS, sp.wanted("@5000,0"), geom=geom) is None
    assert pick("DISPLAY9") is LEFT


def test_instance_names_and_state_dirs():
    from screentinker_native import app
    assert app.instance_name(None, env="") == ""
    assert app.instance_name("2") == "2" and app.instance_name(" menu-b ") == "menu-b"
    assert app.instance_name("../x") is None and app.instance_name("a" * 33) is None
    assert app.instance_name(None, env="2") == "2"
    base = os.path.join("C:", "ProgramData", "ScreenTinker", "state")
    assert app.instance_state_dir(base, "") == base, "the first player keeps its pairing"
    assert app.instance_state_dir(base, "2") == os.path.join(base, "players", "2")


def test_only_the_first_player_installs_updates(monkeypatch):
    from screentinker_native.system import updater
    monkeypatch.setenv("ST_INSTANCE", "2")
    assert updater.packaged() is False


def test_helper_runs_one_plain_player_without_a_players_list():
    assert service.player_specs({}) == [("", [])]
    assert service.player_specs({"players": []}) == [("", [])]
    assert service.player_specs({"players": "two"}) == [("", [])]


def test_helper_players_list():
    specs = service.player_specs({"players": [{"display": "@0,0"}, {"instance": "2", "display": "@1920,0"}]})
    assert specs == [("", ["--display", "@0,0"]), ("2", ["--instance", "2", "--display", "@1920,0"])]


def test_helper_skips_anything_unsafe_or_duplicated():
    specs = service.player_specs({"players": [
        {"instance": "2", "display": '@1920,0" --server http://evil'},
        {"instance": "x & calc"},
        {"instance": "3", "display": "DISPLAY 3"},
        {"instance": "3", "display": "1"},
        "nope",
    ]})
    assert specs == [("3", ["--instance", "3", "--display", "DISPLAY 3"])]
    assert service.player_specs({"players": [{"instance": "bad name!"}]}) == [("", [])]
    assert len(service.player_specs({"players": [{"instance": str(i)} for i in range(1, 10)]})) == service.MAX_PLAYERS


def test_helper_command_line():
    exe = r"C:\Program Files\ScreenTinker\ScreenTinker.exe"
    assert service.command_line(exe, []) == '"%s"' % exe
    assert service.command_line(exe, ["--instance", "2", "--display", "@1920,0"]) == \
        '"%s" --instance 2 --display @1920,0' % exe
    assert service.command_line(exe, ["--display", "DISPLAY 3"]) == '"%s" --display "DISPLAY 3"' % exe


def test_a_config_saved_with_a_bom_still_reads(tmp_path, monkeypatch):
    """PowerShell 5's Set-Content -Encoding UTF8 writes a BOM; the helper read {} and started nothing."""
    p = tmp_path / "config.json"
    p.write_bytes(b"\xef\xbb\xbf" + b'{"server_url": "http://x", "players": [{"display": "@0,0"}]}')
    monkeypatch.setattr(service, "CONFIG", str(p))
    assert service.load_config()["server_url"] == "http://x"
    from screentinker_native import config
    assert config._read_json(str(p))["players"] == [{"display": "@0,0"}]


# --- #927 follow-up: a hand-started second copy, and saying which players the helper read -------------

def test_a_player_started_without_arguments_finds_its_own_screen_in_config():
    """The Start menu / a Startup shortcut passes no --display: the player opened on the main monitor."""
    from screentinker_native.config import configured_display
    cfg = {"players": [{"display": "@1330,-1080"}, {"instance": "2", "display": " @1319,768 "}]}
    assert configured_display(cfg, "") == "@1330,-1080"
    assert configured_display(cfg, "2") == "@1319,768"
    assert configured_display(cfg, "3") is None
    assert configured_display({"players": [{"instance": "2"}]}, "2") is None, "no display = the primary"
    assert configured_display({}, "") is None and configured_display({"players": "x"}, "") is None
    assert configured_display({"players": ["x", {"display": "1"}]}, None) == "1"


def test_helper_describes_the_players_it_read():
    assert "no \"players\" list" in service.describe_specs([("", [])])
    line = service.describe_specs(service.player_specs(
        {"players": [{"display": "@1330,-1080"}, {"instance": "2"}]}))
    assert "first on @1330,-1080" in line and "2 on the main screen" in line


def test_helper_logs_the_players_once_per_change(monkeypatch, caplog):
    import logging
    monkeypatch.setattr(service, "_last_specs", None)
    one = service.player_specs({})
    two = service.player_specs({"players": [{"display": "@0,0"}, {"instance": "2", "display": "@1920,0"}]})
    with caplog.at_level(logging.INFO, logger="helper"):
        for specs in (one, one, two, two, two):
            service.log_specs_if_changed(specs)
    lines = [r.getMessage() for r in caplog.records]
    assert len(lines) == 2 and "2 on @1920,0" in lines[1]


def test_a_hand_started_copy_is_named_once_and_rechecked_steadily(caplog):
    """The field log (#927): 'player first exited (0): relaunching in 3s, 6s, 12s...' forever, with no
    hint that a Start-menu copy held the lock. Now: one clear warning, a steady 30 s re-check, no backoff."""
    import logging
    sl = service._Slot("", [])
    with caplog.at_level(logging.INFO, logger="helper"):
        for i in range(5):
            sl.launched_at = i * 30.0
            sl.exited(service.EXIT_ALREADY_RUNNING, i * 30.0 + 2, 1)
            assert sl.retry_at == i * 30.0 + 2 + service.ALREADY_RUNNING_RECHECK
            assert sl.backoff == 3 and sl.suppressed_session is None
        warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1 and "started outside the ScreenTinker service" in warnings[0]
        sl.still_running(200.0)             # the copy closed and ours kept running
        assert not sl.blocked and any("running under the service" in r.getMessage() for r in caplog.records)


def test_a_crash_still_backs_off_and_an_operator_exit_still_stands_down():
    sl = service._Slot("2", ["--instance", "2"])
    sl.exited(1, 5.0, 1)
    sl.exited(1, 10.0, 1)
    assert sl.backoff == 12 and not sl.blocked
    sl.exited(service.EXIT_BY_OPERATOR, 20.0, 1)
    assert sl.suppressed_session == 1


def test_player_and_helper_agree_on_the_exit_codes():
    from screentinker_native import app
    assert app.EXIT_ALREADY_RUNNING == service.EXIT_ALREADY_RUNNING
    assert app.EXIT_BY_OPERATOR == service.EXIT_BY_OPERATOR
