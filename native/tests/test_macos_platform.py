"""The macOS backend (screentinker_native/platform/macos), tested on Linux.

There is no Mac for these unit tests: the parsers are fed output captured from real Macs, the
LaunchAgent is written into a temporary home, and the remote terminal — which is plain POSIX — runs
for real here through the same ptyexec wrapper the Mac uses. What only a Mac can show (the .app
starting, AVFoundation/FFmpeg playback, the LaunchAgent under launchd) is the macOS CI job's and
docs/macos-player.md's business.
"""

import asyncio
import base64
import os
import plistlib
import subprocess
import sys

import pytest

from screentinker_native import capabilities, ptyexec
from screentinker_native.platform.macos import audio, deviceinfo, display, launchagent, ops, privileged
from screentinker_native.ui import screen_pick

IOREG_PLATFORM = '''
+-o J274AP  <class IOPlatformExpertDevice, id 0x100000202, registered, matched, active, busy 0 (2367 ms), retain 34>
    {
      "IOPolledInterface" = "AppleARMWatchdogTimerHibernateHandler is not serializable"
      "IOPlatformUUID" = "6E1A2B3C-4D5E-6F70-8192-A3B4C5D6E7F8"
      "IOPlatformSerialNumber" = "H4XQ12ABCD"
      "model" = <"Macmini9,1">
    }
'''

SW_VERS = "ProductName:\t\tmacOS\nProductVersion:\t\t15.1\nBuildVersion:\t\t24B83\n"

SYSTEM_PROFILER = """Hardware:

    Hardware Overview:

      Model Name: Mac mini
      Model Identifier: Mac14,3
      Chip: Apple M2
"""

EDID = "00ffffffffffff00" + "10ac" * 60   # 128 bytes, header first


def test_ioreg_platform_identity():
    ids = deviceinfo.parse_ioreg_platform(IOREG_PLATFORM)
    assert ids == {"uuid": "6E1A2B3C-4D5E-6F70-8192-A3B4C5D6E7F8", "serial": "H4XQ12ABCD"}
    assert deviceinfo.parse_ioreg_platform("") == {}


def test_os_and_model_parsers():
    assert deviceinfo.parse_sw_vers(SW_VERS) == ("macOS", "15.1", "24B83")
    assert deviceinfo.parse_sw_vers("") == ("macOS", "", "")
    assert deviceinfo.parse_model_name(SYSTEM_PROFILER) == "Mac mini"
    assert deviceinfo.parse_model_name("nothing") == ""


def test_edid_from_either_ioreg_key():
    for key in ("IODisplayEDID", "EDID"):
        out = '  | |   "%s" = <%s>\n' % (key, EDID)
        assert deviceinfo.parse_edid_hex(out) == bytes.fromhex(EDID)
    # A short blob is not an EDID (a 128-byte base block is the minimum).
    assert deviceinfo.parse_edid_hex('"EDID" = <00ff>') is None


def test_wifi_summary_redacted_ssid_is_none():
    out = "<dictionary> {\n  SSID : Lobby-WiFi\n  RSSI : -61\n}"
    assert deviceinfo.parse_wifi_summary(out) == ("Lobby-WiFi", -61)
    # macOS 15 without Location permission: the SSID is withheld, the signal is not.
    assert deviceinfo.parse_wifi_summary("  SSID : <redacted>\n  RSSI : -70") == (None, -70)
    assert deviceinfo.parse_wifi_summary("") == (None, None)


def test_platform_string_and_fingerprint(monkeypatch):
    outputs = {
        ("ioreg", "-rd1", "-c", "IOPlatformExpertDevice"): IOREG_PLATFORM,
        ("sysctl", "-n", "hw.model"): "Mac14,3\n",
        ("system_profiler", "SPHardwareDataType"): SYSTEM_PROFILER,
        ("sw_vers",): SW_VERS,
    }
    monkeypatch.setattr(deviceinfo, "_run", lambda argv, timeout=10: outputs.get(tuple(argv), ""))
    for f in (deviceinfo._platform_ids, deviceinfo.model, deviceinfo._os):
        f.cache_clear()
    try:
        # ⚠️ The server keys the macos family on this prefix (and on client_type 'mac').
        assert deviceinfo.platform_string() == "macOS/15.1 (Mac mini (Mac14,3))"
        assert deviceinfo.os_pretty() == "macOS 15.1 (24B83)"
        assert deviceinfo.serial() == "H4XQ12ABCD"
        fp = deviceinfo.fingerprint()
        assert len(fp) == 64
        monkeypatch.setenv("ST_INSTANCE", "2")
        assert deviceinfo.fingerprint() != fp, "a second player on one Mac must not collide"
    finally:
        for f in (deviceinfo._platform_ids, deviceinfo.model, deviceinfo._os):
            f.cache_clear()


