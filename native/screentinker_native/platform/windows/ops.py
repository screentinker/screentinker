"""Windows OS actions and identity — the twin of platform/linux/ops.py, same names and signatures.

Everything privileged goes to the ScreenTinkerHelper service (privileged.py → winhelper/service.py).
"""

import os
import sys

from . import privileged

CLIENT_TYPE = "win"
UPDATE_CHECK_PATH = "/api/win/update/check"
DOWNLOAD_PATH = "/download/win"
PACKAGE_NAME = "ScreenTinker-Setup-{version}.exe"
PACKAGE_EXT = ".exe"
PROGRAM_DATA = os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"), "ScreenTinker")


def default_state_dir():
    env = os.environ.get("ST_STATE_DIR")
    if env:
        return env
    # The installer creates ProgramData\ScreenTinker\state writable by the player's users, so the
    # pairing survives the kiosk account being swapped; a dev run falls back to the user profile.
    d = os.path.join(PROGRAM_DATA, "state")
    if os.path.isdir(d) and os.access(d, os.W_OK):
        return d
    return os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "ScreenTinker")


def system_config_path():
    # Admin-writable only (the installer's ACL). The helper trusts THIS file's server_url, never the
    # player's own state, which the player user can rewrite.
    return os.environ.get("ST_SYSTEM_CONFIG", os.path.join(PROGRAM_DATA, "config.json"))


def packaged():
    return bool(getattr(sys, "frozen", False))


def _has_microphone():
    try:
        import comtypes
        comtypes.CoInitialize()
        from pycaw.pycaw import AudioUtilities
        return AudioUtilities.GetMicrophone() is not None
    except Exception:
        return False


def extra_capabilities(brightness_supported):
    caps = []
    if privileged.available():
        caps += ["system.reboot", "system.time", "system.install_apk", "system.screen_timeout"]
    if brightness_supported:
        caps.append("system.brightness")
    if _has_microphone():
        caps.append("remote.mic")
    return caps


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
    return await privileged.run("install", path, timeout=120)


def screen_timeout_supported():
    return privileged.available()


async def set_screen_timeout(ms):
    return await privileged.run("set-screen-timeout", max(0, int(ms)))
