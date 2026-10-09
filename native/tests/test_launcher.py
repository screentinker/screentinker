"""The /usr/bin/screentinker-pi launcher: run-mode selection and the Qt platform it asks for.

Field report (Pi OS Desktop, labwc): after a correct Desktop install the player never appeared, and
re-running `screentinker-pi setup URL` by hand switched the Pi to lite — the system service then
fought the display manager for the screen ("Could not queue DRM page flip … Permission denied").
"""
import importlib.machinery
import importlib.util
import json
import os
import types

import pytest

LAUNCHER = os.path.join(os.path.dirname(__file__), "..", "packaging", "linux", "screentinker-pi")
BUILD_DEB = os.path.join(os.path.dirname(__file__), "..", "packaging", "linux", "build-deb.sh")


@pytest.fixture
def launcher(monkeypatch, tmp_path):
    loader = importlib.machinery.SourceFileLoader("st_launcher", LAUNCHER)
    spec = importlib.util.spec_from_loader("st_launcher", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    mod.SYSTEM_CONFIG = str(tmp_path / "config.json")
    mod.calls = []
    monkeypatch.setattr(mod, "need_root", lambda: None)
    monkeypatch.setattr(mod, "sh", lambda *argv, check=False: mod.calls.append(argv))
    monkeypatch.setattr(mod.pwd, "getpwnam", lambda u: None)
    monkeypatch.setenv("SUDO_USER", "pi")
    return mod


def setup(mod, mode=None, desktop=False):
    mod.boots_to_desktop = lambda: desktop
    mod.desktop_login_user = lambda: "pi"
    # Never touch the test machine's own clock or zone.
    mod.setup_clock = lambda server, wanted=None, **k: mod.calls.append(("setup_clock", server, wanted))
    mod.install_all_outputs = lambda user, **k: mod.calls.append(("install_all_outputs", user))
    mod.cmd_setup(types.SimpleNamespace(url="http://localhost:3001/", name=None, mode=mode,
                                        user=None, allow_package_install=False, timezone=None))
    with open(mod.SYSTEM_CONFIG) as f:
        return json.load(f)


def test_setup_without_mode_on_a_desktop_pi_stays_desktop(launcher):
    cfg = setup(launcher, desktop=True)
    assert cfg["mode"] == "desktop" and cfg["desktop_user"] == "pi"
    assert ("systemctl", "disable", "--now", "screentinker-pi") in launcher.calls
    assert ("systemctl", "enable", "screentinker-pi") not in launcher.calls, "never enable the service on a desktop"


def test_setup_without_mode_on_lite_is_lite(launcher):
    cfg = setup(launcher, desktop=False)
    assert cfg["mode"] == "lite"
    assert ("systemctl", "enable", "screentinker-pi") in launcher.calls


def test_explicit_lite_on_a_desktop_is_honoured_but_warned(launcher, capsys):
    cfg = setup(launcher, mode="lite", desktop=True)
    assert cfg["mode"] == "lite"
    assert "desktop owns the screen" in capsys.readouterr().out


def test_wayland_session_asks_for_qt_with_an_xcb_fallback(launcher, monkeypatch):
    seen = {}
    monkeypatch.setattr(launcher.os, "execve", lambda exe, argv, env: seen.update(env))
    monkeypatch.setenv("WAYLAND_DISPLAY", "wayland-0")
    monkeypatch.delenv("QT_QPA_PLATFORM", raising=False)
    launcher.cmd_run(types.SimpleNamespace(rest=[]))
    assert seen["QT_QPA_PLATFORM"] == "wayland;xcb", "a bare 'wayland' aborts Qt when the plugin is missing"


def test_the_package_depends_on_the_wayland_platform_plugin():
    # libqwayland-*.so is in qt6-wayland, NOT qt6-qpa-plugins (which carries only the VNC plugin).
    assert "qt6-wayland" in open(BUILD_DEB).read()


# ---------------------------------------------------------------------- audience-counting add-on

def test_addon_platform_names_the_cpu_and_the_python(launcher):
    assert launcher.addon_platform("aarch64", (3, 13)) == "linux-aarch64-cp313"
    assert launcher.addon_platform("x86_64", (3, 13)) == "linux-x86_64-cp313"
    assert launcher.addon_platform("armv7l", (3, 13)) is None, "no 32-bit wheels exist"
    # 32-bit Pi OS on a 64-bit kernel: uname says aarch64, the Python (and the player) is 32-bit.
    assert launcher.addon_platform("aarch64", (3, 13), pointer_bits=32) is None
    assert launcher.addon_platform("aarch64", (3, 13), pointer_bits=64) == "linux-aarch64-cp313"


def test_a_32_bit_userland_is_told_why(launcher, monkeypatch):
    monkeypatch.setattr(launcher.struct, "calcsize", lambda fmt: 4)
    monkeypatch.setattr(launcher, "OLD_AUDIENCE_DIRS", ())
    with pytest.raises(SystemExit, match="64-bit userland.*32-bit Python"):
        launcher.cmd_audience_addon(types.SimpleNamespace(action="install", server="http://x"))


def test_the_addon_is_not_under_the_tree_the_pi_setup_gives_away(launcher):
    # raspberry-pi-setup.sh (all-in-one) chowns /opt/screentinker to the Pi user.
    assert launcher.AUDIENCE_DIR == "/usr/lib/screentinker-pi-audience"
    from screentinker_native.system import audience
    assert audience.LINUX_ADDON_DIR == launcher.AUDIENCE_DIR, "the player looks where the launcher installs"


def _zip(path, members):
    import zipfile
    with zipfile.ZipFile(path, "w") as z:
        for name, data in members.items():
            z.writestr(name, data)


@pytest.mark.parametrize("bad", ["../evil.py", "/etc/passwd", "a/../../evil.py"])
def test_safe_extract_refuses_paths_out_of_the_addon_dir(launcher, tmp_path, bad):
    import zipfile
    zpath = tmp_path / "a.zip"
    _zip(zpath, {"ADDON.json": "{}", bad: "x"})
    dest = tmp_path / "out"
    dest.mkdir()
    with zipfile.ZipFile(zpath) as zf, pytest.raises(ValueError):
        launcher.safe_extract(zf, str(dest))
    assert not (tmp_path / "evil.py").exists()


@pytest.fixture
def addon_server(tmp_path):
    """A server offering one add-on zip: (base_url, state) — state['sha'] can be falsified."""
    import hashlib
    import http.server
    import sys
    import threading
    zpath = tmp_path / "addon.zip"
    _zip(zpath, {"ADDON.json": json.dumps({"name": "screentinker-audience", "version": "1.0.0",
                                           "python": "%d.%d" % sys.version_info[:2]}),
                 "cv2/__init__.py": "", "face.onnx": "model"})
    body = zpath.read_bytes()
    state = {"sha": hashlib.sha256(body).hexdigest(), "downloads": 0}

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path.startswith("/api/audience-addon/"):
                out = json.dumps({"available": True, "version": "1.0.0", "sha256": state["sha"], "size": len(body),
                                  "download_url": "/download/audience-addon/x"}).encode()
            elif self.path.startswith("/download/audience-addon/"):
                state["downloads"] += 1
                out = body
            else:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1], state
    srv.shutdown()