def test_identity_and_paths():
    assert ops.CLIENT_TYPE == "mac"
    assert ops.UPDATE_CHECK_PATH is None, "the server mounts no Mac update check (download only)"
    assert ops.DOWNLOAD_PATH == "/download/mac"
    assert ops.PACKAGE_NAME.format(version="2.5.0") == "ScreenTinker-2.5.0.dmg"
    assert ops.default_state_dir().endswith(os.path.join("Library", "Application Support", "ScreenTinker", "state"))
    assert ops.system_config_path() == "/Library/Application Support/ScreenTinker/config.json"


def test_no_privileged_helper_means_no_privileged_capabilities(monkeypatch):
    assert privileged.available() is False
    assert ops.extra_capabilities(False) == []
    assert ops.extra_capabilities(True) == ["system.brightness"]
    ok, out = asyncio.run(ops.reboot())
    assert ok is False and "macOS" in out
    ok, _ = asyncio.run(ops.install_package("/tmp/x.dmg"))
    assert ok is False
    # The shared list minus what the Mac withdrew — and nothing it never had.
    monkeypatch.setattr(capabilities, "ops", ops)
    caps = capabilities.declared_capabilities(False)
    assert "system.self_update" not in caps
    for c in ("system.reboot", "system.time", "system.install_apk", "system.screen_timeout"):
        assert c not in caps
    assert "playback.video" in caps and "system.pty" in caps and "display.power" in caps
    # And the other backends are untouched by the withdrawal seam.
    from screentinker_native.platform.linux import ops as linux_ops
    monkeypatch.setattr(capabilities, "ops", linux_ops)
    assert "system.self_update" in capabilities.declared_capabilities(False)


def test_a_mac_never_checks_downloads_or_installs(monkeypatch):
    from screentinker_native.system import updater
    monkeypatch.setattr(updater, "ops", ops)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert updater.packaged() is False

    class Cfg:
        server_url = "https://signs.example.com"
        device_id = "d1"

    u = updater.Updater.__new__(updater.Updater)
    u._lock = asyncio.Lock()
    u.config = Cfg()
    u.state = None

    def boom(*a, **k):
        raise AssertionError("a Mac must not make an update request")
    monkeypatch.setattr(updater.aiohttp, "ClientSession", boom)
    asyncio.run(u.check(False))


def test_operator_exit_is_clean_for_launchd():
    # KeepAlive.SuccessfulExit=false restarts on any non-zero exit; the menu's "Exit player" must be 0.
    assert ops.EXIT_BY_OPERATOR == 0


def test_launchagent_plist(tmp_path):
    data = plistlib.loads(launchagent.build_plist(["/Applications/ScreenTinker.app/Contents/MacOS/ScreenTinker"],
                                                  server="https://signs.example.com", log_dir="/tmp/st"))
    assert data["Label"] == "com.screentinker.player"
    assert data["ProgramArguments"] == ["/Applications/ScreenTinker.app/Contents/MacOS/ScreenTinker",
                                        "--server", "https://signs.example.com"]
    assert data["RunAtLoad"] is True
    assert data["KeepAlive"] == {"SuccessfulExit": False}
    assert data["LimitLoadToSessionType"] == "Aqua"
    assert data["StandardErrorPath"] == "/tmp/st/launchd.err.log"
    path = launchagent.install(["/x/ScreenTinker"], home=str(tmp_path), load=False)
    assert path == str(tmp_path / "Library" / "LaunchAgents" / "com.screentinker.player.plist")
    assert plistlib.loads(open(path, "rb").read())["ProgramArguments"] == ["/x/ScreenTinker"]
    assert launchagent.remove(home=str(tmp_path), unload=False) is True
    assert launchagent.remove(home=str(tmp_path), unload=False) is False


def test_single_instance_lock(tmp_path):
    assert ops.single_instance(str(tmp_path)) is True
    # A second player in another process cannot take it while this one holds it.
    code = ("import sys; sys.path.insert(0, %r); from screentinker_native.platform.macos import ops; "
            "sys.exit(0 if ops.single_instance(%r) else 3)") % (os.path.abspath(os.path.join(os.path.dirname(__file__), "..")), str(tmp_path))
    assert subprocess.run([sys.executable, "-c", code]).returncode == 3


def test_volume_scripts():
    assert audio.set_script(0.5) == "set volume output volume 50 without output muted"
    assert audio.set_script(7) == "set volume output volume 100 without output muted"
    assert audio.parse_volume("37\n") == 0.37
    assert audio.parse_volume("missing value") is None


