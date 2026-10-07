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
    mod.cmd_setup(types.SimpleNamespace(url="http://localhost:3001/", name=None, mode=mode,
                                        user=None, allow_package_install=False))
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