def test_addon_install_verifies_the_checksum_and_is_idempotent(launcher, tmp_path, addon_server, monkeypatch):
    base, state = addon_server
    monkeypatch.setattr(launcher, "AUDIENCE_DIR", str(tmp_path / "usr" / "lib" / "audience"))
    old = tmp_path / "opt" / "audience-addon"
    (old / "cv2").mkdir(parents=True)
    monkeypatch.setattr(launcher, "OLD_AUDIENCE_DIRS", (str(old),))
    monkeypatch.setattr(launcher, "addon_platform", lambda: "linux-aarch64-cp313")
    monkeypatch.setattr(launcher, "_restart_player", lambda cfg: None)
    run = lambda: launcher.cmd_audience_addon(types.SimpleNamespace(action="install", server=base))

    real = state["sha"]
    state["sha"] = "0" * 64
    with pytest.raises(SystemExit, match="Checksum mismatch"):
        run()
    assert not os.path.exists(launcher.AUDIENCE_DIR), "nothing installed from an unverified download"

    state["sha"] = real
    run()
    assert os.path.isfile(os.path.join(launcher.AUDIENCE_DIR, "ADDON.json"))
    assert not old.exists(), "the old location is deleted, not left to be loaded"
    assert os.stat(launcher.AUDIENCE_DIR).st_mode & 0o777 == 0o755
    assert open(os.path.join(launcher.AUDIENCE_DIR, "ADDON-SHA256")).read().strip() == real
    n = state["downloads"]
    run()
    assert state["downloads"] == n, "the same build is not downloaded again"

    launcher.cmd_audience_addon(types.SimpleNamespace(action="remove", server=None))
    assert not os.path.exists(launcher.AUDIENCE_DIR)


