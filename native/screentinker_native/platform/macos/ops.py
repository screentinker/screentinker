"""macOS OS actions and identity — the twin of platform/linux/ops.py and platform/windows/ops.py.

The Mac player runs as the signed-in user from a LaunchAgent (launchagent.py) and has no privileged
helper (privileged.py), so the root-only actions are not offered and their capabilities are not
declared. What it cannot do is withdrawn from the shared "always" list, not left as a dead button:

  * system.self_update — replacing a signed, notarized .app in /Applications is an admin action on a
    managed Mac and MDM's job on a fleet. The player reports a newer version (the updater still
    checks) but never downloads or installs one. docs/macos-player.md.
"""

import os
import sys

from . import privileged

CLIENT_TYPE = "mac"
# No update check: the server mounts none for macOS (server/routes/mac-update.js is download-only).
UPDATE_CHECK_PATH = None
DOWNLOAD_PATH = "/download/mac"
PACKAGE_NAME = "ScreenTinker-{version}.dmg"
PACKAGE_EXT = ".dmg"
SELF_UPDATE = False
NO_SELF_UPDATE_REASON = "a Mac is updated from the .dmg or by MDM"
UNSUPPORTED_CAPABILITIES = ("system.self_update",)
# launchd's KeepAlive can only tell a clean exit (0) from any other: the on-screen "Exit player" must be
# 0 so the LaunchAgent stays down, and a crash (1) is what brings the player back.
EXIT_BY_OPERATOR = 0
HIDE_CURSOR = True

APP_SUPPORT = os.path.join(os.path.expanduser("~"), "Library", "Application Support", "ScreenTinker")
SYSTEM_SUPPORT = "/Library/Application Support/ScreenTinker"


def default_state_dir():
    env = os.environ.get("ST_STATE_DIR")
    if env:
        return env
    return os.path.join(APP_SUPPORT, "state")


def system_config_path():
    # Admin-writable only (/Library is root:admin). An MDM profile or an admin drops config.json here
    # to pre-set the server for a fleet; the player's own state stays in the user's Library.
    return os.environ.get("ST_SYSTEM_CONFIG", os.path.join(SYSTEM_SUPPORT, "config.json"))


def packaged():
    return bool(getattr(sys, "frozen", False))


def extra_capabilities(brightness_supported):
    caps = []
    if brightness_supported:
        caps.append("system.brightness")
    return caps


async def _unsupported(what):
    return False, "%s is not available on macOS: the player has no privileged helper" % what


async def reboot():
    return await _unsupported("reboot")


async def poweroff():
    return await _unsupported("shutdown")


async def set_time(epoch_ms):
    return await _unsupported("setting the clock")


async def set_timezone(tz):
    return await _unsupported("setting the timezone")


async def block_uninstall(block):
    return await _unsupported("blocking uninstall")


async def install_package(path):
    return await _unsupported("installing a package")


def screen_timeout_supported():
    return False


async def set_screen_timeout(ms):
    return False, "the display sleep timeout is the player's own (keep-awake) on macOS"


def single_instance(state_dir):
    """One player per user session: a LaunchAgent's KeepAlive and a manual double-click must not race two
    players onto one screen and one socket identity. An flock on a file in the state dir dies with the
    process, so a crash never leaves a stale lock."""
    import fcntl
    os.makedirs(state_dir, exist_ok=True)
    global _lock_fd
    _lock_fd = os.open(os.path.join(state_dir, "player.lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(_lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


_lock_fd = None

def program_arguments():
    """How launchd should start THIS player: the .app's own binary, or `python -m` for a source run."""
    if packaged():
        return [sys.executable]
    return [sys.executable, "-m", "screentinker_native"]


def install_autostart(server=None):
    from . import launchagent
    return launchagent.install(program_arguments(), server, log_dir=default_state_dir())


def remove_autostart():
    from . import launchagent
    return launchagent.remove()


# privileged is imported for the shared contract (app.py asks privileged.available()).
__all__ = ["privileged"]
