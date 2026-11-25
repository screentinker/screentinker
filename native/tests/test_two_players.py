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