def test_build_deb_purge_removes_the_addon():
    with open(BUILD_DEB) as f:
        src = f.read()
    assert "rm -rf /usr/lib/screentinker-pi-audience" in src and '"$1" = "purge"' in src
    assert "rm -rf /opt/screentinker/audience-addon" in src, "and the old location"


# ---------------------------------------------------------------------- sound on Lite (PipeWire)

def test_pulse_server_finds_the_player_users_pipewire_socket(launcher):
    """Debian's Qt has no ALSA backend: without a sound server every Lite Pi played video silently
    ("No audio device detected"). The launcher points the player at its own user's PipeWire socket."""
    seen = []
    assert launcher.pulse_server(uid=102, exists=lambda p: seen.append(p) or True) == "unix:/run/user/102/pulse/native"
    assert seen == ["/run/user/102/pulse/native"]
    # Not up yet at boot: waits, then finds it.
    calls = {"n": 0}
    def later(p):
        calls["n"] += 1
        return calls["n"] >= 3
    assert launcher.pulse_server(uid=102, sleep=lambda s: None, exists=later) == "unix:/run/user/102/pulse/native"
    # Never comes up: gives up (the player still runs, without sound) instead of blocking forever.
    naps = []
    assert launcher.pulse_server(uid=102, wait_s=5, sleep=naps.append, exists=lambda p: False) is None
    assert len(naps) == 5


def test_the_package_brings_a_sound_server_and_sends_audio_to_every_output():
    with open(BUILD_DEB) as f:
        src = f.read()
    for pkg in ("pipewire", "pipewire-pulse", "wireplumber"):
        assert pkg in src.split("Depends:", 1)[1].split("EOF", 1)[0], pkg
    assert "loginctl enable-linger screentinker" in src
    assert "pipewire-all-outputs.conf" in src and "/var/lib/screentinker-pi/.config/pipewire/pipewire.conf.d/" in src
    conf = os.path.join(os.path.dirname(BUILD_DEB), "pipewire-all-outputs.conf")
    with open(conf) as f:
        c = f.read()
    assert "libpipewire-module-combine-stream" in c and 'node.name = "~alsa_output.*"' in c
    assert "priority.session" in c, "the combined sink must win as the default"


# ---------------------------------------------------------------------- clock: NTP + a real time zone

class _Run:
    def __init__(self, rc=0):
        self.calls, self.rc = [], rc
    def __call__(self, *argv):
        self.calls.append(argv)
        return type("R", (), {"returncode": self.rc, "stdout": "", "stderr": "nope"})()
    def zones_set(self):
        return [c[2] for c in self.calls if c[:2] == ("timedatectl", "set-timezone")]


def test_setup_clock_turns_on_ntp_and_detects_a_default_zone(launcher):
    """⚠️ Pi OS's default zone IS Europe/London: a Pi in Chicago played its schedules on UK time."""
    run, out = _Run(), []
    tz = launcher.setup_clock("http://s", run=run, current="Europe/London",
                              lookup=lambda s: "America/Chicago", out=out.append)
    assert tz == "America/Chicago" and run.zones_set() == ["America/Chicago"]
    assert ("timedatectl", "set-ntp", "true") in run.calls
    assert "detected" in out[-1]


def test_setup_clock_keeps_a_zone_somebody_chose(launcher):
    run, looked = _Run(), []
    tz = launcher.setup_clock("http://s", run=run, current="Asia/Tokyo",
                              lookup=lambda s: looked.append(s) or "America/Chicago", out=lambda m: None)
    assert tz == "Asia/Tokyo" and run.zones_set() == [] and looked == [], "never second-guess a chosen zone"
    assert ("timedatectl", "set-ntp", "true") in run.calls


