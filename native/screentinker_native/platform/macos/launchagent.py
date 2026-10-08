"""Start the player at login and keep it running: a per-user LaunchAgent.

    ScreenTinker.app/Contents/MacOS/ScreenTinker --install-autostart [--server https://…]
    ScreenTinker.app/Contents/MacOS/ScreenTinker --remove-autostart

A LaunchAgent (not a LaunchDaemon): the player draws on the user's display, and only a process in the
user's GUI session can. KeepAlive restarts it if it exits or crashes — except a clean "Exit player"
from the on-screen menu, which exits with EXIT_STAY_DOWN so launchd leaves it stopped until the next
login (KeepAlive.SuccessfulExit = false means "restart only after a non-zero exit"). A kiosk Mac needs
automatic login for this to cover a power cut; docs/macos-player.md.
"""

import os
import plistlib
import subprocess

LABEL = "com.screentinker.player"


def plist_path(home=None):
    return os.path.join(home or os.path.expanduser("~"), "Library", "LaunchAgents", LABEL + ".plist")


def build_plist(program, server=None, log_dir=None):
    """program: the argv that starts the player (a list), or one executable path."""
    args = list(program) if isinstance(program, (list, tuple)) else [program]
    if server:
        args += ["--server", server]
    d = {
        "Label": LABEL,
        "ProgramArguments": args,
        "RunAtLoad": True,
        # Restart after a crash or a non-zero exit; a clean exit (the on-screen "Exit player") stays down.
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 10,
        # A GUI app: Aqua session only, never a background-only context where it could not draw.
        "LimitLoadToSessionType": "Aqua",
        "ProcessType": "Interactive",
    }
    if log_dir:
        d["StandardOutPath"] = os.path.join(log_dir, "launchd.out.log")
        d["StandardErrorPath"] = os.path.join(log_dir, "launchd.err.log")
    return plistlib.dumps(d)


def install(program, server=None, home=None, log_dir=None, load=True):
    path = plist_path(home)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)
    data = build_plist(program, server, log_dir)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    if load:
        uid = str(os.getuid())
        subprocess.run(["launchctl", "bootout", "gui/%s/%s" % (uid, LABEL)], capture_output=True)
        subprocess.run(["launchctl", "bootstrap", "gui/%s" % uid, path], capture_output=True)
    return path


def remove(home=None, unload=True):
    path = plist_path(home)
    if unload:
        subprocess.run(["launchctl", "bootout", "gui/%s/%s" % (os.getuid(), LABEL)], capture_output=True)
    try:
        os.remove(path)
        return True
    except FileNotFoundError:
        return False
