"""Linux (Raspberry Pi) OS actions and identity — the per-OS half the neutral app calls by name.

Every function here has a twin in platform/windows/ops.py with the same signature; app.py never
branches on the OS itself.
"""

import os
import shutil

from . import display, privileged

# Identity on the wire. ⚠️ client_type 'pi' is what the server's platformFamily() keys the linux family
# on, and what /download/pi and /api/pi/update/check are named after; it stays 'pi' on any Linux box.
CLIENT_TYPE = "pi"
UPDATE_CHECK_PATH = "/api/pi/update/check"
DOWNLOAD_PATH = "/download/pi"
PACKAGE_NAME = "screentinker-pi_{version}_all.deb"
PACKAGE_EXT = ".deb"
INSTALL_ROOT = "/usr/lib/screentinker-pi"


def default_state_dir():
    env = os.environ.get("ST_STATE_DIR")
    if env:
        return env
    if os.geteuid() == 0 or os.access("/var/lib/screentinker-pi", os.W_OK):
        return "/var/lib/screentinker-pi"
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "screentinker-pi")


def system_config_path():
    return os.environ.get("ST_SYSTEM_CONFIG", "/etc/screentinker-pi/config.json")


def packaged():
    return os.path.isdir(INSTALL_ROOT)


def extra_capabilities(brightness_supported):
    caps = []
    if privileged.available():
        # reboot/shutdown, the clock and timezone, and installing a package all go through the root
        # helper; without it (a dev checkout) they would be promises the panel cannot keep.
        caps += ["system.reboot", "system.time", "system.install_apk"]
    if brightness_supported:
        caps.append("system.brightness")
    if screen_timeout_supported():
        caps.append("system.screen_timeout")
    if any(os.path.exists(p) for p in _capture_devices()):
        caps.append("remote.mic")
    return caps


def _capture_devices():
    import glob
    return glob.glob("/dev/snd/pcmC*D*c")


async def reboot():
    return await privileged.run("reboot")


async def poweroff():
    return await privileged.run("poweroff")


async def set_time(epoch_ms):
    return await privileged.run("set-time", int(epoch_ms))


async def set_timezone(tz):
    return await privileged.run("set-timezone", tz)


async def block_uninstall(block):
    return await privileged.run("hold" if block else "unhold")


async def install_package(path):
    return await privileged.run("install-deb", path, timeout=60)


def screen_timeout_supported():
    # The only session where a blanking timeout is a real, settable thing (xset s). Under Wayland/KMS
    # the player itself is what keeps the screen awake.
    return display.session_type() == "x11" and shutil.which("xset") is not None


async def set_screen_timeout(ms):
    if not screen_timeout_supported():
        return False, "screen timeout is only settable on an X11 session"
    s = str(max(0, ms // 1000))
    await privileged.run_cmd(["xset", "s", s if ms > 0 else "off"])
    rc, out = await privileged.run_cmd(["xset", "dpms", s, s, s] if ms > 0 else ["xset", "-dpms"])
    return rc == 0, out