def test_setup_clock_explicit_zone_wins_and_bad_ones_are_refused(launcher):
    run = _Run()
    assert launcher.setup_clock("http://s", "America/Denver", run=run, current="Asia/Tokyo",
                                lookup=lambda s: "America/Chicago", out=lambda m: None) == "America/Denver"
    assert run.zones_set() == ["America/Denver"]
    run, out = _Run(), []
    for bad in ("Mars/Olympus", "../../etc/passwd", "America/Chicago; reboot"):
        assert launcher.setup_clock("http://s", bad, run=run, current="Europe/London", out=out.append) == "Europe/London"
    assert run.zones_set() == [] and all("Unknown time zone" in m for m in out)


def test_setup_clock_keeps_the_zone_when_it_cannot_tell(launcher):
    """A LAN server can't see where the Pi is: keep the zone and say how to fix it, never guess."""
    run, out = _Run(), []
    assert launcher.setup_clock("http://s", run=run, current="Etc/UTC", lookup=lambda s: None,
                                out=out.append) == "Etc/UTC"
    assert run.zones_set() == [] and "--timezone" in " ".join(out)
    run = _Run(rc=1)   # timedatectl refused: report it, don't claim success
    out = []
    assert launcher.setup_clock("http://s", run=run, current="Etc/UTC", lookup=lambda s: "America/Chicago",
                                out=out.append) == "Etc/UTC"
    assert "Could not set" in out[-1]


def test_lookup_zone_asks_our_own_server_and_validates_the_answer(launcher):
    import io
    asked = []
    def opener(body):
        def urlopen(url, timeout):
            asked.append(url)
            class R(io.BytesIO):
                def __enter__(self): return self
                def __exit__(self, *a): return False
            return R(body)
        return urlopen
    assert launcher.lookup_zone("https://screentinker.com/", opener(b'{"timezone":"America/Chicago"}')) == "America/Chicago"
    assert asked == ["https://screentinker.com/api/public/timezone"]
    assert launcher.lookup_zone("http://s", opener(b'{"timezone":"Mars/Olympus"}')) is None
    assert launcher.lookup_zone("http://s", opener(b'{"timezone":null}')) is None
    assert launcher.lookup_zone("http://s", opener(b'<html>404</html>')) is None
    def boom(url, timeout):
        raise OSError("down")
    assert launcher.lookup_zone("http://s", boom) is None


def test_setup_sets_the_clock_before_the_service_starts(launcher):
    setup(launcher)
    names = [c[0] if c[0] == "setup_clock" else " ".join(c) for c in launcher.calls]
    assert ("setup_clock", "http://localhost:3001", None) in launcher.calls
    assert names.index("setup_clock") < names.index("systemctl restart screentinker-pi"), \
        "the player must start in the right zone, not pick it up at the next reboot"


# ---------------------------------------------------------------------- desktop sound: all outputs

def test_desktop_setup_sends_the_login_users_sound_to_all_outputs(launcher):
    """⚠️ The package sets "All outputs" up for the Lite service's user only. In desktop mode the
    player runs as the login user, whose sound went to the headphone jack — never the HDMI screen."""
    setup(launcher, desktop=True)
    assert ("install_all_outputs", "pi") in launcher.calls
    launcher.calls.clear()
    setup(launcher, desktop=False)
    assert not [c for c in launcher.calls if c[0] == "install_all_outputs"], "Lite's user has it from the package"


def test_install_all_outputs_writes_as_the_user_into_their_pipewire_config(launcher, monkeypatch, capsys):
    monkeypatch.setattr(launcher.pwd, "getpwnam", lambda u: types.SimpleNamespace(pw_dir="/home/" + u))
    run = _Run()
    assert launcher.install_all_outputs("owner", run=run) is True
    assert run.calls == [("runuser", "-u", "owner", "--", "install", "-D", "-m", "0644", launcher.ALL_OUTPUTS_CONF,
                          "/home/owner/.config/pipewire/pipewire.conf.d/50-screentinker-all-outputs.conf")], \
        "as the user, never root writing into someone's home"
    assert "all outputs" in capsys.readouterr().out


def test_install_all_outputs_never_fails_setup(launcher, monkeypatch, capsys):
    monkeypatch.setattr(launcher.pwd, "getpwnam", lambda u: types.SimpleNamespace(pw_dir="/home/" + u))
    assert launcher.install_all_outputs("owner", run=_Run(rc=1)) is False
    assert "Could not set up sound" in capsys.readouterr().out
    def missing(u):
        raise KeyError(u)
    monkeypatch.setattr(launcher.pwd, "getpwnam", missing)
    assert launcher.install_all_outputs("ghost", run=_Run()) is False