def test_dev_runs_never_touch_the_host_mixer(monkeypatch):
    monkeypatch.setenv("ST_TEST_NO_SYSTEM_AUDIO", "1")
    called = []

    async def fake(argv, timeout=10):
        called.append(argv)
        return 0, ""
    monkeypatch.setattr(audio, "run_cmd", fake)
    assert asyncio.run(audio.set_volume(0.2)) is None
    assert called == []


def test_keep_awake_is_tied_to_our_process():
    argv = display.caffeinate_argv(1234)
    assert argv == ["caffeinate", "-dimsu", "-w", "1234"]


def test_display_power_commands(monkeypatch):
    calls = []

    async def fake(argv, timeout=10):
        calls.append(argv)
        return 0, ""
    monkeypatch.setattr(display, "run_cmd", fake)
    assert asyncio.run(display.set_power(False)) == "pmset:ok,overlay"
    assert asyncio.run(display.set_power(True)) == "caffeinate-u:ok,overlay"
    assert calls == [["pmset", "displaysleepnow"], ["caffeinate", "-u", "-t", "2"]]


def test_screen_pick():
    assert screen_pick.wanted_index(None, env=None) is None
    assert screen_pick.wanted_index("1") == 1
    assert screen_pick.wanted_index(None, env="0") == 0
    assert screen_pick.wanted_index("-1") is None and screen_pick.wanted_index("two") is None
    assert screen_pick.pick(["a", "b"], "a", 1) == "b"
    assert screen_pick.pick(["a", "b"], "a", 5) == "a", "an index that does not exist falls back to the primary"
    assert screen_pick.pick(["a"], "a", None) == "a"


def test_ptyexec_command_shapes():
    assert ptyexec.command(["/bin/zsh", "-l"], frozen=True, executable="/A.app/Contents/MacOS/ScreenTinker") == \
        ["/A.app/Contents/MacOS/ScreenTinker", "--st-pty-exec", "/bin/zsh", "-l"]
    src = ptyexec.command(["/bin/zsh", "-l"], frozen=False, executable="/usr/bin/python3")
    assert src[0] == "/usr/bin/python3" and src[1].endswith("ptyexec.py") and src[2:] == ["/bin/zsh", "-l"]
    assert ptyexec.dispatch(["player", "--server", "x"]) is None


def read_pty_until_exit(master, proc, timeout=20):
    """Read the pty master WHILE the child runs. ⚠️ Not after it exits: macOS discards whatever is still
    buffered in a pty once the slave's last descriptor closes (Linux keeps it), so a read after wait()
    returned nothing on the macOS runner even though the child had printed."""
    import select
    import time
    out = b""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break                      # EIO: the slave side is gone
            if not chunk:
                break
            out += chunk
        elif proc.poll() is not None:
            break
    proc.wait(timeout=5)
    return out


@pytest.mark.skipif(not hasattr(os, "openpty"), reason="POSIX only")
def test_ptyexec_gives_the_shell_a_controlling_terminal():
    """The real thing, on this machine: the wrapped process is the session leader AND the foreground
    process group of the pty it was started on — which is what job control and ^C need."""
    import pty
    import time
    master, slave = pty.openpty()
    # The short sleep keeps the slave open until the line has been read (see read_pty_until_exit).
    probe = ("import os, time; print('ctty', os.getsid(0) == os.getpid(), os.tcgetpgrp(0) == os.getpgrp(), flush=True); "
             "time.sleep(0.5)")
    p = subprocess.Popen(ptyexec.command([sys.executable, "-c", probe], frozen=False), stdin=slave, stdout=slave,
                         stderr=slave, close_fds=True)
    os.close(slave)
    out = read_pty_until_exit(master, p)
    os.close(master)
    assert b"ctty True True" in out, out


@pytest.mark.skipif(not hasattr(os, "openpty"), reason="POSIX only")
def test_mac_pty_session_end_to_end():
    """platform/macos/shell.PtyManager, run here: open, type, read the output back, exit cleanly."""
    from screentinker_native.platform.macos import shell

    async def go():
        events = []

        async def emit(ev, payload):
            events.append((ev, payload))
        mgr = shell.PtyManager(emit)
        os.environ["SHELL"] = "/bin/sh"
        await mgr.open({"session_id": "s1", "rows": 24, "cols": 80})
        assert "s1" in mgr.sessions
        mgr.input({"session_id": "s1", "data": base64.b64encode(b"echo st-$((40+2))\nexit\n").decode()})
        for _ in range(100):
            if any(e == "device:pty-exit" for e, _ in events):
                break
            await asyncio.sleep(0.05)
        out = b"".join(base64.b64decode(p["data"]) for e, p in events if e == "device:pty-data")
        assert b"st-42" in out, out
        assert events[-1][0] == "device:pty-exit"
        assert "s1" not in mgr.sessions
    asyncio.run(go())
